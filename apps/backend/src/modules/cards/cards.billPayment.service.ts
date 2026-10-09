import { HydratedDocument, Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Account, Transaction, TransactionDoc } from "../../models";
import { AccountType } from "../../types";
import { transferCategoryId } from "../categories/categories.system";
import { BillCard, CardBillMatch, recogniseCardBill } from "./cards.billPayment";

/**
 * Marking card bill payments as they arrive, and in what was imported
 * before they were recognised.
 *
 * What a recognised payment becomes:
 *
 *   bank side, card known    cardPaymentFor = that card. Counts nothing
 *                            (CARD_BILL), and the bill reads as paid.
 *   bank side, card unknown  a transfer to an account SpendLog does not
 *                            know. Still counts nothing, and links to no
 *                            card, because a wrong card would mark the
 *                            wrong bill paid. The same shape a transfer
 *                            typed in by hand with no other account has.
 *   card side                a transfer in. Money arriving on a card is not
 *                            income, and must stay out of the savings
 *                            bucket's extra income as much as the totals.
 *
 * The two sides of one payment are then paired (transferPairId), the way
 * detectSelfTransfer pairs a transfer - only over days rather than ten
 * minutes, since an issuer can take two working days to post it. Pairing
 * is also how an unknown card becomes known: the card side says which card
 * the money landed on.
 *
 * All of it is written with save(), so the counted amount is worked out by
 * the same hook as every other write.
 */

/// How far apart the two sides of one payment may be: the card posts it
/// up to a few days after the bank lets it go, never much before.
const CARD_POSTS_AFTER_DAYS = 4;
const CARD_POSTS_BEFORE_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What recognising needs to know about a user's accounts, loaded once. */
export interface CardBillContext {
  cards: BillCard[];
  accountTypeOf: Map<string, AccountType>;
}

export async function cardBillContext(userId: Types.ObjectId): Promise<CardBillContext> {
  const accounts = await Account.find({ userId }).select(
    "bankName issuer nickname aliases last4 accountType isActive"
  );
  return {
    cards: accounts
      .filter((account) => account.accountType === "CARD")
      .map((card) => ({
        id: card._id.toString(),
        bankName: card.bankName,
        issuer: card.issuer ?? null,
        nickname: card.nickname ?? null,
        aliases: card.aliases,
        last4: card.last4 ?? null,
        isActive: card.isActive,
      })),
    accountTypeOf: new Map(accounts.map((account) => [account._id.toString(), account.accountType])),
  };
}

/** Everything that was said about a transaction, as one piece of text. */
function wordsOf(transaction: Pick<TransactionDoc, "rawText" | "merchant" | "sources">): string {
  const texts = [transaction.rawText, ...transaction.sources.map((entry) => entry.rawText), transaction.merchant];
  return [...new Set(texts.filter((text): text is string => Boolean(text)))].join(" \n ");
}

/**
 * Whether automatic recognition may decide what this transaction is.
 *
 * Not when a person has said what kind it is, and not when it is already
 * something that excludes being a bill: an EMI or loan instalment, a
 * settlement, a refund, the month's pay, money set aside. A manual row is
 * what someone typed, card link and all, so it is left as they made it.
 */
function mayRecognise(transaction: HydratedDocument<TransactionDoc>): boolean {
  if (transaction.kindEditedAt || transaction.source === "MANUAL") return false;
  if (transaction.isSettlement || transaction.emiRole || transaction.loanId) return false;
  if (transaction.type === "CREDIT") {
    return (
      transaction.refundOf.length === 0 &&
      !transaction.isSalary &&
      !transaction.isEarmarked &&
      transaction.people.length === 0
    );
  }
  return true;
}

function recognise(
  transaction: HydratedDocument<TransactionDoc>,
  context: CardBillContext,
  confirmed = false
): CardBillMatch | null {
  const accountId = transaction.accountId?.toString() ?? null;
  return recogniseCardBill(
    {
      text: wordsOf(transaction),
      type: transaction.type,
      accountId,
      accountType: accountId ? (context.accountTypeOf.get(accountId) ?? null) : null,
      confirmed,
    },
    context.cards
  );
}

