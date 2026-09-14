import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayKey, istDayStart } from "../../time";
import { budgetPeriodFromSalary } from "./budget.period";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "salary-test-secret";

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let budgetPace: typeof import("./budget.pace").budgetPace;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_salary_test"));

  const [loaded, pace] = await Promise.all([import("../../models"), import("./budget.pace")]);
  models = loaded;
  budgetPace = pace.budgetPace;
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.FixedCommitment.deleteMany({}),
  ]);
});

let userCount = 0;

/** Someone paid a lakh, nominally on the 15th. */
async function paidOnThe15th() {
  const user = await models.User.create({
    email: `sal${(userCount += 1)}@example.com`,
    salaryAmountMinor: 10000000,
    salaryDay: 15,
  });
  return user._id;
}

async function credit(userId: Types.ObjectId, day: string, amountMinor: number, isSalary: boolean) {
  return models.Transaction.create({
    userId,
    amountMinor,
    type: "CREDIT",
    merchant: isSalary ? "ACME PAYROLL" : "Someone paying me back",
    source: "SMS",
    occurredAt: istDayStart(day),
    isSalary,
  });
}

async function spend(userId: Types.ObjectId, day: string, amountMinor: number) {
  return models.Transaction.create({
    userId,
    amountMinor,
    type: "DEBIT",
    source: "SMS",
    occurredAt: istDayStart(day),
  });
}

describe("budgetPeriodFromSalary", () => {
  it("starts the period on the day the money actually arrived", () => {
    // Paid on the 14th against a configured day of the 15th. The old
    // behaviour opened the period on the 15th, which counted the 14th
    // against the previous month twice over.
    const period = budgetPeriodFromSalary(istDayStart("2026-09-14"), 15, istDayStart("2026-09-20"));
    assert.equal(istDayKey(period.start), "2026-09-14");
    assert.equal(istDayKey(period.end), "2026-10-15", "and runs to the next one due");
  });

  it("closes on the following month when pay lands on the day itself", () => {
    const period = budgetPeriodFromSalary(istDayStart("2026-09-15"), 15, istDayStart("2026-09-20"));
    assert.equal(istDayKey(period.start), "2026-09-15");
    assert.equal(istDayKey(period.end), "2026-10-15");
  });

  it("closes next month when pay lands after the day it was due", () => {
    const period = budgetPeriodFromSalary(istDayStart("2026-09-17"), 15, istDayStart("2026-09-20"));
    assert.equal(istDayKey(period.start), "2026-09-17");
    assert.equal(istDayKey(period.end), "2026-10-15");
  });

  it("never reports less than a day left when the next salary is overdue", () => {
    // What is left has to last until it arrives, and nobody knows when.
    const period = budgetPeriodFromSalary(istDayStart("2026-08-14"), 15, istDayStart("2026-09-20"));
    assert.equal(period.daysLeft, 1);
  });

  it("clamps a pay day past the end of a short month", () => {
    const period = budgetPeriodFromSalary(istDayStart("2026-01-31"), 31, istDayStart("2026-02-10"));
    assert.equal(istDayKey(period.end), "2026-02-28");
  });
});

describe("the pace, once a salary is marked", () => {
  it("falls back to the configured day when nothing is marked", async () => {
    const userId = await paidOnThe15th();
    const pace = await budgetPace(userId, istDayStart("2026-09-20"));

    assert.equal(pace.configured, true);
    if (!pace.configured) return;
    assert.equal(istDayKey(pace.periodStart), "2026-09-15");
    assert.equal(pace.salaryMinor, 10000000, "the figure from the profile");
    assert.equal(pace.salaryIsActual, false);
  });

  it("opens the period on the day pay landed, not the day it was due", async () => {
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-14", 9600000, true);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");

    assert.equal(istDayKey(pace.periodStart), "2026-09-14");
    assert.equal(pace.salaryIsActual, true);
  });

  it("uses what was actually paid, so a month with leave in it is smaller", async () => {
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-15", 8200000, true);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");

    assert.equal(pace.salaryMinor, 8200000);
    assert.equal(pace.remainingMinor, 8200000, "and what is left follows it down");
  });

  it("adds pay that arrived in two parts", async () => {
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-15", 8200000, true);
    await credit(userId, "2026-09-18", 1400000, true);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.salaryMinor, 9600000);
  });

  it("ignores a credit nobody called pay", async () => {
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-14", 500000, false);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");

    assert.equal(istDayKey(pace.periodStart), "2026-09-15", "the configured day still");
    assert.equal(pace.salaryIsActual, false);
  });

  it("counts spending from the day pay landed rather than the day after", async () => {
    // The day between an early salary and the configured pay day used to
    // fall into neither period.
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-14", 10000000, true);
    await spend(userId, "2026-09-14", 250000);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.spentMinor, 250000);
  });

  it("does not reach back to last month's pay once it is stale", async () => {
    const userId = await paidOnThe15th();
    await credit(userId, "2026-07-15", 10000000, true);

    // Two months on, that credit is outside the window and the configured
    // day takes over rather than anchoring the period in July for ever.
    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(istDayKey(pace.periodStart), "2026-09-15");
  });

  it("keeps one person's pay out of another's period", async () => {
    const mine = await paidOnThe15th();
    const theirs = await paidOnThe15th();
    await credit(theirs, "2026-09-14", 9600000, true);

    const pace = await budgetPace(mine, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(istDayKey(pace.periodStart), "2026-09-15");
  });
});

