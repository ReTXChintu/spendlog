import { Types } from "mongoose";
import { MetalRate, MetalRateDoc, User } from "../../models";
import { IST_OFFSET_MS, istDayKey } from "../../time";
import { sendNotification } from "../family/family.push";
import { IBJA_URL, IbjaRates, parseIbjaHistory, parseIbjaRates } from "./metals.ibja";

/**
 * Gold and silver, a day at a time, for deciding when to buy.
 *
 * IBJA's rates are read every half hour through the working day and kept
 * one row a day (metals.ibja.ts reads the page). A day is a good one to
 * buy when its rate is below the average of the 30 days before it - said
 * as a percentage, the same for every purity of gold, since IBJA's 22K and
 * 18K are its 24K times their fineness. The day's rates are pushed, once,
 * to whoever asked, as soon as they are out (about half past twelve).
 */

/// How far back the good-day signal looks.
export const AVERAGE_DAYS = 30;
/// GST on gold and silver, which a digital gold app adds to the rate.
export const GST_PERCENT = 3;

/** When IBJA's day is under way, in IST: its morning rates are out by eleven. */
function inWorkingDay(now: Date): boolean {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const day = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && minutes >= 11 * 60 && minutes <= 20 * 60 + 30;
}

async function fetchIbja(): Promise<string> {
  const response = await fetch(IBJA_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (SpendLog rates reader)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`IBJA answered ${response.status}`);
  return response.text();
}

/**
 * Which day the page's undated rates are for: today, on a weekday once the
 * morning's are out and they differ from the last dated day - else none,
 * since a holiday shows the last day's rates again.
 */
export function liveDay(
  rates: Pick<IbjaRates, "gold999">,
  lastDated: Pick<MetalRateDoc, "day" | "gold999"> | null,
  now: Date
): string | null {
  const today = istDayKey(now);
  if (lastDated?.day === today) return today;
  if (!inWorkingDay(now)) return null;
  if (lastDated && lastDated.gold999 === rates.gold999) return null;
  return today;
}

export type RefreshResult = { day: string | null; isNew: boolean };

/**
 * Reads IBJA once: its dated history into any day not yet kept, and the
 * day's rates onto today. Returns the day the rates were put on, and
 * whether that day is new.
 */
export async function refreshMetalRates(now = new Date(), read: () => Promise<string> = fetchIbja): Promise<RefreshResult> {
  const html = await read();

  // History is IBJA's own, dated: what a day closed at. It does not
  // replace an evening quote already kept, and keeps 18K, which it lacks.
  for (const day of parseIbjaHistory(html)) {
    await MetalRate.updateOne(
      { day: day.day, session: { $ne: "PM" } },
      { $set: { gold999: day.gold999, gold916: day.gold916, silver999: day.silver999, session: "CLOSE" } },
      { upsert: false }
    );
    await MetalRate.updateOne(
      { day: day.day },
      {
        $setOnInsert: {
          day: day.day,
          gold999: day.gold999,
          gold916: day.gold916,
          gold750: null,
          silver999: day.silver999,
          session: "CLOSE",
          notifiedAt: null,
        },
      },
      { upsert: true }
    );
  }

  const rates = parseIbjaRates(html);
  if (!rates) return { day: null, isNew: false };
  const lastDated = await MetalRate.findOne({ day: { $lt: istDayKey(now) } }).sort({ day: -1 }).lean();
  const day = liveDay(rates, lastDated, now);
  if (!day) return { day: null, isNew: false };

  const existing = await MetalRate.findOne({ day }).lean();
  // An evening quote stays over a morning one read later from a cached page.
  if (existing?.session === "PM" && rates.session === "AM") return { day, isNew: false };
  await MetalRate.updateOne(
    { day },
    {
      $set: {
        gold999: rates.gold999,
        gold916: rates.gold916,
        gold750: rates.gold750,
        silver999: rates.silver999,
        session: rates.session,
      },
      $setOnInsert: { notifiedAt: null },
    },
    { upsert: true }
  );
  return { day, isNew: !existing };
}

/** Rupees per 10 g of gold, or per kg of silver, as paise per gram. */
const goldPerGram = (per10g: number | null) => (per10g === null ? null : per10g * 10);
const silverPerGram = (perKg: number | null) => (perKg === null ? null : Math.round(perKg / 10));

export interface MetalSignal {
  /// The average of the days before, per gram, in paise.
  averageMinor: number | null;
  /// How far below that average today is, as a percentage; negative when
  /// it is above.
  belowAveragePercent: number | null;
  isGoodDay: boolean;
  /// Against the day before, as a percentage.
  changePercent: number | null;
}

/** Today's rate against the days before it. */
export function signalFor(today: number | null, earlier: (number | null)[]): MetalSignal {
  const known = earlier.filter((value): value is number => value !== null && value > 0);
  const previous = known.length > 0 ? known[known.length - 1] : null;
  const average = known.length > 0 ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    averageMinor: average === null ? null : Math.round(average),
    belowAveragePercent: today === null || average === null ? null : round(((average - today) / average) * 100),
    isGoodDay: today !== null && average !== null && today < average,
    changePercent: today === null || previous === null ? null : round(((today - previous) / previous) * 100),
  };
}

