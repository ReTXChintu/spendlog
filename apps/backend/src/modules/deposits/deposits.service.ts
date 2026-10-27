import { Types } from "mongoose";
import { Deposit, DepositDoc, Transaction } from "../../models";
import { userMonth } from "../budget/budget.months";

/**
 * RDs and FDs as running totals.
 *
 * A deposit's total is the figure the user last gave for it plus every
 * payment put into it after that moment - so the RD that gets ₹2,000 of
 * each month's ₹3,000 to the agent grows by ₹2,000 a month on its own, and
 * a total corrected from the passbook starts again from there. Money put
 * into a deposit is still spending, like every fixed cost; this is only
 * where it went.
 */

export class DepositPartError extends Error {}

/**
 * The parts of a payment that go into deposits, checked: every deposit is
 * the user's, none twice, each part more than nothing, and together no
 * more than the payment. An empty list takes it out of every deposit.
 */
export async function checkDepositParts(
  userId: Types.ObjectId,
  amountMinor: number,
  parts: { depositId: string; amountMinor: number }[]
): Promise<{ depositId: Types.ObjectId; amountMinor: number }[]> {
  if (parts.length === 0) return [];
  const ids = parts.map((part) => part.depositId);
  if (new Set(ids).size !== ids.length) throw new DepositPartError("The same deposit is on it twice.");
  const owned = await Deposit.countDocuments({ userId, _id: { $in: ids } });
  if (owned !== ids.length) throw new DepositPartError("Unknown deposit");
  const total = parts.reduce((sum, part) => sum + part.amountMinor, 0);
  if (total > amountMinor) {
    throw new DepositPartError(
      `That's ₹${(total / 100).toFixed(2)} into deposits, but the payment is ₹${(amountMinor / 100).toFixed(2)}.`
    );
  }
  return parts.map((part) => ({ depositId: new Types.ObjectId(part.depositId), amountMinor: part.amountMinor }));
}

export interface DepositView {
  id: string;
  name: string;
  kind: DepositDoc["kind"];
  institution: string | null;
  monthlyMinor: number | null;
  isActive: boolean;
  /// What it holds now: the figure given, plus what went in since.
  totalMinor: number;
  /// Put in during the user's month running now.
  addedThisMonthMinor: number;
  lastAddedAt: string | null;
  baselineMinor: number;
  baselineAt: string;
}

/** Every deposit of the user's with its total, active first, then by name. */
export async function depositsOf(userId: Types.ObjectId, now = new Date()): Promise<DepositView[]> {
  const deposits = await Deposit.find({ userId }).sort({ isActive: -1, name: 1 }).lean();
  if (deposits.length === 0) return [];
  const month = await userMonth(userId, undefined, now);

  // Every part ever put into one of them: a few a month each, so read and
  // added up here rather than in an aggregation.
  const payments = await Transaction.find({ userId, "depositParts.0": { $exists: true } })
    .select("occurredAt depositParts")
    .lean();
  const totals = new Map<string, { sinceBaseline: number; thisMonth: number; last: Date | null }>();
  const baselines = new Map(deposits.map((deposit) => [deposit._id.toString(), deposit.baselineAt]));
  for (const payment of payments) {
    for (const part of payment.depositParts) {
      const id = part.depositId.toString();
      const baselineAt = baselines.get(id);
      if (!baselineAt) continue;
      const entry = totals.get(id) ?? { sinceBaseline: 0, thisMonth: 0, last: null };
      if (payment.occurredAt > baselineAt) entry.sinceBaseline += part.amountMinor;
      if (payment.occurredAt >= month.start && payment.occurredAt < month.end) entry.thisMonth += part.amountMinor;
      if (!entry.last || payment.occurredAt > entry.last) entry.last = payment.occurredAt;
      totals.set(id, entry);
    }
  }

  return deposits.map((deposit) => {
    const entry = totals.get(deposit._id.toString());
    return {
      id: deposit._id.toString(),
      name: deposit.name,
      kind: deposit.kind,
      institution: deposit.institution ?? null,
      monthlyMinor: deposit.monthlyMinor ?? null,
      isActive: deposit.isActive,
      totalMinor: deposit.baselineMinor + (entry?.sinceBaseline ?? 0),
      addedThisMonthMinor: entry?.thisMonth ?? 0,
      lastAddedAt: entry?.last ? entry.last.toISOString() : null,
      baselineMinor: deposit.baselineMinor,
      baselineAt: deposit.baselineAt.toISOString(),
    };
  });
}

/** The payments put into one deposit, newest first, with the part that went in. */
export async function depositPayments(userId: Types.ObjectId, depositId: Types.ObjectId) {
  const rows = await Transaction.find({ userId, "depositParts.depositId": depositId })
    .sort({ occurredAt: -1 })
    .limit(200)
    .select("merchant occurredAt amountMinor depositParts")
    .lean();
  return rows.map((row) => ({
    transactionId: row._id.toString(),
    merchant: row.merchant ?? null,
    occurredAt: row.occurredAt.toISOString(),
    paymentMinor: row.amountMinor,
    amountMinor: row.depositParts.find((part) => part.depositId.equals(depositId))?.amountMinor ?? 0,
  }));
}
