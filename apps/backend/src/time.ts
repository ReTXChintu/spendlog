/**
 * Everything in SpendLog happens in India, so every calendar decision is
 * made in IST — which day a payment belongs to, where a month begins, what
 * "from the 1st to the 11th" means.
 *
 * Instants are still stored as UTC, as they should be. What this fixes is
 * the layer above: the server runs in UTC, so grouping by the UTC calendar
 * put anything between midnight and 5:30am on the previous day, and the
 * month of a late-night payment on the 31st fell into the wrong month.
 *
 * India has a fixed +05:30 offset and no daylight saving, which is what
 * makes plain arithmetic safe here. It would not be in a country that
 * changes its clocks.
 */

/** The offset as MongoDB's aggregation framework wants it. */
export const IST_OFFSET = "+05:30";

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** The IST calendar day an instant falls on, as `YYYY-MM-DD`. */
export function istDayKey(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The IST calendar month an instant falls in, as `YYYY-MM`. */
export function istMonthKey(instant: Date): string {
  return istDayKey(instant).slice(0, 7);
}

/** Midnight IST at the start of `YYYY-MM-DD`, as the instant it really is. */
export function istDayStart(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00.000${IST_OFFSET}`));
}

/**
 * The last instant of an IST day, for an inclusive range.
 *
 * A millisecond before the next midnight rather than the next midnight
 * itself, so a `$lte` on it cannot pick up a payment made at 00:00:00 the
 * following day.
 */
export function istDayEnd(day: string): Date {
  return new Date(istDayStart(day).getTime() + 24 * 60 * 60 * 1000 - 1);
}

/** Midnight IST on the 1st of `YYYY-MM`. */
export function istMonthStart(month: string): Date {
  return istDayStart(`${month}-01`);
}

/** Midnight IST on the 1st of the following month — exclusive. */
export function istMonthEnd(month: string): Date {
  const [year, mon] = month.split("-").map(Number);
  const nextYear = mon === 12 ? year + 1 : year;
  const nextMonth = mon === 12 ? 1 : mon + 1;
  return istMonthStart(`${nextYear}-${String(nextMonth).padStart(2, "0")}`);
}

/** Today's date in IST, as `YYYY-MM-DD`. */
export function istToday(): string {
  return istDayKey(new Date());
}
