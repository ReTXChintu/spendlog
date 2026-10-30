import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { parseIbjaHistory, parseIbjaRates } from "./metals.ibja";
import { liveDay, rateNotice, signalFor } from "./metals.service";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "metals-test-secret";

const history = (labels: string[], gold: number[], gold916: number[], silver: number[]) => {
  const quote = (value: unknown) => JSON.stringify(value).replace(/"/g, "&quot;");
  return (
    `<input type="hidden" id="HdnGold" value="${quote({ labels, purity999: gold, purity916: gold916 })}" />` +
    `<input type="hidden" id="HdnSilver" value="${quote({ labels, silverRate: silver })}" />`
  );
};

/** The page as IBJA lays it out, cut down to what is read. */
function page(opts: { am?: number; pm?: number; silver?: number; history?: string } = {}) {
  const am = opts.am ?? 140891;
  return `
    <span id="GoldRatesCompare999">14089</span>
    <tr><td>Gold 999</td><td><span id="lblGold999_AM">${am}</span></td><td><span id="lblGold999_PM">${opts.pm ?? ""}</span></td></tr>
    <span id="lblGold995_AM">140327</span><span id="lblGold995_PM"></span>
    <span id="lblGold916_AM">${Math.round(am * 0.916)}</span><span id="lblGold916_PM">${opts.pm ? Math.round(opts.pm * 0.916) : ""}</span>
    <span id="lblGold750_AM">${Math.round(am * 0.75)}</span><span id="lblGold750_PM">${opts.pm ? Math.round(opts.pm * 0.75) : ""}</span>
    <span id="lblSilver999_AM">${opts.silver ?? 183800}</span><span id="lblSilver999_PM"></span>
    ${opts.history ?? history(["28/10/2026", "29/10/2026"], [142707, 142255], [130720, 130306], [193442, 190478])}`;
}

describe("reading IBJA's page", () => {
  it("reads the morning's rates while the evening's are not out", () => {
    assert.deepEqual(parseIbjaRates(page()), {
      gold999: 140891,
      gold916: 129056,
      gold750: 105668,
      silver999: 183800,
      session: "AM",
    });
  });

  it("takes the evening's once they are, silver falling back to the morning's", () => {
    const rates = parseIbjaRates(page({ pm: 141000 }));
    assert.equal(rates?.session, "PM");
    assert.equal(rates?.gold999, 141000);
    assert.equal(rates?.silver999, 183800);
  });

  it("is not a page of rates without gold 999", () => {
    assert.equal(parseIbjaRates("<html>Service unavailable</html>"), null);
  });

  it("reads the dated history, gold and silver by day", () => {
    assert.deepEqual(parseIbjaHistory(page()), [
      { day: "2026-10-28", gold999: 142707, gold916: 130720, silver999: 193442 },
      { day: "2026-10-29", gold999: 142255, gold916: 130306, silver999: 190478 },
    ]);
    assert.deepEqual(parseIbjaHistory("<html></html>"), []);
  });
});

describe("which day the rates are for", () => {
  const friday = (hour: number) => new Date(`2026-10-30T${String(hour).padStart(2, "0")}:00:00+05:30`);
  const thursday = { day: "2026-10-29", gold999: 142255 };

  it("is today on a weekday once the morning's are out and they have changed", () => {
    assert.equal(liveDay({ gold999: 140891 }, thursday, friday(13)), "2026-10-30");
  });

  it("is no day before eleven, on a weekend, or when they are yesterday's again", () => {
    assert.equal(liveDay({ gold999: 140891 }, thursday, friday(9)), null);
    assert.equal(liveDay({ gold999: 140891 }, thursday, new Date("2026-10-31T13:00:00+05:30")), null);
    assert.equal(liveDay({ gold999: 142255 }, thursday, friday(13)), null);
  });
});

describe("a good day to buy", () => {
  it("is a day below the average of the days before, said by how much", () => {
    const signal = signalFor(9800, [10000, 10200, 10100, 9900]);
    assert.equal(signal.averageMinor, 10050);
    assert.equal(signal.belowAveragePercent, 2.49);
    assert.equal(signal.isGoodDay, true);
    assert.equal(signal.changePercent, -1.01);
  });

  it("is not a day above it, nor one with nothing to compare", () => {
    assert.equal(signalFor(10300, [10000, 10100]).isGoodDay, false);
    assert.equal(signalFor(10300, [10000, 10100]).belowAveragePercent! < 0, true);
    assert.deepEqual(signalFor(10000, []), { averageMinor: null, belowAveragePercent: null, isGoodDay: false, changePercent: null });
  });
});

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let service: typeof import("./metals.service");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_metals_test"));
  const [{ app }, auth, loaded, loadedService] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./metals.service"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  service = loadedService;
  await models.MetalRate.init();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([models.MetalRate.deleteMany({}), models.User.deleteMany({})]);
});

