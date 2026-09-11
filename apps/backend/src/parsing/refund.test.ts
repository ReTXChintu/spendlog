import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Transaction, User } from "../models";
import { resolveCountedAmount } from "../models/counted";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_refund_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Transaction.deleteMany({}), User.deleteMany({})]);
});

let userCount = 0;

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `u${(userCount += 1)}@example.com`, name: "Test" });
  return user._id;
}

function purchase(userId: Types.ObjectId, amountMinor: number, overrides: Record<string, unknown> = {}) {
  return Transaction.create({
    userId,
    amountMinor,
    currency: "INR",
    type: "DEBIT",
    merchant: "Myntra",
    source: "MANUAL",
    occurredAt: new Date("2026-09-01T12:00:00Z"),
    ...overrides,
  });
}

describe("the counted rule for refunds", () => {
  it("counts a refund credit as nothing, since it is not income", () => {
    const result = resolveCountedAmount({ amountMinor: 85000, refundOfId: "purchase-1" });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "REFUND" });
  });

  it("leaves a purchase costing what was not given back", () => {
    // ₹1,000 spent, ₹850 returned: the ₹150 of tax and delivery that
    // stayed gone is what it actually cost.
    const result = resolveCountedAmount({ amountMinor: 100000, refundedMinor: 85000 });
    assert.deepEqual(result, { countedAmountMinor: 15000, countedReason: "REFUNDED" });
  });

  it("costs nothing when the whole amount comes back", () => {
    const result = resolveCountedAmount({ amountMinor: 100000, refundedMinor: 100000 });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "REFUNDED" });
  });

  it("never goes below zero if more comes back than went out", () => {
    const result = resolveCountedAmount({ amountMinor: 100000, refundedMinor: 120000 });
    assert.equal(result.countedAmountMinor, 0);
  });

  it("takes the refund off the user's share of a split bill", () => {
    const result = resolveCountedAmount({
      amountMinor: 120000,
      split: { myShareMinor: 40000 },
      refundedMinor: 10000,
    });
    assert.deepEqual(result, { countedAmountMinor: 30000, countedReason: "REFUNDED" });
  });

  it("still counts a transfer as a transfer", () => {
    const result = resolveCountedAmount({ amountMinor: 100000, isTransfer: true, refundedMinor: 40000 });
    assert.equal(result.countedReason, "TRANSFER");
  });
});

describe("linking a refund to its purchase", () => {
  /** What POST /transactions/:id/refund-of does, applied directly. */
  async function link(refundId: Types.ObjectId, purchaseId: Types.ObjectId | null, userId: Types.ObjectId) {
    const refund = await Transaction.findById(refundId).orFail();
    const previous = refund.refundOfId;
    refund.refundOfId = purchaseId;
    await refund.save();

    for (const target of [previous, purchaseId]) {
      if (!target) continue;
      const purchaseDoc = await Transaction.findOne({ _id: target, userId });
      if (!purchaseDoc) continue;
      const refunds = await Transaction.find({ userId, refundOfId: purchaseDoc._id });
      purchaseDoc.refundedMinor = refunds.reduce((sum, r) => sum + r.amountMinor, 0);
      await purchaseDoc.save();
    }
  }

  async function credit(userId: Types.ObjectId, amountMinor: number) {
    return Transaction.create({
      userId,
      amountMinor,
      currency: "INR",
      type: "CREDIT",
      merchant: "Myntra refund",
      source: "SMS",
      occurredAt: new Date("2026-09-08T12:00:00Z"),
    });
  }

  it("shows the loss on the purchase once a partial refund lands", async () => {
    const userId = await makeUser();
    const bought = await purchase(userId, 100000);
    const back = await credit(userId, 85000);

    await link(back._id, bought._id, userId);

    const stored = await Transaction.findById(bought._id).orFail();
    assert.equal(stored.refundedMinor, 85000);
    assert.equal(stored.countedAmountMinor, 15000, "₹150 of tax never came back");
    assert.equal(stored.countedReason, "REFUNDED");

    const storedRefund = await Transaction.findById(back._id).orFail();
    assert.equal(storedRefund.countedAmountMinor, 0, "the credit is not income");
  });

  it("adds up several refunds against the same purchase", async () => {
    const userId = await makeUser();
    const bought = await purchase(userId, 100000);

    // An order returned in two parcels, refunded separately.
    for (const amount of [40000, 45000]) {
      const back = await credit(userId, amount);
      await link(back._id, bought._id, userId);
    }

    const stored = await Transaction.findById(bought._id).orFail();
    assert.equal(stored.refundedMinor, 85000);
    assert.equal(stored.countedAmountMinor, 15000);
  });

  it("puts the purchase back to full cost when the link is removed", async () => {
    const userId = await makeUser();
    const bought = await purchase(userId, 100000);
    const back = await credit(userId, 85000);

    await link(back._id, bought._id, userId);
    await link(back._id, null, userId);

    const stored = await Transaction.findById(bought._id).orFail();
    assert.equal(stored.refundedMinor, 0);
    assert.equal(stored.countedAmountMinor, 100000);
    assert.equal(stored.countedReason, "FULL");
  });

  it("moves the amount across when a refund is pointed at a different purchase", async () => {
    const userId = await makeUser();
    const [first, second] = await Promise.all([purchase(userId, 100000), purchase(userId, 90000)]);
    const back = await credit(userId, 50000);

    await link(back._id, first._id, userId);
    await link(back._id, second._id, userId);

    assert.equal((await Transaction.findById(first._id).orFail()).refundedMinor, 0);
    assert.equal((await Transaction.findById(second._id).orFail()).refundedMinor, 50000);
  });

  it("keeps a refunded purchase out of the month's spending beyond its real cost", async () => {
    const userId = await makeUser();
    const bought = await purchase(userId, 100000);
    const back = await credit(userId, 85000);
    await link(back._id, bought._id, userId);

    const [totals] = await Transaction.aggregate<{ spend: number; income: number }>([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          spend: { $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, "$countedAmountMinor", 0] } },
          income: { $sum: { $cond: [{ $eq: ["$type", "CREDIT"] }, "$countedAmountMinor", 0] } },
        },
      },
    ]);

    assert.equal(totals.spend, 15000);
    assert.equal(totals.income, 0);
  });
});
