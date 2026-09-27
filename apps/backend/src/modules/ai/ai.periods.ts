import { Types } from "mongoose";
import { User } from "../../models";
import { istDayKey, istMonthEnd, istMonthKey, istMonthStart } from "../../time";
import { currentBudgetPeriod } from "../budget/budget.pace";
import { budgetPeriodFor } from "../budget/budget.period";

/**
 * The months the assistant talks about.
 *
 * For someone paid on the 15th, "this month" means the 15th to the 14th -
 * the same stretch the pace and the daily budget measure - not the 1st to
 * the 30th. Without a pay day it falls back to calendar months.
 *
 * The current period comes from the pace's own reckoning, so a salary that
 * landed a day early opens it on the day it landed; older ones step back
 * from there by the configured day, each ending where the next begins.
 */

export interface PayPeriod {
  /** First day, YYYY-MM-DD in IST. */
  from: string;
  /** Last day, inclusive. */
  to: string;
  start: Date;
  /** Exclusive. */
  end: Date;
}

export interface Periods {
  /** Whether these run salary to salary, or are calendar months. */
  bySalary: boolean;
  salaryDay: number | null;
  /** Newest first; the first is the one today is in. */
  recent: PayPeriod[];
}

const DAY = 24 * 60 * 60 * 1000;

function period(start: Date, end: Date): PayPeriod {
  return { from: istDayKey(start), to: istDayKey(new Date(end.getTime() - 1)), start, end };
}

export async function periodsFor(userId: Types.ObjectId, now = new Date(), count = 24): Promise<Periods> {
  const user = await User.findById(userId).select("salaryDay").orFail();
  const recent: PayPeriod[] = [];

  if (!user.salaryDay) {
    let month = istMonthKey(now);
    for (let i = 0; i < count; i += 1) {
      recent.push(period(istMonthStart(month), istMonthEnd(month)));
      month = istMonthKey(new Date(istMonthStart(month).getTime() - DAY));
    }
    return { bySalary: false, salaryDay: null, recent };
  }

  const current = await currentBudgetPeriod(userId, user.salaryDay, now);
  recent.push(period(current.start, current.end));

  let nextStart = current.start;
  for (let i = 1; i < count; i += 1) {
    const earlier = budgetPeriodFor(user.salaryDay, new Date(nextStart.getTime() - 1));
    // A period can never be empty or overlap the one after it, whatever a
    // salary landing early did to the one after it.
    const start = earlier.start.getTime() < nextStart.getTime() ? earlier.start : new Date(nextStart.getTime() - DAY);
    recent.push(period(start, nextStart));
    nextStart = start;
  }

  return { bySalary: true, salaryDay: user.salaryDay, recent };
}
