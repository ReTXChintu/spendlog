import { Types } from "mongoose";
import { FundHolding, FundTxn } from "../../models";
import { istDayKey } from "../../time";

/**
 * A payment marked, from its own editor, as buying into mutual funds - one
 * or several, and how much into each.
 *
 * The links are the same LINKED entries the Investments screen makes when
 * it pairs a debit with a fund, so a fund's units, its SIP months and its
 * returns read them exactly as they always have. What a part adds is how
 * much of the payment it was: null is all of it (every link from before
 * splitting means that), which keeps following the payment's amount when
 * that is corrected; a number is only that much.
 */

export class FundPartError extends Error {}

export interface FundPart {
  holdingId: string;
  amountMinor: number;
}

/** The parts asked for, checked before anything is written. */
export async function checkFundParts(userId: Types.ObjectId, paymentMinor: number, parts: FundPart[]): Promise<FundPart[]> {
  if (parts.length === 0) return [];
  const ids = parts.map((part) => part.holdingId);
  if (new Set(ids).size !== ids.length) throw new FundPartError("The same fund is on it twice.");
  const owned = await FundHolding.countDocuments({ userId, _id: { $in: ids } });
  if (owned !== ids.length) throw new FundPartError("Unknown fund");
  const total = parts.reduce((sum, part) => sum + part.amountMinor, 0);
  if (total > paymentMinor) {
    throw new FundPartError(
      `That's ₹${(total / 100).toFixed(2)} into funds, but the payment is ₹${(paymentMinor / 100).toFixed(2)}.`
    );
  }
  return parts;
}

/**
 * The payment's links made to say exactly these parts: links to funds no
 * longer on it go (the SIP instalment each stood in for comes back), the
 * rest are made or given their new part. An empty list takes it off every
 * fund.
 */
export async function setFundParts(
  userId: Types.ObjectId,
  transaction: { _id: Types.ObjectId; amountMinor: number; occurredAt: Date },
  parts: FundPart[]
): Promise<void> {
  const keep = parts.map((part) => new Types.ObjectId(part.holdingId));
  await FundTxn.deleteMany({ userId, kind: "LINKED", transactionId: transaction._id, holdingId: { $nin: keep } });
  const whole = parts.length === 1 && parts[0].amountMinor === transaction.amountMinor;
  for (const part of parts) {
    const partMinor = whole ? null : part.amountMinor;
    await FundTxn.updateOne(
      { userId, kind: "LINKED", transactionId: transaction._id, holdingId: new Types.ObjectId(part.holdingId) },
      {
        $set: { partMinor, amountMinor: part.amountMinor, on: istDayKey(transaction.occurredAt) },
        $setOnInsert: { userId, kind: "LINKED", transactionId: transaction._id, holdingId: new Types.ObjectId(part.holdingId) },
      },
      { upsert: true }
    );
  }
}

/** The funds a payment bought into, each with what of it went there. */
export async function fundPartsOf(
  userId: Types.ObjectId,
  transaction: { _id: Types.ObjectId; amountMinor: number }
): Promise<FundPart[]> {
  const links = await FundTxn.find({ userId, kind: "LINKED", transactionId: transaction._id }).sort({ createdAt: 1 }).lean();
  return links.map((link) => ({
    holdingId: link.holdingId.toString(),
    amountMinor: link.partMinor ?? transaction.amountMinor,
  }));
}

/**
 * Refused when the parts given to funds come to more than a corrected
 * amount. A link for the whole payment simply follows it.
 */
export async function checkFundPartsFit(userId: Types.ObjectId, transactionId: Types.ObjectId, paymentMinor: number) {
  const links = await FundTxn.find({ userId, kind: "LINKED", transactionId, partMinor: { $ne: null } })
    .select("partMinor")
    .lean();
  const given = links.reduce((sum, link) => sum + (link.partMinor ?? 0), 0);
  if (given > paymentMinor) {
    throw new FundPartError(
      `₹${(given / 100).toFixed(2)} of it went into funds, more than the ₹${(paymentMinor / 100).toFixed(2)} it now comes to.`
    );
  }
}
