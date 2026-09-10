import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Transaction, User } from "../models";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_split_test"));
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

function bill(userId: Types.ObjectId, overrides: Record<string, unknown> = {}) {
  return {
    userId,
    amountMinor: 120000,
    currency: "INR",
    type: "DEBIT" as const,
    source: "MANUAL" as const,
    occurredAt: new Date("2026-09-01T19:00:00Z"),
    ...overrides,
  };
}

/**
 * The balance the /analytics/owed endpoint reports, computed the same way.
 * Kept here rather than imported so the arithmetic is asserted directly
 * against stored rows.
 */
async function owedBalance(userId: Types.ObjectId): Promise<number> {
  const splits = await Transaction.find({ userId, "split.myShareMinor": { $ne: null }, type: "DEBIT" });
  const lent = splits.reduce((sum, t) => sum + (t.amountMinor - (t.split?.myShareMinor ?? 0)), 0);

  const settlements = await Transaction.find({ userId, isSettlement: true });
  const received = settlements.filter((t) => t.type === "CREDIT").reduce((s, t) => s + t.amountMinor, 0);
  const paid = settlements.filter((t) => t.type === "DEBIT").reduce((s, t) => s + t.amountMinor, 0);

  return lent - received + paid;
}

describe("splitting a bill", () => {
  it("counts only the user's share as spending", async () => {
    const userId = await makeUser();
    const created = await Transaction.create(bill(userId, { split: { myShareMinor: 40000 } }));

    assert.equal(created.countedAmountMinor, 40000);
    assert.equal(created.countedReason, "SPLIT");
    assert.equal(created.amountMinor, 120000, "what the bank moved is untouched");
  });

  it("counts nothing when the whole bill was someone else's", async () => {
    const userId = await makeUser();
    const created = await Transaction.create(bill(userId, { split: { myShareMinor: 0 } }));

    assert.equal(created.countedAmountMinor, 0);
    assert.equal(created.countedReason, "SPLIT");
  });

  it("goes back to counting in full when the split is removed", async () => {
    const userId = await makeUser();
    const created = await Transaction.create(bill(userId, { split: { myShareMinor: 40000 } }));

    const updated = await Transaction.findOneAndUpdate(
      { _id: created._id },
      { $set: { split: null } },
      { new: true }
    );

    assert.equal(updated?.countedAmountMinor, 120000);
    assert.equal(updated?.countedReason, "FULL");
  });

  it("leaves the rest of the bill owed to the user", async () => {
    const userId = await makeUser();
    await Transaction.create(bill(userId, { split: { myShareMinor: 40000 } }));

    assert.equal(await owedBalance(userId), 80000);
  });
});

describe("settling up", () => {
  it("counts a repayment as neither income nor spending", async () => {
    const userId = await makeUser();
    const created = await Transaction.create(
      bill(userId, { type: "CREDIT", amountMinor: 80000, isSettlement: true })
    );

    assert.equal(created.countedAmountMinor, 0);
    assert.equal(created.countedReason, "SETTLEMENT");
  });

  it("clears the balance when the money comes back", async () => {
    const userId = await makeUser();
    await Transaction.create(bill(userId, { split: { myShareMinor: 40000 } }));
    await Transaction.create(bill(userId, { type: "CREDIT", amountMinor: 80000, isSettlement: true }));

    assert.equal(await owedBalance(userId), 0);
  });

  it("moves the balance the other way when the user pays someone back", async () => {
    const userId = await makeUser();
    // Nothing lent, and a payment out: the user owed, and has now settled.
    await Transaction.create(bill(userId, { amountMinor: 50000, isSettlement: true }));

    assert.equal(await owedBalance(userId), 50000);
  });

  it("nets several months of splits and settlements", async () => {
    const userId = await makeUser();
    await Transaction.create(bill(userId, { amountMinor: 120000, split: { myShareMinor: 40000 } })); // +80000
    await Transaction.create(bill(userId, { amountMinor: 60000, split: { myShareMinor: 20000 } })); // +40000
    await Transaction.create(bill(userId, { type: "CREDIT", amountMinor: 90000, isSettlement: true })); // -90000

    assert.equal(await owedBalance(userId), 30000);
  });

  it("keeps a settlement out of the month's totals", async () => {
    const userId = await makeUser();
    await Transaction.create(bill(userId, { amountMinor: 30000 }));
    await Transaction.create(bill(userId, { type: "CREDIT", amountMinor: 80000, isSettlement: true }));

    const [totals] = await Transaction.aggregate<{ spend: number; income: number }>([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          spend: {
            $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, "$countedAmountMinor", 0] },
          },
          income: {
            $sum: { $cond: [{ $eq: ["$type", "CREDIT"] }, "$countedAmountMinor", 0] },
          },
        },
      },
    ]);

    assert.equal(totals.spend, 30000);
    assert.equal(totals.income, 0, "money back from a friend is not income");
  });
});
