import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "monthly-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let monthly: typeof import("./budget.monthly");
let bucket: typeof import("./budget.bucket");
let months: typeof import("./budget.months");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_monthly_budget_test"));
  const [{ app }, auth, loadedModels, loadedMonthly, loadedBucket, loadedMonths] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./budget.monthly"),
    import("./budget.bucket"),
    import("./budget.months"),
  ]);
  signToken = auth.signSessionToken;
  models = loadedModels;
  monthly = loadedMonthly;
  bucket = loadedBucket;
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

let userId: Types.ObjectId;
let token: string;
let count = 0;

beforeEach(async () => {
  await Promise.all([
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.Account.deleteMany({}),
    models.Category.deleteMany({}),
    models.FixedCommitment.deleteMany({}),
  ]);
});

/** An IST calendar day, as an instant at noon so no boundary is grazed. */
function on(day: string): Date {
  return new Date(`${day}T12:00:00+05:30`);
}

async function withUser(fields: Record<string, unknown> = {}) {
  const email = `m${(count += 1)}@example.com`;
  const user = await models.User.create({ email, salaryDay: 1, ...fields });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  return user;
}

function budgetFrom(fromMonthKey: string, amountRupees: number, limits: [Types.ObjectId, number][] = []) {
  return {
    fromMonthKey,
    amountMinor: amountRupees * 100,
    categoryLimits: limits.map(([categoryId, rupees]) => ({ categoryId, amountMinor: rupees * 100 })),
  };
}

async function spend(day: string | Date, rupees: number, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    type: "DEBIT",
    amountMinor: rupees * 100,
    occurredAt: typeof day === "string" ? on(day) : day,
    source: "MANUAL",
    ...extra,
  });
}

async function credit(day: string | Date, rupees: number, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    type: "CREDIT",
    amountMinor: rupees * 100,
    occurredAt: typeof day === "string" ? on(day) : day,
    source: "MANUAL",
    ...extra,
  });
}

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

describe("the pace", () => {
  const base = { fixedPaidMinor: 0, fixedStillDueMinor: 0, daysInMonth: 30 };

  it("is on track while spending is where an even month would have it", () => {
    const pace = monthly.paceFor({ ...base, budgetMinor: 30_000_00, spentMinor: 10_000_00, dayOfMonth: 10, today: "2026-10-10" });
    assert.equal(pace.status, "on_track");
    assert.equal(pace.expectedSpentMinor, 10_000_00);
    assert.equal(pace.remainingMinor, 20_000_00);
    assert.equal(pace.daysLeft, 21, "today counts as a day left");
    assert.equal(pace.safeDailyMinor, Math.floor(20_000_00 / 21));
    assert.equal(pace.runOutOn, null, "it lasts exactly to the end");
  });

  it("is high when ahead of plan, and names the day it runs out", () => {
    // 15,000 in ten days is 1,500 a day; the 15,000 left lasts ten more.
    const pace = monthly.paceFor({ ...base, budgetMinor: 30_000_00, spentMinor: 15_000_00, dayOfMonth: 10, today: "2026-10-10" });
    assert.equal(pace.status, "high");
    assert.equal(pace.aheadByMinor, 5_000_00);
    assert.equal(pace.dailyAverageMinor, 1_500_00);
    assert.equal(pace.projectedSpentMinor, 45_000_00);
    assert.equal(pace.runOutOn, "2026-10-20");
    assert.equal(pace.safeDailyMinor, Math.floor(15_000_00 / 21));
  });

  it("is over once the budget is spent, with nothing left a day", () => {
    const pace = monthly.paceFor({ ...base, budgetMinor: 30_000_00, spentMinor: 31_000_00, dayOfMonth: 20, today: "2026-10-20" });
    assert.equal(pace.status, "over");
    assert.equal(pace.remainingMinor, -1_000_00);
    assert.equal(pace.safeDailyMinor, 0);
    assert.equal(pace.runOutOn, null);
  });

  it("does not call a month high for having paid the rent on the 1st", () => {
    const pace = monthly.paceFor({
      ...base,
      budgetMinor: 30_000_00,
      spentMinor: 12_500_00,
      fixedPaidMinor: 12_000_00,
      dayOfMonth: 2,
      today: "2026-10-02",
    });
    // 12,000 of rent, plus two days of the other 18,000.
    assert.equal(pace.expectedSpentMinor, 13_200_00);
    assert.equal(pace.status, "on_track");
    assert.equal(pace.dailyAverageMinor, 250_00, "the rent is not a daily habit");
  });

  it("holds back the fixed costs still to go out from what can be spent a day", () => {
    const pace = monthly.paceFor({
      ...base,
      budgetMinor: 30_000_00,
      spentMinor: 0,
      fixedStillDueMinor: 12_000_00,
      dayOfMonth: 1,
      today: "2026-10-01",
    });
    assert.equal(pace.safeDailyMinor, 600_00);
    assert.equal(pace.status, "on_track");
  });
});

