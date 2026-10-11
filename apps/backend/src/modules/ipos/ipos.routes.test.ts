import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "ipos-test-secret";
// Set outright rather than ??=: dotenv never overwrites a key that exists,
// even an empty one, so this is the value the app sees.
process.env.IPO_API_KEY = "test-ipo-key";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let token: string;
let models: typeof import("../../models");
let routes: typeof import("./ipos.routes");
let config: typeof import("../../env");

const realFetch = globalThis.fetch;

/** What the stubbed IPO Guru was asked, and what it should say next. */
let guruRequests: { path: string; key: string | null }[] = [];
let guruReplies: { status: number; json: unknown }[] = [];
let sleeps: number[] = [];

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_ipos_test"));

  const [{ app }, auth, loaded, loadedRoutes, loadedEnv] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./ipos.routes"),
    import("../../env"),
  ]);
  models = loaded;
  routes = loadedRoutes;
  config = loadedEnv;
  routes.setIpoSleepForTests(async (ms) => {
    sleeps.push(ms);
  });

  const user = await models.User.create({ email: "ipos@example.com" });
  token = auth.signSessionToken({ id: user._id.toString(), email: "ipos@example.com" });

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // IPO Guru is stubbed; the test's own calls to the app go through for real.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://www.ipoguru.in/")) return realFetch(input, init);

    const headers = new Headers(init?.headers);
    guruRequests.push({ path: url.replace("https://www.ipoguru.in/api/v2", ""), key: headers.get("X-API-KEY") });
    const reply = guruReplies.shift();
    assert.ok(reply, `unexpected IPO Guru call to ${url}`);
    return new Response(JSON.stringify(reply.json), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  routes.setIpoSleepForTests(undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await routes.iposSettled();
  guruRequests = [];
  guruReplies = [];
  sleeps = [];
  config.env.ipoApiKey = "test-ipo-key";
  await models.IpoCache.deleteMany({});
});

