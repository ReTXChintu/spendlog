import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  // No autoIndex: the old index has to be there first, as on a server
  // that has been running since before plans could lack a purchase.
  await mongoose.connect(mongod.getUri("spendlog_emi_index_test"), { autoIndex: false });
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe("the EMI plan index, on a database that has the old one", () => {
  it("drops the old unique index, builds the partial one, and is a no-op the second time", async () => {
    const collection = mongoose.connection.collection("emiplans");
    await collection.createIndex({ sourceTransactionId: 1 }, { unique: true, name: "sourceTransactionId_1" });

    const { dropSupersededIndexes } = await import("../../db");
    const { EmiPlan } = await import("../../models");
    await dropSupersededIndexes();
    await dropSupersededIndexes();

    const names = (await collection.indexes()).map((index) => index.name);
    assert.ok(!names.includes("sourceTransactionId_1"), "the old index is gone");
    assert.ok(names.includes("sourceTransactionId_1_converted"), "the partial one is built");

    const base = {
      userId: new Types.ObjectId(),
      principalMinor: 1,
      months: 1,
      monthlyAmountMinor: 1,
      totalPayableMinor: 1,
      startDate: new Date(),
    };
    // Two plans with no purchase no longer collide on null...
    await EmiPlan.create({ ...base, origin: "EXISTING", sourceTransactionId: null });
    await EmiPlan.create({ ...base, origin: "EXISTING", sourceTransactionId: null });
    // ...while the same purchase converted twice still does.
    const purchase = new Types.ObjectId();
    await EmiPlan.create({ ...base, sourceTransactionId: purchase });
    await assert.rejects(EmiPlan.create({ ...base, sourceTransactionId: purchase }), /duplicate key/);
  });
});
