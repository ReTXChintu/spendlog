import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayKey, istDayStart } from "../../time";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "salary-test-secret";

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let budgetPace: typeof import("./budget.pace").budgetPace;
let changeCommitmentAmount: typeof import("./budget.pace").changeCommitmentAmount;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_salary_test"));

  const [loaded, pace] = await Promise.all([import("../../models"), import("./budget.pace")]);
  models = loaded;
  budgetPace = pace.budgetPace;
  changeCommitmentAmount = pace.changeCommitmentAmount;
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

  it("starts the period on the pay day in Settings, whenever pay lands", async () => {
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-16", 9600000, true);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");

    assert.equal(istDayKey(pace.periodStart), "2026-09-15");
    assert.equal(pace.salaryIsActual, true);
    assert.equal(istDayKey(pace.salaryPaidOn!), "2026-09-16");
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

  it("leaves spending before the pay day in the month before, even with pay in early", async () => {
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-14", 10000000, true);
    await spend(userId, "2026-09-14", 250000);
    await spend(userId, "2026-09-15", 100000);

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(istDayKey(pace.periodStart), "2026-09-15");
    assert.equal(pace.spentMinor, 100000);
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

  it("counts a payment made on the pay day towards that month", async () => {
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-15", 10000000, true);

    const father = await commitment(userId, "Father", 1000000);
    await payTowards(userId, father._id, "2026-09-15", 1000000);

    const pace = await budgetPace(userId, istDayStart("2026-09-16"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.commitments[0].isPaid, true);
  });

  it("leaves a payment made before the pay day in the month before", async () => {
    // Only the pay day in Settings decides the month: an early salary
    // spent early is spent in the month it was spent in.
    const userId = await paidOnThe15th();
    await credit(userId, "2026-09-14", 10000000, true);

    const father = await commitment(userId, "Father", 1000000);
    await payTowards(userId, father._id, "2026-09-14", 1000000);

    const pace = await budgetPace(userId, istDayStart("2026-09-16"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.commitments[0].isPaid, false);
  });

  describe("changing the amount", () => {
    it("starts a raise with the next payment when this one already went out", async () => {
      // SIP of 2,000 paid on the 18th, raised to 3,000 on the 20th. This
      // month is done; the 3,000 is next month's figure, not 1,000 owed.
      const userId = await paidOnThe15th();
      const sip = await commitment(userId, "SIP", 200000);
      await payTowards(userId, sip._id, "2026-09-18", 200000);

      await changeCommitmentAmount(sip, 300000, istDayStart("2026-09-20"));
      await sip.save();

      const pace = await budgetPace(userId, istDayStart("2026-09-21"));
      if (!pace.configured) return assert.fail("should be configured");
      assert.equal(pace.commitments[0].isPaid, true);
      assert.equal(pace.commitmentsRemainingMinor, 0, "nothing still to go out");
      assert.equal(pace.commitments[0].thisPeriodAmountMinor, 200000);
      assert.equal(pace.commitments[0].amountMinor, 300000);

      // And next period, the new figure is what it costs.
      const next = await budgetPace(userId, istDayStart("2026-10-16"));
      if (!next.configured) return assert.fail("should be configured");
      assert.equal(next.commitments[0].thisPeriodAmountMinor, 300000);
      assert.equal(next.commitmentsRemainingMinor, 300000);
    });

    it("applies at once when this period has not been paid yet", async () => {
      const userId = await paidOnThe15th();
      const sip = await commitment(userId, "SIP", 200000);

      await changeCommitmentAmount(sip, 300000, istDayStart("2026-09-20"));
      await sip.save();

      const pace = await budgetPace(userId, istDayStart("2026-09-21"));
      if (!pace.configured) return assert.fail("should be configured");
      assert.equal(pace.commitments[0].thisPeriodAmountMinor, 300000);
      assert.equal(pace.commitmentsRemainingMinor, 300000);
    });

    it("treats a hand-ticked period as met", async () => {
      const userId = await paidOnThe15th();
      const sip = await commitment(userId, "SIP", 200000);
      sip.paidForPeriod = "2026-09-15";
      await sip.save();

      await changeCommitmentAmount(sip, 300000, istDayStart("2026-09-20"));
      await sip.save();

      const pace = await budgetPace(userId, istDayStart("2026-09-21"));
      if (!pace.configured) return assert.fail("should be configured");
      assert.equal(pace.commitments[0].thisPeriodAmountMinor, 200000);
      assert.equal(pace.commitments[0].isPaid, true);
    });

    it("keeps the paid-at figure through a second change in the same period", async () => {
      const userId = await paidOnThe15th();
      const sip = await commitment(userId, "SIP", 200000);
      await payTowards(userId, sip._id, "2026-09-18", 200000);

      await changeCommitmentAmount(sip, 300000, istDayStart("2026-09-20"));
      await sip.save();
      await changeCommitmentAmount(sip, 350000, istDayStart("2026-09-22"));
      await sip.save();

      const pace = await budgetPace(userId, istDayStart("2026-09-23"));
      if (!pace.configured) return assert.fail("should be configured");
      assert.equal(pace.commitments[0].thisPeriodAmountMinor, 200000);
      assert.equal(pace.commitments[0].amountMinor, 350000);
    });
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

describe("a fixed cost paid for a household", () => {
  it("reads a shared bill as the share it cost, not the sum that left", async () => {
    // Rent of 12,000 for a flat of three, paid whole by one of them. The
    // commitment is the 4,000 it actually costs; the payment that meets it
    // is a 12,000 debit split down to that share.
    const userId = await paidOnThe15th();
    const rent = await models.FixedCommitment.create({
      userId,
      name: "Rent",
      amountMinor: 400000,
      dayOfMonth: 5,
    });

    await models.Transaction.create({
      userId,
      amountMinor: 1200000,
      type: "DEBIT",
      merchant: "Landlord",
      source: "MANUAL",
      occurredAt: istDayStart("2026-09-18"),
      commitmentId: rent._id,
      split: { myShareMinor: 400000 },
    });

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");

    assert.equal(pace.commitments[0].paidMinor, 400000, "the share, not the cheque");
    assert.equal(pace.commitments[0].isPaid, true);
    assert.equal(pace.commitmentsRemainingMinor, 0);
    assert.equal(pace.spentMinor, 400000, "and the spending is the share too");
  });

  it("still reads short when the share itself went out short", async () => {
    const userId = await paidOnThe15th();
    const rent = await models.FixedCommitment.create({
      userId,
      name: "Rent",
      amountMinor: 400000,
      dayOfMonth: 5,
    });

    await models.Transaction.create({
      userId,
      amountMinor: 900000,
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: istDayStart("2026-09-18"),
      commitmentId: rent._id,
      split: { myShareMinor: 100000 },
    });

    const pace = await budgetPace(userId, istDayStart("2026-09-20"));
    if (!pace.configured) return assert.fail("should be configured");
    assert.equal(pace.commitments[0].isPartial, true);
    assert.equal(pace.commitments[0].shortfallMinor, 300000);
  });
});
