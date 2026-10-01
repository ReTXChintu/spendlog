import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "months-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let months: typeof import("../budget/budget.months");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_months_test"));
  const [{ app }, auth, loaded, loadedMonths] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../budget/budget.months"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  months = loadedMonths;
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
  await Promise.all([models.Transaction.deleteMany({}), models.User.deleteMany({})]);
});

async function user(fields: Record<string, unknown>) {
  const email = `m${(count += 1)}@example.com`;
  const created = await models.User.create({ email, ...fields });
  userId = created._id;
  token = signToken({ id: created._id.toString(), email });
}

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function move(type: "DEBIT" | "CREDIT", rupees: number, at: string, extra: Record<string, unknown> = {}) {
  const created = await models.Transaction.create({
    userId,
    type,
    amountMinor: rupees * 100,
    source: "MANUAL",
    occurredAt: new Date(`${at}T12:00:00+05:30`),
    ...extra,
  });
  return created._id.toString();
}

describe("the user's months", () => {
  it("names a salary month after the pay day that opens it", async () => {
    await user({ salaryDay: 15 });
    const { recent } = await months.userMonths(userId, new Date("2026-10-02T12:00:00+05:30"), 3);
    assert.deepEqual(
      recent.map((month) => [month.key, month.from, month.to]),
      [
        ["2026-09", "2026-09-15", "2026-10-14"],
        ["2026-08", "2026-08-15", "2026-09-14"],
        ["2026-07", "2026-07-15", "2026-08-14"],
      ]
    );
  });

  it("keeps early pay in the month it was paid for", async () => {
    // Paid on the 1st, and October's pay landed on 30 September.
    await user({ salaryDay: 1 });
    await move("CREDIT", 80_000, "2026-09-30", { isSalary: true });
    const { recent } = await months.userMonths(userId, new Date("2026-10-02T12:00:00+05:30"), 2);
    assert.equal(recent[0].key, "2026-10");
    assert.equal(recent[0].from, "2026-09-30");
    assert.equal(recent[1].key, "2026-09");
  });

  it("lays out an old month from the pay day alone", async () => {
    await user({ salaryDay: 5 });
    const month = await months.userMonth(userId, "2023-02", new Date("2026-10-02T12:00:00+05:30"));
    assert.deepEqual([month.from, month.to], ["2023-02-05", "2023-03-04"]);
  });

  it("is the calendar month with no pay day", async () => {
    await user({});
    const month = await months.userMonth(userId, "2026-02");
    assert.deepEqual([month.from, month.to], ["2026-02-01", "2026-02-28"]);
  });
});

describe("analytics in salary months", () => {
  it("totals a month from salary day to salary day", async () => {
    await user({ salaryDay: 15 });
    await move("DEBIT", 100, "2026-08-14"); // the month before
    await move("DEBIT", 200, "2026-08-15");
    await move("DEBIT", 300, "2026-09-14");
    await move("DEBIT", 400, "2026-09-15"); // the month after

    const summary = (await (await call("/analytics/summary?month=2026-08")).json()) as {
      totalSpendMinor: number;
      from: string;
      to: string;
      label: string;
    };
    assert.equal(summary.totalSpendMinor, 500_00);
    assert.deepEqual([summary.from, summary.to], ["2026-08-15", "2026-09-14"]);
    assert.match(summary.label, /15 Aug/);
  });

  it("compares with the salary month before", async () => {
    await user({ salaryDay: 15 });
    await move("DEBIT", 100, "2026-08-10"); // July's month
    await move("DEBIT", 250, "2026-08-20"); // August's

    const compare = (await (await call("/analytics/compare?month=2026-08")).json()) as {
      totalSpendMinor: number;
      previousSpendMinor: number;
      previousMonth: string;
    };
    assert.equal(compare.totalSpendMinor, 250_00);
    assert.equal(compare.previousSpendMinor, 100_00);
    assert.equal(compare.previousMonth, "2026-07");
  });

  it("lists the months to step through, current first", async () => {
    await user({ salaryDay: 15 });
    const body = (await (await call("/analytics/months")).json()) as {
      bySalary: boolean;
      current: string;
      months: { month: string }[];
    };
    assert.equal(body.bySalary, true);
    assert.equal(body.months[0].month, body.current);
  });
});

describe("refunds that came before the purchase", () => {
  it("offers payments made after the credit too", async () => {
    await user({});
    const credit = await move("CREDIT", 600, "2026-09-10");
    const before = await move("DEBIT", 100, "2026-09-01");
    const afterwards = await move("DEBIT", 600, "2026-09-20");
    const tooLate = await move("DEBIT", 50, "2026-11-30");

    const candidates = (await (await call(`/transactions/${credit}/refund-candidates`)).json()) as { id: string }[];
    const ids = candidates.map((candidate) => candidate.id);
    assert.ok(ids.includes(before));
    assert.ok(ids.includes(afterwards));
    assert.ok(!ids.includes(tooLate));

    const linked = await call(`/transactions/${credit}/refund-of`, {
      method: "POST",
      body: JSON.stringify({ allocations: [{ transactionId: afterwards, amountMinor: 600_00 }] }),
    });
    assert.equal(linked.status, 200);
    const purchase = await models.Transaction.findById(afterwards).orFail();
    assert.equal(purchase.countedAmountMinor, 0, "the purchase was paid for by the money that came first");
  });
});
