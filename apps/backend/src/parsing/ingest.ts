import { HydratedDocument, Types } from "mongoose";
import { Transaction, TransactionDoc, TransactionSourceEntry } from "../models";
import { AccountType, TransactionSource } from "../types";
import { resolveAccount } from "./accounts";
import { categorizeTransaction } from "./categorizer";
import { matchEmiInstalment } from "../modules/emi/emi.matching";
import { matchLoanInstalment } from "../modules/loans/loans.matching";
import { groupForOccurredAt, syncGroupSplit } from "../modules/groups/groups.service";
import { findDuplicate, detectSelfTransfer } from "./dedupe";
import { parseStatedFigures } from "./balance";
import { parseTransactionText } from "./parser";
import { statedMoment } from "./moment";
import { transactionReference } from "./reference";
import { horizonFor } from "../modules/ledger/ledger.horizon";
import {
  cardBillAccount,
  cardBillContext,
  findPaymentTwin,
  markCardBillPayment,
} from "../modules/cards/cards.billPayment.service";
import { mayBeCardPayment, recogniseCardBill } from "../modules/cards/cards.billPayment";
import { detectAfterStatedBalance } from "../modules/accounts/accounts.missingCredits";
import { reconcileUser } from "../modules/subscriptions/subscriptions.service";
import { linkSharedCommitment } from "../modules/budget/budget.commitmentShares";
import { linkMetalPurchase } from "../modules/metals/metals.holdings";
import {
  adoptAutoLeg,
  couldBeSameAccount,
  ensureTransferLegs,
  findAutoLeg,
} from "../modules/transactions/transactions.transfer";

export interface IngestResult {
  status: "created" | "duplicate" | "ignored";
  transaction: HydratedDocument<TransactionDoc> | null;
}

/** Whether two source entries describe the same message. */
function isSameMessage(
  a: { source: string; sourceRef?: string | null; receivedAt: Date },
  b: { source: string; sourceRef?: string | null; receivedAt: Date }
): boolean {
  if (a.sourceRef && b.sourceRef) return a.sourceRef === b.sourceRef;
  return a.source === b.source && a.receivedAt.getTime() === b.receivedAt.getTime();
}

/**
 * The bank's figures a message states, sorted by what they are about. A
 * balance is a bank account's; on a card the same words would mean what
 * is owed, so it is not kept there. What is left of a limit is a card's,
 * and nothing else has one.
 */
export function statedFiguresFor(
  rawText: string,
  accountType: AccountType | null
): { balanceMinor: number | null; availableLimitMinor: number | null } {
  const figures = parseStatedFigures(rawText);
  const onCard = accountType === "CARD";
  return {
    balanceMinor: onCard ? null : figures.balanceMinor,
    availableLimitMinor: onCard ? figures.availableLimitMinor : null,
  };
}

/**
 * Single entry point for turning a raw SMS or email snippet into a stored,
 * categorized transaction. Used by both the SMS ingestion endpoint (mobile
 * posts messages here) and the Gmail sync job.
 */
