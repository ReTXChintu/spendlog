import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Account, Category, CategoryRule, Transaction, User } from "../models";
import { ingestRawMessage } from "./ingest";

// Exercises the query layer against a real MongoDB, which typechecking
// alone can't validate — populate paths, upsert semantics, index
// constraints and `id` serialization all only fail at runtime.
let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Transaction.deleteMany({}),
    Account.deleteMany({}),
    Category.deleteMany({}),
    CategoryRule.deleteMany({}),
    User.deleteMany({}),
  ]);
});

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `u${Date.now()}@example.com`, name: "Test" });
  return user._id;
}

const HDFC_CARD_SMS =
  "Txn Rs.105.00\nOn HDFC Bank Card 1377\nAt paytmqr6g6fjc@ptys \nby UPI 661266604357\nOn 03-09\nNot You?\nCall 18002586161/SMS BLOCK CC 1377 to 7308080808";
const SWIGGY_SMS = "Rs 349 debited from A/c XX9876 on 15-08-26 to VPA swiggy@icici Ref 4433221100 -Axis Bank";

describe("ingestion pipeline (real MongoDB)", () => {
  it("stores a parsed transaction with its resolved account", async () => {
    const userId = await makeUser();

    const result = await ingestRawMessage({
      userId,
      rawText: HDFC_CARD_SMS,
      source: "SMS",
      sourceRef: null,
      receivedAt: new Date(),
    });

    assert.equal(result.status, "created");
    assert.equal(result.transaction?.amountMinor, 10500);
    assert.equal(result.transaction?.merchant, "paytmqr6g6fjc@ptys");

    const account = await Account.findById(result.transaction!.accountId).orFail();
    assert.equal(account.bankName, "HDFC Bank");
    assert.equal(account.last4, "1377");
    assert.equal(account.accountType, "CARD");
  });

  it("reuses the same Account for repeat messages instead of duplicating it", async () => {
    const userId = await makeUser();
    const base = { userId, source: "SMS" as const, sourceRef: null };

    await ingestRawMessage({ ...base, rawText: HDFC_CARD_SMS, receivedAt: new Date("2026-09-03T10:00:00Z") });
    await ingestRawMessage({ ...base, rawText: HDFC_CARD_SMS, receivedAt: new Date("2026-09-04T10:00:00Z") });

    assert.equal(await Account.countDocuments({ userId }), 1);
    assert.equal(await Transaction.countDocuments({ userId }), 2);
  });

  it("treats the same transaction arriving by SMS and email as one", async () => {
    const userId = await makeUser();
    const receivedAt = new Date("2026-09-03T10:00:00Z");

    const first = await ingestRawMessage({
      userId,
      rawText: HDFC_CARD_SMS,
      source: "SMS",
      sourceRef: null,
      receivedAt,
    });
    const second = await ingestRawMessage({
      userId,
      rawText: HDFC_CARD_SMS,
      source: "EMAIL",
      sourceRef: "gmail-123",
      // A few minutes later, as the email alert typically arrives.
      receivedAt: new Date(receivedAt.getTime() + 5 * 60 * 1000),
    });

    assert.equal(first.status, "created");
    assert.equal(second.status, "duplicate");
    assert.equal(await Transaction.countDocuments({ userId }), 1);
  });

  it("keeps one user's transactions out of another's", async () => {
    const [userA, userB] = [await makeUser(), await makeUser()];

    await ingestRawMessage({
      userId: userA,
      rawText: HDFC_CARD_SMS,
      source: "SMS",
      sourceRef: null,
      receivedAt: new Date(),
    });

    assert.equal(await Transaction.countDocuments({ userId: userA }), 1);
    assert.equal(await Transaction.countDocuments({ userId: userB }), 0);
  });

  it("auto-categorizes using a matching rule", async () => {
    const userId = await makeUser();
    const food = await Category.create({ name: "Food & Dining", isSystem: true, userId: null });
    await CategoryRule.create({
      userId: null,
      categoryId: food._id,
      matchType: "MERCHANT_CONTAINS",
      pattern: "swiggy",
      priority: 0,
    });

    const result = await ingestRawMessage({
      userId,
      rawText: SWIGGY_SMS,
      source: "SMS",
      sourceRef: null,
      receivedAt: new Date(),
    });

    assert.equal(result.status, "created");
    assert.ok(result.transaction?.categoryId?.equals(food._id), "should be categorized as Food & Dining");
  });

  it("prefers a user's own rule over a system default", async () => {
    const userId = await makeUser();
    const [system, custom] = await Promise.all([
      Category.create({ name: "Food & Dining", isSystem: true, userId: null }),
      Category.create({ name: "Team Lunches", isSystem: false, userId }),
    ]);
    await CategoryRule.create({
      userId: null,
      categoryId: system._id,
      matchType: "MERCHANT_CONTAINS",
      pattern: "swiggy",
    });
    await CategoryRule.create({
      userId,
      categoryId: custom._id,
      matchType: "MERCHANT_CONTAINS",
      pattern: "swiggy",
    });

    const result = await ingestRawMessage({
      userId,
      rawText: SWIGGY_SMS,
      source: "SMS",
      sourceRef: null,
      receivedAt: new Date(),
    });

    assert.ok(result.transaction?.categoryId?.equals(custom._id), "the user's own rule should win");
  });

  it("ignores a message that isn't a transaction", async () => {
    const userId = await makeUser();

    const result = await ingestRawMessage({
      userId,
      rawText: "123456 is your OTP for transaction of Rs.5000 at Amazon. Do not share with anyone.",
      source: "SMS",
      sourceRef: null,
      receivedAt: new Date(),
    });

    assert.equal(result.status, "ignored");
    assert.equal(await Transaction.countDocuments({ userId }), 0);
  });

  it("flags both sides of a self-transfer between the user's own accounts", async () => {
    const userId = await makeUser();
    const at = new Date("2026-09-03T10:00:00Z");

    await ingestRawMessage({
      userId,
      rawText: "Rs.5000 debited from A/c XX1111 on 03-09-26 to self. -HDFC Bank",
      source: "SMS",
      sourceRef: null,
      receivedAt: at,
    });
    await ingestRawMessage({
      userId,
      rawText: "Rs.5000 credited to A/c XX2222 on 03-09-26 from self. -ICICI Bank",
      source: "SMS",
      sourceRef: null,
      receivedAt: new Date(at.getTime() + 60 * 1000),
    });

    const transactions = await Transaction.find({ userId });
    assert.equal(transactions.length, 2);
    assert.ok(
      transactions.every((t) => t.isTransfer),
      "both legs should be flagged as a transfer"
    );
  });
});

describe("serialization contract", () => {
  it("exposes `id` and populated `category`/`account`, not `_id`", async () => {
    const userId = await makeUser();
    const category = await Category.create({ name: "Shopping", isSystem: true, userId: null });
    await CategoryRule.create({
      userId: null,
      categoryId: category._id,
      matchType: "MERCHANT_CONTAINS",
      pattern: "paytmqr",
    });

    await ingestRawMessage({
      userId,
      rawText: HDFC_CARD_SMS,
      source: "SMS",
      sourceRef: null,
      receivedAt: new Date(),
    });

    const tx = await Transaction.findOne({ userId }).populate("category").populate("account").orFail();
    // This is exactly what the API hands the web and mobile clients.
    const json = JSON.parse(JSON.stringify(tx)) as Record<string, any>;

    assert.equal(typeof json.id, "string", "clients read `id`");
    assert.equal(json._id, undefined, "`_id` should not leak");
    assert.equal(json.__v, undefined, "version key should not leak");
    assert.equal(json.category.name, "Shopping");
    assert.equal(typeof json.category.id, "string");
    assert.equal(json.account.bankName, "HDFC Bank");
    assert.equal(json.account.last4, "1377");
  });
});
