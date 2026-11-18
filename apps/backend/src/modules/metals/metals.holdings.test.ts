import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { perGramFor } from "./metals.holdings";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "metal-holdings-secret";

describe("a day's rate for each purity", () => {
  const live = { gold999: 140891, gold916: 129056, gold750: 105668, silver999: 183800 };

  it("is IBJA's own for the purity, per gram in paise", () => {
    assert.equal(perGramFor(live, "24K"), 1408910);
    assert.equal(perGramFor(live, "22K"), 1290560);
    assert.equal(perGramFor(live, "18K"), 1056680);
    assert.equal(perGramFor(live, "SILVER"), 18380);
  });

  it("comes from 24K by fineness on a day only 24K is known for", () => {
    assert.equal(perGramFor({ ...live, gold916: null, gold750: null }, "18K"), 1056683);
    assert.equal(perGramFor(null, "24K"), null);
  });
});

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let ingest: typeof import("../../parsing/ingest");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_metal_holdings_test"));
  const [{ app }, auth, loaded, loadedIngest] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../../parsing/ingest"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  ingest = loadedIngest;
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
  await Promise.all([
    models.MetalRate.deleteMany({}),
    models.MetalHolding.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.Deposit.deleteMany({}),
  ]);
  // Two days of rates: a purchase is worked out at its own day's.
  await models.MetalRate.create([
    { day: "2026-10-29", gold999: 142255, gold916: 130306, gold750: null, silver999: 190478, session: "CLOSE" },
    { day: "2026-10-30", gold999: 140891, gold916: 129056, gold750: 105668, silver999: 183800, session: "AM" },
  ]);
});

type Json = Record<string, any>;

async function makeUser() {
  const user = await models.User.create({ email: `h${Math.random()}@example.com` });
  return { id: user._id, token: signToken({ id: user._id.toString(), email: user.email }) };
}

async function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Json };
}

const buy = (token: string, body: Json) =>
  call("/transactions", token, { body: { type: "DEBIT", source: "MANUAL", merchant: "SafeGold", ...body } });

describe("gold the user owns", () => {
  it("starts from what is held, and each purchase adds grams at that day's rate with GST", async () => {
    const user = await makeUser();
    const digital = (await call("/metals/holdings", user.token, {
      body: { name: "Digital gold", purity: "24K", kind: "DIGITAL", grams: 3.2, investedMinor: 40_000_00 },
    })).body;
    assert.equal(digital.grams, 3.2);

    // ₹500 on the 29th: 500 / (14,225.50 × 1.03) = 0.0341 g.
    const thursday = await buy(user.token, {
      amountMinor: 500_00,
      occurredAt: "2026-10-29T12:00:00+05:30",
      metalBuy: { holdingId: digital.id },
    });
    assert.equal(thursday.status, 201, JSON.stringify(thursday.body));
    assert.equal(thursday.body.metalBuy.grams, 0.0341);
    assert.equal(thursday.body.metalBuy.rateMinor, 1465227);
    assert.equal(thursday.body.countedAmountMinor, 500_00, "still spending");

    // A day with no rate of its own (the 31st) takes the last one before it.
    await buy(user.token, { amountMinor: 1000_00, occurredAt: "2026-10-31T12:00:00+05:30", metalBuy: { holdingId: digital.id } });

    const [listed] = (await call("/metals/holdings", user.token)).body as unknown as Json[];
    assert.equal(listed.grams, 3.303);
    assert.equal(listed.investedMinor, 41_500_00);
    // Valued at today's 24K, before GST.
    assert.equal(listed.valueMinor, Math.round(listed.grams * 1408910));
    assert.equal(listed.purchases, 2);
  });

  it("takes grams typed for a jeweller's piece, and keeps them through an amount change", async () => {
    const user = await makeUser();
    const jewellery = (await call("/metals/holdings", user.token, { body: { name: "Jewellery", purity: "22K", kind: "JEWELLERY", grams: 0 } })).body;
    const ring = (await buy(user.token, {
      merchant: "Tanishq",
      amountMinor: 70_000_00,
      occurredAt: "2026-10-30T12:00:00+05:30",
      metalBuy: { holdingId: jewellery.id, grams: 4.8 },
    })).body;
    assert.equal(ring.metalBuy.grams, 4.8);
    assert.equal(ring.metalBuy.gramsTyped, true);

    await call(`/transactions/${ring.id}`, user.token, { method: "PATCH", body: { amountMinor: 71_000_00 } });
    assert.equal((await models.Transaction.findById(ring.id).lean())!.metalBuys[0].grams, 4.8);
  });

  it("works grams out again when a computed purchase's amount changes, and drops it off money in", async () => {
    const user = await makeUser();
    const digital = (await call("/metals/holdings", user.token, { body: { name: "Digital gold", purity: "24K", grams: 0 } })).body;
    const payment = (await buy(user.token, { amountMinor: 500_00, occurredAt: "2026-10-30T12:00:00+05:30", metalBuy: { holdingId: digital.id } })).body;
    await call(`/transactions/${payment.id}`, user.token, { method: "PATCH", body: { amountMinor: 1000_00 } });
    assert.equal((await models.Transaction.findById(payment.id).lean())!.metalBuys[0].grams, 0.0689);

    await call(`/transactions/${payment.id}`, user.token, { method: "PATCH", body: { type: "CREDIT" } });
    assert.deepEqual((await models.Transaction.findById(payment.id).lean())!.metalBuys, []);
  });

  it("puts a payment to the holding's payee down as a purchase as it arrives", async () => {
    const user = await makeUser();
    const digital = (await call("/metals/holdings", user.token, {
      body: { name: "Digital gold", purity: "24K", grams: 1, payee: "SafeGold" },
    })).body;
    const result = await ingest.ingestRawMessage({
      userId: user.id,
      rawText: "Debited Rs 500.00 from a/c X5130 via UPI to SAFEGOLD. Ref 666106275999. -Federal Bank",
      source: "SMS",
      sourceRef: "g1",
      // Now: a message from before the user's ledger begins is ignored. The
      // latest rate on or before today is the 30th's.
      receivedAt: new Date(),
    });
    const row = await models.Transaction.findById((result as { transaction: { _id: Types.ObjectId } }).transaction._id).lean();
    assert.equal(String(row!.metalBuys[0]?.holdingId), digital.id);
    assert.equal(row!.metalBuys[0]?.grams, 0.0345);
  });

  it("refuses another user's holding", async () => {
    const [user, other] = [await makeUser(), await makeUser()];
    const theirs = (await call("/metals/holdings", other.token, { body: { name: "Theirs", purity: "24K", grams: 1 } })).body;
    const refused = await buy(user.token, { amountMinor: 500_00, occurredAt: "2026-10-30T12:00:00+05:30", metalBuy: { holdingId: theirs.id } });
    assert.equal(refused.status, 400);
  });

  it("adds everything held into one total, gain only where the cost is known", async () => {
    const user = await makeUser();
    await call("/deposits", user.token, { body: { name: "RD", kind: "RD", totalMinor: 40_000_00 } });
    await call("/metals/holdings", user.token, { body: { name: "Digital gold", purity: "24K", grams: 2, investedMinor: 26_000_00 } });
    await call("/metals/holdings", user.token, { body: { name: "Silver coins", purity: "SILVER", grams: 100 } });

    const overview = (await call("/investments/overview", user.token)).body;
    assert.deepEqual(overview.parts.map((p: Json) => [p.kind, p.valueMinor, p.investedMinor]), [
      ["DEPOSITS", 40_000_00, 40_000_00],
      ["GOLD", 2 * 1408910, 26_000_00],
      ["SILVER", 100 * 18380, null],
    ]);
    assert.equal(overview.valueMinor, 40_000_00 + 2 * 1408910 + 100 * 18380);
    assert.equal(overview.investedMinor, 66_000_00);
    assert.equal(overview.gainMinor, 2 * 1408910 - 26_000_00);
    assert.equal(overview.partial, true);
  });
});

