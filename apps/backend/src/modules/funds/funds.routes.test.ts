import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "funds-test-secret";
process.env.STATEMENT_ENCRYPTION_KEY = "b".repeat(64);

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let cache: typeof import("./funds.cache");
let crypto: typeof import("../statements/statements.crypto");

const realFetch = globalThis.fetch;

// ---- A small, consistent upstream: mfapi.in, AMFI and Gemini ----

const DAY_MS = 24 * 60 * 60 * 1000;
const istToday = () => new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
const addMonths = (day: string, count: number) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 10);
};

const TODAY = istToday();
/// The last NAV published: the last weekday before today.
let LAST = addDays(TODAY, -1);
while (isWeekend(LAST)) LAST = addDays(LAST, -1);
const START = addDays(LAST, -4 * 365);

interface Scheme {
  code: number;
  base: string;
  plan: "Direct Plan" | "Regular Plan";
  option: string;
  house: string;
  category: string;
  growth: number;
}

const FLEXI = "Equity Scheme - Flexi Cap Fund";
const LIQUID = "Debt Scheme - Liquid Fund";
const SHORT = "Debt Scheme - Short Duration Fund";
const BAF = "Hybrid Scheme - Dynamic Asset Allocation or Balanced Advantage";
const INDEX = "Other Scheme - Index Funds";

const scheme = (code: number, base: string, house: string, category: string, growth: number, plan: Scheme["plan"] = "Direct Plan", option = "Growth"): Scheme => ({
  code,
  base,
  plan,
  option,
  house,
  category,
  growth,
});

const SCHEMES: Scheme[] = [
  scheme(100001, "Laggard Flexi Cap Fund", "Laggard Mutual Fund", FLEXI, 0.04),
  scheme(100002, "Laggard Flexi Cap Fund", "Laggard Mutual Fund", FLEXI, 0.03, "Regular Plan"),
  ...[0.08, 0.1, 0.12, 0.14, 0.16, 0.18, 0.2, 0.22].map((growth, i) =>
    scheme(100011 + i, `Peer${i + 1} Flexi Cap Fund`, `Peer${i + 1} Mutual Fund`, FLEXI, growth)
  ),
  scheme(100019, "Peer1 Flexi Cap Fund", "Peer1 Mutual Fund", FLEXI, 0.08, "Direct Plan", "IDCW"),
  ...[0.065, 0.066, 0.067, 0.064].map((growth, i) =>
    scheme(200001 + i, `Liquid${i + 1} Liquid Fund`, `Liquid${i + 1} Mutual Fund`, LIQUID, growth)
  ),
  ...[0.07, 0.072, 0.075].map((growth, i) => scheme(300001 + i, `Short${i + 1} Short Duration Fund`, `Short${i + 1} Mutual Fund`, SHORT, growth)),
  ...[0.09, 0.095, 0.1].map((growth, i) => scheme(400001 + i, `Baf${i + 1} Balanced Advantage Fund`, `Baf${i + 1} Mutual Fund`, BAF, growth)),
  scheme(500001, "Alpha Nifty 50 Index Fund", "Alpha Mutual Fund", INDEX, 0.11),
  scheme(500002, "Beta Nifty 50 Index Fund", "Beta Mutual Fund", INDEX, 0.111),
  scheme(500003, "Gamma Nifty Next 50 Index Fund", "Gamma Mutual Fund", INDEX, 0.2),
  scheme(500004, "Delta Nifty 50 Index Fund", "Delta Mutual Fund", INDEX, 0.109),
];
const byCode = new Map(SCHEMES.map((s) => [s.code, s]));
const fullName = (s: Scheme) => `${s.base} - ${s.plan} - ${s.option}`;

