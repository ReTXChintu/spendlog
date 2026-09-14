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

/**
 * The period opened by a salary that has actually landed.
 *
 * A configured pay day is a prediction; a credit marked as pay is a fact.
 * Salaries arrive a day either side of the date they are meant to, and a
 * period that starts on the 15th when the money came in on the 14th counts
 * a day of spending against the wrong month twice over — once at the end of
 * the old period and not at all in the new one.
 *
 * So the marked credit sets the start, and the configured day is used only
 * to say when the next one is due.
 */
export function budgetPeriodFromSalary(paidOn: Date, salaryDay: number, now: Date): BudgetPeriod {
  const start = new Date(Date.parse(`${istDayKey(paidOn)}T00:00:00.000+05:30`));

  const shifted = new Date(start.getTime() + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();

  // Which due date this payment was *for*, which is not always the next one
  // after it. Pay arriving on the 14th against a due day of the 15th is
  // early pay for the 15th, not a payment in the middle of a cycle - so the
  // period it opens has to close on the 15th of the following month, not
  // the day after it started.
  const candidates = [
    istDate(year, month - 1, salaryDay),
    istDate(year, month, salaryDay),
    istDate(year, month + 1, salaryDay),
  ];
  const paidFor = candidates.reduce((nearest, candidate) =>
    Math.abs(candidate.getTime() - start.getTime()) < Math.abs(nearest.getTime() - start.getTime())
      ? candidate
      : nearest
  );

  const forParts = new Date(paidFor.getTime() + IST_OFFSET_MS);
  const end = istDate(forParts.getUTCFullYear(), forParts.getUTCMonth() + 1, salaryDay);

  const day = 24 * 60 * 60 * 1000;
  const todayStart = Date.parse(`${istDayKey(now)}T00:00:00.000+05:30`);

  return {
    start,
    end,
    key: istDayKey(start),
    // Clamped at one, which also covers a salary that is simply late: what
    // is left has to last until it arrives, and nobody knows when that is.
    // Erring towards "less per day" is the safe direction to be wrong in.
    daysLeft: Math.max(1, Math.ceil((end.getTime() - todayStart) / day)),
    daysElapsed: Math.max(1, Math.round((todayStart - start.getTime()) / day) + 1),
  };
}