/** Marks one side of a bill payment, in memory. Returns whether it changed. */
async function applyMatch(transaction: HydratedDocument<TransactionDoc>, match: CardBillMatch): Promise<boolean> {
  if (transaction.type === "DEBIT" && match.cardId) {
    if (transaction.cardPaymentFor) return false;
    transaction.cardPaymentFor = new Types.ObjectId(match.cardId);
    return true;
  }

  // An unknown card, or the card side: a transfer whose other account is
  // not known yet. Pairing may name it shortly.
  if (transaction.isTransfer || transaction.cardPaymentFor) return false;
  transaction.isTransfer = true;
  transaction.transferAccountId = null;
  const transfers = await transferCategoryId();
  if (transfers) transaction.categoryId ??= transfers;
  return true;
}

/**
 * Pairs one side of a bill payment with the other, when both have been
 * seen. The candidate must itself read as the other side, and name the
 * same card where both name one - two bills of the same amount paid in
 * the same week are not rare, and pairing on the amount alone would mix
 * them up.
 */
async function pairSides(
  transaction: HydratedDocument<TransactionDoc>,
  match: CardBillMatch,
  context: CardBillContext
): Promise<void> {
  if (transaction.transferPairId) return;

  const isDebit = transaction.type === "DEBIT";
  const at = transaction.occurredAt.getTime();
  const candidates = await Transaction.find({
    userId: transaction.userId,
    _id: { $ne: transaction._id },
    type: isDebit ? "CREDIT" : "DEBIT",
    amountMinor: transaction.amountMinor,
    transferPairId: null,
    kindEditedAt: null,
    occurredAt: isDebit
      ? { $gte: new Date(at - CARD_POSTS_BEFORE_DAYS * DAY_MS), $lte: new Date(at + CARD_POSTS_AFTER_DAYS * DAY_MS) }
      : { $gte: new Date(at - CARD_POSTS_AFTER_DAYS * DAY_MS), $lte: new Date(at + CARD_POSTS_BEFORE_DAYS * DAY_MS) },
  });

  const ourCard = (isDebit ? transaction.cardPaymentFor?.toString() : undefined) ?? match.cardId;
  const paired = candidates
    .filter((candidate) => mayRecognise(candidate) || candidate.cardPaymentFor || candidate.isTransfer)
    .map((candidate) => {
      // A debit already linked to a card - by hand, or by a statement -
      // is a payment whatever its words say. One that only probably paid
      // a card (to CRED) is certain once the card says the same amount
      // arrived.
      const other: CardBillMatch | null =
        candidate.type === "DEBIT" && candidate.cardPaymentFor
          ? { side: "PAYMENT", cardId: candidate.cardPaymentFor.toString() }
          : recognise(candidate, context, !isDebit);
      const otherCard = (candidate.type === "DEBIT" ? candidate.cardPaymentFor?.toString() : undefined) ?? other?.cardId;
      return { candidate, other, otherCard };
    })
    .filter(({ candidate, other, otherCard }) => {
      if (!other || other.side === match.side) return false;
      if (ourCard && otherCard && ourCard !== otherCard) return false;
      // Already a transfer to somewhere else: someone else's pair.
      if (candidate.isTransfer && candidate.transferAccountId && !candidate.cardPaymentFor) return false;
      return true;
    })
    .sort(
      (a, b) => Math.abs(a.candidate.occurredAt.getTime() - at) - Math.abs(b.candidate.occurredAt.getTime() - at)
    )[0];
  if (!paired) return;

  const debit = isDebit ? transaction : paired.candidate;
  const credit = isDebit ? paired.candidate : transaction;
  const card = ourCard ?? paired.otherCard ?? null;

  // The debit side, marked if it was not yet - the CRED case - and given
  // its card if only the card side knew it.
  if (!debit.cardPaymentFor && card) debit.cardPaymentFor = new Types.ObjectId(card);
  if (!debit.cardPaymentFor && !debit.isTransfer) await applyMatch(debit, { side: "PAYMENT", cardId: null });
  // The other account of each leg - unless it is the leg's own, which
  // happens when the parser filed the bank's message under the card it
  // names. A transfer from a card to itself is no transfer to show.
  const other = (own: Types.ObjectId | null | undefined, there: Types.ObjectId | null | undefined) =>
    there && !(own && own.equals(there)) ? there : null;
  if (debit.isTransfer && !debit.transferAccountId) {
    debit.transferAccountId = other(debit.accountId, card ? new Types.ObjectId(card) : credit.accountId);
  }

  if (!credit.isTransfer) await applyMatch(credit, { side: "PAYMENT_RECEIVED", cardId: card });
  credit.transferAccountId = other(credit.accountId, debit.accountId);

  // Each leg points at the other, so neither balance moves twice.
  debit.transferPairId = credit._id;
  credit.transferPairId = debit._id;
  await Promise.all([debit.save(), credit.save()]);
}

