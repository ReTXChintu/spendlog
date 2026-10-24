import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Account, Category, Transaction, User } from "../models";
import { ingestRawMessage } from "./ingest";
import { splitMergedPayments } from "../modules/transactions/transactions.referenceSplit";
import { redateFromMessages } from "../modules/transactions/transactions.statedTime";

// Messages and their times as the user's phone and mailbox delivered them.
let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_references_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Transaction.deleteMany({}), Account.deleteMany({}), Category.deleteMany({}), User.deleteMany({})]);
});

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `r${Date.now()}${Math.random()}@example.com`, name: "Test", ledgerFrom: "2026-01" });
  return user._id;
}

const ist = (wall: string) => new Date(`${wall}+05:30`);

const hdfcSms = (ref: string) =>
  `Credit Alert! Rs.350.00 credited to HDFC Bank A/c XX8342 on 23-10-26 from VPA *22-2@okicici (UPI ${ref}) `;
const HDFC_EMAIL =
  "Dear Customer, Greetings from HDFC Bank! We&#39;re writing to inform you that Rs.350.00 has been successfully " +
  "credited to your HDFC Bank account ending in 8342. Transaction Details: a. Date: 23-10-26 b";

type Message = { rawText: string; source: "SMS" | "EMAIL"; sourceRef: string; receivedAt: Date; detailText?: string };

async function deliver(userId: Types.ObjectId, messages: Message[]) {
  for (const message of messages) await ingestRawMessage({ userId, ...message });
}

describe("two payments alike in everything but their reference", () => {
  it("keeps two Rs 350 credits apart, each with its SMS twice and its email", async () => {
    const userId = await makeUser();
    // The real arrival order: the first email before its SMS, each SMS
    // delivered twice, the second payment's messages interleaved.
    await deliver(userId, [
      { rawText: HDFC_EMAIL, source: "EMAIL", sourceRef: "mail-1", receivedAt: ist("2026-10-23T11:12:50") },
      { rawText: hdfcSms("666285487168"), source: "SMS", sourceRef: "VM-1", receivedAt: ist("2026-10-23T11:12:52") },
      { rawText: hdfcSms("666291491063"), source: "SMS", sourceRef: "AD-1", receivedAt: ist("2026-10-23T11:25:37") },
      { rawText: hdfcSms("666285487168"), source: "SMS", sourceRef: "VM-2", receivedAt: ist("2026-10-23T11:12:53") },
      { rawText: HDFC_EMAIL, source: "EMAIL", sourceRef: "mail-2", receivedAt: ist("2026-10-23T11:25:37") },
      { rawText: hdfcSms("666291491063"), source: "SMS", sourceRef: "AD-2", receivedAt: ist("2026-10-23T11:25:41") },
    ]);

    const rows = await Transaction.find({ userId }).sort({ occurredAt: 1 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.sources.length), [3, 3]);
    assert.deepEqual(rows.map((row) => row.reference), ["666285487168", "666291491063"]);
    assert.deepEqual(rows[0].sources.map((entry) => entry.sourceRef).sort(), ["VM-1", "VM-2", "mail-1"]);
    assert.deepEqual(rows[1].sources.map((entry) => entry.sourceRef).sort(), ["AD-1", "AD-2", "mail-2"]);
  });

  it("joins an SMS and the email that quotes the same reference 40 minutes later", async () => {
    const userId = await makeUser();
    await deliver(userId, [
      { rawText: hdfcSms("666285487168"), source: "SMS", sourceRef: "sms", receivedAt: ist("2026-10-23T10:00:00") },
      {
        rawText: HDFC_EMAIL,
        source: "EMAIL",
        sourceRef: "mail",
        receivedAt: ist("2026-10-23T10:40:00"),
        detailText: `${HDFC_EMAIL}. Amount: Rs.350.00 c. UPI Reference Number: 666285487168 d. From VPA`,
      },
    ]);
    const rows = await Transaction.find({ userId });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sources.length, 2);
  });
});

describe("the time a message says the money moved", () => {
  const jupiter = (when: string, ref: string) =>
    `Rs.172.00 debited to your Edge CSB Bank RuPay Credit Card ending 6623 on 10/23/26, ${when} - (UPI Ref no.${ref}).`;

  it("stores the stated time, not the late arrival", async () => {
    const userId = await makeUser();
    const result = await ingestRawMessage({
      userId,
      rawText: jupiter("1:39 AM", "629632671192"),
      source: "SMS",
      sourceRef: null,
      receivedAt: ist("2026-10-23T05:15:00"),
    });
    assert.deepEqual(result.transaction?.occurredAt, ist("2026-10-23T01:39:00"));
    assert.deepEqual(result.transaction?.sources[0].receivedAt, ist("2026-10-23T05:15:00"));
  });

  it("keeps two payments apart when their texts state different times, however close they arrived", async () => {
    const userId = await makeUser();
    const text = (when: string) => `Rs 20.00 debited from A/c XX5130 on 23-10-26 ${when} via UPI to SHOP`;
    await deliver(userId, [
      { rawText: text("01:39"), source: "SMS", sourceRef: "a", receivedAt: ist("2026-10-23T05:15:00") },
      { rawText: text("03:10"), source: "SMS", sourceRef: "b", receivedAt: ist("2026-10-23T05:15:02") },
    ]);
    assert.equal(await Transaction.countDocuments({ userId }), 2);
  });

  it("pairs a late SMS stating its time with an email that states none, by when they arrived", async () => {
    const userId = await makeUser();
    await deliver(userId, [
      { rawText: "Rs 20.00 debited from A/c XX5130 on 23-10-26 01:39 via UPI to SHOP", source: "SMS", sourceRef: "s", receivedAt: ist("2026-10-23T05:15:00") },
      { rawText: "Dear Customer, Rs.20.00 has been debited from account XX5130 to SHOP", source: "EMAIL", sourceRef: "e", receivedAt: ist("2026-10-23T05:16:00") },
    ]);
    const rows = await Transaction.find({ userId });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].occurredAt, ist("2026-10-23T01:39:00"));
  });
});

