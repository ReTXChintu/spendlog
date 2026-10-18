import { FundTxnKind } from "../../types";
import { SipPlan, sipSlots } from "./funds.sip";

/**
 * A mutual fund holding, worked out from what the user told us.
 *
 * Pure functions over days written YYYY-MM-DD and a NAV series, oldest
 * first. Nothing here reads the database or the clock, so every rule about
 * which instalment counts is a test away from being checked.
 *
 * Money is in paise everywhere except NAVs, which are rupees per unit as
 * AMFI publishes them. Returns are fractions (0.12 is 12%); the routes
 * turn them into percentages.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/// A year, for annualising. 365 rather than 365.25 because that is what
/// XIRR in every spreadsheet and fund house statement uses.
const YEAR_DAYS = 365;

export interface NavSeries {
  days: string[];
  navs: number[];
}

export interface NavPoint {
  day: string;
  nav: number;
}

const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fromTime = (time: number) => new Date(time).toISOString().slice(0, 10);

export function addDays(day: string, count: number): string {
  return fromTime(toTime(day) + count * DAY_MS);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toTime(to) - toTime(from)) / DAY_MS);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The same date `count` years on; 29 Feb becomes 28 Feb in a common year. */
export function addYears(day: string, count: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const target = year + count;
  const clamped = Math.min(date, daysInMonth(target, month));
  return `${target}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/** Index of the first day >= `day`, or days.length. */
function lowerBound(days: string[], day: string): number {
  let low = 0;
  let high = days.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (days[mid] < day) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The NAV an order placed on `day` gets: that day's, or the next one
 * published when the day was a weekend or holiday. Null when none is out
 * yet.
 */
export function navOnOrAfter(series: NavSeries, day: string): NavPoint | null {
  const index = lowerBound(series.days, day);
  return index < series.days.length ? { day: series.days[index], nav: series.navs[index] } : null;
}

/** The last NAV known on `day`. Null before the fund existed. */
export function navOnOrBefore(series: NavSeries, day: string): NavPoint | null {
  const index = lowerBound(series.days, day);
  if (index < series.days.length && series.days[index] === day) return { day, nav: series.navs[index] };
  return index > 0 ? { day: series.days[index - 1], nav: series.navs[index - 1] } : null;
}

export function latestNav(series: NavSeries): NavPoint | null {
  const last = series.days.length - 1;
  return last >= 0 ? { day: series.days[last], nav: series.navs[last] } : null;
}

/** The NAV before the latest, for the day's change. */
export function previousNav(series: NavSeries): NavPoint | null {
  const index = series.days.length - 2;
  return index >= 0 ? { day: series.days[index], nav: series.navs[index] } : null;
}

/**
 * Compound annual growth from one value to another over `days`. Under a
 * year it is still annualised; callers only ask for whole years.
 */
export function cagr(start: number, end: number, days: number): number | null {
  if (!(start > 0) || !(end > 0) || !(days > 0)) return null;
  return Math.pow(end / start, YEAR_DAYS / days) - 1;
}

/// How far the NAV found can be from the date asked for before the
/// history is treated as having a hole there rather than a holiday.
const GAP_TOLERANCE_DAYS = 10;

/**
 * The fund's own return over the last `years`, annualised: latest NAV
 * against the one on the same date `years` earlier, or the last trading
 * day before it. Null when the fund is younger than that.
 */
export function trailingReturn(series: NavSeries, years: number): number | null {
  const end = latestNav(series);
  if (!end) return null;
  const target = addYears(end.day, -years);
  const start = navOnOrBefore(series, target);
  if (!start || daysBetween(start.day, target) > GAP_TOLERANCE_DAYS) return null;
  return cagr(start.nav, end.nav, daysBetween(start.day, end.day));
}

export interface CashFlow {
  day: string;
  /// Negative is money put in, positive money taken out (or the value today).
  amount: number;
}

/**
 * The annual rate that makes every flow's present value add up to zero:
 * the return the user's own money actually earned, timing and all.
 *
 * Newton's method from 10%, which is where most funds land in a few steps;
 * bisection when Newton wanders off (a huge loss, a near-zero derivative),
 * which always gets there because the sum falls steadily as the rate rises
 * whenever every outflow comes before the final value. Null when there is
 * nothing to solve: no money in, no money out, or every flow on one day.
 */
export function xirr(flows: CashFlow[]): number | null {
  const usable = flows.filter((flow) => Number.isFinite(flow.amount) && flow.amount !== 0);
  if (!usable.some((flow) => flow.amount < 0) || !usable.some((flow) => flow.amount > 0)) return null;

  const first = usable.reduce((earliest, flow) => (flow.day < earliest ? flow.day : earliest), usable[0].day);
  const points = usable.map((flow) => ({ years: daysBetween(first, flow.day) / YEAR_DAYS, amount: flow.amount }));
  if (points.every((point) => point.years === 0)) return null;

  const scale = points.reduce((sum, point) => sum + Math.abs(point.amount), 0);
  const value = (rate: number) => points.reduce((sum, p) => sum + p.amount / Math.pow(1 + rate, p.years), 0);
  const slope = (rate: number) =>
    points.reduce((sum, p) => sum - (p.years * p.amount) / Math.pow(1 + rate, p.years + 1), 0);

  let rate = 0.1;
  for (let step = 0; step < 100; step += 1) {
    const f = value(rate);
    if (Math.abs(f) < scale * 1e-10) return rate;
    const d = slope(rate);
    if (!Number.isFinite(d) || d === 0) break;
    const next = rate - f / d;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - rate) < 1e-12) return next;
    rate = next;
  }

  // Bisection. The low end is a near-total loss; the high end is pushed
  // out until the sign changes, for the odd fund that doubled in a month.
  let low = -0.999999;
  let high = 1;
  while (value(high) > 0 && high < 1e6) high *= 10;
  if (Math.sign(value(low)) === Math.sign(value(high))) return null;
  for (let step = 0; step < 300; step += 1) {
    const mid = (low + high) / 2;
    const f = value(mid);
    if (Math.abs(f) < scale * 1e-10 || high - low < 1e-12) return mid;
    if (Math.sign(f) === Math.sign(value(low))) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export type { SipPlan } from "./funds.sip";

/**
 * Every date a SIP falls due from its start up to `until`, after `after`
 * when given - less the months skipped or paused. A SIP on the 31st falls
 * on the last day of shorter months.
 */
export function sipDates(sip: SipPlan, until: string, after?: string | null): string[] {
  return sipSlots(sip, until)
    .filter((slot) => slot.state === "due" && !(after && slot.due <= after))
    .map((slot) => slot.due);
}

export interface OpeningInput {
  units: number;
  investedMinor: number;
  asOf: string;
  firstOn?: string | null;
}

/** A debit linked to the holding, by hand or through its SIP commitment. */
export interface LinkedInput {
  transactionId: string;
  /// The FundTxn behind it; absent for one that came through a commitment.
  txnId?: string | null;
  on: string;
  amountMinor: number;
  via: "link" | "commitment";
}

export interface ManualInput {
  txnId: string;
  kind: "MANUAL_BUY" | "REDEEM";
  on: string;
  amountMinor: number;
  units?: number | null;
}

export interface LedgerInput {
  sip?: SipPlan | null;
  opening?: OpeningInput | null;
  linked?: LinkedInput[];
  manual?: ManualInput[];
  series: NavSeries;
  today: string;
}

export interface LedgerEntry {
  kind: FundTxnKind;
  /// The day it happened - for a scheduled SIP, the day it was due.
  on: string;
  /// The NAV it was bought or sold at, and that NAV's own day.
  navDay: string | null;
  nav: number | null;
  amountMinor: number;
  units: number;
  /// Whether it is in the totals. An entry inside the opening snapshot is
  /// shown, but the snapshot already holds it.
  counted: boolean;
  /// Bought, but its NAV isn't out yet - in nothing until it is.
  pending: boolean;
  note: string | null;
  transactionId: string | null;
  txnId: string | null;
  via: "link" | "commitment" | null;
  /// The SIP month this stands for: a scheduled instalment's own, or the
  /// one a linked debit replaced. Null for anything extra.
  month: string | null;
  /// What the SIP said that month's instalment would be - on a linked
  /// debit, to set beside what was really paid.
  plannedMinor: number | null;
  /// A linked debit paid in a month marked skipped or paused. It still
  /// counts; see buildLedger.
  inSkippedMonth: boolean;
}

const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;

/// How far a linked debit can be from a scheduled instalment and still be
/// that instalment. Half a month either way: a SIP on the 1st debited on
/// the 31st is the same instalment, a calendar month apart.
export const SAME_INSTALMENT_DAYS = 15;

/**
 * Everything that happened to a holding, in order, with the rules that
 * stop money being counted twice:
 *
 * - The opening snapshot covers everything up to and including its day.
 *   Scheduled instalments start after it; a linked debit or manual entry
 *   on or before it is shown but not counted.
 * - Each month's instalment is the amount of the SIP step in force that
 *   month (funds.sip.ts). A month skipped or paused has none.
 * - A scheduled instalment exists only once its NAV does - the next NAV
 *   published on or after its due date, for a holiday.
 * - A linked debit is the real thing, so it replaces the scheduled
 *   instalment nearest to it within SAME_INSTALMENT_DAYS, at whatever it
 *   really came to. One debit replaces one instalment; a second debit in
 *   the same cycle is an extra purchase and is added.
 * - A debit paid in a month marked skipped or paused is that month's
 *   instalment after all: money that left the bank bought units, whatever
 *   the plan said. The skip stays stored, so unlinking the debit brings
 *   it back. Skipped months are matched like any other for this, which
 *   also stops such a debit being taken for a neighbouring month's.
 * - The same transaction linked by hand and through a commitment counts once.
 */
export function buildLedger(input: LedgerInput): LedgerEntry[] {
  const { series, today, opening } = input;
  const cutoff = opening?.asOf ?? null;
  const entries: LedgerEntry[] = [];

  const base = {
    pending: false,
    note: null,
    transactionId: null,
    txnId: null,
    via: null,
    month: null,
    plannedMinor: null,
    inSkippedMonth: false,
  } as const;

  if (opening) {
    const at = navOnOrBefore(series, opening.asOf);
    entries.push({
      ...base,
      kind: "OPENING",
      on: opening.asOf,
      navDay: at?.day ?? null,
      nav: at?.nav ?? null,
      amountMinor: opening.investedMinor,
      units: opening.units,
      counted: true,
    });
  }

  // Linked debits, each transaction once, oldest first.
  const seen = new Set<string>();
  const linked = [...(input.linked ?? [])]
    .sort((a, b) => (a.on === b.on ? (a.via === "link" ? -1 : 1) : a.on < b.on ? -1 : 1))
    .filter((link) => !seen.has(link.transactionId) && seen.add(link.transactionId));

  // Every instalment day after the snapshot, skipped months included so a
  // debit paid in one has a month to stand for. One whose NAV isn't out
  // can still be replaced; it just isn't added until it is.
  const slots = input.sip
    ? sipSlots(input.sip, today)
        .filter((slot) => cutoff === null || slot.due > cutoff)
        .map((slot) => ({ ...slot, at: navOnOrAfter(series, slot.due), replaced: false }))
    : [];

  for (const link of linked) {
    const covered = cutoff !== null && link.on <= cutoff;
    let nearest: (typeof slots)[number] | null = null;
    if (!covered) {
      for (const slot of slots) {
        if (slot.replaced) continue;
        const distance = Math.abs(daysBetween(slot.due, link.on));
        if (distance > SAME_INSTALMENT_DAYS) continue;
        if (!nearest || distance < Math.abs(daysBetween(nearest.due, link.on))) nearest = slot;
      }
      if (nearest) nearest.replaced = true;
    }

    const at = navOnOrAfter(series, link.on);
    const inSkippedMonth = !!nearest && nearest.state !== "due";
    const differs = !!nearest && Math.abs(link.amountMinor - nearest.amountMinor) >= 100;
    entries.push({
      ...base,
      kind: "LINKED",
      on: link.on,
      navDay: at?.day ?? null,
      nav: at?.nav ?? null,
      amountMinor: link.amountMinor,
      units: at && !covered ? link.amountMinor / 100 / at.nav : 0,
      counted: !covered,
      pending: !covered && !at,
      note: covered
        ? "Inside the opening balance"
        : !at
          ? "Waiting for the NAV"
          : inSkippedMonth
            ? `Paid in a month marked ${nearest!.state}, so it counts as that month's instalment`
            : differs
              ? `${rupees(link.amountMinor)} paid vs ${rupees(nearest!.amountMinor)} planned`
              : null,
      transactionId: link.transactionId,
      txnId: link.txnId ?? null,
      via: link.via,
      month: nearest?.month ?? null,
      plannedMinor: nearest?.amountMinor ?? null,
      inSkippedMonth,
    });
  }

  for (const slot of slots) {
    if (slot.replaced || slot.state !== "due" || !slot.at || slot.at.day > today) continue;
    entries.push({
      ...base,
      kind: "SIP_SCHEDULED",
      on: slot.due,
      navDay: slot.at.day,
      nav: slot.at.nav,
      amountMinor: slot.amountMinor,
      units: slot.amountMinor / 100 / slot.at.nav,
      counted: true,
      month: slot.month,
      plannedMinor: slot.amountMinor,
    });
  }

  for (const manual of input.manual ?? []) {
    const covered = cutoff !== null && manual.on <= cutoff;
    const at = navOnOrAfter(series, manual.on);
    const givenUnits = manual.units != null && manual.units > 0 ? manual.units : null;
    const units = givenUnits ?? (at ? manual.amountMinor / 100 / at.nav : 0);
    const amountMinor = manual.amountMinor > 0 ? manual.amountMinor : at ? Math.round(units * at.nav * 100) : 0;
    const pending = !covered && units === 0;
    entries.push({
      ...base,
      kind: manual.kind,
      on: manual.on,
      navDay: at?.day ?? null,
      nav: at?.nav ?? null,
      amountMinor,
      units: covered ? 0 : units,
      counted: !covered,
      pending,
      note: covered ? "Inside the opening balance" : pending ? "Waiting for the NAV" : null,
      txnId: manual.txnId,
    });
  }

  const order: Record<FundTxnKind, number> = { OPENING: 0, SIP_SCHEDULED: 1, LINKED: 1, MANUAL_BUY: 1, REDEEM: 2 };
  return entries.sort((a, b) => (a.on === b.on ? order[a.kind] - order[b.kind] : a.on < b.on ? -1 : 1));
}