async function getIpos() {
  const response = await realFetch(`${baseUrl}/ipos`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return (await response.json()) as any;
}

/** Pushes the cache's last fetch, or last failure, back in time. */
async function age(field: "fetchedAt" | "lastErrorAt", minutes: number) {
  await models.IpoCache.updateOne({ key: "guru" }, { $set: { [field]: new Date(Date.now() - minutes * 60_000) } });
}

/** One calendar item the way IPO Guru documents it, strings and all. */
function item(overrides: Record<string, unknown> = {}) {
  return {
    slug: "acme",
    name: "Acme Limited",
    display_name: "Acme",
    type: "Mainboard",
    status: "Open",
    is_listed: false,
    open_date: "2026-10-09",
    close_date: "2026-10-13",
    allotment_date: "2026-10-14",
    listing_date: "2026-10-16",
    price_band: "₹100 - ₹105",
    price_min: "100",
    price_max: "105",
    issue_price: null,
    issue_size: "₹1,200 Cr",
    lot_size: "142",
    min_investment: "14,910",
    gmp: { price: "12", percentage: "11.43", kostak: null, updated_at_label: "2 hours ago" },
    subscription_total: "3.4x",
    web_url: "https://www.ipoguru.in/ipo/acme",
    ...overrides,
  };
}

const ok = (json: unknown) => ({ status: 200, json });

describe("GET /ipos", () => {
  it("says it isn't available when there's no key, without calling out", async () => {
    config.env.ipoApiKey = "";
    assert.deepEqual(await getIpos(), { available: false });
    assert.equal(guruRequests.length, 0);
  });

  it("fetches once, reads the strings into paise, and serves the cache after", async () => {
    guruReplies.push(ok({ data: [item()] }));

    const first = await getIpos();
    assert.equal(first.available, true);
    assert.equal(first.stale, false);
    assert.equal(first.error, null);
    assert.deepEqual(first.source, { name: "IPO Guru", url: "https://www.ipoguru.in" });
    assert.ok(first.fetchedAt);
    assert.deepEqual(guruRequests, [{ path: "/ipos", key: "test-ipo-key" }]);

    assert.equal(first.open.length, 1);
    const acme = first.open[0];
    assert.equal(acme.name, "Acme");
    assert.equal(acme.type, "MAINBOARD");
    assert.equal(acme.status, "OPEN");
    assert.equal(acme.priceBand, "₹100 - ₹105");
    assert.equal(acme.priceMaxMinor, 10_500);
    assert.equal(acme.lotSize, 142);
    assert.equal(acme.minInvestmentMinor, 1_491_000);
    assert.equal(acme.subscriptionTimes, 3.4);
    assert.deepEqual(acme.gmp, { premiumMinor: 1_200, percent: 11.43, updatedAtLabel: "2 hours ago" });
    assert.deepEqual(acme.perLot, { costMinor: 1_491_000, atGmpMinor: 1_661_400, gainMinor: 170_400, gainPercent: 11.43 });
    assert.equal(acme.webUrl, "https://www.ipoguru.in/ipo/acme");

    const second = await getIpos();
    assert.equal(second.fetchedAt, first.fetchedAt);
    assert.equal(second.open.length, 1);
    assert.equal(guruRequests.length, 1);
  });

  it("only lets one fetch out when requests arrive together", async () => {
    guruReplies.push(ok([item()]));
    const [a, b, c] = await Promise.all([getIpos(), getIpos(), getIpos()]);
    assert.equal(guruRequests.length, 1);
    for (const body of [a, b, c]) assert.equal(body.open.length, 1);
  });

  it("refetches once the cache is six hours old", async () => {
    guruReplies.push(ok([item()]));
    await getIpos();
    await age("fetchedAt", 6 * 60 + 1);

    guruReplies.push(ok([item({ lot_size: "150" })]));
    const body = await getIpos();
    assert.equal(guruRequests.length, 2);
    assert.equal(body.open[0].lotSize, 150);
    assert.equal(body.stale, false);
  });

  it("serves the last good rows as stale when IPO Guru fails, and waits before trying again", async () => {
    guruReplies.push(ok([item()]));
    await getIpos();
    await age("fetchedAt", 7 * 60);

    guruReplies.push({ status: 500, json: { message: "down" } });
    const failed = await getIpos();
    assert.equal(guruRequests.length, 2);
    assert.equal(failed.stale, true);
    assert.equal(failed.error, "IPO Guru couldn't answer just now.");
    assert.equal(failed.open.length, 1);
    assert.ok(failed.fetchedAt);

    // Inside the 30 minutes: no call, same stale rows.
    const meanwhile = await getIpos();
    assert.equal(guruRequests.length, 2);
    assert.equal(meanwhile.stale, true);
    assert.equal(meanwhile.open.length, 1);

    await age("lastErrorAt", 31);
    guruReplies.push(ok([item()]));
    const recovered = await getIpos();
    assert.equal(guruRequests.length, 3);
    assert.equal(recovered.stale, false);
    assert.equal(recovered.error, null);
  });

  it("returns empty lists and the reason when the very first fetch fails", async () => {
    guruReplies.push({ status: 429, json: { message: "Too many requests" } });
    const body = await getIpos();
    assert.equal(body.available, true);
    assert.equal(body.fetchedAt, null);
    assert.equal(body.stale, false);
    assert.match(body.error, /daily limit/);
    assert.deepEqual([body.open, body.upcoming, body.closed], [[], [], []]);

    // Backing off: no second call straight after.
    await getIpos();
    assert.equal(guruRequests.length, 1);
  });

  it("fetches GMP a minute later when the calendar has none, and merges it by slug", async () => {
    const bare = (overrides: Record<string, unknown>) => {
      const { gmp: _gmp, ...rest } = item(overrides);
      return rest;
    };
    guruReplies.push(
      ok({
        data: [
          bare({}),
          bare({ slug: "tiny", name: "Tiny SME", display_name: null, type: "SME", price_max: "50", lot_size: "2000" }),
          bare({ slug: "flat", name: "Flat Co", display_name: null, price_max: "200", lot_size: "75" }),
        ],
        locked: { fields: ["kostak", "subject_to_sauda"] },
      })
    );
    guruReplies.push(
      ok({
        data: [
          { slug: "acme", gmp: { price: "-5", percentage: null, updated_at_label: "1 hour ago" } },
          { slug: "flat", price: "0", percentage: "0" },
        ],
      })
    );

    // The calendar is shown straight away, without waiting for GMP.
    const first = await getIpos();
    assert.equal(first.open.length, 3);
    assert.ok(first.open.every((row: any) => row.gmp === null && row.perLot === null));

    await routes.iposSettled();
    assert.deepEqual(
      guruRequests.map((request) => request.path),
      ["/ipos", "/gmp"]
    );
    assert.deepEqual(sleeps, [61_000]);

    const merged = await getIpos();
    const bySlug = Object.fromEntries(merged.open.map((row: any) => [row.slug, row]));
    assert.deepEqual(bySlug.acme.gmp, { premiumMinor: -500, percent: -4.76, updatedAtLabel: "1 hour ago" });
    assert.equal(bySlug.acme.perLot.gainMinor, -71_000);
    assert.equal(bySlug.flat.gmp.premiumMinor, 0);
    assert.deepEqual(bySlug.flat.perLot, { costMinor: 1_500_000, atGmpMinor: 1_500_000, gainMinor: 0, gainPercent: 0 });
    assert.equal(bySlug.tiny.type, "SME");
    assert.equal(bySlug.tiny.gmp, null);
    assert.equal(bySlug.tiny.perLot, null);
    assert.equal(guruRequests.length, 2);
  });

  it("drops IPOs that have already listed", async () => {
    guruReplies.push(
      ok([
        item(),
        item({ slug: "done", name: "Done Ltd", display_name: null, status: "Closed", is_listed: true }),
        item({ slug: "waiting", name: "Waiting Ltd", display_name: null, status: "Closed", is_listed: false }),
      ])
    );
    const body = await getIpos();
    assert.deepEqual(
      body.closed.map((row: any) => row.slug),
      ["waiting"]
    );
    assert.equal(body.open.length, 1);
  });

  it("sorts open by closing date, upcoming by opening date with undated last, closed by listing date", async () => {
    guruReplies.push(
      ok([
        item({ slug: "open-late", close_date: "2026-10-15" }),
        item({ slug: "open-soon", close_date: "2026-10-12" }),
        item({ slug: "up-undated", status: "Upcoming", open_date: null }),
        item({ slug: "up-late", status: "Upcoming", open_date: "2026-10-20" }),
        item({ slug: "up-soon", status: "Upcoming", open_date: "2026-10-14" }),
        item({ slug: "closed-late", status: "Closed", listing_date: "2026-10-18" }),
        item({ slug: "closed-soon", status: "Closed", listing_date: "2026-10-12" }),
      ])
    );
    const body = await getIpos();
    const slugs = (rows: any[]) => rows.map((row) => row.slug);
    assert.deepEqual(slugs(body.open), ["open-soon", "open-late"]);
    assert.deepEqual(slugs(body.upcoming), ["up-soon", "up-late", "up-undated"]);
    assert.deepEqual(slugs(body.closed), ["closed-soon", "closed-late"]);
  });

  it("refuses a request without a session", async () => {
    const response = await realFetch(`${baseUrl}/ipos`);
    assert.equal(response.status, 401);
  });
});
