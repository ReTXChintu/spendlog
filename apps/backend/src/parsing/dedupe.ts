import { HydratedDocument, Types } from "mongoose";
import { Account, Transaction, TransactionDoc } from "../models";
import { TransactionType } from "../types";
import { transferCategoryId } from "../modules/categories/categories.system";
import { hasStatedTime } from "./moment";
import { ReferenceKind, TransactionReference, conflictingReferences } from "./reference";

const DEDUPE_WINDOW_MINUTES = 20;

/** Within the window of one another. */
function near(a: Date, b: Date, windowMs: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= windowMs;
}

/** When a row's first message arrived - its own time, for a row that has none. */
export function firstArrival(row: Pick<TransactionDoc, "sources" | "occurredAt">): Date {
  return row.sources?.[0]?.receivedAt ?? row.occurredAt;
}

/**
 * Two messages that both say when the money moved, to the minute, and say
 * times this far apart, are about two payments.
 */
const STATED_WINDOW_MS = 2 * 60 * 1000;

/** Every reference a row's messages quoted, and its own. */
export function referencesOf(row: Pick<TransactionDoc, "reference" | "referenceKind" | "sources">): TransactionReference[] {
  const found: TransactionReference[] = [];
  const add = (value?: string | null, kind?: ReferenceKind | null) => {
    if (value && kind && !found.some((ref) => ref.value === value && ref.kind === kind)) found.push({ kind, value });
  };
  add(row.reference, row.referenceKind);
  for (const entry of row.sources ?? []) add(entry.reference, entry.referenceKind);
  return found;
}

/**
 * The same real-world transaction often arrives twice — once as an SMS,
 * once as a bank email alert a few minutes later. Rather than an exact key,
 * we look for an existing transaction with the same amount/type/account for
 * this user within a short time window and treat that as the same event.
 *
 * The bank's reference settles it whenever both sides have one: the same
 * number is the same payment however far apart the messages came, and two
 * different numbers of one kind are two payments however alike everything
 * else is - two Rs 350 credits from one friend thirteen minutes apart.
 *
 * Without that, close in either of two senses. The times the messages say
 * the money moved, when both say one; or the times they arrived, when
 * either is silent about it - an SMS that states 1:39 AM and an email at
 * 5:16 that states nothing are still the one payment, which their arrivals
 * show. Two messages that each state a time, and different ones, are two
 * payments however close they arrived: a phone that was off delivers a
 * night's texts together. Of several that fit, the nearest.
 */
export async function findDuplicate(params: {
  userId: Types.ObjectId;
  amountMinor: number;
  type: TransactionType;
  accountId: Types.ObjectId | null;
  occurredAt: Date;
  sourceRef: string | null;
  /// When this message arrived. Left out, only the stated times are compared.
  receivedAt?: Date;
  /// The bank's reference this message quotes, if any.
  reference?: TransactionReference | null;
}): Promise<HydratedDocument<TransactionDoc> | null> {
  if (params.sourceRef) {
    const bySourceRef = await Transaction.findOne({
      userId: params.userId,
      sourceRef: params.sourceRef,
    });
    if (bySourceRef) return bySourceRef;
  }

  const reference = params.reference ?? null;
  if (reference) {
    // Same amount and direction too: a reversal quotes the payment it
    // undoes, and is not that payment.
    const byReference = await Transaction.findOne({
      userId: params.userId,
      amountMinor: params.amountMinor,
      type: params.type,
      offLedger: { $ne: true },
      $or: [{ reference: reference.value }, { "sources.reference": reference.value }],
    });
    if (byReference) return byReference;
  }

  const windowMs = DEDUPE_WINDOW_MINUTES * 60 * 1000;
  const around = (instant: Date) => ({
    $gte: new Date(instant.getTime() - windowMs),
    $lte: new Date(instant.getTime() + windowMs),
  });
  const receivedAt = params.receivedAt ?? params.occurredAt;
  const found = await Transaction.find({
    userId: params.userId,
    amountMinor: params.amountMinor,
    type: params.type,
    // A group payment somebody else made is never the same event as a
    // message about the user's own account, however alike the amounts.
    offLedger: { $ne: true },
    $or: [{ occurredAt: around(params.occurredAt) }, { "sources.receivedAt": around(receivedAt) }],
  });

  const stated = hasStatedTime(params.occurredAt, receivedAt);
  const candidates = found.filter((candidate) => {
    if (reference && referencesOf(candidate).some((theirs) => conflictingReferences(reference, theirs))) return false;

    const candidateStated = hasStatedTime(candidate.occurredAt, firstArrival(candidate));
    // Both say when it happened: they have to agree.
    if (stated && candidateStated) return near(candidate.occurredAt, params.occurredAt, STATED_WINDOW_MS);
    if (near(candidate.occurredAt, params.occurredAt, windowMs)) return true;
    // Close only in when they arrived, which means something only for a
    // row a message reported: a payment typed in by hand "arrived" when it
    // was typed, whatever day it was for.
    return candidate.sources.some((entry) => entry.source === "SMS" || entry.source === "EMAIL");
  });

  if (candidates.length === 0) return null;

  // Prefer a candidate on the same account when we know both, then the
  // nearest: in when the money moved, or in when its messages arrived.
  const distance = (candidate: HydratedDocument<TransactionDoc>) =>
    Math.min(
      Math.abs(candidate.occurredAt.getTime() - params.occurredAt.getTime()),
      ...candidate.sources.map((entry) => Math.abs(new Date(entry.receivedAt).getTime() - receivedAt.getTime()))
    );
  const sameAccount = await onSameAccount(params.accountId, candidates);
  const pool = sameAccount.length > 0 ? sameAccount : candidates;
  return pool.reduce((best, candidate) => (distance(candidate) < distance(best) ? candidate : best));
}