describe("the budget's history", () => {
  it("applies a change from the month it is made in, and keeps the last change in a month", () => {
    const user = { monthlyBudgetHistory: [budgetFrom("2026-08", 20_000)] };
    const once = monthly.withMonthlyBudgetChange(user, { amountMinor: 25_000_00, categoryLimits: [] }, "2026-10");
    const twice = monthly.withMonthlyBudgetChange({ monthlyBudgetHistory: once }, { amountMinor: 22_000_00, categoryLimits: [] }, "2026-10");
    assert.deepEqual(
      twice.map((change) => [change.fromMonthKey, change.amountMinor]),
      [
        ["2026-08", 20_000_00],
        ["2026-10", 22_000_00],
      ]
    );
    assert.equal(monthly.monthlyBudgetFor({ monthlyBudgetHistory: twice }, "2026-07"), null);
    assert.equal(monthly.monthlyBudgetFor({ monthlyBudgetHistory: twice }, "2026-09")!.amountMinor, 20_000_00);
    assert.equal(monthly.monthlyBudgetFor({ monthlyBudgetHistory: twice }, "2026-12")!.amountMinor, 22_000_00);
  });
});

describe("the month against its budget", () => {
  it("says it is not set, and suggests the old daily budget times the month", async () => {
    await withUser({ dailyBudgetMinor: 600_00 });
    const status = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-09"));
    assert.equal(status.configured, false);
    assert.equal(status.everSet, false);
    assert.equal(status.suggestedMonthlyMinor, 600_00 * 31);
    assert.equal(status.budgetMinor, null);
    assert.deepEqual(status.bucket, { configured: false });

    const user = await models.User.findById(userId).orFail();
    assert.equal(user.monthlyBudgetHistory!.length, 0, "nothing is seeded");
  });

  it("counts everything the month cost - fixed costs, one-offs, trips, pocket money - and nothing that was not spending", async () => {
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-10", 20_000)] });
    const pocket = await models.Account.create({
      userId,
      bankName: "Rahul's wallet",
      accountType: "BANK",
      pocketMoney: { holder: "Rahul", limitMinor: 2000_00, renewDay: 1 },
    });

    await spend("2026-10-01", 12_000, { commitmentId: new Types.ObjectId() }); // rent
    await spend("2026-10-02", 5_000, { isSpecial: true }); // a one-off
    await spend("2026-10-03", 1_000, { tripId: new Types.ObjectId() });
    await spend("2026-10-04", 300, { accountId: pocket._id });
    await spend("2026-10-05", 4_000, { isTransfer: true });
    await spend("2026-10-05", 9_000, { cardPaymentFor: new Types.ObjectId() });
    await spend("2026-10-06", 2_000, { split: { myShareMinor: 0 } }); // lent to a friend
    await spend("2026-10-06", 30_000, { emiRole: "PARENT" });
    await spend("2026-09-30", 7_000); // last month

    const status = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-09"));
    assert.ok(status.configured);
    assert.equal(status.spentMinor, 18_300_00);
    assert.equal(status.leftMinor, 1_700_00);
    assert.equal(status.isOver, false);
    assert.equal(status.month.key, "2026-10");
    assert.equal(status.month.dayOfMonth, 9);
    assert.equal(status.month.daysLeft, 23);
    assert.equal(status.pace!.fixedPaidMinor, 12_000_00);
  });

  it("nets a refund off through the month's own total", async () => {
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-10", 20_000)] });
    const purchase = await spend("2026-10-03", 2_000);
    await credit("2026-10-05", 2_000, { refundOf: [{ transactionId: purchase._id, amountMinor: 2_000_00 }] });
    purchase.refundedMinor = 2_000_00;
    await purchase.save();

    const status = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-09"));
    assert.equal(status.spentMinor, 0);
  });

  it("splits it into category limits and the unassigned rest", async () => {
    const food = await models.Category.create({ name: "Dining" });
    const groceries = await models.Category.create({ name: "Groceries" });
    const transport = await models.Category.create({ name: "Transport" });
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-10", 20_000, [[food._id, 3_000], [groceries._id, 4_000]])] });

    await spend("2026-10-02", 3_500, { categoryId: food._id });
    await spend("2026-10-03", 1_000, { categoryId: groceries._id });
    await spend("2026-10-04", 2_000, { categoryId: transport._id });
    await spend("2026-10-05", 500);

    const status = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-09"));
    assert.deepEqual(
      status.categories.map((row) => [row.name, row.limitMinor, row.spentMinor, row.leftMinor, row.isOver]),
      [
        ["Dining", 3_000_00, 3_500_00, -500_00, true],
        ["Groceries", 4_000_00, 1_000_00, 3_000_00, false],
      ]
    );
    assert.equal(status.categories[0].pace!.status, "over");
    assert.equal(status.categories[1].pace!.status, "on_track");

    assert.equal(status.unassigned!.amountMinor, 13_000_00);
    assert.equal(status.unassigned!.spentMinor, 2_500_00);
    assert.equal(status.unassigned!.leftMinor, 10_500_00);
    assert.deepEqual(
      status.unassigned!.categories.map((row) => [row.name, row.spentMinor]),
      [
        ["Transport", 2_000_00],
        ["Uncategorized", 500_00],
      ]
    );
    // Limits never add to the total: it is still the one amount.
    assert.equal(status.leftMinor, 20_000_00 - 7_000_00);
  });

  it("says a category is pacing high before it is over", async () => {
    const food = await models.Category.create({ name: "Dining" });
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-10", 20_000, [[food._id, 3_100]])] });
    // 2,000 of 3,100 by the 9th of 31 days: well ahead of the 900 an even
    // month would have spent by now.
    await spend("2026-10-05", 2_000, { categoryId: food._id });

    const status = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-09"));
    const dining = status.categories[0];
    assert.equal(dining.pace!.status, "high");
    assert.equal(dining.pace!.expectedSpentMinor, 900_00);
    assert.ok(dining.pace!.runOutOn, "and runs out before the month does");
  });

  it("measures a past month against the budget it had", async () => {
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-09", 20_000), budgetFrom("2026-10", 25_000)] });
    await spend("2026-09-12", 21_000);

    const september = await monthly.monthlyBudgetStatus(userId, "2026-09", on("2026-10-09"));
    assert.equal(september.budgetMinor, 20_000_00);
    assert.equal(september.isOver, true);
    assert.equal(september.month.isClosed, true);
    assert.equal(september.pace, null, "a month that is over has no pace");

    const october = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-09"));
    assert.equal(october.budgetMinor, 25_000_00);
    assert.equal(october.fromMonthKey, "2026-10");
  });

  it("counts a fixed cost still to go out against what is safe a day", async () => {
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-10", 31_000)] });
    await models.FixedCommitment.create({ userId, name: "Rent", amountMinor: 12_400_00, dayOfMonth: 15 });

    const status = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-01"));
    assert.equal(status.pace!.fixedStillDueMinor, 12_400_00);
    assert.equal(status.pace!.safeDailyMinor, 600_00);
  });
});

