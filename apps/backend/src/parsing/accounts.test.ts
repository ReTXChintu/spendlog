import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Account, User } from "../models";
import { resolveAccount } from "./accounts";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_accounts_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Account.deleteMany({}), User.deleteMany({})]);
});

// A counter, not a timestamp: two users created in the same millisecond
// would collide on the unique email index.
let userCount = 0;

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `u${(userCount += 1)}@example.com`, name: "Test" });
  return user._id;
}

const HDFC_SMS = { bankName: "HDFC Bank", last4: "1377", accountType: "CARD" as const };
const HDFC_EMAIL = { bankName: "HDFC", last4: "1377", accountType: "CARD" as const };

describe("resolveAccount", () => {
  it("creates one account for a newly seen handle", async () => {
    const userId = await makeUser();
    const id = await resolveAccount(userId, HDFC_SMS);

    assert.ok(id);
    assert.equal(await Account.countDocuments({ userId }), 1);
  });

  it("returns the same account for a repeated handle", async () => {
    const userId = await makeUser();
    const first = await resolveAccount(userId, HDFC_SMS);
    const second = await resolveAccount(userId, HDFC_SMS);

    assert.equal(first?.toString(), second?.toString());
    assert.equal(await Account.countDocuments({ userId }), 1);
  });

  it("treats a different spelling as a different account until they are merged", async () => {
    const userId = await makeUser();
    await resolveAccount(userId, HDFC_SMS);
    await resolveAccount(userId, HDFC_EMAIL);

    assert.equal(await Account.countDocuments({ userId }), 2);
  });

  it("resolves an alias to the account that absorbed it", async () => {
    const userId = await makeUser();
    const survivorId = await resolveAccount(userId, HDFC_SMS);

    // What POST /accounts/:id/merge leaves behind.
    await Account.updateOne({ _id: survivorId }, { $push: { aliases: HDFC_EMAIL } });

    const resolved = await resolveAccount(userId, HDFC_EMAIL);

    assert.equal(resolved?.toString(), survivorId?.toString());
    assert.equal(await Account.countDocuments({ userId }), 1, "the merged account must not come back");
  });

  it("keeps one user's accounts out of another's", async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const forA = await resolveAccount(a, HDFC_SMS);
    const forB = await resolveAccount(b, HDFC_SMS);

    assert.notEqual(forA?.toString(), forB?.toString());
  });

  it("tells a card apart from a bank account with the same last four", async () => {
    const userId = await makeUser();
    await resolveAccount(userId, { bankName: "HDFC Bank", last4: "1377", accountType: "CARD" });
    await resolveAccount(userId, { bankName: "HDFC Bank", last4: "1377", accountType: "BANK" });

    assert.equal(await Account.countDocuments({ userId }), 2);
  });

  it("survives two messages for a new account arriving at once", async () => {
    // The foreground listener and the background isolate can both post.
    const userId = await makeUser();
    const ids = await Promise.all([
      resolveAccount(userId, HDFC_SMS),
      resolveAccount(userId, HDFC_SMS),
      resolveAccount(userId, HDFC_SMS),
    ]);

    assert.equal(await Account.countDocuments({ userId }), 1);
    assert.equal(new Set(ids.map((id) => id?.toString())).size, 1);
  });

  it("returns nothing when the message revealed no account", async () => {
    const userId = await makeUser();
    assert.equal(await resolveAccount(userId, null), null);
  });
});