export type PlanStatus = "invested" | "skipped" | "paused" | "pending_nav" | "upcoming";

/** One month of a SIP, planned against what happened. */
export interface PlanMonth {
  month: string;
  /// The instalment day that month.
  due: string;
  plannedMinor: number;
  status: PlanStatus;
  linkedTransactionId: string | null;
  /// What really went in: the debit's amount, or the scheduled one.
  actualMinor: number | null;
  units: number | null;
  nav: number | null;
  navDay: string | null;
  /// On or before the opening snapshot, so inside it rather than added.
  covered: boolean;
  /// Marked skipped or paused, but a debit was paid that month anyway.
  markedSkipped: boolean;
}

/**
 * The SIP month by month from `fromMonth` to `toMonth`, oldest first:
 * what each month was meant to be and what became of it. Read off the
 * ledger, so it can never disagree with the totals.
 *
 * A month inside the opening snapshot shows its plan, `covered`, without
 * units - the snapshot holds it. Months before the SIP starts or after it
 * ends aren't listed.
 */
export function sipMonthPlan(
  input: Pick<LedgerInput, "sip" | "opening" | "today">,
  entries: LedgerEntry[],
  fromMonth: string,
  toMonth: string
): PlanMonth[] {
  if (!input.sip) return [];
  const cutoff = input.opening?.asOf ?? null;
  const byMonth = new Map<string, LedgerEntry>();
  for (const entry of entries) {
    if (entry.month && (entry.kind === "SIP_SCHEDULED" || entry.kind === "LINKED")) byMonth.set(entry.month, entry);
  }

  const last = `${toMonth}-31`;
  return sipSlots(input.sip, last)
    .filter((slot) => slot.month >= fromMonth && slot.month <= toMonth)
    .map((slot) => {
      const entry = byMonth.get(slot.month);
      const covered = cutoff !== null && slot.due <= cutoff;
      const month: PlanMonth = {
        month: slot.month,
        due: slot.due,
        plannedMinor: slot.amountMinor,
        status: slot.state === "due" ? (slot.due > input.today ? "upcoming" : covered ? "invested" : "pending_nav") : slot.state,
        linkedTransactionId: null,
        actualMinor: null,
        units: null,
        nav: null,
        navDay: null,
        covered,
        markedSkipped: false,
      };
      if (!entry) return month;
      return {
        ...month,
        status: entry.pending ? "pending_nav" : "invested",
        linkedTransactionId: entry.kind === "LINKED" ? entry.transactionId : null,
        actualMinor: entry.amountMinor,
        units: entry.pending ? null : entry.units,
        nav: entry.nav,
        navDay: entry.navDay,
        markedSkipped: slot.state !== "due",
      };
    });
}