export async function ingestRawMessage(params: {
  userId: Types.ObjectId;
  rawText: string;
  source: TransactionSource;
  sourceRef: string | null;
  receivedAt: Date;
  /// The whole message as a person reads it, when rawText is only part of
  /// it: an HTML-only email stores Gmail's short preview, and the bank's
  /// reference is further down. Read for the reference, never stored.
  detailText?: string | null;
}): Promise<IngestResult> {
  const parsed = parseTransactionText(params.rawText);
  if (!parsed) {
    return { status: "ignored", transaction: null };
  }

  // When the text says when the money moved, that wins over when the
  // message happened to arrive: an SMS can come hours late. See moment.ts.
  const occurredAt = parsed.occurredAt ?? statedMoment(params.rawText, params.receivedAt) ?? params.receivedAt;

  // Older than this ledger goes back. A mailbox holds months of alerts and
  // a phone holds years, and importing them would fill the app with a
  // period nobody meant to track. Ignored rather than stored-and-hidden:
  // a row that exists but is never shown is a row that turns up in a total
  // one day.
  const horizon = await horizonFor(params.userId);
  if (!horizon || occurredAt < horizon) {
    return { status: "ignored", transaction: null };
  }

  // A card bill payment names two accounts, and the parser alone files it
  // under the wrong one: the bank's debit under the card it paid, the
  // card's "payment received" under a bank account. See cardBillAccount.
  const context = await cardBillContext(params.userId);
  const billAccount = await cardBillAccount(params.userId, params.rawText, parsed, context);
  const accountId = billAccount ? billAccount.accountId : await resolveAccount(params.userId, parsed.account);

  // What the bank said was left, off the original text - the parser
  // strips it before it looks for the amount. A balance belongs to a
  // bank account; a card's message says what is left of its limit, and
  // the one is never the other.
  // The context was read before resolveAccount may have created the
  // account, so a first message from a new card falls back to the parse.
  const accountType = accountId
    ? (context.accountTypeOf.get(accountId.toString()) ?? parsed.account?.accountType ?? null)
    : null;
  const stated = statedFiguresFor(params.rawText, accountType);

  // The bank's number for this payment, which is what tells it from
  // another of the same amount minutes away. See reference.ts.
  const reference = transactionReference(params.rawText) ?? transactionReference(params.detailText);
  const entry = {
    source: params.source,
    sourceRef: params.sourceRef,
    rawText: params.rawText,
    receivedAt: params.receivedAt,
    reference: reference?.value ?? null,
    referenceKind: reference?.kind ?? null,
  };
  const found = { userId: params.userId, amountMinor: parsed.amountMinor, type: parsed.type, accountId, occurredAt };

  let duplicate = await findDuplicate({
    ...found,
    sourceRef: params.sourceRef,
    receivedAt: params.receivedAt,
    reference,
  });
  // A leg SpendLog wrote in is not a message, so the time window alone
  // does not make it this one: only on the account this message names.
  if (duplicate?.autoLeg && !(await couldBeSameAccount(params.userId, duplicate.accountId, accountId))) {
    duplicate = null;
  }
  // Nor is a refund landing on a card the card's side of a bill payment,
  // however close its amount and time.
  if (
    duplicate?.autoLeg &&
    duplicate.accountId &&
    context.accountTypeOf.get(duplicate.accountId.toString()) === "CARD" &&
    !mayBeCardPayment(params.rawText)
  ) {
    duplicate = null;
  }

  // The other account's side of a transfer, or a card's side of a bill
  // payment, written in because nobody texted it - until now. The message
  // becomes that row rather than a second one beside it, and the pairing
  // stays.
  const autoLeg = duplicate
    ? duplicate.autoLeg
      ? duplicate
      : null
    : await findAutoLeg({ ...found, rawText: params.rawText });
  if (autoLeg) {
    await absorbMessage(autoLeg, { userId: params.userId, entry, parsed, accountId, stated }, () =>
      adoptAutoLeg(autoLeg, occurredAt)
    );
    if (stated.balanceMinor !== null) await detectAfterStatedBalance(autoLeg);
    return { status: "duplicate", transaction: autoLeg };
  }

  if (duplicate) {
    // The second message is kept rather than thrown away. It is evidence
    // the transaction really happened, it is what lets the row show it was
    // seen twice, and a bank email routinely names the merchant better
    // than the SMS that arrived first.
    const added = await absorbMessage(duplicate, { userId: params.userId, entry, parsed, accountId, stated });

    // The second message may be the one that says what this was: a
    // bank's email often names the card a bill went to where its SMS
    // gave only an amount.
    if (added && !duplicate.editedAt) await markCardBillPayment(duplicate);
    // A balance the first message lacked is a new figure to measure from.
    if (added && stated.balanceMinor !== null) await detectAfterStatedBalance(duplicate);

    return { status: "duplicate", transaction: duplicate };
  }

  // A card's issuer saying a payment arrived a second time, hours later
  // and in other words (see findPaymentTwin). Only for a message that is
  // itself a card's "payment received": two ordinary credits of the same
  // amount on a card are two credits.
  const twin =
    parsed.type === "CREDIT" &&
    accountId &&
    accountType === "CARD" &&
    recogniseCardBill({ text: params.rawText, type: "CREDIT", accountId: accountId.toString(), accountType }, context.cards)
      ?.side === "PAYMENT_RECEIVED"
      ? await findPaymentTwin({ userId: params.userId, cardId: accountId, amountMinor: parsed.amountMinor, occurredAt })
      : null;
  if (twin) {
    // A written-in side finding its first message is adopted by it, the
    // way findAutoLeg's are; anything else just gains a source.
    const written = twin.autoLeg;
    await absorbMessage(twin, { userId: params.userId, entry, parsed, accountId, stated }, () => {
      if (written) adoptAutoLeg(twin, occurredAt);
    });
    return { status: "duplicate", transaction: twin };
  }

  const categoryId = await categorizeTransaction({
    userId: params.userId,
    merchant: parsed.merchant,
    rawText: params.rawText,
  });

  // Only a group linked from Trippin takes a payment in by itself, by
  // when the money moved rather than when the message arrived, so a late
  // SMS still lands on the right trip. Every other group is picked by hand.
  const groupId = await groupForOccurredAt(params.userId, occurredAt);

  const transaction = await Transaction.create({
    userId: params.userId,
    accountId,
    categoryId,
    groupId,
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    type: parsed.type,
    merchant: parsed.merchant,
    rawText: params.rawText,
    source: params.source,
    sourceRef: params.sourceRef,
    reference: entry.reference,
    referenceKind: entry.referenceKind,
    occurredAt,
    statedBalanceMinor: stated.balanceMinor,
    statedAvailableLimitMinor: stated.availableLimitMinor,
    // No account could be placed: not cash, just not known. A payment
    // typed in by hand with no account is cash; one a bank sent a message
    // about never is, and guessing cash is how the cash balance drifts.
    accountUnknown: accountId === null,
    sources: [entry],
  });

  // A contact in the group it went into has a share of it.
  if (groupId) await syncGroupSplit(transaction);
  await detectSelfTransfer(transaction);
  // A card bill paid from the bank is the month's card purchases leaving
  // a second time, and the card's "payment received" is that same money
  // arriving. Neither is spending or income. See cards.billPayment.ts.
  const isCardBill = await markCardBillPayment(transaction);
  if (!isCardBill) {
    // A monthly EMI debit looks like any other payment, so the schedule is
    // ticked off here rather than waiting for someone to do it by hand.
    // Not a card bill, though, however close its amount: a bill that
    // happened to match an instalment would claim it and leave the real
    // instalment looking unpaid.
    await matchEmiInstalment(transaction);
    // Same reasoning, for a loan taken outside a card.
    await matchLoanInstalment(transaction);
  }
  // detectSelfTransfer pairs both legs it finds, and a card bill is paired
  // by its own rules, so this has nothing to do today. Called all the same:
  // any transfer that leaves ingest naming another account has both legs.
  await ensureTransferLegs(transaction);
  // A balance stated: the gaps either side of it may be money that came
  // in without a message (accounts.missingCredits).
  await detectAfterStatedBalance(transaction);
  // The month's payment for a fixed cost others pay the user back for -
  // rent, say: linked to it and split, so only the user's part counts and
  // each flatmate's is owed. Only on a payee and amount that match exactly.
  if (!isCardBill && transaction.type === "DEBIT") {
    await linkSharedCommitment(transaction).catch((error) => console.error("Shared fixed cost matching failed:", error));
  }
  // Gold or silver bought from a holding's payee: its grams worked out
  // from the day's rate.
  if (!isCardBill && transaction.type === "DEBIT") {
    await linkMetalPurchase(transaction).catch((error) => console.error("Gold purchase matching failed:", error));
  }
  // A subscription's renewal, if that is what this was: matched now, so
  // the screen does not wait for the next time it is opened.
  if (transaction.type === "DEBIT") {
    await reconcileUser(params.userId).catch((error) => console.error("Subscription matching failed:", error));
  }

  return { status: "created", transaction };
}

