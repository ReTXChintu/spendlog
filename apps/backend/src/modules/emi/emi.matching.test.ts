import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Account, EmiInstalment, EmiPlan, Transaction, User } from "../../models";
import { buildSchedule } from "./emi.schedule";
import { matchEmiInstalment } from "./emi.matching";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_emi_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Transaction.deleteMany({}),
    EmiPlan.deleteMany({}),
    EmiInstalment.deleteMany({}),
    Account.deleteMany({}),
    User.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `u${(userCount += 1)}@example.com`, name: "Test" });
  return user._id;
}

const PURCHASE_DATE = new Date("2026-09-10T10:00:00Z");

async function makePlan(
  userId: Types.ObjectId,
  options: { accountId?: Types.ObjectId | null; monthlyAmountMinor?: number } = {}
) {
  const monthlyAmountMinor = options.monthlyAmountMinor ?? 320000;

  const purchase = await Transaction.create({
    userId,
    accountId: options.accountId ?? null,
    amountMinor: 3600000,
    currency: "INR",
    type: "DEBIT",
    merchant: "Croma",
    source: "MANUAL",
    occurredAt: PURCHASE_DATE,
  });

  const plan = await EmiPlan.create({
    userId,
    sourceTransactionId: purchase._id,
    accountId: options.accountId ?? null,
    principalMinor: 3600000,
    months: 12,
    monthlyAmountMinor,
    totalPayableMinor: monthlyAmountMinor * 12,
    startDate: PURCHASE_DATE,
    status: "ACTIVE",
  });

  await EmiInstalment.insertMany(
    buildSchedule(PURCHASE_DATE, 12, monthlyAmountMinor).map((entry) => ({
      userId,
      planId: plan._id,
      ...entry,
    }))
  );

  purchase.emiPlanId = plan._id;
  purchase.emiRole = "PARENT";
  await purchase.save();

  return { purchase, plan };
}

describe("converting a purchase to an EMI", () => {
  it("stops the purchase counting, since the instalments will", async () => {
    const userId = await makeUser();
    const { purchase } = await makePlan(userId);

    const stored = await Transaction.findById(purchase._id).orFail();
    assert.equal(stored.countedAmountMinor, 0);
    assert.equal(stored.countedReason, "EMI_PARENT");
    assert.equal(stored.amountMinor, 3600000, "the purchase itself is unchanged");
  });

  it("counts again in full once the plan is removed", async () => {
    const userId = await makeUser();
    const { purchase } = await makePlan(userId);

    const stored = await Transaction.findById(purchase._id).orFail();
    stored.emiPlanId = null;
    stored.emiRole = null;
    await stored.save();

    assert.equal(stored.countedAmountMinor, 3600000);
    assert.equal(stored.countedReason, "FULL");
  });
});

describe("matching a monthly debit to its instalment", () => {
  async function debit(userId: Types.ObjectId, amountMinor: number, occurredAt: Date, accountId?: Types.ObjectId) {
    return Transaction.create({
      userId,
      accountId: accountId ?? null,
      amountMinor,
      currency: "INR",
      type: "DEBIT",
      merchant: "EMI",
      source: "SMS",
      occurredAt,
    });
  }

  it("ticks off the instalment it pays", async () => {
    const userId = await makeUser();
    const { plan } = await makePlan(userId);

    const payment = await debit(userId, 320000, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchEmiInstalment(payment), true);

    const second = await EmiInstalment.findOne({ planId: plan._id, seq: 2 }).orFail();
    assert.equal(second.status, "PAID");
    assert.equal(String(second.transactionId), String(payment._id));
  });

  it("counts the payment in full, because that is the real spending", async () => {
    const userId = await makeUser();
    await makePlan(userId);

    const payment = await debit(userId, 320000, new Date("2026-10-10T06:00:00Z"));
    await matchEmiInstalment(payment);

    const stored = await Transaction.findById(payment._id).orFail();
    assert.equal(stored.emiRole, "INSTALMENT");
    assert.equal(stored.countedAmountMinor, 320000);
    assert.equal(stored.countedReason, "FULL");
  });

  it("allows for an issuer rounding the last rupee differently", async () => {
    const userId = await makeUser();
    await makePlan(userId);

    const payment = await debit(userId, 320003, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchEmiInstalment(payment), true);
  });

  it("ignores a debit for a clearly different amount", async () => {
    const userId = await makeUser();
    await makePlan(userId);

    const payment = await debit(userId, 450000, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchEmiInstalment(payment), false);
  });

  it("ignores a debit nowhere near a due date", async () => {
    const userId = await makeUser();
    await makePlan(userId);

    const payment = await debit(userId, 320000, new Date("2026-10-25T06:00:00Z"));
    assert.equal(await matchEmiInstalment(payment), false);
  });

  it("prefers the plan on the same card when two could fit", async () => {
    const userId = await makeUser();
    const [cardA, cardB] = await Promise.all([
      Account.create({ userId, bankName: "HDFC Bank", last4: "1111", accountType: "CARD" }),
      Account.create({ userId, bankName: "ICICI Bank", last4: "2222", accountType: "CARD" }),
    ]);

    await makePlan(userId, { accountId: cardA._id });
    const { plan: planB } = await makePlan(userId, { accountId: cardB._id });

    const payment = await debit(userId, 320000, new Date("2026-10-10T06:00:00Z"), cardB._id);
    await matchEmiInstalment(payment);

    const matched = await EmiInstalment.findOne({ transactionId: payment._id }).orFail();
    assert.equal(String(matched.planId), String(planB._id));
  });

  it("does not match the same payment twice", async () => {
    const userId = await makeUser();
    await makePlan(userId);

    const payment = await debit(userId, 320000, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchEmiInstalment(payment), true);
    assert.equal(await matchEmiInstalment(payment), false, "already spoken for");

    assert.equal(await EmiInstalment.countDocuments({ status: "PAID" }), 1);
  });

  it("never matches the purchase that started the plan", async () => {
    const userId = await makeUser();
    const { purchase } = await makePlan(userId);

    assert.equal(await matchEmiInstalment(purchase), false);
  });

  it("closes the plan when the last instalment is paid", async () => {
    const userId = await makeUser();
    const { plan } = await makePlan(userId);

    // Everything but the last, settled without a matching debit.
    await EmiInstalment.updateMany({ planId: plan._id, seq: { $lt: 12 } }, { $set: { status: "PAID" } });

    const last = await EmiInstalment.findOne({ planId: plan._id, seq: 12 }).orFail();
    const payment = await debit(userId, 320000, last.dueDate);
    await matchEmiInstalment(payment);

    const closed = await EmiPlan.findById(plan._id).orFail();
    assert.equal(closed.status, "CLOSED");
  });

  it("keeps one user's plans away from another's payments", async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await makePlan(a);

    const payment = await debit(b, 320000, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchEmiInstalment(payment), false);
  });
});
