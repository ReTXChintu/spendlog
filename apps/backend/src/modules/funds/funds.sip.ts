/**
 * A SIP's history: what it started at, every change of amount since, and
 * the months nothing went in.
 *
 * Real SIPs are rarely one amount for ever. A step-up from 1,000 to 2,000,
 * a month the mandate bounced, three months paused while money was tight -
 * each changes how many units were bought and what the money earned, so
 * each has to be said. Kept as:
 *
 * - steps: amounts in force from a month on, oldest first. The first is
 *   what the SIP started at. A step may also move the SIP day, when the
 *   mandate was re-registered on another date.
 * - skips: single months with no instalment, as YYYY-MM.
 * - pauses: runs of months with none, from a month to a month (or until
 *   resumed). The maths reads them exactly as if every month in them were
 *   skipped; they're kept apart so "paused from March" stays one thing to
 *   undo, not seven.
 *
 * Everything here is by calendar month: "2,000 from May" is the May
 * instalment onwards whatever day in May the step's date names. Pure
 * functions, like funds.math.ts - no database, no clock.
 *
 * A SIP stored before steps existed has only `amountMinor`; it reads as
 * one step from its start, so old rows and new give the same figures.
 */

/// The least a SIP instalment can be, in paise: the same floor the SIP
/// amount has always had (funds.routes.ts, the app's form).
export const MIN_SIP_MINOR = 100;

export interface SipStep {
  /// YYYY-MM-DD; only its month matters.
  fromOn: string;
  amountMinor: number;
  /// The SIP day from this step on, when it moved. Null keeps the SIP's own.
  dayOfMonth?: number | null;
}

export interface SipPause {
  fromOn: string;
  /// The last month paused. Null is paused until resumed.
  toOn?: string | null;
}

export interface SipPlan {
  /// What it started at - the first step's amount.
  amountMinor: number;
  dayOfMonth: number;
  startOn: string;
  endOn?: string | null;
  active?: boolean;
  steps?: SipStep[] | null;
  skips?: string[] | null;
  pauses?: SipPause[] | null;
}

export const monthOf = (day: string) => day.slice(0, 7);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (value: string) => MONTH.test(value);

export function addMonths(month: string, count: number): string {
  const [year, mon] = month.split("-").map(Number);
  const index = year * 12 + (mon - 1) + count;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

function daysInMonth(month: string): number {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon, 0)).getUTCDate();
}

