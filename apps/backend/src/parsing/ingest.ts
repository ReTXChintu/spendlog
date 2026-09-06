import { HydratedDocument, Types } from "mongoose";
import { Transaction, TransactionDoc } from "../models";
import { TransactionSource } from "../types";
import { resolveAccount } from "./accounts";
import { categorizeTransaction } from "./categorizer";
import { findDuplicate, detectSelfTransfer } from "./dedupe";
import { parseTransactionText } from "./parser";

export interface IngestResult {
  status: "created" | "duplicate" | "ignored";
  transaction: HydratedDocument<TransactionDoc> | null;
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
}): Promise<IngestResult> {
  const parsed = parseTransactionText(params.rawText);
  if (!parsed) {
    return { status: "ignored", transaction: null };
  }

  const occurredAt = parsed.occurredAt ?? params.receivedAt;
  const accountId = await resolveAccount(params.userId, parsed.account);

  const duplicate = await findDuplicate({
    userId: params.userId,
    amountMinor: parsed.amountMinor,
    type: parsed.type,
    accountId,
    occurredAt,
    sourceRef: params.sourceRef,
  });
  if (duplicate) {
    return { status: "duplicate", transaction: duplicate };
  }

  const categoryId = await categorizeTransaction({
    userId: params.userId,
    merchant: parsed.merchant,
    rawText: params.rawText,
  });

  const transaction = await Transaction.create({
    userId: params.userId,
    accountId,
    categoryId,
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    type: parsed.type,
    merchant: parsed.merchant,
    rawText: params.rawText,
    source: params.source,
    sourceRef: params.sourceRef,
    occurredAt,
  });

  await detectSelfTransfer(transaction);

  return { status: "created", transaction };
}
