import { IST_OFFSET_MS, istDayKey } from "../../time";

/**
 * Where a payment falls in a credit card's billing cycle.
 *
 * Kept free of the database because every card feature is built on it and
 * the awkward cases — a statement day of 31 in February, a due date that
 * lands in the same month rather than the next — are far easier to check
 * directly than through an endpoint.
 */

export interface BillingCycle {
  /** First day of the cycle, in IST. The statement day itself. */
  start: Date;
  /** The cycle's last day: the day before the next statement is drawn. */
  endsOn: Date;
  /**
   * The day this cycle's bill is generated, which is also the day the next
   * cycle opens. Spending on that day is on the cycle it opens, not on the
   * bill drawn that morning.
   */
  statementOn: Date;
  /** When it has to be paid. Null if the card has no due day recorded. */
  dueOn: Date | null;
}

/** An IST date at midnight, from its parts, clamped to the month's length. */
function istDate(year: number, month: number, day: number): Date {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDay);
  return new Date(Date.UTC(year, month, safeDay) - IST_OFFSET_MS);
}

/** The IST calendar parts of an instant. */
function istParts(instant: Date): { year: number; month: number; day: number } {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

/**
 * The cycle a payment on `date` belongs to.
 *
 * The statement day opens a cycle rather than closing one. A bill drawn on
 * the 17th covers the month up to the 16th, so a purchase made on the 17th
 * is on the *next* bill — which is why the cycle runs from the statement
 * day to the day before the following one.
 *
 * This is the whole of "has my limit reset yet". On the morning the bill
 * arrives the counter goes back to zero, and what is spent that day counts
 * towards the cycle that has just opened.
 *
 * A statement day past the end of a short month clamps to its last day —
 * the 31st becomes the 28th in February — rather than spilling into March
 * and leaving February with no statement at all.
 */
export function cycleFor(
  card: { statementDay?: number | null; dueDay?: number | null },
  date: Date
): BillingCycle | null {
  if (!card.statementDay) return null;

  const { year, month } = istParts(date);

  // On or after this month's statement day, that statement opened the
  // cycle we are in. Before it, last month's did.
  const thisMonthStatement = istDate(year, month, card.statementDay);
  const start =
    date.getTime() >= thisMonthStatement.getTime()
      ? thisMonthStatement
      : istDate(year, month - 1, card.statementDay);

  const { year: sy, month: sm } = istParts(start);
  const statementOn = istDate(sy, sm + 1, card.statementDay);
  const endsOn = new Date(statementOn.getTime() - 24 * 60 * 60 * 1000);

  return { start, endsOn, statementOn, dueOn: dueDateFor(card, statementOn) };
}

/**
 * When a statement has to be paid.
 *
 * Usually the due day falls in the month after the statement — a bill on
 * the 12th paid by the 1st. But a card that statements on the 1st and is
 * due on the 20th is due in the same month, so the rule is simply: the
 * next time that day of the month comes round.
 */
function dueDateFor(
  card: { statementDay?: number | null; dueDay?: number | null },
  statementOn: Date
): Date | null {
  if (!card.dueDay) return null;

  const { year, month } = istParts(statementOn);
  const sameMonth = istDate(year, month, card.dueDay);

  return sameMonth.getTime() > statementOn.getTime()
    ? sameMonth
    : istDate(year, month + 1, card.dueDay);
}

/**
 * How many days before money spent today actually has to leave the account.
 *
 * This is the whole of "which card should I use": the same purchase on two
 * cards with different statement days can be a fortnight apart in when it
 * is really paid for.
 */
export function floatDays(
  card: { statementDay?: number | null; dueDay?: number | null },
  today: Date
): number | null {
  const cycle = cycleFor(card, today);
  if (!cycle?.dueOn) return null;

  const from = Date.parse(`${istDayKey(today)}T00:00:00.000+05:30`);
  const to = Date.parse(`${istDayKey(cycle.dueOn)}T00:00:00.000+05:30`);

  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}
