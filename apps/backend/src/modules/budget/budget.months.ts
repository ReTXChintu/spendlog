import { Types } from "mongoose";
import { Transaction, User } from "../../models";
import { IST_OFFSET_MS, istDayKey, istMonthEnd, istMonthKey, istMonthStart } from "../../time";
import { currentBudgetPeriod } from "./budget.pace";
import { budgetPeriodFor } from "./budget.period";

/**
 * What a "month" is, for this user.
 *
 * For someone paid on the 15th it is the 15th to the 14th - the stretch the
 * money arrives at the start of and has to last to the end of. Analytics,
 * the dashboard, account totals and the assistant all measure in these, so
 * no two screens disagree about which month a payment on the 3rd is in.
 * Without a pay day it is the calendar month.
 *
 * The current month comes from the pace's own reckoning, so a salary that
 * landed a day early opens it on the day it landed; older ones step back
 * from there by the configured day, each ending where the next begins.
 *
 * Each month has a key, YYYY-MM, named for the pay day it opens with - so
 * the month that starts on 15 September is "2026-09", and pay that landed
 * on 30 September for a pay day of 1 October is still October's.
 */

export interface UserMonth {
  /** YYYY-MM, the month of the pay day that opens it. */
  key: string;
  /** First day, YYYY-MM-DD in IST. */
  from: string;
  /** Last day, inclusive. */
  to: string;
  start: Date;
  /** Exclusive. */
  end: Date;
}

export interface UserMonths {
  /** Whether these run salary to salary, or are calendar months. */
  bySalary: boolean;
  salaryDay: number | null;
  /** Newest first; the first is the one today is in. */
  recent: UserMonth[];
}

const DAY = 24 * 60 * 60 * 1000;

/** Midnight IST on `day` of a month, clamped to a short month's last day. */
function istDate(year: number, month: number, day: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)) - IST_OFFSET_MS);
}