describe("the savings bucket", () => {
  it("says it is not set until a monthly budget is", async () => {
    await withUser({ dailyBudgetMinor: 1000_00 });
    const result = await bucket.savingsBucket(userId, on("2026-10-09"));
    assert.deepEqual(result, { configured: false, suggestedMonthlyMinor: 1000_00 * 31 });
  });

  it("opens with the last daily month's result, then adds what each month leaves and takes what it overspends", async () => {
    await withUser({ dailyBudgetMinor: 1000_00, monthlyBudgetHistory: [budgetFrom("2026-09", 20_000)] });
    await spend("2026-07-20", 9_000); // before the daily month: not carried
    await spend("2026-08-10", 500); // the daily month: 31,000 allowed
    await spend("2026-09-10", 15_000); // 5,000 left
    await spend("2026-10-10", 26_000); // 6,000 over
    await spend("2026-11-05", 3_000); // this month, still running
    await credit("2026-11-06", 700, { merchant: "Gift" });

    const result = await bucket.savingsBucket(userId, on("2026-11-15"));
    assert.ok(result.configured);
    assert.equal(result.firstMonthKey, "2026-09");
    assert.equal(result.openingFromDailyMinor, 30_500_00);
    assert.deepEqual(
      result.months.map((row) => [row.key, row.era, row.settled, row.leftMinor, row.toBucketMinor, row.balanceAfterMinor]),
      [
        ["2026-11", "monthly", false, 17_000_00, 700_00, 30_200_00],
        ["2026-10", "monthly", true, -6_000_00, -6_000_00, 29_500_00],
        ["2026-09", "monthly", true, 5_000_00, 5_000_00, 35_500_00],
        ["2026-08", "daily", true, 30_500_00, 30_500_00, 30_500_00],
      ]
    );
    assert.equal(result.balanceMinor, 30_200_00);
    assert.equal(result.balanceIfMonthEndedNowMinor, 47_200_00);
  });

  it("keeps a month's result when the budget changes after it", async () => {
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-09", 20_000), budgetFrom("2026-10", 30_000)] });
    await spend("2026-09-10", 15_000);

    const result = await bucket.savingsBucket(userId, on("2026-10-09"));
    assert.ok(result.configured);
    const september = result.months.find((row) => row.key === "2026-09")!;
    assert.equal(september.budgetMinor, 20_000_00);
    assert.equal(september.toBucketMinor, 5_000_00);
  });

  it("goes below zero rather than forgetting an overspend, as the daily bucket did", async () => {
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-09", 10_000)] });
    await spend("2026-09-10", 15_000);

    const result = await bucket.savingsBucket(userId, on("2026-10-09"));
    assert.ok(result.configured);
    assert.equal(result.openingFromDailyMinor, 0, "no daily budget, nothing carried");
    assert.equal(result.balanceMinor, -5_000_00);
  });

  it("leaves out pay, money from people and money kept out", async () => {
    await withUser({ monthlyBudgetHistory: [budgetFrom("2026-10", 10_000)] });
    await credit("2026-10-02", 80_000, { isSalary: true });
    await credit("2026-10-03", 900, { isSpecial: true });
    await credit("2026-10-04", 2_000, { isSettlement: true });
    await credit("2026-10-05", 400, { merchant: "Interest" });

    const result = await bucket.savingsBucket(userId, on("2026-10-09"));
    assert.ok(result.configured);
    assert.equal(result.months[0].extraIncomeMinor, 400_00);
    assert.equal(result.balanceMinor, 400_00);
  });
});

