import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "balance-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_balance_test"));

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
let bankId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([models.Account.deleteMany({}), models.Transaction.deleteMany({}), models.User.deleteMany({})]);
  const email = `b${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  const bank = await models.Account.create({ userId, bankName: "HDFC Bank", last4: "4821", accountType: "BANK" });
  bankId = bank._id;
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function move(type: "DEBIT" | "CREDIT", amountMinor: number, occurredAt: string, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    accountId: bankId,
    type,
    amountMinor,
    source: "MANUAL",
    occurredAt: new Date(occurredAt),
    ...extra,
  });
}

interface OverviewRow {
  id: string;
  tracksBalance: boolean;
  balance: { openingMinor: number; expectedMinor: number; inMinor: number; outMinor: number; transactionCount: number } | null;
}

async function bankRow(): Promise<OverviewRow> {
  const rows = (await (await call("/accounts/overview")).json()) as OverviewRow[];
  return rows.find((row) => row.id === bankId.toString())!;
}

describe("an account's expected balance", () => {
  it("has none until a starting balance is given", async () => {
    const row = await bankRow();
    assert.equal(row.tracksBalance, true);
    assert.equal(row.balance, null);
  });

  it("adds what came in and takes away what went out since the starting balance", async () => {
    await call(`/accounts/${bankId}`, {
      method: "PATCH",
      body: JSON.stringify({ openingBalanceMinor: 50_000_00, openingBalanceAt: "2026-09-01T12:00:00+05:30" }),
    });
    await move("DEBIT", 5_000_00, "2026-08-30T10:00:00+05:30"); // before: already in the figure
    await move("DEBIT", 2_000_00, "2026-09-02T10:00:00+05:30");
    await move("CREDIT", 10_000_00, "2026-09-03T10:00:00+05:30");
    // A transfer and a split still move the whole amount out of the bank.
    await move("DEBIT", 3_000_00, "2026-09-04T10:00:00+05:30", { isTransfer: true });
    await move("DEBIT", 1_200_00, "2026-09-05T10:00:00+05:30", { split: { myShareMinor: 400_00 } });

    const row = await bankRow();
    assert.deepEqual(
      { ...row.balance, since: undefined },
      {
        openingMinor: 50_000_00,
        inMinor: 10_000_00,
        outMinor: 6_200_00,
        expectedMinor: 53_800_00,
        transactionCount: 4,
        since: undefined,
      }
    );
  });

  it("counts a linked debit card's spending against its bank account", async () => {
    const card = await models.Account.create({
      userId,
      bankName: "HDFC Debit",
      last4: "1111",
      accountType: "DEBIT",
      linkedAccountId: bankId,
    });
    await call(`/accounts/${bankId}`, {
      method: "PATCH",
      body: JSON.stringify({ openingBalanceMinor: 10_000_00, openingBalanceAt: "2026-09-01T00:00:00Z" }),
    });
    await models.Transaction.create({
      userId,
      accountId: card._id,
      type: "DEBIT",
      amountMinor: 700_00,
      source: "MANUAL",
      occurredAt: new Date("2026-09-02T00:00:00Z"),
    });

    assert.equal((await bankRow()).balance?.expectedMinor, 9_300_00);
  });

  it("takes a starting balance as of now when no moment is given", async () => {
    await move("DEBIT", 900_00, new Date(Date.now() - 60_000).toISOString());
    await call(`/accounts/${bankId}`, { method: "PATCH", body: JSON.stringify({ openingBalanceMinor: 25_000_00 }) });

    const row = await bankRow();
    assert.equal(row.balance?.expectedMinor, 25_000_00, "what already happened is in the figure typed in");
  });

  it("forgets it when cleared", async () => {
    await call(`/accounts/${bankId}`, { method: "PATCH", body: JSON.stringify({ openingBalanceMinor: 25_000_00 }) });
    await call(`/accounts/${bankId}`, { method: "PATCH", body: JSON.stringify({ openingBalanceMinor: null }) });

    assert.equal((await bankRow()).balance, null);
    const stored = await models.Account.findById(bankId).orFail();
    assert.equal(stored.openingBalanceAt, null);
  });

  it("is not offered for a credit card", async () => {
    const card = await models.Account.create({ userId, bankName: "Axis", last4: "9999", accountType: "CARD" });
    const rows = (await (await call("/accounts/overview")).json()) as OverviewRow[];
    assert.equal(rows.find((row) => row.id === card._id.toString())!.tracksBalance, false);
  });
});

describe("an account's billing cycles", () => {
  it("runs statement day to the day before the next, with what each came to", async () => {
    const card = await models.Account.create({ userId, bankName: "Axis", last4: "7777", accountType: "CARD", statementDay: 17 });
    const now = new Date();
    await models.Transaction.create({ userId, accountId: card._id, type: "DEBIT", amountMinor: 500_00, source: "MANUAL", occurredAt: now });

    const body = (await (await call(`/accounts/${card.id}/cycles?count=3`)).json()) as {
      byStatement: boolean;
      cycles: { from: string; to: string; current: boolean; spentMinor: number }[];
    };
    assert.equal(body.byStatement, true);
    assert.equal(body.cycles.length, 3);
    assert.ok(body.cycles.every((cycle) => cycle.from.endsWith("-17")));
    assert.ok(body.cycles.every((cycle) => cycle.to.endsWith("-16")));
    assert.equal(body.cycles[0].current, true);
    assert.equal(body.cycles[0].spentMinor, 500_00);
    assert.equal(body.cycles[1].to < body.cycles[0].from, true, "back to back, newest first");
  });

  it("falls back to the user's months without a statement day", async () => {
    const body = (await (await call(`/accounts/${bankId}/cycles?count=2`)).json()) as { byStatement: boolean; cycles: unknown[] };
    assert.equal(body.byStatement, false);
    assert.equal(body.cycles.length, 2);
  });
});

describe("the ledger filtered to one account", () => {
  it("finds that account's transactions, its debit cards' included", async () => {
    const card = await models.Account.create({ userId, bankName: "HDFC Debit", last4: "2222", accountType: "DEBIT", linkedAccountId: bankId });
    const other = await models.Account.create({ userId, bankName: "Axis", last4: "3333", accountType: "CARD" });
    await move("DEBIT", 100_00, new Date().toISOString());
    await models.Transaction.create({ userId, accountId: card._id, type: "DEBIT", amountMinor: 200_00, source: "MANUAL", occurredAt: new Date() });
    await models.Transaction.create({ userId, accountId: other._id, type: "DEBIT", amountMinor: 999_00, source: "MANUAL", occurredAt: new Date() });

    const body = (await (await call(`/transactions/by-day?accountId=${bankId}`)).json()) as {
      days: { transactions: { amountMinor: number }[] }[];
    };
    const amounts = body.days.flatMap((day) => day.transactions.map((t) => t.amountMinor)).sort((a, b) => a - b);
    assert.deepEqual(amounts, [100_00, 200_00]);

    const cardOnly = (await (await call(`/transactions/by-day?accountId=${other.id}`)).json()) as {
      days: { transactions: unknown[] }[];
    };
    assert.equal(cardOnly.days.flatMap((day) => day.transactions).length, 1);
  });
});

describe("a pocket-money account", () => {
  it("tracks the month from its renewal day, and what to top up", async () => {
    const pocket = await models.Account.create({ userId, bankName: "Rahul's wallet", accountType: "BANK" });
    const response = await call(`/accounts/${pocket.id}`, {
      method: "PATCH",
      body: JSON.stringify({ pocketMoney: { holder: "Rahul", limitMinor: 2000_00, renewDay: 1 } }),
    });
    assert.equal(response.status, 200);

    const status = await import("./accounts.pocket").then((m) =>
      m.pocketStatus(userId, { _id: pocket._id, pocketMoney: { holder: "Rahul", limitMinor: 2000_00, renewDay: 1 } }, new Date("2026-10-10T12:00:00+05:30"))
    );
    assert.ok(status);
    assert.deepEqual([status.from, status.to, status.renewsOn], ["2026-10-01", "2026-10-31", "2026-11-01"]);

    await models.Transaction.create({ userId, accountId: pocket._id, type: "DEBIT", amountMinor: 300_00, source: "MANUAL", occurredAt: new Date("2026-09-20T12:00:00+05:30") });
    await models.Transaction.create({ userId, accountId: pocket._id, type: "DEBIT", amountMinor: 450_00, source: "MANUAL", occurredAt: new Date("2026-10-05T12:00:00+05:30") });

    const later = await import("./accounts.pocket").then((m) =>
      m.pocketStatus(userId, { _id: pocket._id, pocketMoney: { holder: "Rahul", limitMinor: 2000_00, renewDay: 1 } }, new Date("2026-10-10T12:00:00+05:30"))
    );
    assert.equal(later!.spentMinor, 450_00);
    assert.equal(later!.leftMinor, 1550_00);
    assert.equal(later!.lastMonthSpentMinor, 300_00);
    assert.equal(later!.renewsToday, false);

    const rows = (await (await call("/accounts/overview")).json()) as { id: string; pocket: { holder: string } | null }[];
    assert.equal(rows.find((row) => row.id === pocket.id)!.pocket?.holder, "Rahul");
  });

  it("is kept out of the daily budget, though it still counts in the month", async () => {
    await models.User.updateOne({ _id: userId }, { dailyBudgetMinor: 1000_00, salaryDay: 1 });
    const pocket = await models.Account.create({
      userId,
      bankName: "Rahul's wallet",
      accountType: "BANK",
      pocketMoney: { holder: "Rahul", limitMinor: 2000_00, renewDay: 1 },
    });
    await models.Transaction.create({ userId, accountId: pocket._id, type: "DEBIT", amountMinor: 500_00, source: "MANUAL", occurredAt: new Date() });

    const { dailyBudget } = await import("../budget/budget.daily");
    const daily = await dailyBudget(userId);
    assert.ok(daily.configured);
    assert.equal(daily.spentMinor, 0);
    assert.equal(daily.keptOutMinor, 500_00);
  });
});