/// Shorter than this and an annualised figure says more about one week's
/// market than about the fund, so XIRR is left out.
export const MIN_XIRR_DAYS = 90;

export interface HoldingSummary {
  units: number;
  /// What the units still held cost, by average cost.
  investedMinor: number;
  /// Everything ever put in, redemptions or not.
  totalInvestedMinor: number;
  valueMinor: number;
  gainMinor: number;
  gainPercent: number | null;
  realisedGainMinor: number;
  xirr: number | null;
  /// Today's value against yesterday's NAV, on today's units.
  dayChangeMinor: number;
  dayChangePercent: number | null;
  nav: NavPoint | null;
  /// The first counted entry, and how long ago that was.
  firstOn: string | null;
  heldDays: number;
  /// The money in and out, for a portfolio-wide XIRR. The value today is not among them.
  flows: CashFlow[];
}

/**
 * Totals for one holding from its ledger.
 *
 * XIRR needs each rupee placed in time. An opening snapshot is the hard
 * part: it says what was invested, not when. With `firstOn` the invested
 * amount is placed halfway between that and the snapshot - right for money
 * that went in evenly, as a SIP does. Without it, the snapshot's value on
 * its day is the starting point, so XIRR is the return since the snapshot
 * (and is left out until MIN_XIRR_DAYS have passed).
 */
