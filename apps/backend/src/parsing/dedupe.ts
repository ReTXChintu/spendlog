import { HydratedDocument, Types } from "mongoose";
import { Transaction, TransactionDoc } from "../models";
import { TransactionType } from "../types";

const DEDUPE_WINDOW_MINUTES = 20;

/**
 * The same real-world transaction often arrives twice — once as an SMS,
 * once as a bank email alert a few minutes later. Rather than an exact key,
 * we look for an existing transaction with the same amount/type/account for
 * this user within a short time window and treat that as the same event.
 */
export async function findDuplicate(params: {
  userId: Types.ObjectId;
  amountMinor: number;
  type: TransactionType;
  accountId: Types.ObjectId | null;
  occurredAt: Date;
  sourceRef: string | null;
}): Promise<HydratedDocument<TransactionDoc> | null> {
  if (params.sourceRef) {
    const bySourceRef = await Transaction.findOne({
      userId: params.userId,
      sourceRef: params.sourceRef,
    });
    if (bySourceRef) return bySourceRef;
  }

  const windowMs = DEDUPE_WINDOW_MINUTES * 60 * 1000;
  const candidates = await Transaction.find({
    userId: params.userId,
    amountMinor: params.amountMinor,
    type: params.type,
    occurredAt: {
      $gte: new Date(params.occurredAt.getTime() - windowMs),
      $lte: new Date(params.occurredAt.getTime() + windowMs),
    },
  });

  if (candidates.length === 0) return null;

  // Prefer a candidate on the same account when we know both; otherwise
  // any amount+type+time match within the window is treated as a dup.
  const sameAccount = candidates.find(
    (c) => !params.accountId || !c.accountId || c.accountId.equals(params.accountId)
  );
  return sameAccount ?? candidates[0];
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

  const match = await Transaction.findOne({
    userId: transaction.userId,
    amountMinor: transaction.amountMinor,
    type: oppositeType,
    // Must be a different, *known* account — a transaction with no account
    // attached isn't evidence of a transfer, and flagging one would hide
    // real spend from the totals.
    accountId: { $nin: [transaction.accountId, null] },
    isTransfer: false,
    occurredAt: {
      $gte: new Date(transaction.occurredAt.getTime() - windowMs),
      $lte: new Date(transaction.occurredAt.getTime() + windowMs),
    },
  });

  if (!match) return;

  await Transaction.updateMany({ _id: { $in: [transaction._id, match._id] } }, { $set: { isTransfer: true } });
}