/**
 * The candidates that could be on the account this message names: that
 * account, no account, or an account of the same bank where one of the two
 * has no number. A bank's email often names the bank without the number
 * ("your HDFC Bank account") while its SMS gives "A/c XX8342", and the two
 * land on two accounts that are really one.
 */
async function onSameAccount(
  accountId: Types.ObjectId | null,
  candidates: HydratedDocument<TransactionDoc>[]
): Promise<HydratedDocument<TransactionDoc>[]> {
  if (!accountId) return candidates;
  const others = candidates.filter((c) => c.accountId && !c.accountId.equals(accountId)).map((c) => c.accountId!);
  const accounts = others.length
    ? await Account.find({ _id: { $in: [accountId, ...others] } }).select("bankName last4 accountType").lean()
    : [];
  const byId = new Map(accounts.map((account) => [String(account._id), account]));
  const mine = byId.get(String(accountId));

  return candidates.filter((c) => {
    if (!c.accountId || c.accountId.equals(accountId)) return true;
    const theirs = byId.get(String(c.accountId));
    return Boolean(
      mine && theirs && mine.bankName === theirs.bankName && mine.accountType === theirs.accountType && (!mine.last4 || !theirs.last4)
    );
  });
}

const TRANSFER_WINDOW_MINUTES = 10;

/**
 * After inserting a transaction, check whether it looks like a transfer
 * between two of the user's own accounts (same amount, opposite direction,
 * different account, close together in time) and flag both sides so they
 * don't inflate spend totals.
 */
export async function detectSelfTransfer(transaction: HydratedDocument<TransactionDoc>): Promise<void> {
  if (!transaction.accountId) return;

  const oppositeType: TransactionType = transaction.type === "DEBIT" ? "CREDIT" : "DEBIT";
  const windowMs = TRANSFER_WINDOW_MINUTES * 60 * 1000;
  const around = (instant: Date) => ({
    $gte: new Date(instant.getTime() - windowMs),
    $lte: new Date(instant.getTime() + windowMs),
  });

  // Close in the times the two banks say the money moved, or - when either
  // says nothing - in when their messages arrived, the same rule as
  // findDuplicate: two banks rarely text with the same delay.
  const arrived = firstArrival(transaction);
  const stated = hasStatedTime(transaction.occurredAt, arrived);
  const candidates = await Transaction.find({
    userId: transaction.userId,
    amountMinor: transaction.amountMinor,
    type: oppositeType,
    // Must be a different, *known* account — a transaction with no account
    // attached isn't evidence of a transfer, and flagging one would hide
    // real spend from the totals.
    accountId: { $nin: [transaction.accountId, null] },
    isTransfer: false,
    $or: [{ occurredAt: around(transaction.occurredAt) }, { "sources.receivedAt": around(arrived) }],
  }).sort({ _id: 1 });
  const match = candidates.find(
    (candidate) =>
      near(candidate.occurredAt, transaction.occurredAt, windowMs) ||
      (candidate.sources.some((entry) => entry.source === "SMS" || entry.source === "EMAIL") &&
        !(stated && hasStatedTime(candidate.occurredAt, firstArrival(candidate))))
  );

  if (!match) return;

  // Saved rather than updateMany'd so the counted-amount hook runs on both
  // sides: a transfer counts as zero, and deriving that here instead would
  // put the rule in two places.
  transaction.isTransfer = true;
  match.isTransfer = true;
  // Each leg knows the other account, and that the other account has a row
  // of its own - so a balance never moves twice for the one transfer.
  transaction.transferAccountId = match.accountId;
  match.transferAccountId = transaction.accountId;
  transaction.transferPairId = match._id;
  match.transferPairId = transaction._id;
  const transfers = await transferCategoryId();
  if (transfers) {
    transaction.categoryId ??= transfers;
    match.categoryId ??= transfers;
  }
  await Promise.all([transaction.save(), match.save()]);
}
