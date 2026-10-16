import { HydratedDocument, Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Transaction, TransactionDoc } from "../../models";
import { accountLabel } from "../accounts/accounts.drift";
import { transferCategoryId } from "../categories/categories.system";
import {
  AccountRow,
  Accounts,
  accountsOf,
  ensureTransferLegs,
  isUnconfirmedLegOf,
  ownerOf,
  resultOf,
  sameId,
  TransferLegResult,
} from "../transactions/transactions.transfer";
import { CARD_POSTS_AFTER_DAYS, CARD_POSTS_BEFORE_DAYS, mayBeCardPayment, recogniseCardBill } from "./cards.billPayment";

/**
 * Every card bill payment, as two real rows: the bank's debit, and the
 * money arriving on the card.
 *
 * A bill paid from the bank used to be allowed one row. The debit, marked
 * as paying the card (cardPaymentFor), counted nothing and settled the
 * bill, which kept the totals right and nothing else: the card's own list
 * never showed the payment landing, and its statement listed a payment
 * the app did not have. So a card bill that has no card side is given one
 * (ensureCardBillLeg), the way a transfer is given its other leg
 * (transactions.transfer.ts), and with the same helpers:
 *
 *   - the card side, already here: a credit on that card, the same
 *     amount, from a day before the debit to four days after it (when an
 *     issuer posts a payment), nobody's leg yet, and not money coming
 *     back - a refund, a reversal, cashback. One whose words say "payment
 *     received" is taken over one that only says "credited", then the
 *     closest in time;
 *   - otherwise, written in: the same amount at the same moment on the
 *     card, "Payment from Federal Bank ••5130", marked autoLeg so the
 *     card's own message adopts it if it turns up after all (findAutoLeg).
 *
 * Both are transfers in, paired with the debit (transferPairId), so they
 * count nothing (TRANSFER) - the same shape the card's "payment received"
 * has always had once pairSides matched it.
 *
 * What a card is owed is unchanged by any of it. paidTowards counts every
 * bank debit marked for the card, plus a card-side payment only while it
 * has no debit beside it; a side paired here, or written in, is the
 * debit's own money and is not counted again.
 *
 * A written-in side nobody has confirmed follows its debit: a new amount
 * or day moves it, a different card replaces it, and un-marking or
 * deleting the debit takes it away (syncCardBillLeg, releaseLegs). Once a
 * message, a statement or a person has vouched for it, it is only ever
 * unpaired.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Payment from Federal Bank ••5130" - what the card's own list says it was. */
export function cardLegMerchant(from: AccountRow | null): string {
  return from ? `Payment from ${accountLabel(from)}` : "Card bill payment";
}

function isCardBill(row: Pick<TransactionDoc, "type" | "cardPaymentFor">): boolean {
  return row.type === "DEBIT" && Boolean(row.cardPaymentFor);
}

/** Everything that was said about a row, as one piece of text. */
function wordsOf(row: Pick<TransactionDoc, "rawText" | "merchant" | "sources">): string {
  const texts = [row.rawText, ...row.sources.map((entry) => entry.rawText), row.merchant];
  return [...new Set(texts.filter((text): text is string => Boolean(text)))].join(" \n ");
}

function cardResult(
  action: TransferLegResult["action"],
  leg: HydratedDocument<TransactionDoc>,
  card: AccountRow
): TransferLegResult {
  return { ...resultOf(action, leg, card), kind: "CARD_BILL" };
}

/**
 * Gives a card bill payment its card side, by pairing it with the credit
 * already on the card or by writing one in. Does nothing - and returns
 * null - for a row that is not a bank debit marked for a card, already has
 * its other side, or whose written-in side was deleted by hand
 * (legDeclined). Nor for a debit filed under the card it paid: that is the
 * parser mistaking the card for the account, and a payment from a card to
 * itself is nothing to show.
 *
 * Writes both rows with save(), so the counted-amount hook zeroes them.
 */
