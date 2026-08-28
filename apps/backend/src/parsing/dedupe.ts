import { Transaction } from "@prisma/client";
import { prisma } from "../db";
import { TransactionType } from "../types";

const DEDUPE_WINDOW_MINUTES = 20;

/**
 * The same real-world transaction often arrives twice — once as an SMS,
 * once as a bank email alert a few minutes later. Rather than an exact key,
 * we look for an existing transaction with the same amount/type/account for
 * this user within a short time window and treat that as the same event.
 */
export async function findDuplicate(params: {
  userId: string;
  amountMinor: number;
  type: TransactionType;
  accountId: string | null;
  occurredAt: Date;
  sourceRef: string | null;
}): Promise<Transaction | null> {
  if (params.sourceRef) {
    const bySourceRef = await prisma.transaction.findFirst({
      where: { userId: params.userId, sourceRef: params.sourceRef },
    });
    if (bySourceRef) return bySourceRef;
  }

  const windowMs = DEDUPE_WINDOW_MINUTES * 60 * 1000;
  const candidates = await prisma.transaction.findMany({
    where: {
      userId: params.userId,
      amountMinor: params.amountMinor,
      type: params.type,
      occurredAt: {
        gte: new Date(params.occurredAt.getTime() - windowMs),
        lte: new Date(params.occurredAt.getTime() + windowMs),
      },
    },
  });

  if (candidates.length === 0) return null;

  // Prefer a candidate on the same account when we know both; otherwise
  // any amount+type+time match within the window is treated as a dup.
  const sameAccount = candidates.find((c) => !params.accountId || !c.accountId || c.accountId === params.accountId);
  return sameAccount ?? candidates[0];
}

const TRANSFER_WINDOW_MINUTES = 10;

/**
 * After inserting a transaction, check whether it looks like a transfer
 * between two of the user's own accounts (same amount, opposite direction,
 * different account, close together in time) and flag both sides so they
 * don't inflate spend totals.
 */
export async function detectSelfTransfer(transaction: Transaction): Promise<void> {
  if (!transaction.accountId) return;

  const oppositeType: TransactionType = transaction.type === "DEBIT" ? "CREDIT" : "DEBIT";
  const windowMs = TRANSFER_WINDOW_MINUTES * 60 * 1000;

  const match = await prisma.transaction.findFirst({
    where: {
      userId: transaction.userId,
      amountMinor: transaction.amountMinor,
      type: oppositeType,
      accountId: { not: transaction.accountId },
      isTransfer: false,
      occurredAt: {
        gte: new Date(transaction.occurredAt.getTime() - windowMs),
        lte: new Date(transaction.occurredAt.getTime() + windowMs),
      },
    },
  });

  if (!match) return;

  await prisma.transaction.updateMany({
    where: { id: { in: [transaction.id, match.id] } },
    data: { isTransfer: true },
  });
}
