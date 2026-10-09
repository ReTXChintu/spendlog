import { Types } from "mongoose";
import { Transaction, User } from "../../models";
import { istMonthKey } from "../../time";
import { dailyBudget, extraIncomeMatch } from "./budget.daily";
import { UserMonth, monthLabel, userMonths } from "./budget.months";
import { monthlyBudgetFor } from "./budget.monthly";

/**
 * The savings bucket, a month at a time.
 *
 * When a salary month ends, whatever is left of its budget goes in; a
 * month that went over takes the overspend back out. Money in on top of
 * pay - a gift, interest, cashback - goes in the day it arrives, as it
 * always has. Nothing floors it at zero, the same as the daily bucket it
 * replaces: a bucket that has given out more than it was given says so.
 *
 * Kept as a running sum rather than a stored balance, for the reason the
 * daily one was: correct last month's transaction and last month's result
 * corrects with it. A refund comes in through the month's own total,
 * which nets it off the purchase it gives back.
 *
 * Where it starts. The daily budget's bucket started again every salary
 * month, so the only balance it ever had when the monthly budget began
 * was the one the month before closed on - the figure that was on screen
 * the evening before payday. That month keeps its result under the daily
 * rules, worked out by the same code that showed it then, and it is what
 * the monthly bucket opens with. Months before it were each already
 * "moved to savings" under the old rules and are not carried again.
 */

export interface BucketMonth {
  key: string;
  label: string;
  from: string;
  to: string;
  /// Which rules scored it: "daily" for the one month carried over from the
  /// daily budget, "monthly" from the first monthly budget on.
  era: "daily" | "monthly";
  /// Over, with its result in the bucket. The month running now is not:
  /// only its extra income is in so far.
  settled: boolean;
  /// What it was allowed. For the daily month, the daily amounts it was
  /// allowed, added up.
  budgetMinor: number;
  spentMinor: number;
  /// Allowed less spent. Negative when it went over.
  leftMinor: number;
  extraIncomeMinor: number;
  /// The daily budget gave refunds back on the day they came; zero for a
  /// monthly month, whose refunds are already in spentMinor.
  refundedBackMinor: number;
  /// What it moved the bucket by: left plus extra income once settled,
  /// the extra income alone while it runs.
  toBucketMinor: number;
  balanceAfterMinor: number;
}

export type SavingsBucket =
  | { configured: false; suggestedMonthlyMinor: number | null }
  | {
      configured: true;
      balanceMinor: number;
      /// What the last month under the daily budget carried in. Zero when
      /// there was no daily budget.
      openingFromDailyMinor: number;
      /// The first month with a monthly budget.
      firstMonthKey: string;
      /// The balance if this month ended now with nothing more spent:
      /// the balance plus what is left of this month.
      balanceIfMonthEndedNowMinor: number;
      /// Newest first, the month running now at the top.
      months: BucketMonth[];
    };

export type BucketSummary =
  | { configured: false }
  | { configured: true; balanceMinor: number; balanceIfMonthEndedNowMinor: number };

/** Whole calendar months from one YYYY-MM to another. */
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

/**
 * One grouped query for a run of consecutive months: each transaction put
 * in the month it falls in, which a calendar group-by cannot do once
 * months run from the 15th.
 */
async function totalsByMonth(
  match: Record<string, unknown>,
  months: UserMonth[],
  until: Date
): Promise<Map<number, number>> {
  if (months.length === 0) return new Map();
  const boundaries = [...months.map((month) => month.start), months[months.length - 1].end];
  const rows = await Transaction.aggregate<{ _id: Date | string; total: number }>([
    { $match: { ...match, occurredAt: { $gte: boundaries[0], $lt: boundaries[boundaries.length - 1], $lte: until } } },
    { $bucket: { groupBy: "$occurredAt", boundaries, default: "other", output: { total: { $sum: "$countedAmountMinor" } } } },
  ]);
  return new Map(
    rows.filter((row) => row._id instanceof Date).map((row) => [(row._id as Date).getTime(), row.total])
  );
}