describe("the budget routes", () => {
  it("saves a budget from this month, and refuses limits that add up to more than it", async () => {
    await withUser();
    const dining = await models.Category.create({ name: "Dining" });
    const groceries = await models.Category.create({ name: "Groceries" });

    const over = await call("/budget/monthly", {
      method: "PUT",
      body: JSON.stringify({
        amountMinor: 20_000_00,
        categoryLimits: [
          { categoryId: dining.id, amountMinor: 12_000_00 },
          { categoryId: groceries.id, amountMinor: 10_000_00 },
        ],
      }),
    });
    assert.equal(over.status, 400);
    const problem = (await over.json()) as { error: string; overshootMinor: number };
    assert.equal(problem.overshootMinor, 2_000_00);
    assert.match(problem.error, /₹22,000/);
    assert.match(problem.error, /₹2,000 more than the ₹20,000/);

    const saved = await call("/budget/monthly", {
      method: "PUT",
      body: JSON.stringify({
        amountMinor: 20_000_00,
        categoryLimits: [{ categoryId: dining.id, amountMinor: 5_000_00 }],
      }),
    });
    assert.equal(saved.status, 200);
    const status = (await saved.json()) as { configured: boolean; budgetMinor: number; unassigned: { amountMinor: number } };
    assert.equal(status.configured, true);
    assert.equal(status.budgetMinor, 20_000_00);
    assert.equal(status.unassigned.amountMinor, 15_000_00);

    const { recent } = await months.userMonths(userId, new Date(), 1);
    const user = await models.User.findById(userId).orFail();
    assert.deepEqual(
      user.monthlyBudgetHistory!.map((change) => [change.fromMonthKey, change.amountMinor]),
      [[recent[0].key, 20_000_00]]
    );

    const current = (await (await call("/budget/monthly")).json()) as { month: { key: string; isCurrent: boolean } };
    assert.equal(current.month.key, recent[0].key);
    assert.equal(current.month.isCurrent, true);
  });

  it("refuses a limit twice, an unknown category, and one for money coming in", async () => {
    await withUser();
    const dining = await models.Category.create({ name: "Dining" });
    const salary = await models.Category.create({ name: "Salary", direction: "IN" });
    const put = (categoryLimits: unknown[]) =>
      call("/budget/monthly", { method: "PUT", body: JSON.stringify({ amountMinor: 10_000_00, categoryLimits }) });

    assert.equal((await put([{ categoryId: dining.id, amountMinor: 1 }, { categoryId: dining.id, amountMinor: 1 }])).status, 400);
    assert.equal((await put([{ categoryId: new Types.ObjectId().toString(), amountMinor: 1 }])).status, 400);
    assert.equal((await put([{ categoryId: salary.id, amountMinor: 1 }])).status, 400);
    assert.equal((await call("/budget/monthly", { method: "PUT", body: JSON.stringify({ amountMinor: 0 }) })).status, 400);
    assert.equal((await call("/budget/monthly/2026-13")).status, 400);
  });

  it("no longer has a daily budget to read or set", async () => {
    await withUser({ salaryAmountMinor: 50_000_00 });
    assert.equal((await call("/budget/daily")).status, 404);

    const patched = await call("/budget/profile", { method: "PATCH", body: JSON.stringify({ dailyBudgetMinor: 900_00, salaryDay: 5 }) });
    assert.equal(patched.status, 200);
    assert.deepEqual(await patched.json(), { salaryAmountMinor: 50_000_00, salaryDay: 5 });
    const user = await models.User.findById(userId).orFail();
    assert.equal(user.dailyBudgetMinor, null);
  });

  it("puts the budget and every account's face on the dashboard", async () => {
    await withUser();
    const longAgo = new Date("2026-01-01T00:00:00Z");
    const bank = await models.Account.create({ userId, bankName: "HDFC", last4: "1234", accountType: "BANK", openingBalanceMinor: 50_000_00, openingBalanceAt: longAgo });
    await models.Account.create({ userId, bankName: "SBI", accountType: "BANK", isSavings: true });
    await models.Account.create({ userId, bankName: "HDFC", last4: "9999", accountType: "DEBIT", cardNetwork: "rupay", linkedAccountId: bank._id });
    const card = await models.Account.create({
      userId,
      bankName: "ICICI",
      nickname: "Amazon Pay",
      last4: "4321",
      accountType: "CARD",
      cardNetwork: "Visa",
      creditLimitMinor: 1_00_000_00,
      statementDay: 5,
      dueDay: 23,
    });
    await spend(new Date(), 2_500, { accountId: card._id });

    const body = (await (await call("/dashboard")).json()) as {
      daily?: unknown;
      budget: { configured: boolean };
      wallet: {
        cards: { accountId: string; name: string; bankName: string; network: string; last4: string; creditLimitMinor: number; cycleSpentMinor: number; usedMinor: number; availableMinor: number; cycleStart: string; cycleEnd: string; lastStatement: unknown; daysToDue: number | null; hasCardDetails: boolean }[];
        banks: { accountId: string; name: string; last4: string | null; balanceMinor: number | null; isSavings: boolean; pocket: unknown; debitCards: { last4: string; network: string }[] }[];
      };
    };
    assert.equal(body.daily, undefined);
    assert.equal(body.budget.configured, false);

    const face = body.wallet.cards.find((row) => row.accountId === card.id)!;
    assert.equal(face.name, "Amazon Pay");
    assert.equal(face.bankName, "ICICI");
    assert.equal(face.network, "VISA");
    assert.equal(face.last4, "4321");
    assert.equal(face.creditLimitMinor, 1_00_000_00);
    assert.equal(face.cycleSpentMinor, 2_500_00);
    assert.equal(face.usedMinor, 2_500_00);
    assert.equal(face.availableMinor, 97_500_00);
    assert.ok(face.cycleStart && face.cycleEnd);
    assert.equal(face.lastStatement, null);
    assert.equal(typeof face.daysToDue, "number");
    assert.equal(face.hasCardDetails, false);

    const [hdfc, sbi] = body.wallet.banks;
    assert.equal(hdfc.balanceMinor, 50_000_00);
    assert.equal(hdfc.isSavings, false);
    assert.deepEqual(hdfc.debitCards.map((debit) => [debit.last4, debit.network]), [["9999", "RUPAY"]]);
    assert.equal(sbi.isSavings, true, "the savings account is in the payload, last");
    assert.equal(sbi.balanceMinor, null);
  });
});
