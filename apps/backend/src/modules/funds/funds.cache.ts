import { FundCache, FundCacheDoc, FundHolding, FundNav, FundNavDoc } from "../../models";
import { IST_OFFSET_MS, istDayKey } from "../../time";
import { addDays } from "./funds.math";
import { buildPeerTable, CategoryPeers, groupPeers, looksLikeTradingDay, activeRows, PeerTable, snapshotDays } from "./funds.peers";
import { fetchNavAll, fetchNavOn, fetchScheme, FundSourceError, NavFileRow } from "./funds.sources";

/**
 * Fund prices, kept in Mongo so that reading a portfolio never waits on
 * mfapi or AMFI unless it has to, and works from the last good copy when
 * they're down. The same pattern as the IPO cache: one fetch at a time per
 * thing, a failure left alone for a while before trying again.
 *
 * Two kinds of thing are kept. Each held scheme's NAV history (FundNav),
 * refreshed once a day after AMFI publishes; and the peer table every
 * category rank comes from (FundCache "peers"), refreshed weekly, because
 * a year's return hardly moves in a week.
 */

/// AMFI wants every NAV in by 11 PM; mfapi follows within the hour.
export const PUBLISH_HOUR_IST = 23;

/// How long a failure is left alone before trying again.
const BACKOFF_MS = 30 * 60 * 1000;

/// A history that is a trading day behind is fetched again after this,
/// for the evening mfapi was late.
const BEHIND_RETRY_MS = 3 * 60 * 60 * 1000;

/// Past this a portfolio says its prices are stale.
export const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export const PEERS_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

/// A daily run that died part way is someone else's to retry after this.
const CLAIM_MS = 15 * 60 * 1000;

const PEERS_KEY = "peers";
const DAILY_KEY = "daily";

/**
 * The last time NAVs were published: 11 PM IST today when that has
 * passed, otherwise yesterday's. Anything fetched before it is a day old.
 */
export function lastPublishMoment(now: Date): Date {
  const today = istDayKey(now);
  const atToday = new Date(Date.parse(`${today}T00:00:00Z`) - IST_OFFSET_MS + PUBLISH_HOUR_IST * 60 * 60 * 1000);
  return atToday.getTime() <= now.getTime() ? atToday : new Date(atToday.getTime() - 24 * 60 * 60 * 1000);
}

