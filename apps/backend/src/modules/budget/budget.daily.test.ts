import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Transaction, User } from "../../models";
import { peopleCategoryId } from "../categories/categories.system";
import { SINCE_ALWAYS, budgetOn, dailyBudget } from "./budget.daily";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_daily_budget_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let userId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([Transaction.deleteMany({}), User.deleteMany({})]);
});

/** An IST calendar day, as an instant at noon so no boundary is grazed. */
function on(day: string): Date {
  return new Date(`${day}T12:00:00+05:30`);
}

async function withUser(fields: Record<string, unknown>) {
  const user = await User.create({ email: `d${(userCount += 1)}@example.com`, ...fields });
  userId = user._id;
  return user;
}

async function spend(day: string, rupees: number, extra: Record<string, unknown> = {}) {
  await Transaction.create({
    userId,
    type: "DEBIT",
    amountMinor: rupees * 100,
    occurredAt: on(day),
    description: `spend on ${day}`,
    source: "MANUAL",
    ...extra,
  });
}

/** Narrowed, because every test here has one configured. */
async function bucket(now: Date) {
  const result = await dailyBudget(userId, now);
  assert.ok(result.configured, "expected a configured daily budget");
  return result;
}

describe("the daily budget bucket", () => {
  it("says nothing at all until a daily budget is set", async () => {
    await withUser({ salaryDay: 1 });
    assert.deepEqual(await dailyBudget(userId, on("2026-09-10")), { configured: false });
  });

  it("puts by what a day came in under", async () => {
    // The example it was asked for: 1,000 a day, 500 spent, 500 put by.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 500);

    const result = await bucket(on("2026-09-01"));
    assert.equal(result.daysCounted, 1);
    assert.equal(result.allowedMinor, 1000_00);
    assert.equal(result.spentMinor, 500_00);
    assert.equal(result.bucketMinor, 500_00);
    assert.equal(result.todayLeftMinor, 500_00);
  });

  it("takes back what a day went over by", async () => {
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 1500);

    const result = await bucket(on("2026-09-01"));
    assert.equal(result.bucketMinor, -500_00);
    assert.equal(result.todayLeftMinor, -500_00);
    assert.equal(result.daysOver, 1);
  });

  it("nets the good days against the bad ones", async () => {
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 500); // +500
    await spend("2026-09-02", 1500); // -500
    await spend("2026-09-03", 200); // +800

    const result = await bucket(on("2026-09-03"));
    assert.equal(result.daysCounted, 3);
    assert.equal(result.spentMinor, 2200_00);
    assert.equal(result.allowedMinor, 3000_00);
    assert.equal(result.bucketMinor, 800_00);
    assert.equal(result.daysOver, 1);
  });

  it("counts a day nothing was spent on", async () => {
    // The best kind of day for a bucket, and the one a group-by would
    // leave out: there is no row for it to come back in.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 1000);

    const result = await bucket(on("2026-09-04"));
    assert.equal(result.daysCounted, 4);
    assert.equal(result.bucketMinor, 3000_00, "three untouched days");
    assert.deepEqual(
      result.days.map((day) => day.deltaMinor),
      [0, 1000_00, 1000_00, 1000_00]
    );
  });

  it("starts again on the salary day", async () => {
    // Paid on the 25th. On the 26th the bucket knows about the 25th and
    // the 26th, and nothing from the month before it.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 25 });
    await spend("2026-08-20", 9000); // last period, and a bad day
    await spend("2026-09-25", 200);
    await spend("2026-09-26", 300);

    const result = await bucket(on("2026-09-26"));
    assert.equal(result.daysCounted, 2);
    assert.equal(result.spentMinor, 500_00);
    assert.equal(result.bucketMinor, 1500_00);
    assert.equal(result.resetsOnSalary, true);
  });

  it("opens the period on the day pay actually landed", async () => {
    // A salary that arrives two days late opens the period two days late,
    // the same way the pace card sees it. Anything else would have the two
    // cards measuring different months.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 25 });
    await Transaction.create({
      userId,
      type: "CREDIT",
      amountMinor: 80_000_00,
      occurredAt: on("2026-09-27"),
      description: "salary",
      source: "MANUAL",
      isSalary: true,
    });
    await spend("2026-09-26", 5000); // before the money landed
    await spend("2026-09-28", 400);

    const result = await bucket(on("2026-09-28"));
    assert.equal(result.daysCounted, 2, "the 27th and the 28th");
    assert.equal(result.spentMinor, 400_00);
  });

  it("falls back to the calendar month with no pay day set", async () => {
    await withUser({ dailyBudgetMinor: 1000_00 });
    await spend("2026-08-31", 4000);
    await spend("2026-09-02", 250);

    const result = await bucket(on("2026-09-03"));
    assert.equal(result.resetsOnSalary, false);
    assert.equal(result.daysCounted, 3);
    assert.equal(result.spentMinor, 250_00);
    assert.equal(result.bucketMinor, 2750_00);
  });

  it("ignores what is not really spending", async () => {
    // countedAmountMinor is what decides, so the bucket agrees with every
    // other total in the app: moving money between your own accounts is
    // not a day's spending, and neither is paying a card bill made up of
    // purchases that were counted when they happened.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 400);
    await spend("2026-09-01", 20_000, { isTransfer: true });

    const result = await bucket(on("2026-09-01"));
    assert.equal(result.spentMinor, 400_00);
    assert.equal(result.bucketMinor, 600_00);
  });

  it("keeps a one-off out of the score, and says so", async () => {
    // A laptop is real spending and the month sees it. But a day is not a
    // bad day for having had a laptop in it, and a daily budget that said
    // otherwise would be one nobody kept to.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 400);
    await spend("2026-09-01", 80_000, { isSpecial: true });

    const result = await bucket(on("2026-09-01"));
    assert.equal(result.spentMinor, 400_00);
    assert.equal(result.bucketMinor, 600_00);
    assert.equal(result.keptOutMinor, 80_000_00);
    assert.equal(result.keptOutCount, 1);
  });

  it("keeps a trip out of the score too", async () => {
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-02", 300);
    await spend("2026-09-02", 6000, { tripId: new Types.ObjectId() });
    await spend("2026-09-03", 4500, { tripId: new Types.ObjectId() });

    const result = await bucket(on("2026-09-03"));
    assert.equal(result.spentMinor, 300_00);
    assert.equal(result.keptOutMinor, 10_500_00);
    assert.equal(result.keptOutCount, 2);
    assert.equal(result.daysOver, 0, "a week away is not three bad days");
  });

  it("keeps a fixed commitment payment out of the score too", async () => {
    // Rent landing on the 1st should not wipe out the day's allowance -
    // "what a day should cost" is set with day-to-day spending in mind,
    // and rent is already accounted for on its own.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 400);
    await spend("2026-09-01", 11_500, { commitmentId: new Types.ObjectId() });

    const result = await bucket(on("2026-09-01"));
    assert.equal(result.spentMinor, 400_00);
    assert.equal(result.bucketMinor, 600_00);
    assert.equal(result.keptOutMinor, 11_500_00);
    assert.equal(result.keptOutCount, 1);
  });

  it("groups a late-night payment into the IST day it happened on", async () => {
    // Half eleven at night in Delhi is six in the evening UTC, still the
    // same date; but half past midnight is seven in the evening UTC on the
    // day before. Grouped in UTC, a late night would land on yesterday and
    // take its allowance with it.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await Transaction.create({
      userId,
      type: "DEBIT",
      amountMinor: 700_00,
      // 00:30 IST on the 2nd.
      occurredAt: new Date("2026-09-01T19:00:00.000Z"),
      description: "late dinner",
      source: "MANUAL",
    });

    const result = await bucket(on("2026-09-02"));
    assert.deepEqual(
      result.days.map((day) => [day.day, day.spentMinor]),
      [
        ["2026-09-01", 0],
        ["2026-09-02", 700_00],
      ]
    );
  });

  it("applies a changed budget from that day on, leaving earlier days as they were", async () => {
    // 1,000 a day for the 1st and 2nd; raised to 1,500 on the 3rd.
    const user = await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 400); // +600
    await spend("2026-09-02", 1200); // -200
    const history = [
      { from: SINCE_ALWAYS, amountMinor: 1000_00 },
      { from: "2026-09-03", amountMinor: 1500_00 },
    ];
    await User.updateOne({ _id: user._id }, { dailyBudgetMinor: 1500_00, dailyBudgetHistory: history });
    await spend("2026-09-03", 1000); // +500 against 1,500

    const result = await bucket(on("2026-09-03"));
    assert.deepEqual(
      result.days.map((day) => [day.day, day.allowedMinor, day.deltaMinor]),
      [
        ["2026-09-01", 1000_00, 600_00],
        ["2026-09-02", 1000_00, -200_00],
        ["2026-09-03", 1500_00, 500_00],
      ]
    );
    assert.equal(result.allowedMinor, 3500_00);
    assert.equal(result.bucketMinor, 900_00);
    assert.equal(result.dailyBudgetMinor, 1500_00);
    assert.equal(result.todayLeftMinor, 500_00);
  });

  it("reads the amount in force on a day from the history", () => {
    const user = {
      dailyBudgetMinor: 900_00,
      dailyBudgetHistory: [
        { from: SINCE_ALWAYS, amountMinor: 1000_00 },
        { from: "2026-09-05", amountMinor: 900_00 },
      ],
    };
    assert.equal(budgetOn(user, "2026-08-01"), 1000_00);
    assert.equal(budgetOn(user, "2026-09-04"), 1000_00);
    assert.equal(budgetOn(user, "2026-09-05"), 900_00);
    assert.equal(budgetOn({ dailyBudgetMinor: 800_00, dailyBudgetHistory: [] }, "2026-09-10"), 800_00);
  });

  it("scores a month that is over to its last day, for the bucket to carry", async () => {
    // The savings bucket asks for the month before the first monthly
    // budget, after it has ended. It gets what the daily rules showed on
    // its last evening, whatever has happened since.
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-01", 400);
    await spend("2026-09-30", 1600);
    await spend("2026-10-02", 5000); // the next month: not this one's

    const result = await dailyBudget(userId, on("2026-10-09"), {
      start: new Date("2026-09-01T00:00:00+05:30"),
      end: new Date("2026-10-01T00:00:00+05:30"),
    });
    assert.ok(result.configured);
    assert.equal(result.daysCounted, 30);
    assert.equal(result.allowedMinor, 30_000_00);
    assert.equal(result.spentMinor, 2000_00);
    assert.equal(result.bucketMinor, 28_000_00);
  });

  describe("money coming back", () => {
    async function credit(day: string, rupees: number, extra: Record<string, unknown> = {}) {
      return Transaction.create({
        userId,
        type: "CREDIT",
        amountMinor: rupees * 100,
        occurredAt: on(day),
        source: "MANUAL",
        ...extra,
      });
    }

    it("keeps a person paying back out of the bucket, however it was marked", async () => {
      await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
      const lentAndBorrowed = await peopleCategoryId();
      await credit("2026-09-01", 2000, { categoryId: lentAndBorrowed }); // repayment, plain credit
      await credit("2026-09-01", 1500, {
        split: { myShareMinor: 500_00 },
        people: [{ contactId: new Types.ObjectId(), amountMinor: 1000_00 }],
      });
      await credit("2026-09-01", 300); // a real gift

      const result = await bucket(on("2026-09-01"));
      assert.equal(result.extraIncomeMinor, 300_00);
    });

    it("gives a refund back on the day it arrives, leaving the purchase's day as it was", async () => {
      await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
      await spend("2026-09-01", 1500); // -500 that day
      const purchase = await Transaction.findOne({ userId }).orFail();
      const refund = await credit("2026-09-03", 600, {
        refundOf: [{ transactionId: purchase._id, amountMinor: 600_00 }],
      });
      purchase.refundedMinor = 600_00;
      await purchase.save();
      assert.equal(refund.countedAmountMinor, 0, "not income");

      const result = await bucket(on("2026-09-03"));
      assert.deepEqual(
        result.days.map((day) => [day.day, day.deltaMinor]),
        [
          ["2026-09-01", -500_00],
          ["2026-09-02", 1000_00],
          ["2026-09-03", 1600_00],
        ]
      );
      assert.equal(result.refundedBackMinor, 600_00);
      assert.equal(result.bucketMinor, 2100_00);
    });

    it("gives nothing back for a purchase the bucket never paid for", async () => {
      await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
      await spend("2026-09-01", 50_000, { isSpecial: true });
      const laptop = await Transaction.findOne({ userId }).orFail();
      await credit("2026-09-02", 50_000, { refundOf: [{ transactionId: laptop._id, amountMinor: 50_000_00 }] });

      const result = await bucket(on("2026-09-02"));
      assert.equal(result.refundedBackMinor, 0);
      assert.equal(result.bucketMinor, 2000_00);
    });

    it("does not charge the bucket for a purchase paid with money set aside for it", async () => {
      await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
      const fromDad = await credit("2026-09-01", 8000, { isEarmarked: true });
      await spend("2026-09-02", 8000);
      const purchase = await Transaction.findOne({ userId, type: "DEBIT" }).orFail();
      fromDad.refundOf = [{ transactionId: purchase._id, amountMinor: 8000_00 }];
      await fromDad.save();
      purchase.refundedMinor = 8000_00;
      await purchase.save();

      const result = await bucket(on("2026-09-02"));
      assert.equal(result.spentMinor, 0);
      assert.equal(result.refundedBackMinor, 0);
      assert.equal(result.bucketMinor, 2000_00);
    });
  });

  it("counts today, so the bucket moves as the day is spent", async () => {
    await withUser({ dailyBudgetMinor: 1000_00, salaryDay: 1 });
    await spend("2026-09-02", 100);

    const before = await bucket(on("2026-09-02"));
    assert.equal(before.bucketMinor, 1900_00);

    await spend("2026-09-02", 900);
    const after = await bucket(on("2026-09-02"));
    assert.equal(after.bucketMinor, 1000_00);
    assert.equal(after.todayLeftMinor, 0);
  });
});