function navOn(s: Scheme, day: string): number {
  const days = (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${START}T00:00:00Z`)) / DAY_MS;
  return Math.round(10 * Math.pow(1 + s.growth, days / 365) * 10_000) / 10_000;
}

function weekdays(): string[] {
  const days: string[] = [];
  for (let day = START; day <= LAST; day = addDays(day, 1)) if (!isWeekend(day)) days.push(day);
  return days;
}
const DAYS = weekdays();

const ddmmyyyy = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const amfiDate = (day: string) => `${day.slice(8, 10)}-${MONTHS[Number(day.slice(5, 7)) - 1]}-${day.slice(0, 4)}`;
const fromAmfiDate = (text: string) => {
  const [dd, mon, yyyy] = text.split("-");
  return `${yyyy}-${String(MONTHS.indexOf(mon) + 1).padStart(2, "0")}-${dd}`;
};

function mfapiScheme(code: number) {
  const s = byCode.get(code);
  if (!s) {
    return { meta: { fund_house: "", scheme_type: "", scheme_category: "", scheme_code: 0, scheme_name: "" }, data: [], status: "SUCCESS" };
  }
  return {
    meta: {
      fund_house: s.house,
      scheme_type: "Open Ended Schemes",
      scheme_category: s.category,
      scheme_code: code,
      scheme_name: fullName(s),
      isin_growth: `INF${code}`,
      isin_div_reinvestment: null,
    },
    data: [...DAYS].reverse().map((day) => ({ date: ddmmyyyy(day), nav: navOn(s, day).toFixed(5) })),
    status: "SUCCESS",
  };
}

/** NAVAll.txt in AMFI's current layout. */
function navAll(): string {
  const lines = ["Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date", " "];
  for (const category of [FLEXI, LIQUID, SHORT, BAF, INDEX]) {
    lines.push(`Open Ended Schemes(${category})`, " ");
    for (const s of SCHEMES.filter((row) => row.category === category)) {
      lines.push(s.house, " ", `${s.code};INF${s.code};-;${s.base};${s.plan};${s.option};${navOn(s, LAST)};${amfiDate(LAST)}`, " ");
    }
  }
  return lines.join("\r\n");
}

/** The NAV history report for one day; a weekend's has only the liquid funds. */
function history(day: string): string {
  const lines = ["Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date", ""];
  const schemes = isWeekend(day) ? SCHEMES.filter((s) => s.category === LIQUID).slice(0, 1) : SCHEMES;
  for (const s of schemes) {
    if (day < START) continue;
    lines.push(`Open Ended Schemes ( ${s.category} )`, "", s.house, `${s.code};${fullName(s)};${s.plan};${s.option};INF${s.code};;${navOn(s, day)};${amfiDate(day)}`);
  }
  return lines.join("\n");
}

let requests: string[] = [];
let upstreamDown = false;
let geminiRequests: any[] = [];
let geminiReplies: ((body: any) => unknown)[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "generativelanguage.googleapis.com") {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    geminiRequests.push(body);
    const reply = geminiReplies.shift();
    assert.ok(reply, "unexpected Gemini call");
    return json({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(reply(body)) }] } }] });
  }
  if (url.hostname === "api.mfapi.in") {
    requests.push(`mfapi ${url.pathname}${url.search}`);
    if (upstreamDown) return json({ message: "down" }, 503);
    if (url.pathname === "/mf/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json(SCHEMES.filter((s) => fullName(s).toLowerCase().includes(q)).map((s) => ({ schemeCode: s.code, schemeName: fullName(s) })));
    }
    return json(mfapiScheme(Number(url.pathname.split("/").pop())));
  }
  if (url.hostname === "portal.amfiindia.com") {
    requests.push(`amfi ${url.pathname}${url.search}`);
    if (upstreamDown) return new Response("down", { status: 503 });
    if (url.pathname === "/spages/NAVAll.txt") return new Response(navAll(), { status: 200 });
    return new Response(history(fromAmfiDate(url.searchParams.get("frmdt")!)), { status: 200 });
  }
  return realFetch(input, init);
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_funds_test"));

  const [{ app }, auth, loadedModels, loadedCache, loadedCrypto] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./funds.cache"),
    import("../statements/statements.crypto"),
  ]);
  signToken = auth.signSessionToken;
  models = loadedModels;
  cache = loadedCache;
  crypto = loadedCrypto;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  globalThis.fetch = fakeFetch as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await cache.fundsSettled();
  requests = [];
  upstreamDown = false;
  geminiRequests = [];
  geminiReplies = [];
  await Promise.all([
    models.User.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.FixedCommitment.deleteMany({}),
    models.FundHolding.deleteMany({}),
    models.FundTxn.deleteMany({}),
    models.FundNav.deleteMany({}),
    models.FundCache.deleteMany({}),
    models.Goal.deleteMany({}),
    models.FundAdvice.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser(extra: Record<string, unknown> = {}) {
  const email = `funds${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ...extra });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

async function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const response = await realFetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function addHolding(token: string, body: Record<string, unknown>) {
  const response = await call("/funds/holdings", token, { method: "POST", body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function debit(userId: Types.ObjectId, day: string, amountMinor: number, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    type: "DEBIT",
    amountMinor,
    currency: "INR",
    source: "SMS",
    occurredAt: new Date(`${day}T10:00:00+05:30`),
    ...extra,
  });
}

/** The SIP days from `startOn` that have a NAV by now. */
function sipDaysSoFar(startOn: string, dayOfMonth: number): string[] {
  const out: string[] = [];
  for (let month = startOn.slice(0, 7); ; ) {
    const day = `${month}-${String(dayOfMonth).padStart(2, "0")}`;
    if (day > LAST) break;
    if (day >= startOn && DAYS.some((d) => d >= day)) out.push(day);
    month = addMonths(`${month}-01`, 1).slice(0, 7);
  }
  return out;
}

describe("adding holdings", () => {
  it("adds one by units, valued at the latest NAV", async () => {
    const user = await makeUser();
    const asOf = addDays(LAST, -200);
    const body = await addHolding(user.token, {
      schemeCode: 100011,
      folio: "1234567/89",
      opening: { units: 1000, investedMinor: 1_200_000, asOf },
    });

    assert.equal(body.schemeName, "Peer1 Flexi Cap Fund - Direct Plan - Growth");
    assert.equal(body.fundHouse, "Peer1 Mutual Fund");
    assert.equal(body.category, FLEXI);
    assert.equal(body.categoryKey, "equity:flexi cap");
    assert.equal(body.assetClass, "equity");
    assert.equal(body.isDirect, true);
    assert.equal(body.isGrowth, true);
    assert.equal(body.units, 1000);
    assert.equal(body.investedMinor, 1_200_000);
    assert.equal(body.valueMinor, Math.round(1000 * navOn(byCode.get(100011)!, LAST) * 100));
    assert.equal(body.nav.day, LAST);
    assert.equal(body.txns.length, 1);
    assert.equal(body.txns[0].kind, "OPENING");
    assert.ok(body.sparkline.length > 40 && body.sparkline.length <= 62);
    assert.equal(body.sparkline.at(-1).day, LAST);
    assert.deepEqual(requests.filter((r) => r.startsWith("mfapi")), ["mfapi /mf/100011"]);

    const duplicate = await call("/funds/holdings", user.token, {
      method: "POST",
      body: { schemeCode: 100011, folio: "1234567/89" },
    });
    assert.equal(duplicate.status, 409);
  });

  it("refuses a scheme mfapi doesn't know, and a snapshot from the future", async () => {
    const user = await makeUser();
    assert.equal((await call("/funds/holdings", user.token, { method: "POST", body: { schemeCode: 999 } })).status, 404);
    const future = await call("/funds/holdings", user.token, {
      method: "POST",
      body: { schemeCode: 100011, opening: { units: 1, investedMinor: 100, asOf: addDays(TODAY, 3) } },
    });
    assert.equal(future.status, 400);
  });

  it("adds one by SIP, each instalment's units from the NAV on its day", async () => {
    const user = await makeUser();
    const startOn = addMonths(TODAY, -14);
    const body = await addHolding(user.token, {
      schemeCode: 100014,
      sip: { amountMinor: 500_000, dayOfMonth: 10, startOn },
    });

    const expected = sipDaysSoFar(startOn, 10);
    const scheduled = body.txns.filter((txn: any) => txn.kind === "SIP_SCHEDULED");
    assert.equal(scheduled.length, expected.length);
    assert.equal(body.investedMinor, expected.length * 500_000);
    assert.deepEqual(body.sip, {
      amountMinor: 500_000,
      dayOfMonth: 10,
      startOn,
      endOn: null,
      active: true,
      steps: [{ fromOn: startOn, amountMinor: 500_000, dayOfMonth: null }],
      skips: [],
      pauses: [],
      currentAmountMinor: 500_000,
      currentDayOfMonth: 10,
    });
    assert.equal(body.monthlySipMinor, 500_000);

    // A weekend SIP day takes Monday's NAV.
    for (const txn of scheduled) {
      assert.ok(txn.navDay >= txn.on && !isWeekend(txn.navDay));
      const units = 5_000 / navOn(byCode.get(100014)!, txn.navDay);
      assert.ok(Math.abs(txn.units - units) < 0.001);
    }
    assert.ok(body.xirrPercent > 12 && body.xirrPercent < 16, `${body.xirrPercent}`);
  });
});

describe("linking SIP debits", () => {
  it("suggests a likely debit, links it in place of the scheduled instalment, and leaves its counted amount alone", async () => {
    const user = await makeUser();
    const startOn = addMonths(TODAY, -6);
    const holding = await addHolding(user.token, {
      schemeCode: 100013,
      sip: { amountMinor: 500_000, dayOfMonth: 5, startOn },
    });
    const before = holding.txns.filter((txn: any) => txn.kind === "SIP_SCHEDULED");
    const due = before[2].on;

    const sipDebit = await debit(user.id, addDays(due, -1), 500_000, { merchant: "ACH D- INDIAN CLEARING CORP" });
    await debit(user.id, due, 500_000, { merchant: "Croma Electronics" });
    const countedBefore = sipDebit.countedAmountMinor;

    const suggestions = await call("/funds/link-suggestions", user.token);
    assert.equal(suggestions.status, 200);
    assert.equal(suggestions.body.suggestions.length, 1);
    assert.equal(suggestions.body.suggestions[0].transactionId, sipDebit._id.toString());
    assert.equal(suggestions.body.suggestions[0].holdingId, holding.id);
    assert.deepEqual(suggestions.body.suggestions[0].reasons, ["sip_words", "amount", "day"]);

    const linked = await call(`/funds/holdings/${holding.id}/link`, user.token, {
      method: "POST",
      body: { transactionId: sipDebit._id.toString() },
    });
    assert.equal(linked.status, 200);
    const after = linked.body.txns;
    assert.equal(after.length, before.length);
    assert.ok(!after.some((txn: any) => txn.kind === "SIP_SCHEDULED" && txn.on === due));
    const link = after.find((txn: any) => txn.kind === "LINKED");
    assert.equal(link.transactionId, sipDebit._id.toString());
    assert.equal(link.on, addDays(due, -1));
    assert.equal(link.via, "link");
    assert.equal(linked.body.investedMinor, holding.investedMinor);

    // Still counted against the budget exactly as before.
    const reread = await models.Transaction.findById(sipDebit._id).lean();
    assert.equal(reread!.countedAmountMinor, countedBefore);
    assert.equal(reread!.countedAmountMinor, 500_000);

    // No longer suggested; can't be linked to a second fund.
    assert.equal((await call("/funds/link-suggestions", user.token)).body.suggestions.length, 0);
    const other = await addHolding(user.token, { schemeCode: 100012, opening: { units: 1, investedMinor: 1000, asOf: LAST } });
    const twice = await call(`/funds/holdings/${other.id}/link`, user.token, {
      method: "POST",
      body: { transactionId: sipDebit._id.toString() },
    });
    assert.equal(twice.status, 409);

    // Unlinked, the scheduled instalment is back.
    const unlinked = await call(`/funds/holdings/${holding.id}/link/${sipDebit._id}`, user.token, { method: "DELETE" });
    assert.equal(unlinked.status, 200);
    assert.ok(unlinked.body.txns.some((txn: any) => txn.kind === "SIP_SCHEDULED" && txn.on === due));
    assert.equal((await call(`/funds/holdings/${holding.id}/link/${sipDebit._id}`, user.token, { method: "DELETE" })).status, 404);
  });

  it("refuses money coming in, and someone else's transaction", async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const holding = await addHolding(user.token, { schemeCode: 100013 });
    const credit = await models.Transaction.create({
      userId: user.id,
      type: "CREDIT",
      amountMinor: 1000,
      currency: "INR",
      source: "SMS",
      occurredAt: new Date(),
    });
    const theirs = await debit(stranger.id, LAST, 1000);
    const link = (transactionId: string) =>
      call(`/funds/holdings/${holding.id}/link`, user.token, { method: "POST", body: { transactionId } });
    assert.equal((await link(credit._id.toString())).status, 400);
    assert.equal((await link(theirs._id.toString())).status, 404);
  });

  it("connects a SIP commitment so the debits matched to it count as instalments", async () => {
    const user = await makeUser();
    const startOn = addMonths(TODAY, -4);
    const holding = await addHolding(user.token, { schemeCode: 100015, sip: { amountMinor: 300_000, dayOfMonth: 12, startOn } });
    const commitment = await models.FixedCommitment.create({
      userId: user.id,
      name: "Peer5 SIP",
      amountMinor: 300_000,
      dayOfMonth: 12,
      kind: "SIP",
    });
    const rent = await models.FixedCommitment.create({ userId: user.id, name: "Rent", amountMinor: 2_000_000, dayOfMonth: 1, kind: "RENT" });
    const due = holding.txns.filter((txn: any) => txn.kind === "SIP_SCHEDULED")[1].on;
    const paid = await debit(user.id, due, 300_000, { merchant: "NACH", commitmentId: commitment._id });

    const suggestions = await call("/funds/link-suggestions", user.token);
    assert.deepEqual(suggestions.body.commitments, [
      {
        commitmentId: commitment._id.toString(),
        name: "Peer5 SIP",
        amountMinor: 300_000,
        dayOfMonth: 12,
        isActive: true,
        matchedDebits: 1,
        suggestedHoldingId: holding.id,
      },
    ]);

    const notSip = await call(`/funds/holdings/${holding.id}`, user.token, { method: "PATCH", body: { commitmentId: rent._id.toString() } });
    assert.equal(notSip.status, 400);

    const connected = await call(`/funds/holdings/${holding.id}`, user.token, {
      method: "PATCH",
      body: { commitmentId: commitment._id.toString() },
    });
    assert.equal(connected.status, 200);
    assert.equal(connected.body.commitmentId, commitment._id.toString());
    const viaCommitment = connected.body.txns.filter((txn: any) => txn.kind === "LINKED");
    assert.equal(viaCommitment.length, 1);
    assert.equal(viaCommitment[0].via, "commitment");
    assert.equal(viaCommitment[0].transactionId, paid._id.toString());
    assert.equal(connected.body.txns.length, holding.txns.length);

    // Connected, it's no longer offered, and its debits aren't either.
    const after = await call("/funds/link-suggestions", user.token);
    assert.deepEqual(after.body.commitments, []);
    assert.deepEqual(after.body.suggestions, []);
  });
});

describe("the portfolio", () => {
  it("adds up the holdings, ranks each in its category and flags the laggards", async () => {
    const user = await makeUser();
    const startOn = addMonths(TODAY, -26);
    const laggard = await addHolding(user.token, { schemeCode: 100001, sip: { amountMinor: 200_000, dayOfMonth: 1, startOn } });
    const regular = await addHolding(user.token, {
      schemeCode: 100002,
      opening: { units: 500, investedMinor: 600_000, asOf: addDays(LAST, -30), firstOn: addMonths(TODAY, -30) },
    });
    const good = await addHolding(user.token, { schemeCode: 100018, sip: { amountMinor: 300_000, dayOfMonth: 15, startOn } });
    const liquid = await addHolding(user.token, { schemeCode: 200003, opening: { units: 10, investedMinor: 120_000, asOf: LAST } });
    const idcw = await addHolding(user.token, {
      schemeCode: 100019,
      opening: { units: 10, investedMinor: 10_000, asOf: addDays(LAST, -400) },
    });

    const response = await call("/funds/portfolio", user.token);
    assert.equal(response.status, 200);
    const { holdings, totals, allocation, peers } = response.body;
    assert.equal(holdings.length, 5);
    assert.equal(response.body.stale, false);
    assert.equal(response.body.error, null);
    assert.equal(response.body.lastNavDate, LAST);
    assert.equal(peers.available, true);
    assert.equal(peers.asOf, LAST);

    const byId = Object.fromEntries(holdings.map((holding: any) => [holding.id, holding]));
    assert.equal(totals.investedMinor, holdings.reduce((sum: number, h: any) => sum + h.investedMinor, 0));
    assert.equal(totals.valueMinor, holdings.reduce((sum: number, h: any) => sum + h.valueMinor, 0));
    assert.equal(totals.gainMinor, totals.valueMinor - totals.investedMinor);
    assert.equal(totals.monthlySipMinor, 500_000);
    assert.ok(totals.xirrPercent !== null);
    assert.equal(
      allocation.reduce((sum: number, row: any) => sum + row.valueMinor, 0),
      totals.valueMinor
    );
    const debt = allocation.find((row: any) => row.assetClass === "debt");
    assert.equal(debt.valueMinor, byId[liquid.id].valueMinor);

    // The laggard: last of nine direct-growth flexi caps, and earning less
    // than a liquid fund after two years.
    const lag = byId[laggard.id];
    assert.equal(lag.peers.basis, "3y");
    assert.deepEqual(lag.peers.rank, { rank: 9, of: 9, percentile: 0 });
    assert.equal(lag.peers.threeYear.count, 9);
    assert.ok(Math.abs(lag.returns.threeYearPercent - 4) < 0.05, `${lag.returns.threeYearPercent}`);
    assert.ok(Math.abs(lag.peers.threeYear.medianPercent - 14) < 0.05, `${lag.peers.threeYear.medianPercent}`);
    assert.deepEqual(lag.flags, ["lagging_category", "low_xirr"]);

    // A regular plan, ranked against the direct plans it could be in.
    assert.equal(byId[regular.id].isRegular, true);
    assert.equal(byId[regular.id].isDirect, false);
    // Growing at 3% a year: under a liquid fund after more than a year, too.
    assert.deepEqual(byId[regular.id].flags, ["lagging_category", "low_xirr", "regular_plan"]);

    // An IDCW plan's NAV-based returns leave out its payouts: not flagged as lagging.
    assert.equal(byId[idcw.id].isGrowth, false);
    assert.equal(byId[idcw.id].peers.rank.rank, 8);
    assert.deepEqual(byId[idcw.id].flags, []);

    const best = byId[good.id];
    assert.equal(best.peers.rank.rank, 1);
    assert.deepEqual(best.flags, []);

    // The flag thresholds are in the response for the app to explain.
    assert.deepEqual(response.body.flagRules.belowMedianPp, { "3y": 2, "1y": 3 });
    assert.equal(response.body.flagRules.liquidRatePercent, 6.5);

    // The peer table was built once: today's NAVAll, then one history file
    // per day tried. How many days that takes depends on the calendar - a
    // year back can land on a weekend and step back to the Friday - so the
    // count is not fixed, but no day is ever asked for twice.
    const amfi = requests.filter((r) => r.startsWith("amfi"));
    assert.equal(amfi[0], "amfi /spages/NAVAll.txt");
    const history = amfi.slice(1);
    assert.ok(history.length >= 2, `${amfi}`);
    assert.equal(new Set(history).size, history.length, `${amfi}`);
    assert.ok(history.every((r) => r.includes("DownloadNAVHistoryReport")), `${amfi}`);

    // And a second look reads it from the store.
    requests = [];
    await call("/funds/portfolio", user.token);
    assert.equal(requests.filter((r) => r.startsWith("amfi")).length, 0);
  });

  it("serves stored prices, marked stale, when mfapi is down, and waits before asking again", async () => {
    const user = await makeUser();
    const holding = await addHolding(user.token, { schemeCode: 100016, opening: { units: 100, investedMinor: 100_000, asOf: addDays(LAST, -100) } });
    await call("/funds/portfolio", user.token);
    await models.FundNav.updateOne({ schemeCode: 100016 }, { $set: { fetchedAt: new Date(Date.now() - 2 * DAY_MS) } });

    upstreamDown = true;
    requests = [];
    const response = await call("/funds/portfolio", user.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.stale, true);
    assert.match(response.body.error, /mfapi\.in couldn't answer/);
    assert.equal(response.body.holdings[0].valueMinor, holding.valueMinor);
    assert.equal(response.body.holdings[0].stale, true);
    assert.deepEqual(requests, ["mfapi /mf/100016"]);

    // Backing off: the next read doesn't call out.
    const again = await call("/funds/portfolio", user.token);
    assert.equal(again.status, 200);
    assert.equal(requests.length, 1);

    // The holding's own page works from the store too.
    const detail = await call(`/funds/holdings/${holding.id}`, user.token);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.valueMinor, holding.valueMinor);
  });

  it("works without category ranks when AMFI has never answered", async () => {
    const user = await makeUser();
    await addHolding(user.token, { schemeCode: 100016, opening: { units: 100, investedMinor: 100_000, asOf: LAST } });
    // Adding it built the peer table; this is a server that never could.
    await models.FundCache.deleteMany({ key: "peers" });
    upstreamDown = true;
    const response = await call("/funds/portfolio", user.token);
    assert.equal(response.status, 200);
    assert.equal(response.body.peers.available, false);
    assert.equal(response.body.holdings[0].peers, null);
    assert.ok(response.body.holdings[0].valueMinor > 0);
  });

  it("is empty, not an error, before the first holding", async () => {
    const user = await makeUser();
    const response = await call("/funds/portfolio", user.token);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.holdings, []);
    assert.equal(response.body.totals.valueMinor, 0);
    assert.equal(requests.length, 0);
  });

  it("adds a redemption by hand, and deletes a holding with everything that hangs off it", async () => {
    const user = await makeUser();
    const holding = await addHolding(user.token, { schemeCode: 100017, opening: { units: 100, investedMinor: 100_000, asOf: addDays(LAST, -60) } });
    const redeemed = await call(`/funds/holdings/${holding.id}/txns`, user.token, {
      method: "POST",
      body: { kind: "REDEEM", on: addDays(LAST, -10), units: 40 },
    });
    assert.equal(redeemed.status, 201);
    assert.equal(redeemed.body.units, 60);
    assert.equal(redeemed.body.investedMinor, 60_000);

    const goal = await call("/goals", user.token, {
      method: "POST",
      body: { name: "Trip", targetMinor: 5_000_000, targetOn: addMonths(TODAY, 20), holdingIds: [holding.id] },
    });
    assert.equal((await call(`/funds/holdings/${holding.id}`, user.token, { method: "DELETE" })).status, 204);
    assert.equal(await models.FundTxn.countDocuments({ holdingId: holding.id }), 0);
    const goals = await call("/goals", user.token);
    assert.deepEqual(goals.body.goals.find((g: any) => g.id === goal.body.id).holdingIds, []);
  });
});