describe("repairs for rows stored before", () => {
  it("splits a row two payments were merged into, keeping what the user gave it", async () => {
    const userId = await makeUser();
    const category = await Category.create({ userId, name: "Friends", type: "INCOME", color: "#000", icon: "people" });
    const entry = (rawText: string, source: "SMS" | "EMAIL", sourceRef: string, wall: string) => ({
      rawText,
      source,
      sourceRef,
      receivedAt: ist(wall),
    });
    const merged = await Transaction.create({
      userId,
      amountMinor: 35000,
      type: "CREDIT",
      source: "SMS",
      rawText: hdfcSms("666285487168"),
      occurredAt: ist("2026-10-23T11:12:52"),
      categoryId: category._id,
      note: "Rent share",
      editedAt: ist("2026-10-24T22:43:04"),
      sources: [
        entry(hdfcSms("666285487168"), "SMS", "VM-1", "2026-10-23T11:12:52"),
        entry(HDFC_EMAIL, "EMAIL", "mail-1", "2026-10-23T11:12:50"),
        entry(hdfcSms("666291491063"), "SMS", "AD-1", "2026-10-23T11:25:37"),
        entry(HDFC_EMAIL, "EMAIL", "mail-2", "2026-10-23T11:25:37"),
        entry(hdfcSms("666291491063"), "SMS", "AD-2", "2026-10-23T11:25:41"),
        entry(hdfcSms("666285487168"), "SMS", "VM-2", "2026-10-23T11:12:53"),
      ],
    });

    assert.equal(await splitMergedPayments(userId), 1);
    const rows = await Transaction.find({ userId }).sort({ occurredAt: 1 });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.sources.length), [3, 3]);
    assert.equal(rows[0].id, merged.id);
    assert.deepEqual(rows[0].occurredAt, ist("2026-10-23T11:12:52"), "a time set by hand stays");
    assert.deepEqual(rows[1].occurredAt, ist("2026-10-23T11:25:37"));
    assert.deepEqual(rows.map((row) => row.reference), ["666285487168", "666291491063"]);
    for (const row of rows) {
      assert.equal(String(row.categoryId), String(category._id));
      assert.equal(row.note, "Rent share");
      assert.equal(row.countedAmountMinor, 35000);
    }
    // Run twice, nothing more happens.
    assert.equal(await splitMergedPayments(userId), 0);
    assert.equal(await Transaction.countDocuments({ userId }), 2);
  });

  it("writes references onto rows that never had them", async () => {
    const userId = await makeUser();
    const row = await Transaction.create({
      userId,
      amountMinor: 35000,
      type: "CREDIT",
      source: "SMS",
      occurredAt: ist("2026-10-23T11:12:52"),
      sources: [{ source: "SMS", rawText: hdfcSms("666285487168"), receivedAt: ist("2026-10-23T11:12:52") }],
    });
    await splitMergedPayments(userId);
    const after = await Transaction.findById(row._id).orFail();
    assert.equal(after.reference, "666285487168");
    assert.equal(after.referenceKind, "RRN");
    assert.equal(after.sources[0].reference, "666285487168");
  });

  it("moves rows to the time their message states, leaving edited ones alone", async () => {
    const userId = await makeUser();
    const text = "Rs.172.00 debited to your Edge CSB Bank RuPay Credit Card ending 6623 on 10/23/26, 1:39 AM - (UPI Ref no.629632671192).";
    const arrived = ist("2026-10-23T05:15:00");
    const base = { userId, amountMinor: 17200, type: "DEBIT" as const, source: "SMS" as const, rawText: text, occurredAt: arrived };
    const plain = await Transaction.create({ ...base, sources: [{ source: "SMS", rawText: text, receivedAt: arrived }] });
    const edited = await Transaction.create({
      ...base,
      editedAt: new Date(),
      sources: [{ source: "SMS", rawText: text, receivedAt: arrived }],
    });

    assert.equal(await redateFromMessages(userId), 1);
    assert.deepEqual((await Transaction.findById(plain._id).orFail()).occurredAt, ist("2026-10-23T01:39:00"));
    assert.deepEqual((await Transaction.findById(edited._id).orFail()).occurredAt, arrived);
    assert.equal(await redateFromMessages(userId), 0, "a second pass changes nothing");
  });
});