/**
 * Recognises a card bill payment on one transaction, marks it, and pairs
 * it with the other side if that has been seen. Returns whether the
 * transaction is a card bill payment, so the caller can keep it away from
 * matchers that would claim it as something else.
 */
export async function markCardBillPayment(
  transaction: HydratedDocument<TransactionDoc>,
  context?: CardBillContext
): Promise<boolean> {
  if (!mayRecognise(transaction)) return false;

  const known = context ?? (await cardBillContext(transaction.userId));
  // Already a card bill, by hand or by a statement: only the pairing is
  // left to do.
  const match: CardBillMatch | null =
    transaction.type === "DEBIT" && transaction.cardPaymentFor
      ? { side: "PAYMENT", cardId: transaction.cardPaymentFor.toString() }
      : recognise(transaction, known);
  if (!match) return false;

  if (await applyMatch(transaction, match)) await transaction.save();
  await pairSides(transaction, match, known);
  return true;
}

/// Raised whenever the recogniser learns enough that rows it passed over
/// before deserve another look. Rows it already marked are left alone, so
/// a second run only ever finds what the first could not.
export const CARD_BILL_BACKFILL = "cardBills";
export const CARD_BILL_BACKFILL_VERSION = 1;

/**
 * Runs the recogniser over one user's existing transactions.
 *
 * Only rows still counted as spending or income are looked at: nothing
 * already a transfer or a card bill, and nothing a person has said the
 * kind of (kindEditedAt). Debits first, so each card-side credit finds the
 * bank-side payment it pairs with already marked.
 */
export async function backfillCardBills(userId: Types.ObjectId): Promise<{ payments: number; received: number }> {
  const context = await cardBillContext(userId);
  const unmarked = { userId, isTransfer: false, cardPaymentFor: null, kindEditedAt: null, source: { $ne: "MANUAL" } };

  // Which credits were unmarked before the debits are seen to, since a
  // debit pairs with its credit and marks it on the way.
  const credits = await Transaction.find({ ...unmarked, type: "CREDIT" }).sort({ occurredAt: 1 }).select("_id");

  let payments = 0;
  for await (const debit of Transaction.find({ ...unmarked, type: "DEBIT" }).sort({ occurredAt: 1 }).cursor()) {
    if (await markCardBillPayment(debit, context)) payments += 1;
  }

  let received = 0;
  for (const { _id } of credits) {
    const credit = await Transaction.findById(_id);
    if (!credit) continue;
    // Already paired by its debit above: done, and counted all the same.
    if (credit.isTransfer || (await markCardBillPayment(credit, context))) received += 1;
  }

  return { payments, received };
}

/**
 * The backfill, for every user it has not run for at this version (see
 * backfill.ts).
 *
 * Called once at server start and left to run in the background: it only
 * ever moves rows from counted to not counted, so a request served while
 * it runs sees a figure that is at worst the old one. Safe to run twice,
 * as runOncePerUser needs - a marked row is no longer looked at.
 */
export async function runCardBillBackfill(): Promise<{ users: number; changed: number }> {
  return runOncePerUser(CARD_BILL_BACKFILL, CARD_BILL_BACKFILL_VERSION, async (userId) => {
    const { payments, received } = await backfillCardBills(userId);
    return payments + received;
  });
}
