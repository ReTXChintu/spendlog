import { HydratedDocument, Types } from "mongoose";
import { Transaction, TransactionDoc } from "../models";
import { TransactionSource } from "../types";
import { resolveAccount } from "./accounts";
import { categorizeTransaction } from "./categorizer";
import { matchEmiInstalment } from "../modules/emi/emi.matching";
import { tripForOccurredAt } from "../modules/trips/trips.service";
import { findDuplicate, detectSelfTransfer } from "./dedupe";
import { parseTransactionText } from "./parser";

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
    // The second message is kept rather than thrown away. It is evidence
    // the transaction really happened, it is what lets the row show it was
    // seen twice, and a bank email routinely names the merchant better
    // than the SMS that arrived first.
    const entry = {
      source: params.source,
      sourceRef: params.sourceRef,
      rawText: params.rawText,
      receivedAt: params.receivedAt,
    };

    const alreadyKnown = duplicate.sources.some((existing) => isSameMessage(existing, entry));
    if (!alreadyKnown) {
      duplicate.sources.push(entry);

      // Only ever fills gaps, and only while nobody has corrected the row
      // by hand. A person's answer outranks a second parse of the same
      // event, and a value already parsed is not necessarily worse than
      // the one arriving now.
      if (!duplicate.editedAt) {
        if (!duplicate.merchant && parsed.merchant) duplicate.merchant = parsed.merchant;
        if (!duplicate.accountId && accountId) duplicate.accountId = accountId;
        if (!duplicate.categoryId) {
          duplicate.categoryId = await categorizeTransaction({
            userId: params.userId,
            merchant: duplicate.merchant ?? null,
            rawText: params.rawText,
          });
        }
      }

      await duplicate.save();
    }

    return { status: "duplicate", transaction: duplicate };
  }

  const categoryId = await categorizeTransaction({
    userId: params.userId,
    merchant: parsed.merchant,
    rawText: params.rawText,
  });

  // Which holiday, if any, this was spent on. Decided by when the money
  // moved rather than when the message arrived, so a late SMS still lands
  // on the right trip.
  const tripId = await tripForOccurredAt(params.userId, occurredAt);

  const transaction = await Transaction.create({
    userId: params.userId,
    accountId,
    categoryId,
    tripId,
    amountMinor: parsed.amountMinor,
    currency: parsed.currency,
    type: parsed.type,
    merchant: parsed.merchant,
    rawText: params.rawText,
    source: params.source,
    sourceRef: params.sourceRef,
    occurredAt,
    sources: [
      {
        source: params.source,
        sourceRef: params.sourceRef,
        rawText: params.rawText,
        receivedAt: params.receivedAt,
      },
    ],
  });

  await detectSelfTransfer(transaction);
  // A monthly EMI debit looks like any other payment, so the schedule is
  // ticked off here rather than waiting for someone to do it by hand.
  await matchEmiInstalment(transaction);

  return { status: "created", transaction };
}
