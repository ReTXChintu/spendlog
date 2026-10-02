import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "money-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let daily: typeof import("../budget/budget.daily");
let coach: typeof import("../ai/ai.coach");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_money_test"));
  const [{ app }, auth, loaded, loadedDaily, loadedCoach] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../budget/budget.daily"),
    import("../ai/ai.coach"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  daily = loadedDaily;
  coach = loadedCoach;
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
    models.Account.deleteMany({}),
    models.User.deleteMany({}),
    models.SavingsPlan.deleteMany({}),
    models.Category.deleteMany({}),
  ]);
  const email = `money${(count += 1)}@example.com`;
  const user = await models.User.create({ email, dailyBudgetMinor: 1000_00, salaryDay: 1 });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const longAgo = new Date("2026-01-01T00:00:00Z");

async function account(fields: Record<string, unknown>) {
  return models.Account.create({ userId, last4: null, ...fields });
}

async function tx(fields: Record<string, unknown>) {
  return models.Transaction.create({ userId, source: "MANUAL", occurredAt: new Date(), ...fields });
}

interface Dashboard {
  money: {
    accounts: { id: string; balanceMinor: number | null; isSavings: boolean; accountType: string }[];
    onHandMinor: number;
    cashMinor: number | null;
    savingsMinor: number | null;
  };
  earmarks: { count: number; totalMinor: number };
}

describe("money on hand", () => {
  it("counts payments with no account as cash", async () => {
    await account({ bankName: "Cash", accountType: "CASH", openingBalanceMinor: 5_000_00, openingBalanceAt: longAgo });
    await tx({ type: "DEBIT", amountMinor: 300_00, accountId: null });

    const body = await json<Dashboard>(await call("/dashboard"));
    assert.equal(body.money.cashMinor, 4_700_00);
  });

  it("moves both accounts for a transfer recorded once, and only once for a paired one", async () => {
    const bank = await account({ bankName: "HDFC", accountType: "BANK", openingBalanceMinor: 50_000_00, openingBalanceAt: longAgo });
    const cash = await account({ bankName: "Cash", accountType: "CASH", openingBalanceMinor: 0, openingBalanceAt: longAgo });

    // An ATM withdrawal, one row: bank down, cash up.
    const atm = await call("/transactions", {
      method: "POST",
      body: JSON.stringify({
        type: "DEBIT",
        amountMinor: 2_000_00,
        occurredAt: new Date().toISOString(),
        accountId: bank.id,
        isTransfer: true,
        transferAccountId: cash.id,
      }),
    });
    assert.equal(atm.status, 201);

    let body = await json<Dashboard>(await call("/dashboard"));
    const balanceOf = (id: string) => body.money.accounts.find((row) => row.id === id)!.balanceMinor;
    assert.equal(balanceOf(bank.id), 48_000_00);
    assert.equal(balanceOf(cash.id), 2_000_00);

    // A savings account fed by a transfer whose two legs both arrived.
    const savings = await account({ bankName: "SBI", accountType: "BANK", openingBalanceMinor: 0, openingBalanceAt: longAgo });
    const out = await tx({ type: "DEBIT", amountMinor: 10_000_00, accountId: bank._id, isTransfer: true, transferAccountId: savings._id });
    const into = await tx({ type: "CREDIT", amountMinor: 10_000_00, accountId: savings._id, isTransfer: true, transferAccountId: bank._id, transferPairId: out._id });
    await models.Transaction.updateOne({ _id: out._id }, { transferPairId: into._id });

    body = await json<Dashboard>(await call("/dashboard"));
    assert.equal(balanceOf(bank.id), 38_000_00);
    assert.equal(balanceOf(savings.id), 10_000_00, "not twenty");
  });

  it("refuses a transfer to the same account", async () => {
    const bank = await account({ bankName: "HDFC", accountType: "BANK" });
    const response = await call("/transactions", {
      method: "POST",
      body: JSON.stringify({
        type: "DEBIT",
        amountMinor: 100_00,
        occurredAt: new Date().toISOString(),
        accountId: bank.id,
        isTransfer: true,
        transferAccountId: bank.id,
      }),
    });
    assert.equal(response.status, 400);
  });

  it("keeps the savings account out of money on hand, one savings account at a time", async () => {
    const main = await account({ bankName: "HDFC", accountType: "BANK", openingBalanceMinor: 20_000_00, openingBalanceAt: longAgo });
    const fund = await account({ bankName: "SBI", accountType: "BANK", openingBalanceMinor: 1_00_000_00, openingBalanceAt: longAgo });
    await call(`/accounts/${main.id}`, { method: "PATCH", body: JSON.stringify({ isSavings: true }) });
    await call(`/accounts/${fund.id}`, { method: "PATCH", body: JSON.stringify({ isSavings: true }) });

    const body = await json<Dashboard>(await call("/dashboard"));
    assert.equal(body.money.onHandMinor, 20_000_00);
    assert.equal(body.money.savingsMinor, 1_00_000_00);
    assert.equal((await models.Account.findById(main._id).orFail()).isSavings, false, "moved to the new one");
  });
});

