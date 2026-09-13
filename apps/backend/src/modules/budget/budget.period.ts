import { IST_OFFSET_MS, istDayKey } from "../../time";

/**
 * The stretch of time a spending pace is measured over.
 *
 * A salary on the 15th makes the useful month run the 15th to the 14th.
 * The money arrives and then gets spent, so "how much a day is left" has a
 * real answer that runs down to nothing as the next salary lands. Measured
 * over a calendar month, the first half would be spending money you already
 * had and the second half money you had just been paid, and the figure
 * would mean neither thing.
 */

export interface BudgetPeriod {
  /** Midnight IST on the salary day that opened this period. */
  start: Date;
  /** The instant the next salary day begins — exclusive. */
  end: Date;
  /** `start` as YYYY-MM-DD, which is how a commitment records being paid. */
  key: string;
  /** Whole days from the start of today to the end. Never below one. */
  daysLeft: number;
  /** Days from the start of the period to the start of today, plus one. */
  daysElapsed: number;
}

function istDate(year: number, month: number, day: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)) - IST_OFFSET_MS);
}

/**
 * The period `now` falls in, for someone paid on `salaryDay`.
 *
 * A salary day past the end of a short month is paid on its last day, the
 * same way a card statement clamps — February does not skip payday.
 */
export function budgetPeriodFor(salaryDay: number, now: Date): BudgetPeriod {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();

  const thisMonth = istDate(year, month, salaryDay);
  const start = now.getTime() >= thisMonth.getTime() ? thisMonth : istDate(year, month - 1, salaryDay);

  const { year: sy, month: sm } = (() => {
    const s = new Date(start.getTime() + IST_OFFSET_MS);
    return { year: s.getUTCFullYear(), month: s.getUTCMonth() };
  })();
  const end = istDate(sy, sm + 1, salaryDay);

  const day = 24 * 60 * 60 * 1000;
  const todayStart = Date.parse(`${istDayKey(now)}T00:00:00.000+05:30`);

  return {
    start,
    end,
    key: istDayKey(start),
    // Counting today as one of the days left: money can still be spent
    // today, so pretending otherwise overstates what is available daily.
    daysLeft: Math.max(1, Math.ceil((end.getTime() - todayStart) / day)),
    daysElapsed: Math.max(1, Math.round((todayStart - start.getTime()) / day) + 1),
  };
}
