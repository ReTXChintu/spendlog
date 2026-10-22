import { IST_OFFSET_MS } from "../../time";

/**
 * When a subscription renews, and what it comes to a month - arithmetic
 * only, so it can be checked without a database.
 *
 * Dates are IST calendar days as YYYY-MM-DD, like everywhere else a day
 * is a day rather than an instant. A monthly plan renews on the same day
 * of the month it started on, falling back to a short month's last day
 * (started on the 31st: 28 Feb, then 31 Mar again) - counted from the
 * start date each time, so it never drifts the way "add a month to the
 * last date" would.
 */

export const SUBSCRIPTION_UNITS = ["day", "week", "month", "year"] as const;
export type SubscriptionUnit = (typeof SUBSCRIPTION_UNITS)[number];

export interface Frequency {
  every: number;
  unit: SubscriptionUnit;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parts(day: string): { year: number; month: number; date: number } {
  const [year, month, date] = day.split("-").map(Number);
  return { year, month, date };
}

/** YYYY-MM-DD from a UTC-midnight instant (the day arithmetic is done in UTC on purpose). */
function key(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

function utc(year: number, monthIndex: number, date: number): Date {
  return new Date(Date.UTC(year, monthIndex, date));
}

function daysInMonth(year: number, monthIndex: number): number {
  return utc(year, monthIndex + 1, 0).getUTCDate();
}

/** Days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(...dateArgs(b)).getTime() - utc(...dateArgs(a)).getTime()) / DAY_MS);
}

function dateArgs(day: string): [number, number, number] {
  const { year, month, date } = parts(day);
  return [year, month - 1, date];
}

/** The day `n` days after `day`. */
export function addDays(day: string, n: number): string {
  return key(new Date(utc(...dateArgs(day)).getTime() + n * DAY_MS));
}

/**
 * The n-th renewal after the start: the start itself for n = 0. Months
 * and years keep the start's day of the month where the month has it.
 */
export function renewalAt(startedOn: string, frequency: Frequency, n: number): string {
  const { year, month, date } = parts(startedOn);
  const steps = n * frequency.every;
  switch (frequency.unit) {
    case "day":
      return addDays(startedOn, steps);
    case "week":
      return addDays(startedOn, steps * 7);
    case "month": {
      const monthIndex = month - 1 + steps;
      const y = year + Math.floor(monthIndex / 12);
      const m = ((monthIndex % 12) + 12) % 12;
      return key(utc(y, m, Math.min(date, daysInMonth(y, m))));
    }
    case "year": {
      const y = year + steps;
      return key(utc(y, month - 1, Math.min(date, daysInMonth(y, month - 1))));
    }
  }
}

/** The first renewal on or after `day`. */
export function firstRenewalFrom(startedOn: string, frequency: Frequency, day: string): string {
  if (day <= startedOn) return startedOn;
  // A guess from the elapsed time, then stepped to the first that fits -
  // the guess can be a step early around short months.
  const elapsed = daysBetween(startedOn, day);
  let n = Math.max(0, Math.floor(elapsed / approxDays(frequency)) - 1);
  while (renewalAt(startedOn, frequency, n) < day) n += 1;
  return renewalAt(startedOn, frequency, n);
}

/** The renewal straight after `day`. */
export function renewalAfter(startedOn: string, frequency: Frequency, day: string): string {
  const onOrAfter = firstRenewalFrom(startedOn, frequency, day);
  if (onOrAfter > day) return onOrAfter;
  const n = indexOf(startedOn, frequency, onOrAfter);
  return renewalAt(startedOn, frequency, n + 1);
}

function indexOf(startedOn: string, frequency: Frequency, day: string): number {
  let n = Math.max(0, Math.floor(daysBetween(startedOn, day) / approxDays(frequency)) - 1);
  while (renewalAt(startedOn, frequency, n) < day) n += 1;
  return n;
}

/** Every renewal from `from` to `to`, both inclusive. */
export function renewalsBetween(startedOn: string, frequency: Frequency, from: string, to: string): string[] {
  const days: string[] = [];
  if (to < from) return days;
  let day = firstRenewalFrom(startedOn, frequency, from);
  let n = indexOf(startedOn, frequency, day);
  while (day <= to) {
    days.push(day);
    n += 1;
    day = renewalAt(startedOn, frequency, n);
  }
  return days;
}

/** How many days a cycle takes, on average. */
export function approxDays(frequency: Frequency): number {
  const perUnit = { day: 1, week: 7, month: 365.25 / 12, year: 365.25 }[frequency.unit];
  return perUnit * frequency.every;
}

/** What a cycle's price comes to a month, on average: ₹1,499 a year is ₹125 a month. */
export function monthlyEquivalentMinor(amountMinor: number, frequency: Frequency): number {
  return Math.round((amountMinor * (365.25 / 12)) / approxDays(frequency));
}

/** And a year. */
export function yearlyEquivalentMinor(amountMinor: number, frequency: Frequency): number {
  return Math.round((amountMinor * 365.25) / approxDays(frequency));
}

/** "Monthly", "Every 3 months", "Weekly", "Every 2 weeks", "Yearly", "Every 45 days". */
export function frequencyLabel(frequency: Frequency): string {
  const { every, unit } = frequency;
  if (every === 1) return { day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" }[unit];
  if (unit === "month" && every === 3) return "Quarterly";
  if (unit === "month" && every === 6) return "Half-yearly";
  if (unit === "month" && every === 12) return "Yearly";
  return `Every ${every} ${unit}s`;
}

/** The standard choices, as the app offers them, from a frequency - or "custom". */
export function frequencyPreset(frequency: Frequency): "weekly" | "monthly" | "quarterly" | "half-yearly" | "yearly" | "custom" {
  const { every, unit } = frequency;
  if (unit === "week" && every === 1) return "weekly";
  if (unit === "month" && every === 1) return "monthly";
  if (unit === "month" && every === 3) return "quarterly";
  if (unit === "month" && every === 6) return "half-yearly";
  if ((unit === "month" && every === 12) || (unit === "year" && every === 1)) return "yearly";
  return "custom";
}

/**
 * The frequency a run of charges suggests, from the days between them -
 * or null when they are too irregular to be a subscription. Weekly,
 * monthly, quarterly, half-yearly and yearly, with a few days' slack for
 * the day a card is charged moving around a weekend.
 */
export function frequencyFromGaps(gapsInDays: number[]): Frequency | null {
  if (gapsInDays.length === 0) return null;
  const sorted = [...gapsInDays].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const fits = (lo: number, hi: number) => median >= lo && median <= hi && sorted.every((gap) => gap >= lo - 2 && gap <= hi + 2);
  if (fits(6, 8)) return { every: 1, unit: "week" };
  if (fits(13, 15)) return { every: 2, unit: "week" };
  if (fits(27, 33)) return { every: 1, unit: "month" };
  if (fits(85, 97)) return { every: 3, unit: "month" };
  if (fits(176, 190)) return { every: 6, unit: "month" };
  if (fits(355, 376)) return { every: 1, unit: "year" };
  return null;
}

/** Today in IST from an instant - the day the schedule is measured against. */
export function todayKey(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
