/**
 * When a payment happened, as the message itself says.
 *
 * A bank's SMS is often delivered late - minutes, sometimes hours, after
 * the money moved - and an email later still. The message's arrival time
 * is then the wrong moment for the payment: a 1:39 AM purchase that texted
 * at 5:15 is not a 5:15 purchase, and when the delay crosses midnight or a
 * card's statement day it lands in the wrong day or the wrong bill. Most
 * banks write the moment into the text ("on 10/23/26, 1:39 AM", "on
 * 23-Oct-26 at 13:45"), so that is read first, and the arrival time is
 * only what is left when the text says nothing usable.
 *
 * Read cautiously. A date or time that cannot be the payment's - in the
 * future, or long before the message arrived - is a due date, an expiry or
 * a misread, and gives way to the arrival time rather than overriding it.
 */

import { istDayKey, istDayStart } from "../time";

/** How far after arrival a stated moment may still be: clocks disagree a little. */
const FUTURE_SLACK_MS = 10 * 60 * 1000;
/** How long before arrival a stated moment may be: no bank texts two months late. */
const MAX_DELAY_MS = 60 * 24 * 60 * 60 * 1000;
/** How far after a date its time is looked for, so a time elsewhere isn't paired with it. */
const TIME_AFTER_DATE_CHARS = 30;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
// The short name or the whole one, never the start of another word: "1
// separately" is not the 1st of September.
const MONTH_NAME =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?(?![a-z])";

interface Day {
  year: number;
  month: number;
  day: number;
}

/** A date found in the text: one or two readings of it, and where it ends. */
interface FoundDate {
  index: number;
  end: number;
  /** More than one when day and month could be either way round (03/04/26). */
  readings: Day[];
}

interface FoundTime {
  index: number;
  seconds: number;
}