export async function ensureCardBillLeg(
  debit: HydratedDocument<TransactionDoc>,
  known?: Accounts
): Promise<TransferLegResult | null> {
  if (!isCardBill(debit) || debit.transferPairId || debit.legDeclined) return null;

  const accounts = known ?? (await accountsOf(debit.userId));
  const card = accounts.get(debit.cardPaymentFor!.toString());
  if (!card || card.accountType !== "CARD") return null;
  if (debit.accountId?.equals(card._id) || sameId(ownerOf(debit.accountId, accounts)?._id, card._id)) return null;

  const transfers = await transferCategoryId();
  const existing = await findCardSide(debit, card, accounts);

  if (existing) {
    existing.isTransfer = true;
    existing.transferAccountId = debit.accountId ?? null;
    existing.transferPairId = debit._id;
    if (transfers) existing.categoryId ??= transfers;
    debit.transferPairId = existing._id;
    await Promise.all([existing.save(), debit.save()]);
    return cardResult("paired", existing, card);
  }

  const leg = await Transaction.create({
    userId: debit.userId,
    accountId: card._id,
    type: "CREDIT",
    amountMinor: debit.amountMinor,
    currency: debit.currency,
    occurredAt: debit.occurredAt,
    merchant: cardLegMerchant(ownerOf(debit.accountId, accounts)),
    categoryId: transfers,
    isTransfer: true,
    transferAccountId: debit.accountId ?? null,
    transferPairId: debit._id,
    source: "MANUAL",
    autoLeg: true,
    autoLegOf: debit._id,
  });
  debit.transferPairId = leg._id;
  await debit.save();
  return cardResult("created", leg, card);
}

/**
 * The credit already on the card that is this payment's card side, if
 * there is one. See ensureCardBillLeg for what qualifies.
 */
async function findCardSide(
  debit: HydratedDocument<TransactionDoc>,
  card: AccountRow,
  accounts: Accounts
): Promise<HydratedDocument<TransactionDoc> | null> {
  const at = debit.occurredAt.getTime();
  const candidates = await Transaction.find({
    userId: debit.userId,
    _id: { $ne: debit._id },
    type: "CREDIT",
    accountId: card._id,
    amountMinor: debit.amountMinor,
    occurredAt: {
      $gte: new Date(at - CARD_POSTS_BEFORE_DAYS * DAY_MS),
      $lte: new Date(at + CARD_POSTS_AFTER_DAYS * DAY_MS),
    },
    transferPairId: null,
    // Something else entirely, whatever its amount.
    cardPaymentFor: null,
    emiRole: null,
    loanId: null,
    isSalary: { $ne: true },
    isSettlement: { $ne: true },
    isEarmarked: { $ne: true },
    isAdjustment: { $ne: true },
    "refundOf.0": { $exists: false },
    "people.0": { $exists: false },
  });

  const bank = ownerOf(debit.accountId, accounts);
  const fitting = candidates
    .filter((candidate) => {
      // A person said what this is, and it is not a payment arriving.
      if (candidate.kindEditedAt && !candidate.isTransfer) return false;
      // A transfer in from some other account is that transfer's.
      if (candidate.isTransfer && candidate.transferAccountId && bank) {
        if (!sameId(ownerOf(candidate.transferAccountId, accounts)?._id, bank._id)) return false;
      }
      return mayBeCardPayment(wordsOf(candidate));
    })
    .map((candidate) => ({
      candidate,
      says: recogniseCardBill({ text: wordsOf(candidate), type: "CREDIT", accountType: "CARD" }, [])?.side === "PAYMENT_RECEIVED",
    }));

  // One that says it is a payment over one that only says money arrived;
  // then the closest in time.
  const distance = (row: HydratedDocument<TransactionDoc>) => Math.abs(row.occurredAt.getTime() - at);
  fitting.sort((a, b) => Number(b.says) - Number(a.says) || distance(a.candidate) - distance(b.candidate));
  return fitting[0]?.candidate ?? null;
}

/** The card-bill fields of a row as they were before an edit. */
export type CardBillSnapshot = Pick<
  TransactionDoc,
  "type" | "amountMinor" | "occurredAt" | "accountId" | "cardPaymentFor" | "isTransfer" | "transferPairId"
>;

/**
 * Keeps a card bill's card side in step after either row was edited, the
 * way syncTransferLegs does for a transfer. Says whether the edit was a
 * card bill's to handle (`handled`); when it was not, the caller hands it
 * to syncTransferLegs as usual.
 *
 * On the debit:
 *   - no longer a card bill, or marked for a different card: a written-in
 *     side is deleted, a confirmed one is unpaired. Then the new card gets
 *     its side - or, no longer a bill, the row its transfer legs;
 *   - otherwise a written-in side takes the new amount, day and paying
 *     account. A confirmed one only learns the paying account.
 *
 * On the card's side: it stays paired while it is still money in on that
 * card as a transfer; made anything else, both are unpaired.
 */
