import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Transaction, User } from "./index";

// The rule itself is covered by counted.test.ts. What this checks is that
// it actually runs on every path that writes a transaction — the failure
// mode being a row whose stored counted amount silently disagrees with the
// rule, which no amount of typechecking would catch.
let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_counted_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Transaction.deleteMany({}), User.deleteMany({})]);
});

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `u${Date.now()}@example.com`, name: "Test" });
  return user._id;
}

function baseTransaction(userId: Types.ObjectId) {
  return {
    userId,
    amountMinor: 45000,
    currency: "INR",
    type: "DEBIT" as const,
    source: "MANUAL" as const,
    occurredAt: new Date("2026-09-01T10:00:00Z"),
  };
}

describe("counted amount is maintained on every write path", () => {
  it("is set on create", async () => {
    const userId = await makeUser();
    const created = await Transaction.create(baseTransaction(userId));

    assert.equal(created.countedAmountMinor, 45000);
    assert.equal(created.countedReason, "FULL");
  });

  it("is zero on create when the row is already a transfer", async () => {
    const userId = await makeUser();
    const created = await Transaction.create({ ...baseTransaction(userId), isTransfer: true });

    assert.equal(created.countedAmountMinor, 0);
    assert.equal(created.countedReason, "TRANSFER");
  });

  it("follows a changed amount through findOneAndUpdate", async () => {
    const userId = await makeUser();
    const created = await Transaction.create(baseTransaction(userId));

    const updated = await Transaction.findOneAndUpdate(
      { _id: created._id },
      { $set: { amountMinor: 79500 } },
      { new: true }
    );

    assert.equal(updated?.countedAmountMinor, 79500);
    assert.equal(updated?.countedReason, "FULL");
  });

  it("recomputes when an update only mentions isTransfer", async () => {
    const userId = await makeUser();
    const created = await Transaction.create(baseTransaction(userId));

    // The rule depends on amountMinor, which this update never names — so
    // it has to be read from the stored document rather than the update.
    const updated = await Transaction.findOneAndUpdate(
      { _id: created._id },
      { $set: { isTransfer: true } },
      { new: true }
    );

    assert.equal(updated?.countedAmountMinor, 0);
    assert.equal(updated?.countedReason, "TRANSFER");
  });

  it("goes back to counting in full when a transfer flag is cleared", async () => {
    const userId = await makeUser();
    const created = await Transaction.create({ ...baseTransaction(userId), isTransfer: true });

    const updated = await Transaction.findOneAndUpdate(
      { _id: created._id },
      { $set: { isTransfer: false } },
      { new: true }
    );

    assert.equal(updated?.countedAmountMinor, 45000);
    assert.equal(updated?.countedReason, "FULL");
  });

  it("is recomputed by save() after a field is reassigned", async () => {
    const userId = await makeUser();
    const created = await Transaction.create(baseTransaction(userId));

    created.isTransfer = true;
    await created.save();

    const reloaded = await Transaction.findById(created._id);
    assert.equal(reloaded?.countedAmountMinor, 0);
    assert.equal(reloaded?.countedReason, "TRANSFER");
  });

  it("leaves totals summable without a transfer filter", async () => {
    const userId = await makeUser();
    await Transaction.create(baseTransaction(userId));
    await Transaction.create({ ...baseTransaction(userId), amountMinor: 500000, isTransfer: true });

    const [total] = await Transaction.aggregate<{ counted: number; raw: number }>([
      { $match: { userId, type: "DEBIT" } },
      {
        $group: {
          _id: null,
          counted: { $sum: "$countedAmountMinor" },
          raw: { $sum: "$amountMinor" },
        },
      },
    ]);

    assert.equal(total.counted, 45000, "the transfer must not reach the total");
    assert.equal(total.raw, 545000, "and the underlying amounts are untouched");
  });
});