/** Which pay day a period opened for: the one nearest its first day. */
function payDayKey(start: Date, salaryDay: number): string {
  const shifted = new Date(start.getTime() + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const nearest = [istDate(year, month - 1, salaryDay), istDate(year, month, salaryDay), istDate(year, month + 1, salaryDay)]
    .reduce((best, candidate) =>
      Math.abs(candidate.getTime() - start.getTime()) < Math.abs(best.getTime() - start.getTime()) ? candidate : best
    );
  return istMonthKey(nearest);
}

/** Under this, a "month" is a pay day that came late, not a month. */
const SHORTEST_MONTH_MS = 20 * DAY;
/** How far from its pay day a salary can land and still be that pay day's. */
const SALARY_SLACK_MS = 10 * DAY;

/**
 * The IST day each salary landed, newest first. Pay in two parts - salary,
 * then arrears days later - is one payment, opened by the first part, the
 * same way the current month's is.
 */
async function salaryDays(userId: Types.ObjectId, now: Date): Promise<Date[]> {
  const credits = await Transaction.find({ userId, isSalary: true, type: "CREDIT", occurredAt: { $lte: now } })
    .select("occurredAt")
    .sort({ occurredAt: -1 })
    .limit(120);

  const days: Date[] = [];
  let clusterEarliest: Date | null = null;
  for (const { occurredAt } of credits) {
    if (clusterEarliest && clusterEarliest.getTime() - occurredAt.getTime() <= SALARY_SLACK_MS) {
      clusterEarliest = occurredAt;
      continue;
    }
    if (clusterEarliest) days.push(clusterEarliest);
    clusterEarliest = occurredAt;
  }
  if (clusterEarliest) days.push(clusterEarliest);
  return days.map((day) => new Date(Date.parse(`${istDayKey(day)}T00:00:00.000+05:30`)));
}

function make(key: string, start: Date, end: Date): UserMonth {
  return { key, from: istDayKey(start), to: istDayKey(new Date(end.getTime() - 1)), start, end };
}

export async function userMonths(userId: Types.ObjectId, now = new Date(), count = 36): Promise<UserMonths> {
  const user = await User.findById(userId).select("salaryDay").orFail();
  const recent: UserMonth[] = [];

  if (!user.salaryDay) {
    let month = istMonthKey(now);
    for (let i = 0; i < count; i += 1) {
      recent.push(make(month, istMonthStart(month), istMonthEnd(month)));
      month = istMonthKey(new Date(istMonthStart(month).getTime() - DAY));
    }
    return { bySalary: false, salaryDay: null, recent };
  }

  const salaryDay = user.salaryDay;
  const current = await currentBudgetPeriod(userId, salaryDay, now);
  recent.push(make(payDayKey(current.start, salaryDay), current.start, current.end));

  const landed = await salaryDays(userId, now);

  let nextStart = current.start;
  for (let i = 1; i < count; i += 1) {
    let payDay = budgetPeriodFor(salaryDay, new Date(nextStart.getTime() - 1)).start;
    // Pay that came late opened the month after this one a day or two past
    // its pay day, and the pay day before that start is that same pay day:
    // a month a day long. The one this month was opened by is a cycle back.
    if (nextStart.getTime() - payDay.getTime() < SHORTEST_MONTH_MS) {
      payDay = budgetPeriodFor(salaryDay, new Date(payDay.getTime() - 1)).start;
    }
    // And the salary that actually landed for that pay day, early or late,
    // opens it on the day it did - as it does for the current month.
    const paidOn = landed.find(
      (day) => Math.abs(day.getTime() - payDay.getTime()) <= SALARY_SLACK_MS && day.getTime() < nextStart.getTime()
    );
    const start = paidOn ?? payDay;
    // A month can never be empty or overlap the one after it.
    const safeStart = start.getTime() < nextStart.getTime() ? start : new Date(nextStart.getTime() - DAY);
    recent.push(make(payDayKey(safeStart, salaryDay), safeStart, nextStart));
    nextStart = safeStart;
  }

  return { bySalary: true, salaryDay, recent };
}

/**
 * One month by its key, or the current one. A key older than the months
 * worked out above - or one still to come - is laid out from the pay day
 * alone, since there is no salary credit to anchor it to.
 */
export async function userMonth(userId: Types.ObjectId, key?: string, now = new Date()): Promise<UserMonth> {
  const months = await userMonths(userId, now);
  if (!key) return months.recent[0];

  const found = months.recent.find((month) => month.key === key);
  if (found) return found;

  const [year, mon] = key.split("-").map(Number);
  if (!months.bySalary) return make(key, istMonthStart(key), istMonthEnd(key));
  return make(key, istDate(year, mon - 1, months.salaryDay!), istDate(year, mon, months.salaryDay!));
}

/**
 * This month so far against the same point in the last one.
 *
 * Day-for-day, not month-for-month: on day 8, a whole previous month is not
 * a comparison - it is a number three times larger, and reading that as
 * overspending would be wrong every time. Days are counted from each
 * month's own first day, so day 8 of a month that began on the 15th is
 * compared with day 8 of the one before, wherever that one began.
 */
export async function monthSoFar(userId: Types.ObjectId, now = new Date()) {
  const { recent, bySalary } = await userMonths(userId, now, 2);
  const [current, previous] = recent;
  const todayStart = Date.parse(`${istDayKey(now)}T00:00:00.000+05:30`);
  const dayOfMonth = Math.max(1, Math.round((todayStart - current.start.getTime()) / DAY) + 1);

  const spendUpTo = async (month: UserMonth): Promise<number> => {
    const end = new Date(Math.min(month.start.getTime() + dayOfMonth * DAY, month.end.getTime()));
    const rows = await Transaction.aggregate<{ total: number }>([
      {
        $match: {
          userId,
          occurredAt: { $gte: month.start, $lt: end },
          type: "DEBIT",
          countedAmountMinor: { $gt: 0 },
        },
      },
      { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
    ]);
    return rows[0]?.total ?? 0;
  };

  const [spentMinor, previousMinor] = await Promise.all([spendUpTo(current), spendUpTo(previous)]);
  return {
    month: current.key,
    from: current.from,
    to: current.to,
    label: monthLabel(current, bySalary),
    dayOfMonth,
    spentMinor,
    previousMinor,
    changeMinor: spentMinor - previousMinor,
  };
}

/** "15 Sep – 14 Oct", or "September 2026" for a calendar month. */
export function monthLabel(month: UserMonth, bySalary: boolean): string {
  const format = (day: string, withYear: boolean) =>
    new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "Asia/Kolkata",
    });
  if (!bySalary) {
    return new Date(`${month.from}T12:00:00+05:30`).toLocaleDateString("en-IN", {
      month: "long",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    });
  }
  return `${format(month.from, false)} – ${format(month.to, true)}`;
}
