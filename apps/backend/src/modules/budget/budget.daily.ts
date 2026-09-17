import { Types } from "mongoose";
import { Transaction, User } from "../../models";
import { IST_OFFSET, IST_OFFSET_MS, istDayKey, istMonthKey, istMonthStart } from "../../time";
import { BudgetPeriod } from "./budget.period";
import { currentBudgetPeriod } from "./budget.pace";

/**
 * A daily allowance, and the pot that fills or drains behind it.
 *
 * Set a day at 1,000. Spend 600 and the 400 left over is put by; spend
 * 1,500 and the 500 over comes back out. Run that across the period and
 * the total is the answer to a question the pace card cannot answer: when
 * the salary lands, how much of it can go straight into savings.
 *
 * Deliberately a different thing from the salary pace next to it. The pace
 * divides what is left by the days remaining, so it moves every time
 * anything is spent and every time a day passes - it says whether you will
 * make it to payday. This says what you decided a day should cost and
 * keeps score against it. One is a forecast, the other is a record.
 *
 * Kept as a running sum rather than a stored balance. Nothing is written
 * down, so correcting a transaction from last Tuesday corrects the bucket
 * too - which a stored balance could only do by being recomputed anyway.
 */

export interface DailyBudgetDay {
  /** The IST calendar day, as YYYY-MM-DD. */
  day: string;
  spentMinor: number;
  /** Budget less spending: positive put by, negative taken back. */
  deltaMinor: number;
}

export type DailyBudget =
  | { configured: false }
  | {
      configured: true;
      dailyBudgetMinor: number;
      periodStart: Date;
      periodEnd: Date;
      /// Whether the period resets on a salary or on the 1st. Said out
      /// loud, because "resets when I am paid" is the whole point of it
      /// and a calendar month is a fallback rather than the intent.
      resetsOnSalary: boolean;
      /// Days counted so far, today included. Today counts because money
      /// can still be spent today and the bucket has to move as it is.
      daysCounted: number;
      daysLeft: number;
      /// The allowance for the days counted: the daily budget times them.
      allowedMinor: number;
      spentMinor: number;
      /// Positive is put by, negative is spent out of what was put by.
      bucketMinor: number;
      todaySpentMinor: number;
      /// What is left of today's allowance. Negative once today is over it.
      todayLeftMinor: number;
      /// How many of the days counted went over. The bucket is one number
      /// and does not say whether it is one bad day or every day.
      daysOver: number;
      /// Day by day, oldest first, for a strip showing where it went.
      days: DailyBudgetDay[];
    };

/** The calendar month, shaped like a budget period, for someone with no pay day. */
function calendarMonth(now: Date): BudgetPeriod {
  const start = istMonthStart(istMonthKey(now));
  const shifted = new Date(start.getTime() + IST_OFFSET_MS);
  const end = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - IST_OFFSET_MS
  );

  const day = 24 * 60 * 60 * 1000;
  const todayStart = Date.parse(`${istDayKey(now)}T00:00:00.000${IST_OFFSET}`);

  return {
    start,
    end,
    key: istDayKey(start),
    daysLeft: Math.max(1, Math.ceil((end.getTime() - todayStart) / day)),
    daysElapsed: Math.max(1, Math.round((todayStart - start.getTime()) / day) + 1),
  };
}

/** Every IST day from `start` up to and including today, oldest first. */
function daysUpToToday(start: Date, now: Date): string[] {
  const days: string[] = [];
  const today = istDayKey(now);

  // Walked as day keys rather than counted, so a period that starts on the
  // 31st and a month that does not have one cannot produce a day that is
  // not a date. Capped, because a clock set wrong should not spin here.
  let cursor = Date.parse(`${istDayKey(start)}T00:00:00.000${IST_OFFSET}`);
  for (let guard = 0; guard < 400; guard += 1) {
    const key = istDayKey(new Date(cursor));
    if (key > today) break;

    days.push(key);
    cursor += 24 * 60 * 60 * 1000;
  }

  return days;
}

export async function dailyBudget(userId: Types.ObjectId, now = new Date()): Promise<DailyBudget> {
  const user = await User.findById(userId).select("dailyBudgetMinor salaryDay").orFail();
  if (!user.dailyBudgetMinor || user.dailyBudgetMinor <= 0) return { configured: false };

  // Salary day to salary day where there is one, because that is when the
  // money to fill the bucket actually turns up. The calendar month is the
  // fallback rather than the intent.
  const period = user.salaryDay
    ? await currentBudgetPeriod(userId, user.salaryDay, now)
    : calendarMonth(now);

  // Grouped by IST day in the database rather than in hand, so a hundred
  // transactions come back as thirty rows. Spending is counted the same
  // way the pace counts it: countedAmountMinor, which already knows that a
  // transfer between your own accounts is not spending and that a card
  // bill is the same money as the purchases it is made of.
  const rows = await Transaction.aggregate<{ _id: string; total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lte: now },
        countedAmountMinor: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: { date: "$occurredAt", format: "%Y-%m-%d", timezone: IST_OFFSET },
        },
        total: { $sum: "$countedAmountMinor" },
      },
    },
  ]);

  const spentByDay = new Map(rows.map((row) => [row._id, row.total]));
  const budget = user.dailyBudgetMinor;

  // Every day from the start, not only the days something was spent on. A
  // day with no spending on it is the best kind of day for a bucket, and
  // leaving it out would silently drop what it put by.
  const days: DailyBudgetDay[] = daysUpToToday(period.start, now).map((day) => {
    const spentMinor = spentByDay.get(day) ?? 0;
    return { day, spentMinor, deltaMinor: budget - spentMinor };
  });

  const spentMinor = days.reduce((sum, day) => sum + day.spentMinor, 0);
  const allowedMinor = budget * days.length;
  const today = days[days.length - 1];

  return {
    configured: true,
    dailyBudgetMinor: budget,
    periodStart: period.start,
    periodEnd: period.end,
    resetsOnSalary: Boolean(user.salaryDay),
    daysCounted: days.length,
    daysLeft: period.daysLeft,
    allowedMinor,
    spentMinor,
    bucketMinor: allowedMinor - spentMinor,
    todaySpentMinor: today?.spentMinor ?? 0,
    todayLeftMinor: budget - (today?.spentMinor ?? 0),
    daysOver: days.filter((day) => day.deltaMinor < 0).length,
    days,
  };
}
