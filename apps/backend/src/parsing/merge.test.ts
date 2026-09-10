import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Account, Category, CategoryRule, Transaction, User } from "../models";
import { ingestRawMessage } from "./ingest";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_merge_test"));
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

let userCount = 0;

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `u${(userCount += 1)}@example.com`, name: "Test" });
  return user._id;
}

// The same payment as the bank reports it twice: a terse SMS first, then an
// email a few minutes later that happens to name the merchant properly.
const SWIGGY_SMS = "Rs 349 debited from A/c XX9876 on 15-08-26 to VPA swiggy@icici Ref 4433221100 -Axis Bank";
const SWIGGY_EMAIL =
  "Dear Customer, Rs 349.00 debited from your Axis Bank A/c XX9876 on 15-08-26 at SWIGGY. Ref 4433221100.";

const AT = new Date("2026-08-15T12:00:00Z");
const FIVE_MINUTES_LATER = new Date("2026-08-15T12:05:00Z");

describe("a transaction reported by more than one message", () => {
  it("keeps both messages rather than discarding the second", async () => {
    const userId = await makeUser();

    await ingestRawMessage({ userId, rawText: SWIGGY_SMS, source: "SMS", sourceRef: "sms-1", receivedAt: AT });
    const second = await ingestRawMessage({
      userId,
      rawText: SWIGGY_EMAIL,
      source: "EMAIL",
      sourceRef: "email-1",
      receivedAt: FIVE_MINUTES_LATER,
    });

    assert.equal(second.status, "duplicate");
    assert.equal(await Transaction.countDocuments({ userId }), 1, "still one transaction");

    const stored = await Transaction.findOne({ userId }).orFail();
    assert.equal(stored.sources.length, 2);
    assert.deepEqual(
      stored.sources.map((s) => s.source),
      ["SMS", "EMAIL"]
    );
    assert.ok(
      stored.sources.some((s) => s.rawText === SWIGGY_EMAIL),
      "the second message's text is kept, not just a note that it arrived"
    );
  });

  it("does not record the same message twice when it is re-sent", async () => {
    const userId = await makeUser();
    const message = { userId, rawText: SWIGGY_SMS, source: "SMS" as const, sourceRef: "sms-1" };

    await ingestRawMessage({ ...message, receivedAt: AT });
    // A manual re-sync posts the whole window again.
    await ingestRawMessage({ ...message, receivedAt: AT });

    const stored = await Transaction.findOne({ userId }).orFail();
    assert.equal(stored.sources.length, 1);
  });

  it("fills a gap the first message left", async () => {
    const userId = await makeUser();

    const first = await ingestRawMessage({
      userId,
      rawText: SWIGGY_SMS,
      source: "SMS",
      sourceRef: "sms-1",
      receivedAt: AT,
    });
    // Blank it, as an unhelpful message would have left it.
    await Transaction.updateOne({ _id: first.transaction!._id }, { $set: { merchant: null } });

    await ingestRawMessage({
      userId,
      rawText: SWIGGY_EMAIL,
      source: "EMAIL",
      sourceRef: "email-1",
      receivedAt: FIVE_MINUTES_LATER,
    });

    const stored = await Transaction.findOne({ userId }).orFail();
    assert.equal(stored.merchant, "SWIGGY", "the second message supplied the merchant the first lacked");
  });

  it("leaves a hand-corrected row alone", async () => {
    const userId = await makeUser();

    const first = await ingestRawMessage({
      userId,
      rawText: SWIGGY_SMS,
      source: "SMS",
      sourceRef: "sms-1",
      receivedAt: AT,
    });
    await Transaction.updateOne(
      { _id: first.transaction!._id },
      { $set: { merchant: null, editedAt: new Date() } }
    );

    await ingestRawMessage({
      userId,
      rawText: SWIGGY_EMAIL,
      source: "EMAIL",
      sourceRef: "email-1",
      receivedAt: FIVE_MINUTES_LATER,
    });

    const stored = await Transaction.findOne({ userId }).orFail();
    assert.equal(stored.merchant, null, "a person cleared this; a later message must not put it back");
    assert.equal(stored.sources.length, 2, "though the message itself is still recorded");
  });

  it("gives a manually created transaction a source of its own", async () => {
    const userId = await makeUser();
    const cash = await Transaction.create({
      userId,
      amountMinor: 5000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: AT,
    });

    assert.equal(cash.sources.length, 1);
    assert.equal(cash.sources[0].source, "MANUAL");
  });
});
