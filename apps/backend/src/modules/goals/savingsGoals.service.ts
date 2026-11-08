import { Types } from "mongoose";
import { Account, SavingsGoal, SavingsGoalDoc, Transaction } from "../../models";
import { istDayKey } from "../../time";

/**
 * Small things saved up for - a PS5 by next October - with the money kept
 * in a savings account and marked against the goal.
 *
 * What a goal has is what was there when it was made (openingMinor), plus
 * every transfer into savings marked for it (a transaction's goalParts:
 * one transfer can be split across goals), plus anything added or taken
 * out by hand (adjustments). The savings account it lives in shows how
 * much of its balance is spoken for.
 */

export class GoalPartError extends Error {}

/** A transaction's parts for goals, checked: the user's goals, once each, no more than the amount. */
export async function checkGoalParts(
  userId: Types.ObjectId,
  amountMinor: number,
  parts: { goalId: string; amountMinor: number }[]
): Promise<{ goalId: Types.ObjectId; amountMinor: number }[]> {
  if (parts.length === 0) return [];
  const ids = parts.map((part) => part.goalId);
  if (new Set(ids).size !== ids.length) throw new GoalPartError("The same goal is on it twice.");
  if ((await SavingsGoal.countDocuments({ userId, _id: { $in: ids } })) !== ids.length) throw new GoalPartError("Unknown goal");
  const total = parts.reduce((sum, part) => sum + part.amountMinor, 0);
  if (total > amountMinor) {
    throw new GoalPartError(`That's ₹${(total / 100).toFixed(2)} for goals, but it's only ₹${(amountMinor / 100).toFixed(2)}.`);
  }
  return parts.map((part) => ({ goalId: new Types.ObjectId(part.goalId), amountMinor: part.amountMinor }));
}

export interface GoalView {
  id: string;
  name: string;
  targetMinor: number;
  /// YYYY-MM-DD.
  targetOn: string;
  accountId: string | null;
  accountLabel: string | null;
  isActive: boolean;
  savedMinor: number;
  leftMinor: number;
  /// Whole months from now to the target day, at least one while it is ahead.
  monthsLeft: number;
  /// What to put aside each month from here to get there on time.
  perMonthMinor: number;
  percent: number;
  isDone: boolean;
  /// Put aside in the user's month running now (transfers and by hand).
  addedThisMonthMinor: number;
}

/** Whole calendar months from one day to another, at least one. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const months = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  return Math.max(1, months + 1);
}

/** Each goal of the user's with what it has, and what a month it needs. */
export async function goalsOf(userId: Types.ObjectId, now = new Date()): Promise<GoalView[]> {
  const goals = await SavingsGoal.find({ userId }).sort({ isActive: -1, targetOn: 1 }).lean();
  if (goals.length === 0) return [];
  const [transfers, accounts] = await Promise.all([
    Transaction.find({ userId, "goalParts.0": { $exists: true } }).select("occurredAt goalParts").lean(),
    Account.find({ userId, _id: { $in: goals.map((g) => g.accountId).filter(Boolean) } }).select("nickname bankName last4").lean(),
  ]);
  const labels = new Map(accounts.map((a) => [a._id.toString(), `${a.nickname || a.bankName}${a.last4 ? ` ••${a.last4}` : ""}`]));
  const today = istDayKey(now);
  const month = today.slice(0, 7);

  return goals.map((goal) => {
    let fromTransfers = 0;
    let thisMonth = 0;
    for (const row of transfers) {
      for (const part of row.goalParts) {
        if (!part.goalId.equals(goal._id)) continue;
        fromTransfers += part.amountMinor;
        if (istDayKey(row.occurredAt).startsWith(month)) thisMonth += part.amountMinor;
      }
    }
    const byHand = goal.adjustments.reduce((sum, entry) => sum + entry.amountMinor, 0);
    thisMonth += goal.adjustments
      .filter((entry) => istDayKey(entry.on).startsWith(month))
      .reduce((sum, entry) => sum + entry.amountMinor, 0);
    const saved = goal.openingMinor + fromTransfers + byHand;
    const left = Math.max(0, goal.targetMinor - saved);
    const monthsLeft = goal.targetOn > today ? monthsBetween(today, goal.targetOn) : 1;
    return {
      id: goal._id.toString(),
      name: goal.name,
      targetMinor: goal.targetMinor,
      targetOn: goal.targetOn,
      accountId: goal.accountId?.toString() ?? null,
      accountLabel: goal.accountId ? (labels.get(goal.accountId.toString()) ?? null) : null,
      isActive: goal.isActive,
      savedMinor: saved,
      leftMinor: left,
      monthsLeft,
      perMonthMinor: Math.ceil(left / monthsLeft / 100) * 100,
      percent: goal.targetMinor > 0 ? Math.min(100, Math.round((saved / goal.targetMinor) * 1000) / 10) : 0,
      isDone: saved >= goal.targetMinor,
      addedThisMonthMinor: thisMonth,
    };
  });
}

/** How much of each account's balance is set aside for the user's open goals. */
export async function spokenForByAccount(userId: Types.ObjectId, now = new Date()): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const goal of await goalsOf(userId, now)) {
    if (!goal.isActive || !goal.accountId || goal.savedMinor <= 0) continue;
    result.set(goal.accountId, (result.get(goal.accountId) ?? 0) + goal.savedMinor);
  }
  return result;
}

/** A goal's history: what was there at the start, each transfer marked for it, each amount by hand. */
export async function goalEntries(userId: Types.ObjectId, goal: SavingsGoalDoc) {
  const transfers = await Transaction.find({ userId, "goalParts.goalId": goal._id })
    .sort({ occurredAt: -1 })
    .select("merchant occurredAt goalParts")
    .lean();
  return [
    ...transfers.map((row) => ({
      kind: "TRANSFER" as const,
      transactionId: row._id.toString(),
      label: row.merchant ?? "Transfer",
      on: row.occurredAt.toISOString(),
      amountMinor: row.goalParts.find((part) => part.goalId.equals(goal._id))?.amountMinor ?? 0,
    })),
    ...goal.adjustments.map((entry) => ({
      kind: "BY_HAND" as const,
      transactionId: null,
      label: entry.note || (entry.amountMinor >= 0 ? "Added" : "Taken out"),
      on: entry.on.toISOString(),
      amountMinor: entry.amountMinor,
    })),
  ].sort((a, b) => (a.on < b.on ? 1 : -1));
}
