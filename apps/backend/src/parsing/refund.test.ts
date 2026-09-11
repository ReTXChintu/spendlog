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
    const result = resolveCountedAmount({
      amountMinor: 85000,
      refundOf: [{ amountMinor: 85000 }],
    });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "REFUND" });
  });

  it("still counts the part of a credit that was not a refund", () => {
    // ₹1,000 in, of which ₹800 settles two cancelled orders. The rest is
    // ordinary income and should say so.
    const result = resolveCountedAmount({
      amountMinor: 100000,
      refundOf: [{ amountMinor: 50000 }, { amountMinor: 30000 }],
    });
    assert.deepEqual(result, { countedAmountMinor: 20000, countedReason: "REFUND" });
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
  async function link(
    refundId: Types.ObjectId,
    allocations: { transactionId: Types.ObjectId; amountMinor: number }[],
    userId: Types.ObjectId
  ) {
    const refund = await Transaction.findById(refundId).orFail();
    const previous = refund.refundOf.map((a) => a.transactionId);
    refund.refundOf = allocations;
    await refund.save();

    const touched = new Set(
      [...previous, ...allocations.map((a) => a.transactionId)].map(String)
    );
    for (const id of touched) {
      const purchaseDoc = await Transaction.findOne({ _id: id, userId });
      if (!purchaseDoc) continue;
      const credits = await Transaction.find({ userId, "refundOf.transactionId": purchaseDoc._id });
      purchaseDoc.refundedMinor = credits.reduce(
        (sum, credit) =>
          sum +
          credit.refundOf
            .filter((a) => a.transactionId.equals(purchaseDoc._id))
            .reduce((inner, a) => inner + a.amountMinor, 0),
        0
      );
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

    await link(back._id, [{ transactionId: bought._id, amountMinor: back.amountMinor }], userId);

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
      await link(back._id, [{ transactionId: bought._id, amountMinor: back.amountMinor }], userId);
    }

    const stored = await Transaction.findById(bought._id).orFail();
    assert.equal(stored.refundedMinor, 85000);
    assert.equal(stored.countedAmountMinor, 15000);
  });

  it("puts the purchase back to full cost when the link is removed", async () => {
    const userId = await makeUser();
    const bought = await purchase(userId, 100000);
    const back = await credit(userId, 85000);

    await link(back._id, [{ transactionId: bought._id, amountMinor: back.amountMinor }], userId);
    await link(back._id, [], userId);

    const stored = await Transaction.findById(bought._id).orFail();
    assert.equal(stored.refundedMinor, 0);
    assert.equal(stored.countedAmountMinor, 100000);
    assert.equal(stored.countedReason, "FULL");
  });

  it("moves the amount across when a refund is pointed at a different purchase", async () => {
    const userId = await makeUser();
    const [first, second] = await Promise.all([purchase(userId, 100000), purchase(userId, 90000)]);
    const back = await credit(userId, 50000);

    await link(back._id, [{ transactionId: first._id, amountMinor: 50000 }], userId);
    await link(back._id, [{ transactionId: second._id, amountMinor: 50000 }], userId);

    assert.equal((await Transaction.findById(first._id).orFail()).refundedMinor, 0);
    assert.equal((await Transaction.findById(second._id).orFail()).refundedMinor, 50000);
  });

  it("spreads one credit across several purchases", async () => {
    const userId = await makeUser();
    const [a, b, c] = await Promise.all([
      purchase(userId, 40000),
      purchase(userId, 30000),
      purchase(userId, 25000),
    ]);
    // Three orders cancelled together, refunded as one credit — and short
    // of the full ₹950, because the delivery on each was kept.
    const back = await credit(userId, 85000);

    await link(
      back._id,
      [
        { transactionId: a._id, amountMinor: 35000 },
        { transactionId: b._id, amountMinor: 27000 },
        { transactionId: c._id, amountMinor: 23000 },
      ],
      userId
    );

    assert.equal((await Transaction.findById(a._id).orFail()).countedAmountMinor, 5000);
    assert.equal((await Transaction.findById(b._id).orFail()).countedAmountMinor, 3000);
    assert.equal((await Transaction.findById(c._id).orFail()).countedAmountMinor, 2000);
    assert.equal((await Transaction.findById(back._id).orFail()).countedAmountMinor, 0);
  });

  it("keeps a refunded purchase out of the month's spending beyond its real cost", async () => {
    const userId = await makeUser();
    const bought = await purchase(userId, 100000);
    const back = await credit(userId, 85000);
    await link(back._id, [{ transactionId: bought._id, amountMinor: back.amountMinor }], userId);

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