// 2026-10-23: year first, never ambiguous.
const ISO_RE = /(?<![\d/.-])(20\d{2})-(\d{1,2})-(\d{1,2})(?![\d/.-])/g;
// 23-10-26, 23/10/2026, 23.10.2026, and the American 10/23/26 some apps send.
// Three parts with the same separator, so "valid till 10/27" and an amount
// like "172.00" are never one.
const NUMERIC_RE = /(?<![\d/.-])(\d{1,2})([-/.])(\d{1,2})\2(\d{4}|\d{2})(?![\d/.-])/g;
// 23 Oct 2026, 23-Oct-26, 23Oct26, 23rd October. A year is optional; one
// directly followed by ":" is the hour of a time ("23 Oct 01:39"), not a year.
const DAY_MONTH_RE = new RegExp(
  `(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?[\\s/-]*${MONTH_NAME}(?:[\\s,/-]*(\\d{4}|\\d{2})(?![\\d:]))?`,
  "gi"
);
// Oct 23, 2026. The year is required: "may 5" alone is too often English.
const MONTH_DAY_RE = new RegExp(`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, "gi");

// 1:39 AM, 01:39AM, 13:45, 13:45:10, 10:05:22 hrs. Not part of a longer
// run of digits and colons.
const TIME_RE = /(?<![\d:])(\d{1,2}):(\d{2})(?::(\d{2}))?(?![\d:])\s*(a\.?m\.?|p\.?m\.?|hrs|hours|ist)?/gi;
// 1.39 PM - a dot only with AM/PM after it, since "1.39" alone is an amount.
const DOTTED_TIME_RE = /(?<![\d.])(\d{1,2})\.(\d{2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi;

function isRealDay({ year, month, day }: Day): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function fullYear(raw: string): number {
  const value = Number(raw);
  return raw.length === 2 ? 2000 + value : value;
}

function dayKey({ year, month, day }: Day): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The year a yearless "23 Oct" means: this year, unless that is still to come. */
function yearFor(month: number, day: number, receivedAt: Date): number {
  const [year] = istDayKey(receivedAt).split("-").map(Number);
  const candidate = dayKey({ year, month, day });
  return candidate > istDayKey(receivedAt) ? year - 1 : year;
}

function findDates(text: string, receivedAt: Date): FoundDate[] {
  const found: FoundDate[] = [];
  // Kept even with no real reading: a date that can't exist (31-02-26) is a
  // garbled one, and its time should not then stand on its own.
  const keep = (index: number, end: number, readings: Day[]) => {
    found.push({ index, end, readings: readings.filter(isRealDay) });
  };

  for (const m of text.matchAll(ISO_RE)) {
    keep(m.index!, m.index! + m[0].length, [{ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }]);
  }
  for (const m of text.matchAll(NUMERIC_RE)) {
    const a = Number(m[1]);
    const b = Number(m[3]);
    const year = fullYear(m[4]);
    // Day first is the Indian way and the usual reading; month first is
    // what an app built on American defaults sends. When both fit, the
    // caller keeps the one nearest the message's arrival.
    const readings = [{ year, month: b, day: a }];
    if (a !== b) readings.push({ year, month: a, day: b });
    keep(m.index!, m.index! + m[0].length, readings);
  }
  for (const m of text.matchAll(DAY_MONTH_RE)) {
    const day = Number(m[1]);
    const month = MONTHS[m[2].toLowerCase().slice(0, 3)];
    const year = m[3] ? fullYear(m[3]) : yearFor(month, day, receivedAt);
    keep(m.index!, m.index! + m[0].length, [{ year, month, day }]);
  }
  for (const m of text.matchAll(MONTH_DAY_RE)) {
    const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
    keep(m.index!, m.index! + m[0].length, [{ year: Number(m[3]), month, day: Number(m[2]) }]);
  }

  return found.sort((a, b) => a.index - b.index);
}

function toSeconds(hourRaw: string, minuteRaw: string, secondRaw: string | undefined, suffix: string | undefined) {
  let hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = secondRaw ? Number(secondRaw) : 0;
  if (minute > 59 || second > 59) return null;

  const meridiem = suffix?.toLowerCase().replace(/\./g, "");
  if (meridiem === "am" || meridiem === "pm") {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (meridiem === "pm" && hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return hour * 3600 + minute * 60 + second;
}

function findTimes(text: string, dates: FoundDate[]): FoundTime[] {
  const insideDate = (index: number) => dates.some((date) => index >= date.index && index < date.end);
  const found: FoundTime[] = [];

  for (const m of text.matchAll(TIME_RE)) {
    if (insideDate(m.index!)) continue;
    const seconds = toSeconds(m[1], m[2], m[3], m[4]);
    if (seconds !== null) found.push({ index: m.index!, seconds });
  }
  for (const m of text.matchAll(DOTTED_TIME_RE)) {
    if (insideDate(m.index!)) continue;
    const seconds = toSeconds(m[1], m[2], undefined, m[3]);
    if (seconds !== null) found.push({ index: m.index!, seconds });
  }
  return found.sort((a, b) => a.index - b.index);
}

function fits(moment: Date, receivedAt: Date): boolean {
  const delta = receivedAt.getTime() - moment.getTime();
  return delta >= -FUTURE_SLACK_MS && delta <= MAX_DELAY_MS;
}

/** The candidate nearest the arrival among those that could be the payment's. */
function nearest(candidates: Date[], receivedAt: Date): Date | null {
  const fitting = candidates.filter((moment) => fits(moment, receivedAt));
  if (fitting.length === 0) return null;
  return fitting.reduce((best, moment) =>
    Math.abs(moment.getTime() - receivedAt.getTime()) < Math.abs(best.getTime() - receivedAt.getTime()) ? moment : best
  );
}

/**
 * The moment a message says its payment happened, in IST, or null when it
 * says nothing usable and the arrival time should stand.
 *
 * - The first date in the text, with the time written just after it (or
 *   else the first time anywhere).
 * - A date whose day and month could be either way round takes whichever
 *   reading is nearest the arrival without being after it.
 * - A time with no date is that time on the day the message arrived, or
 *   the day before when that would be in the future.
 * - A date with no time: the arrival time when it is the same day (it is
 *   closer than any guess); noon on an earlier day.
 * - Anything after the arrival (beyond a few minutes of clock drift) or
 *   more than sixty days before it is not the payment's moment: null.
 */
export function statedMoment(text: string | null | undefined, receivedAt: Date): Date | null {
  if (!text) return null;

  const dates = findDates(text, receivedAt);
  const times = findTimes(text, dates);
  const date = dates[0] ?? null;

  let time: FoundTime | null = null;
  if (date) {
    time =
      times.find((candidate) => candidate.index >= date.end && candidate.index - date.end <= TIME_AFTER_DATE_CHARS) ??
      times[0] ??
      null;
  } else {
    time = times[0] ?? null;
  }

  if (date) {
    if (date.readings.length === 0) return null;
    if (time) {
      const seconds = time.seconds;
      return nearest(
        date.readings.map((day) => new Date(istDayStart(dayKey(day)).getTime() + seconds * 1000)),
        receivedAt
      );
    }

    // No time: decide on the day alone. Readings are compared at the
    // start of their day so that "today" still fits an arrival at 00:05.
    const receivedDay = istDayKey(receivedAt);
    const day = nearest(
      date.readings.map((reading) => istDayStart(dayKey(reading))),
      receivedAt
    );
    if (!day) return null;
    if (istDayKey(day) === receivedDay) return null;
    return new Date(day.getTime() + 12 * 60 * 60 * 1000);
  }

  if (time) {
    const today = istDayStart(istDayKey(receivedAt));
    const sameDay = new Date(today.getTime() + time.seconds * 1000);
    const moment = sameDay.getTime() - receivedAt.getTime() > FUTURE_SLACK_MS
      ? new Date(sameDay.getTime() - 24 * 60 * 60 * 1000)
      : sameDay;
    return fits(moment, receivedAt) ? moment : null;
  }

  return null;
}

/** Whether a row's time came from its message's text rather than its arrival. */
export function hasStatedTime(occurredAt: Date, receivedAt: Date | null | undefined): boolean {
  return Boolean(receivedAt) && Math.abs(occurredAt.getTime() - receivedAt!.getTime()) > 60 * 1000;
}