describe("a fixed cost settled by a payment rather than a tick", () => {
  async function commitment(userId: Types.ObjectId, name: string, amountMinor: number) {
    return models.FixedCommitment.create({ userId, name, amountMinor, dayOfMonth: 5 });
  }

  async function payTowards(
    userId: Types.ObjectId,
    commitmentId: Types.ObjectId,
    day: string,
    amountMinor: number
  ) {
    return models.Transaction.create({
      userId,
      amountMinor,
      type: "DEBIT",
      merchant: "Towards a fixed cost",
      source: "MANUAL",
      occurredAt: istDayStart(day),
      commitmentId,
    });
  }

  it("counts it paid once the money has gone out", async () => {
    const userId = await paidOnThe15th();
    const father = await commitment(userId, "Father", 1000000);
    await payTowards(userId, father._id, "2026-09-18", 1000000);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");

    assert.equal(pace.commitments[0].isPaid, true);
    assert.equal(pace.commitmentsRemainingMinor, 0, "nothing left to hold back");
  });

  it("lets it be paid early, on the day the money actually moved", async () => {
    // The whole reason for marking a payment rather than ticking a due
    // date: an early salary can be spent on early.
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-14", 10000000, true);

    const father = await commitment(userId, "Father", 1000000);
    await payTowards(userId, father._id, "2026-09-14", 1000000);

    const pace = await budgetPace(userId, istDayStart("2026-09-16"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.commitments[0].isPaid, true);
  });

  it("holds back only what is still to go out", async () => {
    // Sending half and still holding back the whole would count the half
    // already sent twice: once in the spending, once here.
    const userId = await paidOnThe15th();
    const father = await commitment(userId, "Father", 1000000);
    await payTowards(userId, father._id, "2026-09-18", 500000);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");

    assert.equal(pace.commitmentsRemainingMinor, 500000);
    assert.equal(pace.commitments[0].isPartial, true);
    assert.equal(pace.commitments[0].isPaid, false);
  });

  it("says what went short, and why only when the money really was not there", async () => {
    const userId = await paidOnThe15th();
    const father = await commitment(userId, "Father", 1000000);
    await payTowards(userId, father._id, "2026-09-18", 500000);

    const roomy = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!roomy.configured) return assert.fail("should be configured");
    assert.match(roomy.shortfallNote!, /Father went out at ₹5,000 of the usual ₹10,000/);
    assert.match(roomy.shortfallNote!, /still room to send the rest/);

    // Now spend the period dry. The claim becomes supportable.
    await spend(userId, "2026-09-19", 9500000);
    const tight = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!tight.configured) return assert.fail("should be configured");
    assert.match(tight.shortfallNote!, /not enough left this period/);
  });

  it("says nothing when a fixed cost has simply not gone out yet", async () => {
    // Not yet paid is not the same as paid short, and calling it a
    // shortfall would nag about every bill on the first of the month.
    const userId = await paidOnThe15th();
    await commitment(userId, "Father", 1000000);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.shortfallNote, null);
    assert.equal(pace.commitmentsRemainingMinor, 1000000);
  });

  it("still honours a hand-tick, for money the app will never see", async () => {
    const userId = await paidOnThe15th();
    const father = await commitment(userId, "Father", 1000000);
    father.paidForPeriod = "2026-09-15";
    await father.save();

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.commitments[0].isPaid, true);
    assert.equal(pace.commitmentsRemainingMinor, 0);
  });

  it("does not let last period's payment settle this one", async () => {
    const userId = await paidOnThe15th();
    const father = await commitment(userId, "Father", 1000000);
    await payTowards(userId, father._id, "2026-08-18", 1000000);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.commitments[0].isPaid, false);
  });
});