export async function syncCardBillLeg(
  row: HydratedDocument<TransactionDoc>,
  before: CardBillSnapshot
): Promise<{ handled: boolean; leg: TransferLegResult | null }> {
  const wasBill = isCardBill(before);
  const isBill = isCardBill(row);
  const partner = before.transferPairId
    ? await Transaction.findOne({ _id: before.transferPairId, userId: row.userId })
    : null;
  const ours = Boolean(partner?.transferPairId?.equals(row._id));

  if (!wasBill && !isBill) {
    if (!partner || !ours || !isCardBill(partner)) return { handled: false, leg: null };
    const stillPaid =
      row.type === "CREDIT" && row.isTransfer && sameId(row.accountId, partner.cardPaymentFor);
    if (!stillPaid) {
      partner.transferPairId = null;
      row.transferPairId = null;
      await Promise.all([partner.save(), row.save()]);
    }
    return { handled: true, leg: null };
  }

  const sameCard = wasBill && isBill && sameId(row.cardPaymentFor, before.cardPaymentFor);
  // Something new was said about which card, so a side deleted for the
  // old answer is no reason to leave the new one without.
  if (!sameCard) row.legDeclined = false;
  if (before.transferPairId && !partner) row.transferPairId = null;

  if (partner) {
    const unconfirmed = isUnconfirmedLegOf(partner, row);
    if (!sameCard) {
      if (unconfirmed) {
        await partner.deleteOne();
      } else if (ours) {
        partner.transferPairId = null;
        partner.transferAccountId = null;
        await partner.save();
      }
      row.transferPairId = null;
    } else if (unconfirmed) {
      const accounts = await accountsOf(row.userId);
      partner.amountMinor = row.amountMinor;
      partner.occurredAt = row.occurredAt;
      partner.transferAccountId = row.accountId ?? null;
      partner.merchant = cardLegMerchant(ownerOf(row.accountId, accounts));
      await partner.save();
    } else if (ours && row.accountId && !sameId(partner.transferAccountId, row.accountId)) {
      partner.transferAccountId = row.accountId;
      await partner.save();
    }
  }

  if (row.isModified()) await row.save();
  if (isBill) return { handled: true, leg: await ensureCardBillLeg(row) };
  // No longer a card bill: whatever it is now - a transfer, say - gets
  // its other leg the usual way.
  return { handled: true, leg: await ensureTransferLegs(row) };
}

/// Raised when the rule for giving a card bill its card side changes.
export const CARD_BILL_LEG_BACKFILL = "cardBillLegs";
export const CARD_BILL_LEG_BACKFILL_VERSION = 1;

/**
 * Gives every card bill payment of a user's its card side: each bank
 * debit marked for a card that has no pair. Oldest first, each row read
 * fresh. Safe to run twice: a paired row is not looked at again, and one
 * that cannot be given a side (a card that is gone, a debit filed under
 * the card itself) is left exactly as it was.
 *
 * What the card is owed does not move: the debit was already counted as
 * the payment, and the side given to it is not counted beside it.
 */
export async function backfillCardBillLegs(userId: Types.ObjectId): Promise<{ paired: number; created: number }> {
  const accounts = await accountsOf(userId);
  const ids = await Transaction.find({
    userId,
    type: "DEBIT",
    cardPaymentFor: { $ne: null },
    transferPairId: null,
    legDeclined: { $ne: true },
  })
    .sort({ occurredAt: 1 })
    .select("_id");

  let paired = 0;
  let created = 0;
  for (const { _id } of ids) {
    const row = await Transaction.findById(_id);
    if (!row) continue;
    const result = await ensureCardBillLeg(row, accounts);
    if (result?.action === "paired") paired += 1;
    if (result?.action === "created") created += 1;
  }
  return { paired, created };
}

/** The backfill above, for every user it has not run for (see backfill.ts). */
export async function runCardBillLegBackfill(): Promise<{
  users: number;
  changed: number;
  paired: number;
  created: number;
}> {
  let paired = 0;
  let created = 0;
  const result = await runOncePerUser(CARD_BILL_LEG_BACKFILL, CARD_BILL_LEG_BACKFILL_VERSION, async (userId) => {
    const counts = await backfillCardBillLegs(userId);
    paired += counts.paired;
    created += counts.created;
    return counts.paired + counts.created;
  });
  if (result.users > 0) {
    console.log(`Card bill legs: ${paired} paired, ${created} written in, across ${result.users} user(s).`);
  }
  return { ...result, paired, created };
}