/**
 * One payment of 1,000 on the 30th: 600 of digital gold, 400 of 22K
 * coins. Each holding gets its own part, at its own purity's rate.
 */
describe("one payment into several holdings", () => {
  const ON = "2026-10-30T12:00:00+05:30";
  // The 30th's rates, per gram with GST, as the server works them out.
  const grams = (minor: number, per10g: number) => Math.round((minor / Math.round(per10g * 10 * 1.03)) * 10_000) / 10_000;

  async function twoHoldings() {
    const user = await makeUser();
    const digital = (await call("/metals/holdings", user.token, { body: { name: "Digital gold", purity: "24K", grams: 0 } })).body;
    const coins = (await call("/metals/holdings", user.token, { body: { name: "Coins", purity: "22K", grams: 0 } })).body;
    return { user, digital, coins };
  }

  async function split(token: string, digitalId: string, coinsId: string) {
    return buy(token, {
      amountMinor: 1000_00,
      occurredAt: ON,
      metalBuys: [
        { holdingId: digitalId, amountMinor: 600_00 },
        { holdingId: coinsId, amountMinor: 400_00 },
      ],
    });
  }

  it("gives each holding its own part, in grams at its own rate", async () => {
    const { user, digital, coins } = await twoHoldings();
    const payment = await split(user.token, digital.id, coins.id);
    assert.equal(payment.status, 201, JSON.stringify(payment.body));
    assert.equal(payment.body.countedAmountMinor, 1000_00, "still spending, all of it");
    // An app from before splitting still sees a purchase on it.
    assert.equal(payment.body.metalBuy.holdingId, digital.id);

    const listed = (await call("/metals/holdings", user.token)).body as unknown as Json[];
    const byName = new Map(listed.map((holding) => [holding.name, holding]));
    assert.equal(byName.get("Digital gold")!.investedMinor, 600_00);
    assert.equal(byName.get("Digital gold")!.grams, grams(600_00, 140891));
    assert.equal(byName.get("Coins")!.investedMinor, 400_00);
    assert.equal(byName.get("Coins")!.grams, grams(400_00, 129056));

    // Its purchases list the holding's part, not the whole payment.
    const purchases = (await call(`/metals/holdings/${coins.id}/purchases`, user.token)).body as unknown as Json[];
    assert.equal(purchases.length, 1);
    assert.equal(purchases[0].amountMinor, 400_00);
  });

  it("refuses parts past the payment, or the same holding twice", async () => {
    const { user, digital, coins } = await twoHoldings();
    const over = await buy(user.token, {
      amountMinor: 1000_00,
      occurredAt: ON,
      metalBuys: [
        { holdingId: digital.id, amountMinor: 700_00 },
        { holdingId: coins.id, amountMinor: 400_00 },
      ],
    });
    assert.equal(over.status, 400);
    const twice = await buy(user.token, {
      amountMinor: 1000_00,
      occurredAt: ON,
      metalBuys: [
        { holdingId: digital.id, amountMinor: 300_00 },
        { holdingId: digital.id, amountMinor: 300_00 },
      ],
    });
    assert.equal(twice.status, 400);
  });

  it("keeps a split through a smaller amount it still fits, and refuses one it doesn't", async () => {
    const { user, digital, coins } = await twoHoldings();
    const payment = (await split(user.token, digital.id, coins.id)).body;
    const smaller = await call(`/transactions/${payment.id}`, user.token, { method: "PATCH", body: { amountMinor: 900_00 } });
    assert.equal(smaller.status, 400, "the parts are 1,000");
    const larger = await call(`/transactions/${payment.id}`, user.token, { method: "PATCH", body: { amountMinor: 1200_00 } });
    assert.equal(larger.status, 200, JSON.stringify(larger.body));
    const row = await models.Transaction.findById(payment.id).lean();
    assert.deepEqual(row!.metalBuys.map((buy) => buy.amountMinor), [600_00, 400_00]);
  });

  it("isn't collapsed by an app from before splitting, which can still set and clear a whole one", async () => {
    const { user, digital, coins } = await twoHoldings();
    const payment = (await split(user.token, digital.id, coins.id)).body;
    // That app sends its single purchase - null, here - with every save.
    await call(`/transactions/${payment.id}`, user.token, { method: "PATCH", body: { note: "Diwali", metalBuy: null } });
    assert.equal((await models.Transaction.findById(payment.id).lean())!.metalBuys.length, 2);

    const plain = (await buy(user.token, { amountMinor: 500_00, occurredAt: ON })).body;
    await call(`/transactions/${plain.id}`, user.token, { method: "PATCH", body: { metalBuy: { holdingId: digital.id } } });
    const bought = (await models.Transaction.findById(plain.id).lean())!.metalBuys;
    assert.equal(bought.length, 1);
    assert.equal(bought[0].amountMinor, null, "all of the payment");
    await call(`/transactions/${plain.id}`, user.token, { method: "PATCH", body: { metalBuy: null } });
    assert.deepEqual((await models.Transaction.findById(plain.id).lean())!.metalBuys, []);
  });

  it("stores one part that is the whole payment as all of it, so it follows a corrected amount", async () => {
    const { user, digital } = await twoHoldings();
    const payment = (await buy(user.token, {
      amountMinor: 500_00,
      occurredAt: ON,
      metalBuys: [{ holdingId: digital.id, amountMinor: 500_00 }],
    })).body;
    await call(`/transactions/${payment.id}`, user.token, { method: "PATCH", body: { amountMinor: 1000_00 } });
    const [bought] = (await models.Transaction.findById(payment.id).lean())!.metalBuys;
    assert.equal(bought.amountMinor, null);
    assert.equal(bought.grams, grams(1000_00, 140891));
  });

  it("moves each payment's single purchase from before into the list", async () => {
    const { user, digital } = await twoHoldings();
    // The shape every purchase had before, written past the schema.
    const { insertedId } = await models.Transaction.collection.insertOne({
      userId: user.id,
      type: "DEBIT",
      amountMinor: 500_00,
      countedAmountMinor: 500_00,
      currency: "INR",
      source: "MANUAL",
      occurredAt: new Date(ON),
      metalBuy: { holdingId: new Types.ObjectId(digital.id), grams: 0.0345, rateMinor: 1451177, gramsTyped: false },
    });
    const { runMetalBuysMigration } = await import("./metals.holdings");
    await models.User.updateOne({ _id: user.id }, { $unset: { "backfills.metalBuys": 1 } });
    await runMetalBuysMigration();
    // Twice is the same as once.
    await models.User.updateOne({ _id: user.id }, { $unset: { "backfills.metalBuys": 1 } });
    await runMetalBuysMigration();

    const raw = await models.Transaction.collection.findOne({ _id: insertedId });
    assert.equal(raw!.metalBuy, undefined);
    assert.equal(raw!.metalBuys.length, 1);
    assert.equal(raw!.metalBuys[0].grams, 0.0345);
    assert.equal(raw!.metalBuys[0].amountMinor, null);
    const [listed] = (await call("/metals/holdings", user.token)).body as unknown as Json[];
    assert.equal(listed.investedMinor, 500_00);
  });
});
