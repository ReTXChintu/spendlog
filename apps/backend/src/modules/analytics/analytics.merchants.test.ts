import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "merchants-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_merchants_test"));
  const [{ app }, auth, loaded] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

let token: string;
let userId: Types.ObjectId;
let count = 0;

beforeEach(async () => {
  await Promise.all([
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.Category.deleteMany({}),
  ]);
  const email = `shop${(count += 1)}@example.com`;
  const created = await models.User.create({ email });
  userId = created._id;
  token = signToken({ id: created._id.toString(), email });
});

/** A payment to a shop on a day, as a bank message would have left it. */
async function paid(merchant: string, rupees: number, on: string, extra: Record<string, unknown> = {}) {
  await models.Transaction.create({
    userId,
    type: "DEBIT",
    amountMinor: rupees * 100,
    source: "MANUAL",
    merchant,
    occurredAt: new Date(`${on}T12:00:00+05:30`),
    ...extra,
  });
}

async function get(path: string) {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() };
}

interface Row {
  merchant: string;
  amountMinor: number;
  count: number;
}

describe("spend by merchant", () => {
  // No pay day, so the user's months are calendar months. "This month" in
  // these tests is whatever month the suite runs in, hence the explicit
  // month keys everywhere.
  const thisMonth = () => new Date().toISOString().slice(0, 7);

  function monthsAgo(n: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15)).toISOString().slice(0, 10);
  }

  it("adds up one shop however its name was spelled", async () => {
    await paid("Swiggy", 400, `${thisMonth()}-02`);
    await paid("SWIGGY", 600, `${thisMonth()}-03`);
    await paid("Zomato", 300, `${thisMonth()}-04`);

    const { body } = await get("/analytics/merchants");
    const rows = body as Row[];
    assert.deepEqual(
      rows.map((row) => [row.merchant, row.amountMinor, row.count]),
      [
        // The spelling first seen, not the folded key and not whichever
        // row the group happened to meet first.
        ["Swiggy", 100_000, 2],
        ["Zomato", 30_000, 1],
      ]
    );
  });

  it("reaches back over several months, and over everything", async () => {
    await paid("Swiggy", 500, monthsAgo(0));
    await paid("Swiggy", 500, monthsAgo(2));
    await paid("Swiggy", 500, monthsAgo(20));

    const month = (await get("/analytics/merchants")).body as Row[];
    assert.equal(month[0].amountMinor, 50_000);

    const half = (await get("/analytics/merchants?range=6m")).body as Row[];
    assert.equal(half[0].amountMinor, 100_000);

    const all = (await get("/analytics/merchants?range=all")).body as Row[];
    assert.equal(all[0].amountMinor, 150_000);
    assert.equal(all[0].count, 3);
  });

  it("gives the whole list when asked, not the top fifteen", async () => {
    for (let i = 0; i < 20; i += 1) await paid(`Shop ${i}`, i + 1, `${thisMonth()}-05`);

    const capped = (await get("/analytics/merchants")).body as Row[];
    assert.equal(capped.length, 15);

    const full = (await get("/analytics/merchants?limit=500")).body as Row[];
    assert.equal(full.length, 20);
  });

  it("refuses a range it does not know", async () => {
    assert.equal((await get("/analytics/merchants?range=forever")).status, 400);
  });
});

describe("one merchant up close", () => {
  const thisMonth = () => new Date().toISOString().slice(0, 7);

  function monthsAgo(n: number): string {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15)).toISOString().slice(0, 10);
  }

  it("totals a shop, averages its payments, and lists them newest first", async () => {
    const food = await models.Category.create({ userId, name: "Food", color: "#FF0000" });
    await paid("Swiggy", 400, monthsAgo(0), { categoryId: food._id });
    await paid("swiggy", 600, monthsAgo(1));
    await paid("Zomato", 900, monthsAgo(0));

    const { body } = await get("/analytics/merchant?name=Swiggy&range=6m");
    const detail = body as {
      merchant: string;
      label: string;
      totalMinor: number;
      count: number;
      averageMinor: number;
      firstOn: string;
      lastOn: string;
      byMonth: { month: string; amountMinor: number; count: number }[];
      byCategory: { name: string; amountMinor: number }[];
      transactions: { merchant: string; amountMinor: number }[];
    };

    assert.equal(detail.merchant, "Swiggy");
    assert.equal(detail.label, "Last 6 months");
    assert.equal(detail.totalMinor, 100_000);
    assert.equal(detail.count, 2);
    assert.equal(detail.averageMinor, 50_000);
    assert.ok(detail.firstOn < detail.lastOn);

    // Six bars, oldest first, with this month's and last month's filled.
    assert.equal(detail.byMonth.length, 6);
    assert.equal(detail.byMonth[detail.byMonth.length - 1].amountMinor, 40_000);
    assert.equal(detail.byMonth[detail.byMonth.length - 2].amountMinor, 60_000);
    assert.equal(detail.byMonth[0].amountMinor, 0);

    assert.deepEqual(
      detail.byCategory.map((row) => [row.name, row.amountMinor]),
      [
        ["Uncategorized", 60_000],
        ["Food", 40_000],
      ]
    );

    // Zomato is somebody else's money.
    assert.equal(detail.transactions.length, 2);
    assert.equal(detail.transactions[0].amountMinor, 40_000);
  });

  it("is that shop alone, not every shop whose name starts the same", async () => {
    await paid("Swiggy", 400, `${thisMonth()}-02`);
    await paid("Swiggy Instamart", 1000, `${thisMonth()}-03`);

    const { body } = await get("/analytics/merchant?name=Swiggy");
    assert.equal((body as { totalMinor: number }).totalMinor, 40_000);
  });

  it("says nothing was paid rather than dividing by zero", async () => {
    const { status, body } = await get("/analytics/merchant?name=Nowhere");
    const detail = body as { totalMinor: number; count: number; averageMinor: number; firstOn: string | null };
    assert.equal(status, 200);
    assert.equal(detail.totalMinor, 0);
    assert.equal(detail.count, 0);
    assert.equal(detail.averageMinor, 0);
    assert.equal(detail.firstOn, null);
  });

  it("needs a name", async () => {
    assert.equal((await get("/analytics/merchant")).status, 400);
  });
});