/** The last weekday on or before a day - the newest NAV there can be, holidays aside. */
function lastWeekday(day: string): string {
  let candidate = day;
  for (let step = 0; step < 3; step += 1) {
    const weekday = new Date(`${candidate}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return candidate;
    candidate = addDays(candidate, -1);
  }
  return candidate;
}

function backingOff(doc: { lastErrorAt: Date | null } | null, now: Date): boolean {
  return !!doc?.lastErrorAt && now.getTime() - doc.lastErrorAt.getTime() < BACKOFF_MS;
}

/** Whether a scheme's history should be fetched again now. */
export function schemeDue(doc: Pick<FundNavDoc, "fetchedAt" | "days" | "lastErrorAt"> | null, now: Date): boolean {
  if (backingOff(doc, now)) return false;
  if (!doc?.fetchedAt) return true;
  const moment = lastPublishMoment(now);
  if (doc.fetchedAt < moment) return true;
  const latest = doc.days[doc.days.length - 1];
  const expected = lastWeekday(istDayKey(moment));
  return (!latest || latest < expected) && now.getTime() - doc.fetchedAt.getTime() > BEHIND_RETRY_MS;
}

const schemeRefreshes = new Map<number, Promise<boolean>>();

/**
 * Fetches one scheme's history and keeps it. A failure is recorded, not
 * thrown: whoever asked carries on with whatever is stored.
 */
export function refreshScheme(schemeCode: number): Promise<boolean> {
  let running = schemeRefreshes.get(schemeCode);
  if (!running) {
    running = (async () => {
      try {
        const history = await fetchScheme(schemeCode);
        if (!history) throw new FundSourceError("mfapi.in doesn't know that scheme.", 404);
        await FundNav.updateOne(
          { schemeCode },
          {
            $set: {
              schemeName: history.schemeName,
              fundHouse: history.fundHouse,
              schemeType: history.schemeType,
              category: history.category,
              isin: history.isin,
              days: history.days,
              navs: history.navs,
              fetchedAt: new Date(),
              lastError: null,
              lastErrorAt: null,
            },
          },
          { upsert: true }
        );
        return true;
      } catch (error) {
        if (!(error instanceof FundSourceError)) console.error(`Fund ${schemeCode} refresh failed:`, error);
        const message = error instanceof FundSourceError ? error.message : "mfapi.in couldn't answer just now.";
        await FundNav.updateOne(
          { schemeCode },
          { $set: { lastError: message, lastErrorAt: new Date() } },
          { upsert: true }
        ).catch((saveFailure) => console.error("Fund cache write failed:", saveFailure));
        return false;
      } finally {
        schemeRefreshes.delete(schemeCode);
      }
    })();
    schemeRefreshes.set(schemeCode, running);
  }
  return running;
}

/** A few at a time, so a big portfolio doesn't open forty connections to mfapi at once. */
async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<unknown>) {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run));
  }
}

/**
 * The stored histories for these schemes, fetching first any that are
 * missing or a day old. Always answers: a scheme that couldn't be fetched
 * comes back as whatever was stored, or not at all.
 */
export async function schemeHistories(codes: number[], now = new Date()): Promise<Map<number, FundNavDoc>> {
  const unique = [...new Set(codes)];
  const stored = await FundNav.find({ schemeCode: { $in: unique } }).lean<FundNavDoc[]>();
  const byCode = new Map(stored.map((doc) => [doc.schemeCode, doc]));
  const due = unique.filter((code) => schemeDue(byCode.get(code) ?? null, now));
  if (due.length === 0) return byCode;

  await inBatches(due, 4, refreshScheme);
  const fresh = await FundNav.find({ schemeCode: { $in: unique } }).lean<FundNavDoc[]>();
  return new Map(fresh.map((doc) => [doc.schemeCode, doc]));
}

/**
 * A scheme's history for adding a holding: the stored one if there is
 * one, fetched otherwise. Throws when there's neither, since a holding
 * needs at least the scheme's name and category.
 */
export async function requireScheme(schemeCode: number): Promise<FundNavDoc> {
  let doc = await FundNav.findOne({ schemeCode }).lean<FundNavDoc>();
  if (!doc?.fetchedAt) {
    await refreshScheme(schemeCode);
    doc = await FundNav.findOne({ schemeCode }).lean<FundNavDoc>();
  }
  if (!doc?.fetchedAt) {
    const notFound = doc?.lastError === "mfapi.in doesn't know that scheme.";
    throw new FundSourceError(doc?.lastError ?? "mfapi.in couldn't answer just now.", notFound ? 404 : 502);
  }
  return doc;
}

// ---- The peer table ----

let peersRefresh: Promise<void> | null = null;

/** The first of a run of days whose file is a real trading day's, or null. */
async function snapshotNear(asOf: string, years: number, activeToday: number): Promise<NavFileRow[] | null> {
  for (const day of snapshotDays(asOf, years)) {
    const rows = await fetchNavOn(day);
    if (looksLikeTradingDay(rows, activeToday)) return rows;
  }
  return null;
}

/** Builds the peer table from AMFI and keeps it. Single-flight; failures recorded. */
export function refreshPeers(): Promise<void> {
  if (!peersRefresh) {
    peersRefresh = (async () => {
      try {
        const today = await fetchNavAll();
        const { asOf, rows } = activeRows(today);
        const yearAgo = await snapshotNear(asOf, 1, rows.length);
        const threeYearsAgo = await snapshotNear(asOf, 3, rows.length);
        const table = buildPeerTable(today, yearAgo, threeYearsAgo);
        await FundCache.updateOne(
          { key: PEERS_KEY },
          { $set: { data: table, fetchedAt: new Date(), lastError: null, lastErrorAt: null } },
          { upsert: true }
        );
      } catch (error) {
        if (!(error instanceof FundSourceError)) console.error("Fund peer refresh failed:", error);
        const message = error instanceof FundSourceError ? error.message : "AMFI couldn't answer just now.";
        await FundCache.updateOne(
          { key: PEERS_KEY },
          { $set: { lastError: message, lastErrorAt: new Date() } },
          { upsert: true }
        ).catch((saveFailure) => console.error("Fund cache write failed:", saveFailure));
      } finally {
        peersRefresh = null;
      }
    })();
  }
  return peersRefresh;
}

/** Settles once nothing is being fetched. For the tests. */
export async function fundsSettled(): Promise<void> {
  await Promise.all([peersRefresh, ...schemeRefreshes.values()]);
}

export interface Peers {
  table: PeerTable;
  groups: Map<string, CategoryPeers>;
  fetchedAt: Date;
}

/// Grouping three thousand schemes is cheap, but not free on every request.
let memo: { at: number; peers: Peers } | null = null;

/**
 * The peer table. Fetched and waited for when there has never been one
 * (once - a failure backs off like everything else); refreshed in the
 * background when it's a week old, the old one served meanwhile. Null only
 * when AMFI has never been reachable.
 */
export async function peers(now = new Date()): Promise<Peers | null> {
  let doc = await FundCache.findOne({ key: PEERS_KEY }).lean<FundCacheDoc>();
  if (!doc?.fetchedAt && !backingOff(doc, now)) {
    await refreshPeers();
    doc = await FundCache.findOne({ key: PEERS_KEY }).lean<FundCacheDoc>();
  } else if (doc?.fetchedAt && now.getTime() - doc.fetchedAt.getTime() > PEERS_FRESH_MS && !backingOff(doc, now)) {
    void refreshPeers();
  }
  if (!doc?.fetchedAt || !doc.data) return null;

  if (memo?.at !== doc.fetchedAt.getTime()) {
    const table = doc.data as PeerTable;
    memo = { at: doc.fetchedAt.getTime(), peers: { table, groups: groupPeers(table), fetchedAt: doc.fetchedAt } };
  }
  return memo.peers;
}

// ---- The daily refresh ----

export interface DailyRun {
  ran: boolean;
  schemes: number;
  failed: number;
  peers: boolean;
}

/**
 * Once a day, after NAVs are published: every held scheme's history, and
 * the peer table when it's a week old. Called every half hour by the
 * server and once at start-up; the guard in Mongo is what makes it once a
 * day however often it's called and however many times PM2 restarts.
 *
 * A run where every scheme failed doesn't count as done, so the next call
 * tries again. One where some failed does: those few are fetched on the
 * next read that needs them.
 */
export async function runDailyFundRefresh(now = new Date()): Promise<DailyRun> {
  const moment = lastPublishMoment(now);
  await FundCache.updateOne({ key: DAILY_KEY }, { $setOnInsert: { data: null } }, { upsert: true });
  const claim = await FundCache.updateOne(
    {
      key: DAILY_KEY,
      $and: [
        { $or: [{ fetchedAt: null }, { fetchedAt: { $lt: moment } }] },
        { $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - CLAIM_MS) } }] },
      ],
    },
    { $set: { claimedAt: now } }
  );
  if (claim.modifiedCount === 0) return { ran: false, schemes: 0, failed: 0, peers: false };

  let failed = 0;
  let schemes = 0;
  let refreshedPeers = false;
  try {
    const codes = (await FundHolding.distinct("schemeCode")) as number[];
    schemes = codes.length;
    await inBatches(codes, 4, async (code) => {
      if (!(await refreshScheme(code))) failed += 1;
    });

    const peerDoc = await FundCache.findOne({ key: PEERS_KEY }).select("fetchedAt").lean<Pick<FundCacheDoc, "fetchedAt">>();
    if (codes.length > 0 && (!peerDoc?.fetchedAt || now.getTime() - peerDoc.fetchedAt.getTime() > PEERS_FRESH_MS)) {
      await refreshPeers();
      refreshedPeers = true;
    }

    const allFailed = schemes > 0 && failed === schemes;
    await FundCache.updateOne(
      { key: DAILY_KEY },
      allFailed
        ? { $set: { claimedAt: null, lastError: "No fund could be refreshed.", lastErrorAt: now } }
        : { $set: { claimedAt: null, fetchedAt: now, lastError: null, lastErrorAt: null, data: { day: istDayKey(now), schemes, failed } } }
    );
  } catch (error) {
    console.error("Daily fund refresh failed:", error);
    await FundCache.updateOne({ key: DAILY_KEY }, { $set: { claimedAt: null, lastError: "Refresh failed.", lastErrorAt: now } });
  }
  return { ran: true, schemes, failed, peers: refreshedPeers };
}