describe("search", () => {
  it("searches mfapi, and the schemes already known when it's down", async () => {
    const user = await makeUser();
    const response = await call("/funds/search?q=liquid1", user.token);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.results, [
      { schemeCode: 200001, schemeName: "Liquid1 Liquid Fund - Direct Plan - Growth", isDirect: true, isGrowth: true, isRegular: false },
    ]);
    assert.equal(response.body.fromCache, false);

    await addHolding(user.token, { schemeCode: 100016 });
    upstreamDown = true;
    const offline = await call("/funds/search?q=peer6", user.token);
    assert.equal(offline.body.fromCache, true);
    assert.deepEqual(
      offline.body.results.map((row: any) => row.schemeCode),
      [100016]
    );
    assert.equal((await call("/funds/search?q=a", user.token)).status, 400);
  });
});

describe("the daily refresh", () => {
  /** An instant on an IST day, at an IST hour. */
  const at = (day: string, hour: number, minute = 0) =>
    new Date(Date.parse(`${day}T00:00:00Z`) - 5.5 * 3600_000 + (hour * 60 + minute) * 60_000);

  it("runs once a day after NAVs are out, however often it's asked", async () => {
    const user = await makeUser();
    await addHolding(user.token, { schemeCode: 100013 });
    await addHolding(user.token, { schemeCode: 200002 });
    await call("/funds/portfolio", user.token);
    requests = [];

    const first = await cache.runDailyFundRefresh(at(TODAY, 23, 30));
    assert.deepEqual(first, { ran: true, schemes: 2, failed: 0, peers: false });
    assert.deepEqual(requests.sort(), ["mfapi /mf/100013", "mfapi /mf/200002"]);

    // Asked again the same night, and the next day before 11 PM: nothing.
    requests = [];
    assert.equal((await cache.runDailyFundRefresh(at(TODAY, 23, 45))).ran, false);
    assert.equal((await cache.runDailyFundRefresh(at(addDays(TODAY, 1), 22, 59))).ran, false);
    assert.deepEqual(requests, []);

    // The next night it runs again - once, however many processes ask.
    const both = await Promise.all([
      cache.runDailyFundRefresh(at(addDays(TODAY, 1), 23, 5)),
      cache.runDailyFundRefresh(at(addDays(TODAY, 1), 23, 5)),
    ]);
    assert.deepEqual(
      both.map((run) => run.ran).sort(),
      [false, true]
    );
  });

  it("catches up at start-up when last night's run never happened", async () => {
    const user = await makeUser();
    await addHolding(user.token, { schemeCode: 100013 });
    await models.FundCache.create({ key: "daily", fetchedAt: at(addDays(TODAY, -2), 23, 10) });
    // Morning: last night's 11 PM has passed since the last run.
    assert.equal((await cache.runDailyFundRefresh(at(TODAY, 8))).ran, true);
  });

  it("doesn't count a night when every fetch failed, so it tries again", async () => {
    const user = await makeUser();
    await addHolding(user.token, { schemeCode: 100013 });
    upstreamDown = true;
    const failed = await cache.runDailyFundRefresh(at(TODAY, 23, 30));
    assert.deepEqual(failed, { ran: true, schemes: 1, failed: 1, peers: false });

    upstreamDown = false;
    await cache.fundsSettled();
    assert.equal((await cache.runDailyFundRefresh(at(TODAY, 23, 40))).ran, true);
    assert.equal((await cache.runDailyFundRefresh(at(TODAY, 23, 50))).ran, false);
  });

  it("knows when NAVs were last published", () => {
    assert.equal(cache.lastPublishMoment(at("2026-10-11", 23, 30)).toISOString(), at("2026-10-11", 23).toISOString());
    assert.equal(cache.lastPublishMoment(at("2026-10-11", 9)).toISOString(), at("2026-10-10", 23).toISOString());
  });
});

