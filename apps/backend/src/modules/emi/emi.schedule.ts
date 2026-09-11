/**
 * The arithmetic behind an EMI plan, kept apart from the routes so it can
 * be checked against a real statement without a database.
 */

/**
 * The standard reducing-balance instalment:
 *
 *   monthly = P × r × (1+r)^n / ((1+r)^n − 1),   r = annual / 12 / 100
 *
 * Offered as a convenience only. Indian card EMIs are usually quoted at a
 * flat rate with GST charged on the interest, so this lands a few rupees
 * away from what the statement actually bills — which is why an entered
 * amount always wins over a computed one.
 */
export function monthlyInstalmentMinor(
  principalMinor: number,
  months: number,
  annualRatePct: number
): number {
  if (months <= 0) throw new Error("An EMI plan needs at least one month");
  // A no-cost EMI is the whole principal split evenly, and the formula
  // below divides by zero at a rate of zero.
  if (annualRatePct <= 0) return Math.round(principalMinor / months);

  const r = annualRatePct / 12 / 100;
  const growth = Math.pow(1 + r, months);
  return Math.round((principalMinor * r * growth) / (growth - 1));
}

/**
 * The same date next month, clamped to the end of a shorter one.
 *
 * A plan starting on the 31st bills on the 28th in February; letting the
 * date roll into March would put two instalments in one month and none in
 * the other.
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const targetMonth = result.getUTCMonth() + months;
  const dayOfMonth = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(targetMonth);

  const lastDayOfTarget = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(dayOfMonth, lastDayOfTarget));

  return result;
}

export interface ScheduledInstalment {
  seq: number;
  dueDate: Date;
  amountMinor: number;
}

/**
 * Every instalment the plan will bill.
 *
 * All of them carry the same amount, which is how a card actually bills an
 * EMI — no remainder is spread across the last one, because the total the
 * user owes is the monthly figure times the term, not the principal plus
 * some derived interest.
 */
export function buildSchedule(
  startDate: Date,
  months: number,
  monthlyAmountMinor: number
): ScheduledInstalment[] {
  const schedule: ScheduledInstalment[] = [];
  for (let i = 0; i < months; i += 1) {
    schedule.push({
      seq: i + 1,
      dueDate: addMonths(startDate, i),
      amountMinor: monthlyAmountMinor,
    });
  }
  return schedule;
}
