/**
 * Gold and silver rates as the India Bullion and Jewellers Association
 * publishes them on ibjarates.com - the benchmark jewellers, banks and the
 * RBI's gold bonds price against. No GST, no making charges.
 *
 * The page carries the day's rates twice a day (AM, PM) by purity - gold
 * 999 (24K), 995, 916 (22K), 750 (18K), 585 per 10 grams, silver 999 per
 * kg - and, in two hidden fields, about four months of daily history for
 * gold 999 and 916 and silver. It does not print the date of the day's
 * rates; see metals.service.ts for how that is worked out.
 *
 * Pure: everything here is reading text, tested against a sample page.
 */

export const IBJA_URL = "https://ibjarates.com/";

/** Rates in whole rupees: gold per 10 g, silver per kg, as IBJA quotes them. */
export interface IbjaRates {
  gold999: number | null;
  gold916: number | null;
  gold750: number | null;
  silver999: number | null;
  /// Which of the day's two quotes these are: the evening's once it is out.
  session: "AM" | "PM";
}

export interface IbjaHistoryDay {
  /// YYYY-MM-DD.
  day: string;
  gold999: number | null;
  gold916: number | null;
  silver999: number | null;
}

/** The number in a span with this id, or null when it is empty or missing. */
function spanNumber(html: string, id: string): number | null {
  const match = html.match(new RegExp(`id="${id}"[^>]*>\\s*([0-9][0-9,]*)\\s*<`));
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The day's rates: the evening quote when it is out, else the morning's.
 * Null when the page carries neither for gold 999 - not a page of rates.
 */
export function parseIbjaRates(html: string): IbjaRates | null {
  const read = (metal: string, session: "AM" | "PM") => spanNumber(html, `lbl${metal}_${session}`);
  const session = read("Gold999", "PM") !== null ? "PM" : "AM";
  const gold999 = read("Gold999", session);
  if (gold999 === null) return null;
  return {
    gold999,
    gold916: read("Gold916", session),
    gold750: read("Gold750", session),
    // Silver's evening quote can lag gold's; the morning's stands in.
    silver999: read("Silver999", session) ?? read("Silver999", "AM"),
    session,
  };
}

/** A hidden field's JSON, entities and all. */
function hiddenJson(html: string, id: string): Record<string, unknown> | null {
  const match = html.match(new RegExp(`id="${id}"\\s+value="([^"]*)"`));
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** "29/10/2026" as "2026-10-29", or null. */
function isoDay(label: unknown): string | null {
  const match = typeof label === "string" ? label.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) : null;
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

const numberAt = (list: unknown, index: number): number | null => {
  const value = Array.isArray(list) ? Number(list[index]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** The dated history the page carries, oldest first, gold and silver merged by day. */
export function parseIbjaHistory(html: string): IbjaHistoryDay[] {
  const gold = hiddenJson(html, "HdnGold");
  const silver = hiddenJson(html, "HdnSilver");
  const days = new Map<string, IbjaHistoryDay>();
  const entry = (day: string) => {
    const existing = days.get(day) ?? { day, gold999: null, gold916: null, silver999: null };
    days.set(day, existing);
    return existing;
  };

  const goldLabels = Array.isArray(gold?.labels) ? gold!.labels : [];
  goldLabels.forEach((label, index) => {
    const day = isoDay(label);
    if (!day) return;
    const row = entry(day);
    row.gold999 = numberAt(gold!.purity999, index);
    row.gold916 = numberAt(gold!.purity916, index);
  });
  const silverLabels = Array.isArray(silver?.labels) ? silver!.labels : [];
  silverLabels.forEach((label, index) => {
    const day = isoDay(label);
    if (!day) return;
    entry(day).silver999 = numberAt(silver!.silverRate, index);
  });

  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