describe("goals", () => {
  it("plans a laptop on a liquid fund, with example funds, and tracks it as it changes", async () => {
    const user = await makeUser();
    const liquid = await addHolding(user.token, {
      schemeCode: 200001,
      sip: { amountMinor: 1_000_000, dayOfMonth: 1, startOn: addMonths(TODAY, -2) },
    });

    const created = await call("/goals", user.token, {
      method: "POST",
      body: { name: "Laptop", targetMinor: 20_000_000, targetOn: addMonths(TODAY, 8), holdingIds: [liquid.id] },
    });
    assert.equal(created.status, 201);
    const goal = created.body;
    assert.equal(goal.name, "Laptop");
    assert.equal(goal.monthsLeft, 8);
    assert.equal(goal.assumption.id, "liquid");
    assert.equal(goal.assumption.annualReturnPercent, 6.5);
    assert.equal(goal.suggestedCategory, "Liquid / overnight fund");
    assert.equal(goal.actualMonthlyMinor, 1_000_000);
    assert.ok(goal.progress.holdingsValueMinor > 0);
    assert.equal(goal.progress.currentMinor, goal.progress.holdingsValueMinor);
    assert.ok(goal.requiredMonthlyMinor > 1_000_000);
    assert.equal(goal.status, "behind");
    assert.match(goal.warning, /a month short/);
    // Best liquid funds by 1y return.
    assert.deepEqual(
      goal.exampleFunds.map((fund: any) => fund.schemeCode),
      [200003, 200002, 200001]
    );
    assert.ok(Math.abs(goal.exampleFunds[0].oneYearPercent - 6.7) < 0.05);

    const raised = await call(`/goals/${goal.id}`, user.token, { method: "PATCH", body: { savedMinor: 15_000_000 } });
    assert.equal(raised.status, 200);
    assert.equal(raised.body.status, "on_track");
    assert.equal(raised.body.progress.savedMinor, 15_000_000);
    assert.ok(raised.body.requiredMonthlyMinor < 1_000_000);
    assert.equal(raised.body.warning, null);

    const done = await call(`/goals/${goal.id}`, user.token, { method: "PATCH", body: { savedMinor: 20_000_000 } });
    assert.equal(done.body.status, "done");

    const list = await call("/goals", user.token);
    assert.equal(list.body.goals.length, 1);
    assert.equal(list.body.peersAvailable, true);
    assert.deepEqual(
      list.body.assumptions.map((band: any) => [band.id, band.annualReturnPercent]),
      [
        ["liquid", 6.5],
        ["short_debt", 7],
        ["hybrid", 9],
        ["equity", 11],
      ]
    );

    assert.equal((await call(`/goals/${goal.id}`, user.token, { method: "DELETE" })).status, 204);
    assert.deepEqual((await call("/goals", user.token)).body.goals, []);
  });

  it("picks Nifty 50 index funds for a goal years away", async () => {
    const user = await makeUser();
    const created = await call("/goals", user.token, {
      method: "POST",
      body: { name: "House", targetMinor: 500_000_000, targetOn: addMonths(TODAY, 120) },
    });
    assert.equal(created.body.assumption.id, "equity");
    // Ranked on 3y; the Nifty Next 50 fund is left out however well it did.
    assert.deepEqual(
      created.body.exampleFunds.map((fund: any) => fund.schemeCode),
      [500002, 500001, 500004]
    );
    assert.equal(created.body.status, "behind");
  });

  it("refuses a date that's passed, and someone else's fund", async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    const theirs = await addHolding(stranger.token, { schemeCode: 100013 });
    const past = await call("/goals", user.token, { method: "POST", body: { name: "X", targetMinor: 1000, targetOn: TODAY } });
    assert.equal(past.status, 400);
    const notMine = await call("/goals", user.token, {
      method: "POST",
      body: { name: "X", targetMinor: 100_000, targetOn: addMonths(TODAY, 3), holdingIds: [theirs.id] },
    });
    assert.equal(notMine.status, 400);
    assert.equal((await call(`/goals/${new Types.ObjectId()}`, user.token, { method: "DELETE" })).status, 404);
  });
});