describe("adding a transaction by hand", () => {
  it("keeps the one-off, salary and fixed-cost markings rather than dropping them", async () => {
    const rent = await models.FixedCommitment.create({ userId, name: "Rent", amountMinor: 500_00, dayOfMonth: 5 });
    const post = (body: Record<string, unknown>) =>
      call("/transactions", {
        method: "POST",
        body: JSON.stringify({ occurredAt: new Date().toISOString(), ...body }),
      }).then((response) => json<{ id: string }>(response));

    const laptop = await post({ type: "DEBIT", amountMinor: 50_000_00, isSpecial: true, commitmentId: rent.id });
    const pay = await post({ type: "CREDIT", amountMinor: 80_000_00, isSalary: true });

    const storedLaptop = await models.Transaction.findById(laptop.id).orFail();
    assert.equal(storedLaptop.isSpecial, true);
    assert.equal(String(storedLaptop.commitmentId), rent.id);
    assert.equal((await models.Transaction.findById(pay.id).orFail()).isSalary, true);
  });
});

describe("money set aside for a purchase still to come", () => {
  it("is not income, and shows on the dashboard until it is spent", async () => {
    const credit = await tx({ type: "CREDIT", amountMinor: 8_000_00, merchant: "Father", isEarmarked: true });
    assert.equal(credit.countedAmountMinor, 0);
    assert.equal(credit.countedReason, "EARMARKED");

    let body = await json<Dashboard>(await call("/dashboard"));
    assert.deepEqual([body.earmarks.count, body.earmarks.totalMinor], [1, 8_000_00]);

    // A week later the thing is bought, and linked to the money.
    const purchase = await tx({
      type: "DEBIT",
      amountMinor: 8_000_00,
      occurredAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const candidates = await json<{ id: string }[]>(await call(`/transactions/${credit.id}/refund-candidates`));
    assert.ok(candidates.some((candidate) => candidate.id === purchase.id));
    await call(`/transactions/${credit.id}/refund-of`, {
      method: "POST",
      body: JSON.stringify({ allocations: [{ transactionId: purchase.id, amountMinor: 8_000_00 }] }),
    });

    assert.equal((await models.Transaction.findById(purchase._id).orFail()).countedAmountMinor, 0);
    body = await json<Dashboard>(await call("/dashboard"));
    assert.equal(body.earmarks.count, 0);
  });
});

describe("money in on top of pay", () => {
  it("goes into the savings bucket, but not the salary or a refund", async () => {
    const today = new Date();
    await tx({ type: "CREDIT", amountMinor: 1_500_00, merchant: "Gift" });
    await tx({ type: "CREDIT", amountMinor: 80_000_00, isSalary: true });
    await tx({ type: "CREDIT", amountMinor: 900_00, isSpecial: true });
    await tx({ type: "CREDIT", amountMinor: 2_000_00, isSettlement: true });

    const result = await daily.dailyBudget(userId, today);
    assert.ok(result.configured);
    assert.equal(result.extraIncomeMinor, 1_500_00);
    assert.equal(result.bucketMinor, result.allowedMinor - result.spentMinor + 1_500_00);
  });
});

describe("the savings plan's rules", () => {
  it("warns when a capped category runs ahead of the month, and when it passes the cap", async () => {
    const food = await models.Category.create({ name: "Food & Dining" });
    await models.SavingsPlan.create({
      userId,
      summary: "Eat out less.",
      model: "test",
      rules: [
        { text: "Keep eating out under ₹3,000", category: "Food & Dining", monthlyCapMinor: 3_000_00 },
        { text: "Review subscriptions" },
      ],
    });

    await tx({ type: "DEBIT", amountMinor: 3_500_00, categoryId: food._id });
    const status = await coach.planStatus(userId);
    assert.ok(status);
    assert.equal(status.rules[0].state, "over");
    assert.equal(status.rules[1].state, "ok");
    assert.equal(status.warnings.length, 1);

    const dashboard = await json<{ planWarnings: unknown[] }>(await call("/dashboard"));
    assert.equal(dashboard.planWarnings.length, 1);
  });
});

describe("analytics charts", () => {
  it("lays out every day, the weekdays, and spending by account with cash", async () => {
    const card = await account({ bankName: "Axis", accountType: "CARD" });
    await tx({ type: "DEBIT", amountMinor: 400_00, accountId: card._id });
    await tx({ type: "DEBIT", amountMinor: 100_00, accountId: null });

    const days = await json<{ day: string; spendMinor: number }[]>(await call("/analytics/daily"));
    assert.ok(days.length >= 28);
    assert.equal(days.reduce((sum, day) => sum + day.spendMinor, 0), 500_00);

    const weekdays = await json<{ day: string; amountMinor: number }[]>(await call("/analytics/weekday"));
    assert.equal(weekdays.length, 7);
    assert.equal(weekdays.reduce((sum, day) => sum + day.amountMinor, 0), 500_00);

    const byAccount = await json<{ accountId: string; amountMinor: number }[]>(await call("/analytics/accounts"));
    assert.deepEqual(
      byAccount.map((row) => [row.accountId, row.amountMinor]),
      [
        [card.id, 400_00],
        ["cash", 100_00],
      ]
    );

    const cashOnly = await json<{ totalSpendMinor: number }>(await call("/analytics/summary?account=cash"));
    assert.equal(cashOnly.totalSpendMinor, 100_00);
  });
});