export function summariseHolding(
  entries: LedgerEntry[],
  series: NavSeries,
  opening?: OpeningInput | null
): HoldingSummary {
  let units = 0;
  let invested = 0;
  let totalInvested = 0;
  let realised = 0;
  const flows: CashFlow[] = [];

  for (const entry of entries) {
    if (!entry.counted || entry.pending) continue;
    if (entry.kind === "REDEEM") {
      const sold = Math.min(entry.units, units);
      const costOut = units > 0 ? invested * (sold / units) : 0;
      invested -= costOut;
      units -= sold;
      realised += entry.amountMinor - costOut;
      flows.push({ day: entry.on, amount: entry.amountMinor });
      continue;
    }

    units += entry.units;
    invested += entry.amountMinor;
    totalInvested += entry.amountMinor;

    if (entry.kind === "OPENING" && opening) {
      if (opening.firstOn && opening.firstOn < opening.asOf) {
        const middle = addDays(opening.firstOn, Math.floor(daysBetween(opening.firstOn, opening.asOf) / 2));
        flows.push({ day: middle, amount: -entry.amountMinor });
      } else if (entry.nav) {
        flows.push({ day: entry.on, amount: -entry.units * entry.nav * 100 });
      } else {
        flows.push({ day: entry.on, amount: -entry.amountMinor });
      }
    } else {
      flows.push({ day: entry.on, amount: -entry.amountMinor });
    }
  }

  const nav = latestNav(series);
  const previous = previousNav(series);
  const valueMinor = nav ? Math.round(units * nav.nav * 100) : 0;
  const investedMinor = Math.round(invested);
  const gainMinor = valueMinor - investedMinor;

  const firstFlow = flows.reduce<string | null>((earliest, flow) => (!earliest || flow.day < earliest ? flow.day : earliest), null);
  // An opening that says when investing began is that old, not as old as its snapshot.
  const first = entries.find((entry) => entry.counted && !entry.pending);
  const firstOn = first?.kind === "OPENING" && opening?.firstOn && opening.firstOn < first.on ? opening.firstOn : first?.on ?? null;
  const span = firstFlow && nav ? daysBetween(firstFlow, nav.day) : 0;
  const rate =
    nav && span >= MIN_XIRR_DAYS
      ? xirr(units > 0 ? [...flows, { day: nav.day, amount: units * nav.nav * 100 }] : flows)
      : null;

  const dayChangeMinor = nav && previous ? Math.round(units * (nav.nav - previous.nav) * 100) : 0;

  return {
    units,
    investedMinor,
    totalInvestedMinor: Math.round(totalInvested),
    valueMinor,
    gainMinor,
    gainPercent: investedMinor > 0 ? gainMinor / investedMinor : null,
    realisedGainMinor: Math.round(realised),
    xirr: rate,
    dayChangeMinor,
    dayChangePercent: nav && previous ? nav.nav / previous.nav - 1 : null,
    nav,
    firstOn,
    heldDays: firstOn && nav ? Math.max(0, daysBetween(firstOn, nav.day)) : 0,
    flows,
  };
}

