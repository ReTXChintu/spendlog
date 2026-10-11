import { AssetClass, categoryOf } from "./funds.category";
import { addDays, addYears, cagr, CategoryStats, categoryStats, daysBetween } from "./funds.math";
import { displayName, isDirectPlan, isGrowthOption, NavFileRow } from "./funds.sources";

/**
 * Every direct-growth scheme's 1y and 3y return, by category, from three
 * of AMFI's files: today's NAVAll and the full NAV list on the days a year
 * and three years back.
 *
 * Direct + growth only. The same portfolio sold as a regular plan or an
 * IDCW option would count three or four times over, and the regular one
 * always trails by its commission - ranking against both would say more
 * about plans than about funds. A user's regular plan is still ranked
 * against these, which is fair: the direct plan is what they could hold.
 */

export interface PeerScheme {
  code: number;
  name: string;
  house: string;
  /// Category key and label (funds.category.ts).
  key: string;
  label: string;
  cls: AssetClass;
  nav: number;
  day: string;
  /// Annualised returns as fractions. Null when the scheme wasn't around.
  r1: number | null;
  r3: number | null;
}

export interface PeerTable {
  /// The latest NAV day in today's file.
  asOf: string;
  /// The days the 1y and 3y NAVs were actually taken from, after stepping
  /// back over a weekend or holiday. Null when no file could be found.
  oneYearOn: string | null;
  threeYearOn: string | null;
  schemes: PeerScheme[];
}

/// A scheme whose last NAV is older than this is wound up or merged, not a peer.
const ACTIVE_WITHIN_DAYS = 7;

/**
 * A day's file is a real trading day's when it has at least this share of
 * the schemes today's has. Weekends and holidays come back with only the
 * overnight and liquid funds - well under a tenth.
 */
export const TRADING_DAY_SHARE = 0.4;

/**
 * The schemes in today's NAVAll that are still running, and the day most
 * of them are priced on. The most common day rather than the latest:
 * overnight funds publish on Sundays too, and a year back from a Sunday
 * is a needless step over a weekend.
 */
export function activeRows(rows: NavFileRow[]): { asOf: string; rows: NavFileRow[] } {
  const latest = rows.reduce((max, row) => (row.day > max ? row.day : max), "");
  const since = latest ? addDays(latest, -ACTIVE_WITHIN_DAYS) : "";
  const active = rows.filter((row) => row.day >= since);
  const counts = new Map<string, number>();
  for (const row of active) counts.set(row.day, (counts.get(row.day) ?? 0) + 1);
  let asOf = latest;
  for (const [day, count] of counts) if (count > (counts.get(asOf) ?? 0)) asOf = day;
  return { asOf, rows: active };
}

export function looksLikeTradingDay(snapshot: NavFileRow[], activeToday: number): boolean {
  return snapshot.length > 0 && snapshot.length >= activeToday * TRADING_DAY_SHARE;
}

/** The days to try for "a year ago": the date itself, then up to a week before it. */
export function snapshotDays(asOf: string, years: number, tries = 8): string[] {
  const target = addYears(asOf, -years);
  return Array.from({ length: tries }, (_, index) => addDays(target, -index));
}

function navByCode(rows: NavFileRow[] | null): Map<number, NavFileRow> {
  const map = new Map<number, NavFileRow>();
  for (const row of rows ?? []) map.set(row.schemeCode, row);
  return map;
}

function returnFrom(then: NavFileRow | undefined, now: NavFileRow): number | null {
  if (!then) return null;
  return cagr(then.nav, now.nav, daysBetween(then.day, now.day));
}

export function buildPeerTable(
  today: NavFileRow[],
  yearAgo: NavFileRow[] | null,
  threeYearsAgo: NavFileRow[] | null
): PeerTable {
  const { asOf, rows } = activeRows(today);
  const before1 = navByCode(yearAgo);
  const before3 = navByCode(threeYearsAgo);
  const seen = new Set<number>();

  const schemes: PeerScheme[] = [];
  for (const row of rows) {
    if (seen.has(row.schemeCode)) continue;
    if (!/open ended/i.test(row.schemeType)) continue;
    if (!isDirectPlan(row.name, row.plan) || !isGrowthOption(row.name, row.option)) continue;
    seen.add(row.schemeCode);

    const name = displayName(row);
    const category = categoryOf(row.category, name);
    schemes.push({
      code: row.schemeCode,
      name,
      house: row.fundHouse,
      key: category.key,
      label: category.label,
      cls: category.assetClass,
      nav: row.nav,
      day: row.day,
      r1: returnFrom(before1.get(row.schemeCode), row),
      r3: returnFrom(before3.get(row.schemeCode), row),
    });
  }

  return {
    asOf,
    oneYearOn: yearAgo?.[0]?.day ?? null,
    threeYearOn: threeYearsAgo?.[0]?.day ?? null,
    schemes,
  };
}

export interface CategoryPeers {
  key: string;
  label: string;
  schemes: PeerScheme[];
  oneYear: CategoryStats;
  threeYear: CategoryStats;
}

/** The table grouped by category, with each category's 1y and 3y average and median. */
export function groupPeers(table: PeerTable): Map<string, CategoryPeers> {
  const groups = new Map<string, CategoryPeers>();
  for (const scheme of table.schemes) {
    let group = groups.get(scheme.key);
    if (!group) {
      group = { key: scheme.key, label: scheme.label, schemes: [], oneYear: categoryStats([]), threeYear: categoryStats([]) };
      groups.set(scheme.key, group);
    }
    group.schemes.push(scheme);
  }
  for (const group of groups.values()) {
    group.oneYear = categoryStats(group.schemes.flatMap((scheme) => (scheme.r1 === null ? [] : [scheme.r1])));
    group.threeYear = categoryStats(group.schemes.flatMap((scheme) => (scheme.r3 === null ? [] : [scheme.r3])));
  }
  return groups;
}

export interface TopPickSpec {
  /// Category keys to pick from, together.
  keys: string[];
  rankBy: "1y" | "3y";
  /// Only names that match, when a category is too broad (index funds
  /// track everything from the Nifty 50 to a PSU bond index).
  nameMatches?: RegExp;
  nameExcludes?: RegExp;
}

/**
 * The best direct-growth schemes by return, for an example to put next to
 * a suggestion. Ranked on 3y, a scheme needs three years of NAVs to be in
 * at all: a fund that started last year has no record to be picked on,
 * and with no fund size in AMFI's files that is also what keeps tiny new
 * ones out.
 */
export function topPicks(table: PeerTable, spec: TopPickSpec, count = 3): PeerScheme[] {
  const field = spec.rankBy === "3y" ? "r3" : "r1";
  const other = spec.rankBy === "3y" ? "r1" : "r3";
  return table.schemes
    .filter((scheme) => spec.keys.includes(scheme.key))
    .filter((scheme) => scheme[field] !== null && (spec.rankBy === "1y" || scheme.r1 !== null))
    .filter((scheme) => !spec.nameMatches || spec.nameMatches.test(scheme.name))
    .filter((scheme) => !spec.nameExcludes || !spec.nameExcludes.test(scheme.name))
    .sort((a, b) => {
      // Within a twentieth of a point - liquid funds mostly are - the one
      // with the longer record of doing so goes first.
      const apart = Math.round(((b[field] as number) - (a[field] as number)) * 2000);
      if (apart !== 0) return apart;
      return (b[other] ?? -Infinity) - (a[other] ?? -Infinity);
    })
    .slice(0, count);
}