describe("fund advice", () => {
  it("names only candidate funds, checks every id, and is kept for the day", async () => {
    const user = await makeUser({ geminiApiKeyEnc: crypto.encryptPassword("test-gemini-key"), geminiApiKeyHint: "-key" });
    const laggard = await addHolding(user.token, {
      schemeCode: 100001,
      sip: { amountMinor: 200_000, dayOfMonth: 1, startOn: addMonths(TODAY, -26) },
    });
    const goal = (
      await call("/goals", user.token, {
        method: "POST",
        body: { name: "Laptop", targetMinor: 20_000_000, targetOn: addMonths(TODAY, 8) },
      })
    ).body;

    geminiReplies.push((body) => {
      const prompt = body.contents[0].parts[0].text as string;
      assert.match(prompt, /Candidate funds/);
      assert.match(prompt, new RegExp(`id ${laggard.id}: Laggard Flexi Cap Fund`));
      assert.match(prompt, /ranks 9 of 9 on 3y/);
      assert.match(prompt, /code 100018: Peer8 Flexi Cap Fund/);
      assert.doesNotMatch(prompt, /code 100011:/);
      assert.match(body.systemInstruction.parts[0].text, /ONLY from the candidate list/);
      return {
        summary: "One fund is dragging the portfolio down.",
        underperformers: [
          { holdingId: laggard.id, reason: "XIRR 4% against a 14% category median; last of 9." },
          { holdingId: new Types.ObjectId().toString(), reason: "Made up." },
        ],
        actions: [
          {
            title: "Switch the laggard",
            detail: "Move the SIP to a top flexi cap fund.",
            amountRupees: 2000,
            category: "Flexi Cap",
            exampleFundCodes: [100018, 555555, 100018],
          },
          {
            title: "Try this one",
            detail: "Peer1 Flexi Cap Fund has done fine too.",
            exampleFundCodes: [],
          },
        ],
        goals: [
          { goalId: goal.id, line: "Put ₹24,500/month into a liquid fund, e.g. Liquid3 Liquid Fund." },
          { goalId: "nope", line: "Ignored." },
        ],
      };
    });

    const first = await call("/funds/advice", user.token, { method: "POST" });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.cached, false);
    assert.equal(first.body.hasKey, true);
    const advice = first.body.advice;
    assert.equal(advice.summary, "One fund is dragging the portfolio down.");
    assert.deepEqual(advice.underperformers, [
      { holdingId: laggard.id, schemeName: "Laggard Flexi Cap Fund - Direct Plan - Growth", reason: "XIRR 4% against a 14% category median; last of 9." },
    ]);
    // The made-up code is dropped, and so is the action naming a fund
    // that wasn't offered.
    assert.deepEqual(advice.actions, [
      {
        title: "Switch the laggard",
        detail: "Move the SIP to a top flexi cap fund.",
        amountMinor: 200_000,
        category: "Flexi Cap",
        exampleFunds: [{ schemeCode: 100018, name: "Peer8 Flexi Cap Fund - Direct Plan - Growth" }],
      },
    ]);
    assert.deepEqual(advice.goals, [
      { goalId: goal.id, name: "Laptop", line: "Put ₹24,500/month into a liquid fund, e.g. Liquid3 Liquid Fund." },
    ]);
    assert.match(advice.disclaimer, /not investment advice/);
    assert.match(advice.disclaimer, /Past returns/);
    assert.equal(geminiRequests.length, 1);

    // Kept for the day: no second call.
    const second = await call("/funds/advice", user.token, { method: "POST" });
    assert.equal(second.body.cached, true);
    assert.deepEqual(second.body.advice, advice);
    assert.equal(geminiRequests.length, 1);
    assert.deepEqual((await call("/funds/advice", user.token)).body.advice, advice);

    // Unless asked for a new one.
    geminiReplies.push(() => ({ summary: "Fresh.", underperformers: [], actions: [], goals: [] }));
    const fresh = await call("/funds/advice?refresh=1", user.token, { method: "POST" });
    assert.equal(fresh.body.cached, false);
    assert.equal(fresh.body.advice.summary, "Fresh.");
    assert.equal(geminiRequests.length, 2);
    assert.equal(await models.FundAdvice.countDocuments({ userId: user.id }), 1);
  });

  it("asks for a key when there isn't one", async () => {
    const user = await makeUser();
    const response = await call("/funds/advice", user.token, { method: "POST" });
    assert.equal(response.status, 409);
    assert.match(response.body.error, /Gemini API key/);
    const nothing = await call("/funds/advice", user.token);
    assert.deepEqual(nothing.body, { advice: null, day: null, model: null, cached: true, hasKey: false });
  });
});