export interface CategoryStats {
  count: number;
  average: number | null;
  median: number | null;
}

export function categoryStats(values: number[]): CategoryStats {
  if (values.length === 0) return { count: 0, average: null, median: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return {
    count: sorted.length,
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
  };
}

export interface Rank {
  /// 1 is the best return in the category.
  rank: number;
  /// Peers plus the fund itself.
  of: number;
  /// The share of its peers it beat, 0-100.
  percentile: number;
}

/** Where `value` sits among its peers' returns (the fund itself not among them). */
export function rankAmong(value: number, peers: number[]): Rank | null {
  if (peers.length === 0) return null;
  const better = peers.filter((peer) => peer > value).length;
  const beaten = peers.filter((peer) => peer < value).length;
  return { rank: better + 1, of: peers.length + 1, percentile: (beaten / peers.length) * 100 };
}

export const FUND_FLAGS = ["lagging_category", "low_xirr", "regular_plan"] as const;
export type FundFlag = (typeof FUND_FLAGS)[number];

/**
 * When a fund counts as "not performing", and why each threshold is what
 * it is. In one place so the app, the advice and the tests agree.
 */
export const FLAG_RULES = {
  /// Fewer peers than this and a rank means nothing.
  minPeers: 5,
  /// Bottom quartile: beat fewer than this share of its category.
  bottomPercentile: 25,
  /// Or this many percentage points a year under the category median.
  /// Wider on one year, which swings more.
  belowMedianPp: { "3y": 2, "1y": 3 },
  /// Below what a liquid fund pays, after a year of holding it, is worse
  /// than leaving the money somewhere safe.
  liquidRate: 0.065,
  lowXirrAfterDays: 365,
} as const;

export interface FlagInput {
  xirr: number | null;
  heldDays: number;
  isRegular: boolean;
  /// The return compared: 3y when the fund has three years, else 1y.
  basis: "3y" | "1y" | null;
  fundReturn: number | null;
  median: number | null;
  rank: Rank | null;
}

export function fundFlags(input: FlagInput): FundFlag[] {
  const flags: FundFlag[] = [];
  if (input.basis && input.fundReturn !== null && input.rank && input.rank.of - 1 >= FLAG_RULES.minPeers) {
    const margin = FLAG_RULES.belowMedianPp[input.basis] / 100;
    const bottom = input.rank.percentile < FLAG_RULES.bottomPercentile;
    const underMedian = input.median !== null && input.fundReturn < input.median - margin;
    if (bottom || underMedian) flags.push("lagging_category");
  }
  if (input.xirr !== null) {
    const late = input.heldDays >= FLAG_RULES.lowXirrAfterDays;
    if (input.xirr < 0 || (late && input.xirr < FLAG_RULES.liquidRate)) flags.push("low_xirr");
  }
  if (input.isRegular) flags.push("regular_plan");
  return flags;
}

/** Every point for a sparkline, thinned to about `points` evenly spaced, the last always kept. */
export function downsample(series: NavSeries, from: string, points = 60): NavPoint[] {
  const start = lowerBound(series.days, from);
  const count = series.days.length - start;
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(count / points));
  const out: NavPoint[] = [];
  for (let index = start; index < series.days.length; index += step) {
    out.push({ day: series.days[index], nav: series.navs[index] });
  }
  const last = series.days.length - 1;
  if (out[out.length - 1].day !== series.days[last]) out.push({ day: series.days[last], nav: series.navs[last] });
  return out;
}