const friday = new Date("2026-10-30T13:00:00+05:30");

async function makeUser(extra: Record<string, unknown> = {}) {
  const user = await models.User.create({ email: `m${Math.random()}@example.com`, ...extra });
  return { id: user._id, token: signToken({ id: user._id.toString(), email: user.email }) };
}

async function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe("keeping the rates", () => {
  it("keeps IBJA's history and puts the day's rates on today, once", async () => {
    const first = await service.refreshMetalRates(friday, async () => page());
    assert.deepEqual(first, { day: "2026-10-30", isNew: true });
    assert.deepEqual((await models.MetalRate.find({}).sort({ day: 1 }).lean()).map((r) => [r.day, r.session, r.gold999]), [
      ["2026-10-28", "CLOSE", 142707],
      ["2026-10-29", "CLOSE", 142255],
      ["2026-10-30", "AM", 140891],
    ]);

    const evening = await service.refreshMetalRates(new Date("2026-10-30T17:30:00+05:30"), async () => page({ pm: 141200 }));
    assert.deepEqual(evening, { day: "2026-10-30", isNew: false });
    const today = await models.MetalRate.findOne({ day: "2026-10-30" }).lean();
    assert.equal(today!.session, "PM");
    assert.equal(today!.gold999, 141200);
  });

  it("shows today's per gram against the month before, with GST for a digital gold app", async () => {
    await service.refreshMetalRates(friday, async () => page());
    const user = await makeUser();
    const view = (await call("/metals", user.token)).body;
    assert.equal(view.available, true);
    assert.equal(view.day, "2026-10-30");
    assert.deepEqual(view.gold.perGramMinor, { "24K": 1408910, "22K": 1290560, "18K": 1056680 });
    assert.equal(view.gold.withGstPerGramMinor, 1451177);
    assert.equal(view.silver.perGramMinor, 18380);
    assert.equal(view.silver.perKgMinor, 18380000);
    // Below both days before it.
    assert.equal(view.gold.signal.isGoodDay, true);
    assert.equal(view.gold.signal.changePercent, -0.96);
    assert.equal(view.gold.history.length, 3);
    assert.equal(view.push, false);
  });

  it("is not available before anything has been read", async () => {
    const user = await makeUser();
    assert.equal((await call("/metals", user.token)).body.available, false);
  });

  it("words the day's notice, and claims the day so it goes out once", async () => {
    await service.refreshMetalRates(friday, async () => page());
    const asked = await makeUser({ metalRatesPush: true });
    const view = await service.metalsView(asked.id, friday);
    const notice = rateNotice(view);
    assert.equal(notice.title, "A good day to buy gold");
    assert.match(notice.body, /^24K ₹14,089\/g · 22K ₹12,906\/g · 18K ₹10,567\/g · Silver ₹184\/g\. gold is [0-9.]+% below/);
    await service.notifyMetalRates("2026-10-30", friday);
    assert.ok((await models.MetalRate.findOne({ day: "2026-10-30" }).lean())!.notifiedAt);
    assert.equal(await service.notifyMetalRates("2026-10-30", friday), 0, "never twice");
  });

  it("turns the daily notification on and off", async () => {
    const user = await makeUser();
    const on = await call("/metals/settings", user.token, { method: "PATCH", body: { push: true } });
    assert.equal(on.body.push, true);
    assert.equal((await models.User.findById(user.id).lean())!.metalRatesPush, true);
  });
});