/**
 * Adds a message to a row that already stands for the same money: a
 * second report of a payment, or the bank's own message for a leg
 * SpendLog wrote in. Returns false when the row already had this message.
 *
 * `beforeSave` is for what a particular caller changes on top, in the
 * same write.
 */
async function absorbMessage(
  row: HydratedDocument<TransactionDoc>,
  message: {
    userId: Types.ObjectId;
    entry: TransactionSourceEntry;
    parsed: { merchant: string | null };
    accountId: Types.ObjectId | null;
    stated: { balanceMinor: number | null; availableLimitMinor: number | null };
  },
  beforeSave?: () => void
): Promise<boolean> {
  const { entry, parsed, accountId, stated } = message;
  if (row.sources.some((existing) => isSameMessage(existing, entry))) return false;
  row.sources.push(entry);
  // The first reference any of its messages quoted is the row's.
  if (!row.reference && entry.reference) {
    row.reference = entry.reference;
    row.referenceKind = entry.referenceKind ?? null;
  }

  // Only ever fills gaps, and only while nobody has corrected the row by
  // hand. A person's answer outranks a second parse of the same event,
  // and a value already parsed is not necessarily worse than the one
  // arriving now.
  if (!row.editedAt) {
    if (!row.merchant && parsed.merchant) row.merchant = parsed.merchant;
    if (!row.accountId && accountId) {
      row.accountId = accountId;
      // The second message said which account; nobody is guessing now.
      row.accountUnknown = false;
    }
    if (!row.categoryId) {
      row.categoryId = await categorizeTransaction({
        userId: message.userId,
        merchant: row.merchant ?? null,
        rawText: entry.rawText ?? "",
      });
    }
  }

  // The bank's figure is not something a person edits, so it fills in
  // whenever a message carries it: an SMS often says the balance where the
  // email for the same payment does not, and the other way round.
  if (row.statedBalanceMinor == null && stated.balanceMinor !== null) {
    row.statedBalanceMinor = stated.balanceMinor;
  }
  if (row.statedAvailableLimitMinor == null && stated.availableLimitMinor !== null) {
    row.statedAvailableLimitMinor = stated.availableLimitMinor;
  }

  beforeSave?.();
  await row.save();
  return true;
}