export async function savingsBucket(userId: Types.ObjectId, now = new Date()): Promise<SavingsBucket> {
  const user = await User.findById(userId).select("monthlyBudgetHistory dailyBudgetMinor").orFail();
  const history = user.monthlyBudgetHistory ?? [];

  if (history.length === 0) {
    const { recent } = await userMonths(userId, now, 1);
    const days = Math.round((recent[0].end.getTime() - recent[0].start.getTime()) / (24 * 60 * 60 * 1000));
    return { configured: false, suggestedMonthlyMinor: user.dailyBudgetMinor ? user.dailyBudgetMinor * days : null };
  }

  const firstMonthKey = history[0].fromMonthKey;
  // Enough months to reach back past the first monthly one, with room for
  // a salary month's key running a month either side of the calendar.
  const count = Math.min(240, Math.max(2, monthsBetween(firstMonthKey, istMonthKey(now)) + 3));
  const { recent, bySalary } = await userMonths(userId, now, count);
  const currentKey = recent[0].key;

  // Oldest first, for a running balance.
  const monthly = recent.filter((month) => month.key >= firstMonthKey && month.key <= currentKey).reverse();
  const lastDaily = recent.find((month) => month.key < firstMonthKey && month.key < currentKey);

  const [spent, income] = await Promise.all([
    totalsByMonth({ userId, type: "DEBIT", countedAmountMinor: { $gt: 0 } }, monthly, monthly.length ? monthly[monthly.length - 1].end : now),
    totalsByMonth(await extraIncomeMatch(userId), monthly, now),
  ]);

  const rows: BucketMonth[] = [];
  let balance = 0;

  if (lastDaily) {
    const daily = await dailyBudget(userId, now, lastDaily);
    if (daily.configured) {
      balance += daily.bucketMinor;
      rows.push({
        key: lastDaily.key,
        label: monthLabel(lastDaily, bySalary),
        from: lastDaily.from,
        to: lastDaily.to,
        era: "daily",
        settled: true,
        budgetMinor: daily.allowedMinor,
        spentMinor: daily.spentMinor,
        leftMinor: daily.allowedMinor - daily.spentMinor,
        extraIncomeMinor: daily.extraIncomeMinor,
        refundedBackMinor: daily.refundedBackMinor,
        toBucketMinor: daily.bucketMinor,
        balanceAfterMinor: balance,
      });
    }
  }
  const openingFromDailyMinor = balance;

  let runningLeft = 0;
  for (const month of monthly) {
    const budgetMinor = monthlyBudgetFor(user, month.key)?.amountMinor ?? 0;
    const spentMinor = spent.get(month.start.getTime()) ?? 0;
    const extraIncomeMinor = income.get(month.start.getTime()) ?? 0;
    // Settled once a newer month has begun - by the user's own months,
    // so pay that is late leaves this one open until it lands.
    const settled = month.key !== currentKey;
    const leftMinor = budgetMinor - spentMinor;
    const toBucketMinor = (settled ? leftMinor : 0) + extraIncomeMinor;
    if (!settled) runningLeft = leftMinor;

    balance += toBucketMinor;
    rows.push({
      key: month.key,
      label: monthLabel(month, bySalary),
      from: month.from,
      to: month.to,
      era: "monthly",
      settled,
      budgetMinor,
      spentMinor,
      leftMinor,
      extraIncomeMinor,
      refundedBackMinor: 0,
      toBucketMinor,
      balanceAfterMinor: balance,
    });
  }

  return {
    configured: true,
    balanceMinor: balance,
    openingFromDailyMinor,
    firstMonthKey,
    balanceIfMonthEndedNowMinor: balance + runningLeft,
    months: rows.reverse(),
  };
}

/** The balance alone, for a screen that shows it beside something else. */
export async function bucketSummary(userId: Types.ObjectId, now = new Date()): Promise<BucketSummary> {
  const bucket = await savingsBucket(userId, now);
  return bucket.configured
    ? {
        configured: true,
        balanceMinor: bucket.balanceMinor,
        balanceIfMonthEndedNowMinor: bucket.balanceIfMonthEndedNowMinor,
      }
    : { configured: false };
}