/** The month's last day, YYYY-MM-DD. */
export function monthEnd(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** The SIP day in a month; the 31st is the last day of a shorter one. */
export function dueIn(month: string, dayOfMonth: number): string {
  return `${month}-${String(Math.min(dayOfMonth, daysInMonth(month))).padStart(2, "0")}`;
}

const byFromOn = (a: { fromOn: string }, b: { fromOn: string }) => (a.fromOn < b.fromOn ? -1 : a.fromOn > b.fromOn ? 1 : 0);

/**
 * The steps, oldest first, the first from the start. Read defensively:
 * a SIP with no steps (stored before there were any) is one step at its
 * amount, and whatever date the first step names, it is the amount the
 * SIP started at.
 */
export function sipSteps(sip: SipPlan): SipStep[] {
  const given = (sip.steps ?? []).filter((step) => step && typeof step.fromOn === "string" && step.amountMinor > 0);
  if (given.length === 0) return [{ fromOn: sip.startOn, amountMinor: sip.amountMinor, dayOfMonth: null }];
  const sorted = [...given].sort(byFromOn).map((step) => ({ ...step, dayOfMonth: step.dayOfMonth ?? null }));
  return [{ ...sorted[0], fromOn: sip.startOn }, ...sorted.slice(1)];
}

/** The amount and day in force for an instalment in `month`. */
export function stepFor(sip: SipPlan, month: string): { amountMinor: number; dayOfMonth: number } {
  const steps = sipSteps(sip);
  let current = steps[0];
  for (const step of steps) if (monthOf(step.fromOn) <= month) current = step;
  return { amountMinor: current.amountMinor, dayOfMonth: current.dayOfMonth ?? sip.dayOfMonth };
}

/** The pauses as month ranges, oldest first; `to` null is until resumed. */
export function pauseRanges(sip: Pick<SipPlan, "pauses">): { from: string; to: string | null }[] {
  return (sip.pauses ?? [])
    .filter((pause) => pause && typeof pause.fromOn === "string")
    .map((pause) => ({ from: monthOf(pause.fromOn), to: pause.toOn ? monthOf(pause.toOn) : null }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

export function isPaused(sip: Pick<SipPlan, "pauses">, month: string): boolean {
  return pauseRanges(sip).some((range) => range.from <= month && (range.to === null || range.to >= month));
}

export function isSkipped(sip: Pick<SipPlan, "skips">, month: string): boolean {
  return (sip.skips ?? []).includes(month);
}

export type SlotState = "due" | "skipped" | "paused";

/** One month's instalment day, skipped or not. */
export interface SipSlot {
  month: string;
  due: string;
  /// What the step in force says, even for a month that was skipped.
  amountMinor: number;
  state: SlotState;
}

/**
 * Every month the SIP has an instalment day, from its start up to `until`
 * (or its end, when that's sooner). A skipped or paused month is still
 * listed, marked, so a debit paid in it anyway has a month to stand for.
 * The first month is left out when its SIP day falls before the start.
 */
export function sipSlots(sip: SipPlan, until: string): SipSlot[] {
  const last = sip.endOn && sip.endOn < until ? sip.endOn : until;
  const slots: SipSlot[] = [];
  let month = monthOf(sip.startOn);
  for (let guard = 0; guard < 1200; guard += 1, month = addMonths(month, 1)) {
    const step = stepFor(sip, month);
    const due = dueIn(month, step.dayOfMonth);
    if (due > last) break;
    if (due < sip.startOn) continue;
    const state: SlotState = isPaused(sip, month) ? "paused" : isSkipped(sip, month) ? "skipped" : "due";
    slots.push({ month, due, amountMinor: step.amountMinor, state });
  }
  return slots;
}

/** The amount a debit on `day` would be expected to be, for matching it. */
export function sipAmountOn(sip: SipPlan, day: string): number {
  return stepFor(sip, monthOf(day)).amountMinor;
}

/** "Can't be outside the SIP" for a month, given its start and end. */
function outside(sip: Pick<SipPlan, "startOn" | "endOn">, month: string): boolean {
  return month < monthOf(sip.startOn) || (!!sip.endOn && month > monthOf(sip.endOn));
}

/**
 * The first thing wrong with a SIP's history, in words for the user, or
 * null. Run on the shape about to be stored, after the first step has
 * been put at the start.
 */
export function sipProblem(sip: SipPlan): string | null {
  const steps = sip.steps ?? [];
  const stepMonths = new Set<string>();
  for (const step of steps) {
    if (!(step.amountMinor >= MIN_SIP_MINOR)) return "Each SIP amount has to be at least ₹1.";
    const month = monthOf(step.fromOn);
    if (outside(sip, month)) return "An amount change has to fall between the SIP's start and its end.";
    if (stepMonths.has(month)) return "Two amount changes can't be in the same month.";
    stepMonths.add(month);
  }

  const skips = new Set<string>();
  for (const month of sip.skips ?? []) {
    if (!isMonth(month)) return "A skipped month is written YYYY-MM.";
    if (outside(sip, month)) return "A skipped month has to fall between the SIP's start and its end.";
    if (skips.has(month)) return "The same month is skipped twice.";
    skips.add(month);
  }

  const ranges = pauseRanges(sip);
  for (const [index, range] of ranges.entries()) {
    if (outside(sip, range.from)) return "A pause has to start between the SIP's start and its end.";
    if (range.to !== null && range.to < range.from) return "A pause can't end before it starts.";
    const next = ranges[index + 1];
    if (next && (range.to === null || range.to >= next.from)) return "Two pauses can't overlap.";
  }
  return null;
}

/** The SIP terms a request may send: an amount, steps, or both. */
export interface SipInput {
  amountMinor?: number | null;
  dayOfMonth: number;
  startOn: string;
  endOn?: string | null;
  active?: boolean;
  steps?: SipStep[] | null;
  skips?: string[] | null;
  pauses?: SipPause[] | null;
}

export interface StoredSip {
  amountMinor: number;
  dayOfMonth: number;
  startOn: string;
  endOn: string | null;
  active: boolean;
  steps: { fromOn: string; amountMinor: number; dayOfMonth: number | null }[];
  skips: string[];
  pauses: { fromOn: string; toOn: string | null }[];
}

/** Steps in a row that change nothing - the same amount on the same day - folded into the one before. */
function withoutRepeats(steps: StoredSip["steps"], baseDay: number): StoredSip["steps"] {
  const out: StoredSip["steps"] = [];
  for (const step of steps) {
    const before = out[out.length - 1];
    if (before && before.amountMinor === step.amountMinor && (before.dayOfMonth ?? baseDay) === (step.dayOfMonth ?? baseDay)) {
      continue;
    }
    out.push(step);
  }
  return out;
}

/**
 * A SIP as it will be stored, from what a request sent and what was
 * stored before (when editing).
 *
 * `amountMinor` is what the SIP started at. `steps` may list every amount
 * or only the changes after the start; when the first one is later than
 * the start month, the starting amount goes before it. Leave `steps`,
 * `skips` or `pauses` out of an edit and the stored ones are kept - so an
 * app that only knows about one amount can still change the SIP day or
 * stop it without wiping its history - less any that the new start or
 * end leaves outside the SIP.
 *
 * Stopped without an end date means stopped today, as before.
 */
export function sipToStore(input: SipInput, today: string, stored?: SipPlan | null): StoredSip | { error: string } {
  const active = input.active ?? true;
  const endOn = input.endOn ?? (active ? null : today);
  const frame = { startOn: input.startOn, endOn };
  const startMonth = monthOf(input.startOn);

  let steps: StoredSip["steps"];
  if (input.steps) {
    const sorted = [...input.steps].sort(byFromOn).map((step) => ({
      fromOn: step.fromOn,
      amountMinor: step.amountMinor,
      dayOfMonth: step.dayOfMonth ?? null,
    }));
    if (sorted.length === 0 || monthOf(sorted[0].fromOn) > startMonth) {
      if (input.amountMinor == null) return { error: "Say what the SIP started at." };
      sorted.unshift({ fromOn: input.startOn, amountMinor: input.amountMinor, dayOfMonth: null });
    }
    steps = sorted;
  } else {
    const startAmount = input.amountMinor ?? (stored ? sipSteps(stored)[0].amountMinor : null);
    if (startAmount == null) return { error: "Enter the SIP amount." };
    const later = stored
      ? sipSteps(stored)
          .slice(1)
          .filter((step) => monthOf(step.fromOn) > startMonth && !outside(frame, monthOf(step.fromOn)))
          .map((step) => ({ fromOn: step.fromOn, amountMinor: step.amountMinor, dayOfMonth: step.dayOfMonth ?? null }))
      : [];
    steps = [{ fromOn: input.startOn, amountMinor: startAmount, dayOfMonth: null }, ...later];
  }

  const skips = input.skips ?? (stored?.skips ?? []).filter((month) => isMonth(month) && !outside(frame, month));
  const pauses = (input.pauses ?? (stored?.pauses ?? []).filter((pause) => !outside(frame, monthOf(pause.fromOn)))).map(
    (pause) => ({ fromOn: pause.fromOn, toOn: pause.toOn ?? null })
  );

  const draft = {
    dayOfMonth: input.dayOfMonth,
    startOn: input.startOn,
    endOn,
    active,
    amountMinor: steps[0].amountMinor,
    steps,
    skips,
    pauses,
  };
  const problem = sipProblem(draft);
  if (problem) return { error: problem };

  // Only now is the first step put at the start: checked first, so one
  // that named a month before the start is refused rather than moved.
  const placed = [{ ...steps[0], fromOn: input.startOn }, ...steps.slice(1)];
  const folded = withoutRepeats(placed, input.dayOfMonth);
  return {
    ...draft,
    amountMinor: folded[0].amountMinor,
    steps: folded,
    skips: [...skips].sort(),
    pauses: [...pauses].sort(byFromOn),
  };
}

/** A stored SIP back as input, to edit one part of it. */
export function sipAsInput(sip: SipPlan): SipInput {
  return {
    amountMinor: sipSteps(sip)[0].amountMinor,
    dayOfMonth: sip.dayOfMonth,
    startOn: sip.startOn,
    endOn: sip.endOn ?? null,
    active: sip.active ?? true,
    steps: sipSteps(sip),
    skips: [...(sip.skips ?? [])],
    pauses: (sip.pauses ?? []).map((pause) => ({ fromOn: pause.fromOn, toOn: pause.toOn ?? null })),
  };
}

/**
 * A step-up or step-down from `month`: the amount from then on, until the
 * next change already there. In the start month it changes what the SIP
 * started at; on a month with a change already, it replaces that one.
 */
export function withAmountFrom(sip: SipPlan, month: string, amountMinor: number, dayOfMonth?: number | null): SipInput {
  const input = sipAsInput(sip);
  const startMonth = monthOf(sip.startOn);
  const target = month <= startMonth ? startMonth : month;
  const others = (input.steps ?? []).filter((step) => monthOf(step.fromOn) !== target);
  const fromOn = target === startMonth ? sip.startOn : `${target}-01`;
  const kept = (input.steps ?? []).find((step) => monthOf(step.fromOn) === target);
  return {
    ...input,
    steps: [...others, { fromOn, amountMinor, dayOfMonth: dayOfMonth === undefined ? kept?.dayOfMonth ?? null : dayOfMonth }],
  };
}

/** `month` marked skipped. Already skipped, or paused, changes nothing. */
export function withSkip(sip: SipPlan, month: string): SipInput {
  const input = sipAsInput(sip);
  if (isSkipped(sip, month) || isPaused(sip, month)) return input;
  return { ...input, skips: [...(input.skips ?? []), month] };
}

/**
 * `month` not skipped any more. Inside a pause, the pause is split around
 * it: that one month goes in, the rest stay paused.
 */
export function withoutSkip(sip: SipPlan, month: string): SipInput {
  const input = sipAsInput(sip);
  const pauses: SipPause[] = [];
  for (const pause of input.pauses ?? []) {
    const from = monthOf(pause.fromOn);
    const to = pause.toOn ? monthOf(pause.toOn) : null;
    if (from > month || (to !== null && to < month)) {
      pauses.push(pause);
      continue;
    }
    if (from < month) pauses.push({ fromOn: pause.fromOn, toOn: monthEnd(addMonths(month, -1)) });
    if (to === null || to > month) pauses.push({ fromOn: `${addMonths(month, 1)}-01`, toOn: pause.toOn ?? null });
  }
  return { ...input, skips: (input.skips ?? []).filter((skipped) => skipped !== month), pauses };
}

/**
 * Paused from `fromMonth` to `toMonth` (or until resumed). Joined with any
 * pause it overlaps or touches, so the months paused are one run.
 */
export function withPause(sip: SipPlan, fromMonth: string, toMonth: string | null): SipInput {
  const input = sipAsInput(sip);
  const ranges = [...pauseRanges(input), { from: fromMonth, to: toMonth }].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : 0
  );
  const merged: { from: string; to: string | null }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && (last.to === null || addMonths(last.to, 1) >= range.from)) {
      last.to = last.to === null || range.to === null ? null : last.to > range.to ? last.to : range.to;
    } else {
      merged.push({ ...range });
    }
  }
  return {
    ...input,
    pauses: merged.map((range) => ({ fromOn: `${range.from}-01`, toOn: range.to === null ? null : monthEnd(range.to) })),
  };
}

/** Going in again from `month`: no pause from then on. Pauses that start later are dropped. */
export function resumedFrom(sip: SipPlan, month: string): SipInput {
  const input = sipAsInput(sip);
  const pauses: SipPause[] = [];
  for (const pause of input.pauses ?? []) {
    const from = monthOf(pause.fromOn);
    const to = pause.toOn ? monthOf(pause.toOn) : null;
    if (from >= month) continue;
    pauses.push(to === null || to >= month ? { fromOn: pause.fromOn, toOn: monthEnd(addMonths(month, -1)) } : pause);
  }
  return { ...input, pauses };
}