describe("a SIP's history", () => {
  /** YYYY-MM, `count` months from this one. */
  const monthFrom = (count: number) => addMonths(`${TODAY.slice(0, 7)}-01`, count).slice(0, 7);
  const scheduledOf = (body: any) => body.txns.filter((txn: any) => txn.kind === "SIP_SCHEDULED");
  const sumAmounts = (txns: any[]) => txns.reduce((sum: number, txn: any) => sum + txn.amountMinor, 0);

  it("adds a fund with its whole history: 1,000 a month, 2,000 for two, one skipped", async () => {
    const user = await makeUser();
    const startOn = `${monthFrom(-9)}-10`;
    const twoFrom = monthFrom(-5);
    const backFrom = monthFrom(-3);
    const body = await addHolding(user.token, {
      schemeCode: 100014,
      sip: {
        amountMinor: 100_000,
        dayOfMonth: 10,
        startOn,
        steps: [
          { fromOn: `${twoFrom}-01`, amountMinor: 200_000 },
          { fromOn: `${backFrom}-01`, amountMinor: 100_000 },
        ],
        skips: [backFrom],
      },
    });

    const planned = (day: string) => (day.slice(0, 7) >= twoFrom && day.slice(0, 7) < backFrom ? 200_000 : 100_000);
    const expected = sipDaysSoFar(startOn, 10).filter((day) => day.slice(0, 7) !== backFrom);
    const scheduled = scheduledOf(body);
    assert.deepEqual(
      scheduled.map((txn: any) => [txn.on, txn.amountMinor]).reverse(),
      expected.map((day) => [day, planned(day)])
    );
    assert.equal(body.investedMinor, expected.reduce((sum, day) => sum + planned(day), 0));
    for (const txn of scheduled) {
      const units = txn.amountMinor / 100 / navOn(byCode.get(100014)!, txn.navDay);
      assert.ok(Math.abs(txn.units - units) < 0.001);
    }
    assert.ok(body.xirrPercent > 10 && body.xirrPercent < 18, `${body.xirrPercent}`);
    assert.equal(body.monthlySipMinor, 100_000);
    assert.equal(body.sipPaused, false);
    assert.deepEqual(
      body.sip.steps.map((step: any) => [step.fromOn, step.amountMinor]),
      [
        [startOn, 100_000],
        [`${twoFrom}-01`, 200_000],
        [`${backFrom}-01`, 100_000],
      ]
    );
    assert.deepEqual(body.sip.skips, [backFrom]);

    // Month by month, from the start to three months ahead.
    const plan = body.sipPlan;
    assert.equal(plan.length, 13);
    assert.equal(plan[0].month, monthFrom(-9));
    const at = (month: string) => plan.find((row: any) => row.month === month);
    assert.equal(at(backFrom).status, "skipped");
    assert.equal(at(backFrom).plannedMinor, 100_000);
    assert.equal(at(twoFrom).status, "invested");
    assert.equal(at(twoFrom).plannedMinor, 200_000);
    assert.equal(at(twoFrom).actualMinor, 200_000);
    assert.ok(at(twoFrom).units > 0 && at(twoFrom).nav > 0);
    assert.deepEqual(
      plan.slice(-3).map((row: any) => row.status),
      ["upcoming", "upcoming", "upcoming"]
    );
  });

  it("steps up, skips, takes a skip back, pauses and resumes - the figures and the goal following", async () => {
    const user = await makeUser();
    const startOn = `${monthFrom(-6)}-10`;
    const holding = await addHolding(user.token, { schemeCode: 100014, sip: { amountMinor: 100_000, dayOfMonth: 10, startOn } });
    const goal = await call("/goals", user.token, {
      method: "POST",
      body: { name: "Bike", targetMinor: 20_000_000, targetOn: addMonths(TODAY, 30), holdingIds: [holding.id] },
    });
    assert.equal(goal.body.actualMonthlyMinor, 100_000);
    const sipPath = `/funds/holdings/${holding.id}/sip`;

    const up = await call(`${sipPath}/change`, user.token, { method: "POST", body: { fromOn: `${monthFrom(-2)}-01`, amountMinor: 200_000 } });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.monthlySipMinor, 200_000);
    assert.equal(up.body.sip.currentAmountMinor, 200_000);
    assert.equal(up.body.investedMinor, sumAmounts(scheduledOf(up.body)));
    assert.ok(scheduledOf(up.body).some((txn: any) => txn.on.startsWith(monthFrom(-2)) && txn.amountMinor === 200_000));
    assert.ok(up.body.investedMinor > holding.investedMinor);

    const skip = await call(`${sipPath}/skip`, user.token, { method: "POST", body: { month: monthFrom(-4) } });
    assert.equal(skip.status, 200);
    assert.ok(!scheduledOf(skip.body).some((txn: any) => txn.on.startsWith(monthFrom(-4))));
    assert.equal(skip.body.investedMinor, up.body.investedMinor - 100_000);
    assert.ok(skip.body.units < up.body.units);
    const twice = await call(`${sipPath}/skip`, user.token, { method: "POST", body: { month: monthFrom(-4) } });
    assert.deepEqual(twice.body.sip.skips, [monthFrom(-4)]);

    const unskipped = await call(`${sipPath}/skip/${monthFrom(-4)}`, user.token, { method: "DELETE" });
    assert.equal(unskipped.status, 200);
    assert.deepEqual(unskipped.body.sip.skips, []);
    assert.equal(unskipped.body.investedMinor, up.body.investedMinor);

    // Paused from this month: nothing going in now, and the goal says so
    // rather than falling back on what went in before.
    const paused = await call(`${sipPath}/pause`, user.token, { method: "POST", body: { fromOn: `${monthFrom(0)}-01` } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.sipPaused, true);
    assert.equal(paused.body.monthlySipMinor, 0);
    assert.deepEqual(paused.body.sip.pauses, [{ fromOn: `${monthFrom(0)}-01`, toOn: null }]);
    assert.ok(paused.body.sipPlan.slice(-4).every((row: any) => row.status === "paused"));
    assert.equal((await call("/funds/portfolio", user.token)).body.totals.monthlySipMinor, 0);
    assert.equal((await call(`/goals`, user.token)).body.goals[0].actualMonthlyMinor, 0);

    const resumed = await call(`${sipPath}/resume`, user.token, { method: "POST", body: {} });
    assert.equal(resumed.status, 200);
    assert.deepEqual(resumed.body.sip.pauses, []);
    assert.equal(resumed.body.monthlySipMinor, 200_000);
    assert.equal((await call(`/goals`, user.token)).body.goals[0].actualMonthlyMinor, 200_000);
  });

  it("refuses a history that can't be", async () => {
    const user = await makeUser();
    const startOn = `${monthFrom(-6)}-10`;
    const endOn = `${monthFrom(6)}-10`;
    const holding = await addHolding(user.token, { schemeCode: 100014, sip: { amountMinor: 100_000, dayOfMonth: 10, startOn, endOn } });
    const bare = await addHolding(user.token, { schemeCode: 100013 });
    const sipPath = `/funds/holdings/${holding.id}/sip`;
    const error = async (path: string, body: unknown, method = "POST") => {
      const response = await call(path, user.token, { method, body });
      assert.equal(response.status, 400, JSON.stringify(response.body));
      return response.body.error;
    };

    assert.match(await error(`${sipPath}/change`, { fromOn: `${monthFrom(-7)}-01`, amountMinor: 200_000 }), /before the SIP started/);
    assert.match(await error(`${sipPath}/change`, { fromOn: `${monthFrom(7)}-01`, amountMinor: 200_000 }), /between the SIP's start and its end/);
    assert.match(await error(`${sipPath}/change`, { fromOn: `${monthFrom(-1)}-01`, amountMinor: 50 }), /at least ₹1/);
    assert.match(await error(`${sipPath}/skip`, { month: monthFrom(-8) }), /between the SIP's start and its end/);
    assert.match(await error(`${sipPath}/skip`, { month: "2026-13" }), /YYYY-MM/);
    assert.match(await error(`${sipPath}/pause`, { fromOn: `${monthFrom(1)}-01`, toOn: `${monthFrom(0)}-01` }), /end before it starts/);
    assert.match(await error(`/funds/holdings/${bare.id}/sip/skip`, { month: monthFrom(-1) }), /no SIP yet/);

    const patch = (sip: Record<string, unknown>) =>
      error(`/funds/holdings/${holding.id}`, { sip: { amountMinor: 100_000, dayOfMonth: 10, startOn, ...sip } }, "PATCH");
    assert.match(
      await patch({ steps: [{ fromOn: `${monthFrom(-2)}-01`, amountMinor: 200_000 }, { fromOn: `${monthFrom(-2)}-15`, amountMinor: 300_000 }] }),
      /same month/
    );
    assert.match(await patch({ skips: [monthFrom(-3), monthFrom(-3)] }), /skipped twice/);

    // Nothing was stored by any of it.
    const reread = await call(`/funds/holdings/${holding.id}`, user.token);
    assert.equal(reread.body.sip.steps.length, 1);
    assert.deepEqual(reread.body.sip.skips, []);
  });

  it("counts a debit linked in a skipped month, and one of a different amount, and shows both", async () => {
    const user = await makeUser();
    const startOn = `${monthFrom(-6)}-10`;
    const holding = await addHolding(user.token, {
      schemeCode: 100014,
      sip: { amountMinor: 100_000, dayOfMonth: 10, startOn, skips: [monthFrom(-2)] },
    });
    const inSkipped = await debit(user.id, `${monthFrom(-2)}-10`, 100_000);
    const bigger = await debit(user.id, `${monthFrom(-4)}-10`, 200_000);
    for (const transaction of [inSkipped, bigger]) {
      const linked = await call(`/funds/holdings/${holding.id}/link`, user.token, {
        method: "POST",
        body: { transactionId: transaction._id.toString() },
      });
      assert.equal(linked.status, 200);
    }

    const detail = (await call(`/funds/holdings/${holding.id}`, user.token)).body;
    const lineFor = (id: unknown) => detail.txns.find((txn: any) => txn.transactionId === String(id));
    assert.equal(lineFor(inSkipped._id).inSkippedMonth, true);
    assert.equal(lineFor(inSkipped._id).counted, true);
    assert.equal(lineFor(bigger._id).note, "₹2,000 paid vs ₹1,000 planned");
    assert.equal(lineFor(bigger._id).plannedMinor, 100_000);
    assert.equal(detail.investedMinor, holding.investedMinor + 100_000 + 100_000);

    const at = (month: string) => detail.sipPlan.find((row: any) => row.month === month);
    assert.equal(at(monthFrom(-2)).status, "invested");
    assert.equal(at(monthFrom(-2)).markedSkipped, true);
    assert.equal(at(monthFrom(-2)).linkedTransactionId, inSkipped._id.toString());
    assert.equal(at(monthFrom(-4)).actualMinor, 200_000);
    assert.equal(at(monthFrom(-4)).plannedMinor, 100_000);
  });

  it("migrates a SIP stored as one amount without moving a figure", async () => {
    const { backfillSipSteps } = await import("./funds.backfill");
    const user = await makeUser();
    const startOn = addMonths(TODAY, -14);
    const holding = await addHolding(user.token, { schemeCode: 100014, sip: { amountMinor: 500_000, dayOfMonth: 10, startOn } });
    // As a row from before steps looked.
    await models.FundHolding.collection.updateOne(
      { _id: new Types.ObjectId(holding.id) },
      { $unset: { "sip.steps": 1, "sip.skips": 1, "sip.pauses": 1 } }
    );
    const raw = async () => (await models.FundHolding.collection.findOne({ _id: new Types.ObjectId(holding.id) }))!.sip;
    assert.equal((await raw()).steps, undefined);

    const figures = (body: any) => ({
      units: body.units,
      investedMinor: body.investedMinor,
      valueMinor: body.valueMinor,
      xirrPercent: body.xirrPercent,
      monthlySipMinor: body.monthlySipMinor,
      txns: body.txns,
      sip: body.sip,
    });
    // Read safely before it's migrated: one step, the same figures.
    const before = figures((await call(`/funds/holdings/${holding.id}`, user.token)).body);
    assert.deepEqual(before, figures(holding));

    assert.equal(await backfillSipSteps(user.id), 1);
    const migrated = await raw();
    assert.deepEqual(migrated.steps, [{ fromOn: startOn, amountMinor: 500_000, dayOfMonth: null }]);
    assert.deepEqual(migrated.skips, []);
    assert.deepEqual(migrated.pauses, []);
    assert.deepEqual(figures((await call(`/funds/holdings/${holding.id}`, user.token)).body), before);

    // Twice is safe; a SIP-less holding is left alone.
    await addHolding(user.token, { schemeCode: 100013, opening: { units: 1, investedMinor: 1000, asOf: LAST } });
    assert.equal(await backfillSipSteps(user.id), 0);
  });
});

describe("access", () => {
  it("refuses a request without a session", async () => {
    for (const path of ["/funds/portfolio", "/goals", "/funds/link-suggestions"]) {
      const response = await realFetch(`${baseUrl}${path}`);
      assert.equal(response.status, 401);
    }
  });

  it("keeps one user's holdings from another", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const holding = await addHolding(owner.token, { schemeCode: 100013 });
    assert.equal((await call(`/funds/holdings/${holding.id}`, other.token)).status, 404);
    assert.equal((await call(`/funds/holdings/${holding.id}`, other.token, { method: "DELETE" })).status, 404);
    assert.deepEqual((await call("/funds/portfolio", other.token)).body.holdings, []);
  });
});
