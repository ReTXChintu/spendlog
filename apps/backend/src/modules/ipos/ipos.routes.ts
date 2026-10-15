import { Router } from "express";
import { env } from "../../env";
import { requireAuth } from "../../middleware/auth";
import { IpoCache, IpoCacheDoc } from "../../models";
import { perLot } from "./ipos.estimate";
import { fetchIpos, IpoError, IpoRow } from "./ipos.guru";

export const ipoRouter = Router();
ipoRouter.use(requireAuth);

const CACHE_KEY = "guru";

/** Four refreshes a day at most - eight calls if GMP needs its own - of the ten the key allows. */
const FRESH_MS = 6 * 60 * 60 * 1000;

/** How long a failure is left alone before trying again, so it can't burn the day's quota. */
const BACKOFF_MS = 30 * 60 * 1000;

const SOURCE = { name: "IPO Guru", url: "https://www.ipoguru.in" };

// Swapped out by the tests, so the minute between the two calls isn't real.
let sleep: ((ms: number) => Promise<void>) | undefined;

export function setIpoSleepForTests(fake: ((ms: number) => Promise<void>) | undefined) {
  sleep = fake;
}

/**
 * The refresh in progress, if any - one at a time, however many people
 * open the screen at once, the same idea as categories.system.ts.
 *
 * `refreshing` is the whole job, GMP and all; `calendarReady` settles as
 * soon as there's a calendar to show, which is what a request waits for.
 */
let refreshing: Promise<void> | null = null;
let calendarReady: Promise<void> = Promise.resolve();

/** Settles once nothing is being fetched. For the tests. */
export function iposSettled(): Promise<void> {
  return refreshing ?? Promise.resolve();
}

async function saveRows(rows: IpoRow[]) {
  await IpoCache.updateOne(
    { key: CACHE_KEY },
    { $set: { rows, fetchedAt: new Date(), lastError: null, lastErrorAt: null } },
    { upsert: true }
  );
}

async function saveError(error: unknown) {
  if (!(error instanceof IpoError)) console.error("IPO refresh failed:", error);
  const message = error instanceof IpoError ? error.message : "IPO Guru couldn't answer just now.";
  await IpoCache.updateOne(
    { key: CACHE_KEY },
    { $set: { lastError: message, lastErrorAt: new Date() } },
    { upsert: true }
  );
}

function refresh(): Promise<void> {
  if (!refreshing) {
    let ready!: () => void;
    calendarReady = new Promise((resolve) => (ready = resolve));
    refreshing = (async () => {
      try {
        // A request that read the cache just before the last refresh saved
        // can arrive here just after it finished. Asking again then would
        // spend a second of the ten calls a day on the same answer.
        const latest = await IpoCache.findOne({ key: CACHE_KEY }).lean<IpoCacheDoc>();
        if (isFresh(latest, Date.now()) || backingOff(latest, Date.now())) return;

        const rows = await fetchIpos(env.ipoApiKey, {
          sleep,
          onCalendar: async (calendar) => {
            await saveRows(calendar);
            ready();
          },
        });
        await saveRows(rows);
      } catch (error) {
        await saveError(error).catch((saveFailure) => console.error("IPO cache write failed:", saveFailure));
      } finally {
        ready();
        refreshing = null;
      }
    })();
  }
  return calendarReady;
}

function isFresh(doc: IpoCacheDoc | null, now: number): boolean {
  return !!doc?.fetchedAt && now - doc.fetchedAt.getTime() < FRESH_MS;
}

function backingOff(doc: IpoCacheDoc | null, now: number): boolean {
  return !!doc?.lastErrorAt && now - doc.lastErrorAt.getTime() < BACKOFF_MS;
}

/** Earliest first, with the ones not dated yet at the end. */
function byDate(field: "openDate" | "closeDate" | "listingDate") {
  return (a: IpoRow, b: IpoRow) => {
    const left = a[field];
    const right = b[field];
    if (left !== right) {
      if (left === null) return 1;
      if (right === null) return -1;
      return left < right ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  };
}

/**
 * GET /ipos — open, upcoming and closed-but-not-listed IPOs, each with what
 * one lot costs and what today's GMP makes of it.
 *
 * `{ available: false }` with no key on the server, so the app can hide
 * the screen. Otherwise always 200: when IPO Guru can't be reached, the
 * last good rows come back marked stale, or empty lists if there have
 * never been any, with `error` saying why.
 */
ipoRouter.get("/", async (_req, res) => {
  if (!env.ipoApiKey) return res.json({ available: false });

  let doc = await IpoCache.findOne({ key: CACHE_KEY }).lean<IpoCacheDoc>();
  if (!isFresh(doc, Date.now()) && !backingOff(doc, Date.now())) {
    await refresh();
    doc = await IpoCache.findOne({ key: CACHE_KEY }).lean<IpoCacheDoc>();
  }

  const fresh = isFresh(doc, Date.now());
  const stale = !fresh && !!doc?.fetchedAt;
  const rows = ((doc?.rows ?? []) as IpoRow[]).map((row) => ({ ...row, perLot: perLot(row) }));

  res.json({
    available: true,
    fetchedAt: doc?.fetchedAt?.toISOString() ?? null,
    stale,
    error: fresh ? null : doc?.lastError ?? "IPO Guru couldn't answer just now.",
    source: SOURCE,
    open: rows.filter((row) => row.status === "OPEN").sort(byDate("closeDate")),
    upcoming: rows.filter((row) => row.status === "UPCOMING").sort(byDate("openDate")),
    closed: rows.filter((row) => row.status === "CLOSED").sort(byDate("listingDate")),
  });
});