export interface MetalsView {
  available: boolean;
  day: string | null;
  session: MetalRateDoc["session"] | null;
  isToday: boolean;
  source: { name: string; url: string };
  gold: {
    perGramMinor: { "24K": number | null; "22K": number | null; "18K": number | null };
    /// 24K with GST, about what a digital gold app charges before its own margin.
    withGstPerGramMinor: number | null;
    signal: MetalSignal;
    history: { day: string; perGramMinor: number }[];
  };
  silver: {
    perGramMinor: number | null;
    perKgMinor: number | null;
    withGstPerGramMinor: number | null;
    signal: MetalSignal;
    history: { day: string; perGramMinor: number }[];
  };
  push: boolean;
}

const withGst = (minor: number | null) => (minor === null ? null : Math.round(minor * (1 + GST_PERCENT / 100)));

/** The latest day's rates, how they stand against the month before, and about three months of history. */
export async function metalsView(userId: Types.ObjectId, now = new Date()): Promise<MetalsView> {
  const [rows, user] = await Promise.all([
    MetalRate.find({}).sort({ day: -1 }).limit(120).lean(),
    User.findById(userId).select("metalRatesPush").lean(),
  ]);
  const source = { name: "IBJA", url: IBJA_URL };
  const latest = rows[0] ?? null;
  const empty: MetalSignal = { averageMinor: null, belowAveragePercent: null, isGoodDay: false, changePercent: null };
  if (!latest) {
    return {
      available: false,
      day: null,
      session: null,
      isToday: false,
      source,
      gold: { perGramMinor: { "24K": null, "22K": null, "18K": null }, withGstPerGramMinor: null, signal: empty, history: [] },
      silver: { perGramMinor: null, perKgMinor: null, withGstPerGramMinor: null, signal: empty, history: [] },
      push: Boolean(user?.metalRatesPush),
    };
  }

  // Oldest first; the days before the latest, within the averaging window.
  const ordered = [...rows].reverse();
  const cutoff = new Date(`${latest.day}T00:00:00Z`).getTime() - AVERAGE_DAYS * 24 * 60 * 60 * 1000;
  const before = ordered.filter((row) => row.day < latest.day && new Date(`${row.day}T00:00:00Z`).getTime() >= cutoff);

  const gold24 = goldPerGram(latest.gold999);
  const silver = silverPerGram(latest.silver999);
  const history = (pick: (row: MetalRateDoc) => number | null) =>
    ordered.slice(-90).flatMap((row) => {
      const value = pick(row);
      return value === null ? [] : [{ day: row.day, perGramMinor: value }];
    });

  return {
    available: true,
    day: latest.day,
    session: latest.session,
    isToday: latest.day === istDayKey(now),
    source,
    gold: {
      perGramMinor: { "24K": gold24, "22K": goldPerGram(latest.gold916), "18K": goldPerGram(latest.gold750) },
      withGstPerGramMinor: withGst(gold24),
      signal: signalFor(gold24, before.map((row) => goldPerGram(row.gold999))),
      history: history((row) => goldPerGram(row.gold999)),
    },
    silver: {
      perGramMinor: silver,
      perKgMinor: latest.silver999 === null ? null : latest.silver999 * 100,
      withGstPerGramMinor: withGst(silver),
      signal: signalFor(silver, before.map((row) => silverPerGram(row.silver999))),
      history: history((row) => silverPerGram(row.silver999)),
    },
    push: Boolean(user?.metalRatesPush),
  };
}

const rupees = (minor: number | null) =>
  minor === null ? "-" : `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;

/** The day's notification: the rates, and whether it is a good day for either. */
export function rateNotice(view: MetalsView): { title: string; body: string } {
  const gold = view.gold;
  const good = [
    gold.signal.isGoodDay ? `gold is ${gold.signal.belowAveragePercent}% below its 30-day average` : null,
    view.silver.signal.isGoodDay ? `silver is ${view.silver.signal.belowAveragePercent}% below` : null,
  ].filter(Boolean);
  const title = gold.signal.isGoodDay
    ? "A good day to buy gold"
    : view.silver.signal.isGoodDay
      ? "A good day to buy silver"
      : "Gold and silver today";
  const rates =
    `24K ${rupees(gold.perGramMinor["24K"])}/g · 22K ${rupees(gold.perGramMinor["22K"])}/g · ` +
    `18K ${rupees(gold.perGramMinor["18K"])}/g · Silver ${rupees(view.silver.perGramMinor)}/g`;
  return { title, body: good.length > 0 ? `${rates}. ${good.join(", ")}.` : `${rates}. Above the 30-day average.` };
}

/** The day's rates, once, to everyone who asked for them. */
export async function notifyMetalRates(day: string, now = new Date()): Promise<number> {
  const claimed = await MetalRate.updateOne({ day, notifiedAt: null }, { $set: { notifiedAt: now } });
  if (claimed.modifiedCount === 0) return 0;
  const users = await User.find({ metalRatesPush: true, role: { $ne: "KID" } }).select("_id");
  let sent = 0;
  for (const user of users) {
    const view = await metalsView(user._id, now);
    if (!view.available || view.day !== day) continue;
    const result = await sendNotification(user._id, { ...rateNotice(view), data: { type: "METAL_RATES" } }).catch(() => null);
    if (result?.sent) sent += 1;
  }
  return sent;
}

/** Asked every half hour: reads IBJA in its working day (and once at start), and sends a new day's rates. */
export async function runMetalRefresh(now = new Date(), force = false): Promise<RefreshResult | null> {
  if (!force && !inWorkingDay(now)) return null;
  const result = await refreshMetalRates(now);
  if (result.day && result.day === istDayKey(now)) await notifyMetalRates(result.day, now);
  return result;
}
