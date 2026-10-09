import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { app } from "../../app";
import { signSessionToken } from "../../middleware/auth";
import { Account, Category, FixedCommitment, Transaction, User } from "../../models";
import { ingestRawMessage } from "../../parsing/ingest";
import { monthlyBudgetStatus, spentInMonth } from "../budget/budget.monthly";
import { extraIncomeMatch } from "../budget/budget.daily";
import { budgetPace } from "../budget/budget.pace";
import { userMonth } from "../budget/budget.months";
import {
  CARD_BILL_BACKFILL,
  CARD_BILL_BACKFILL_VERSION,
  backfillCardBills,
  runCardBillBackfill,
} from "./cards.billPayment.service";

// The whole path a bill payment takes - parsed, filed, recognised, paired
// - against a real MongoDB, ending at the figures the complaint was about:
// the month's spent, and the savings bucket's extra income.
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_card_bills_test"));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Transaction.deleteMany({}),
    Account.deleteMany({}),
    Category.deleteMany({}),
    FixedCommitment.deleteMany({}),
    User.deleteMany({}),
  ]);
});

/** An IST calendar day, as an instant at noon so no boundary is grazed. */
function on(day: string): Date {
  return new Date(`${day}T12:00:00+05:30`);
}

const NOW = on("2026-10-09");
let count = 0;

async function makeUser(fields: Record<string, unknown> = {}): Promise<Types.ObjectId> {
  const user = await User.create({
    email: `bills${(count += 1)}@example.com`,
    ledgerFrom: "2026-01",
    salaryDay: 1,
    monthlyBudgetHistory: [{ fromMonthKey: "2026-10", amountMinor: 50_000_00, categoryLimits: [] }],
    ...fields,
  });
  return user._id;
}

async function makeCard(userId: Types.ObjectId, bankName: string, last4: string) {
  return Account.create({ userId, bankName, last4, accountType: "CARD" });
}

async function sms(userId: Types.ObjectId, rawText: string, day: string) {
  const result = await ingestRawMessage({ userId, rawText, source: "SMS", sourceRef: null, receivedAt: on(day) });
  assert.equal(result.status, "created", rawText);
  return result.transaction!;
}

async function extraIncome(userId: Types.ObjectId): Promise<number> {
  const [row] = await Transaction.aggregate<{ total: number }>([
    { $match: await extraIncomeMatch(userId) },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);
  return row?.total ?? 0;
}

async function spent(userId: Types.ObjectId): Promise<number> {
  return spentInMonth(userId, await userMonth(userId, undefined, NOW));
}

const PURCHASE = "Rs.2,000.00 spent on your HDFC Bank Credit Card XX5678 at AMAZON on 03-10-26.";
const BILL_PAID =
  "Rs.15,000.00 debited from A/c **9876 on 05-10-26 towards HDFC Bank Credit Card XX5678. Avl bal Rs 42,000.00 -HDFC Bank";
const BILL_RECEIVED =
  "DEAR CARDMEMBER, PAYMENT OF RS 15000.00 RECEIVED TOWARDS YOUR HDFC BANK CREDIT CARD ENDING 5678 ON 06/OCT/2026. YOUR AVAILABLE LIMIT IS RS 1,50,000.00";
const CRED_HANDLE =
  "Rs.15000.00 debited from A/c XX9876 on 05-10-26 to VPA cred.club@axisbank (UPI Ref No 627812345678). Not you? Call 18002586161 -HDFC Bank";
const CRED_PLAIN =
  "Your A/C XXXXX9876 Debited INR 15,000.00 on 05/10/26 -Transferred to CRED. Avl Balance INR 40,000.00-SBI";
const ICICI_RECEIVED =
  "Dear Customer, Payment of INR 15,000.00 has been received on your ICICI Bank Credit Card Account 4XXX2009 on 06-Oct-26. Thank you.";

describe("a card bill imported from SMS", () => {
  it("leaves the month's spent alone, and the card's credit is not extra income", async () => {
    const userId = await makeUser();
    const card = await makeCard(userId, "HDFC Bank", "5678");

    await sms(userId, PURCHASE, "2026-10-03");
    assert.equal((await monthlyBudgetStatus(userId, undefined, NOW)).spentMinor, 2_000_00);

    const paid = await sms(userId, BILL_PAID, "2026-10-05");
    assert.equal(paid.cardPaymentFor?.toString(), card._id.toString());
    assert.equal(paid.countedAmountMinor, 0);
    assert.equal(paid.countedReason, "CARD_BILL");

    const received = await sms(userId, BILL_RECEIVED, "2026-10-06");
    assert.equal(received.type, "CREDIT");
    assert.equal(received.countedAmountMinor, 0);

    const status = await monthlyBudgetStatus(userId, undefined, NOW);
    assert.equal(status.spentMinor, 2_000_00);
    assert.equal(await extraIncome(userId), 0);

    // The two sides know each other.
    const [debit, credit] = await Promise.all([Transaction.findById(paid._id), Transaction.findById(received._id)]);
    assert.equal(debit!.transferPairId?.toString(), received._id.toString());
    assert.equal(credit!.transferPairId?.toString(), paid._id.toString());
    assert.equal(credit!.isTransfer, true);
  });

  it("keeps a bill for an unknown card out of spending, and names the card once its credit arrives", async () => {
    const userId = await makeUser();
    await makeCard(userId, "HDFC Bank", "5678");
    const icici = await makeCard(userId, "ICICI Bank", "2009");

    // Through CRED: certainly a card bill, but for which of the two?
    const paid = await sms(userId, CRED_HANDLE, "2026-10-05");
    assert.equal(paid.cardPaymentFor ?? null, null);
    assert.equal(paid.isTransfer, true);
    assert.equal(paid.transferAccountId ?? null, null);
    assert.equal(paid.countedAmountMinor, 0);
    assert.equal(await spent(userId), 0);

    const received = await sms(userId, ICICI_RECEIVED, "2026-10-06");
    const debit = await Transaction.findById(paid._id).orFail();
    assert.equal(debit.cardPaymentFor?.toString(), icici._id.toString());
    assert.equal(debit.transferPairId?.toString(), received._id.toString());
    assert.equal(debit.countedAmountMinor, 0);
    assert.equal(await extraIncome(userId), 0);
  });

  it("takes a plain payment to CRED as a card bill once the card says it arrived", async () => {
    const userId = await makeUser();
    const card = await makeCard(userId, "HDFC Bank", "5678");
    await makeCard(userId, "ICICI Bank", "2009");

    // CRED takes rent too, so on its own this is spending.
    const paid = await sms(userId, CRED_PLAIN, "2026-10-05");
    assert.equal(paid.countedAmountMinor, 15_000_00);
    assert.equal(await spent(userId), 15_000_00);

    await sms(userId, BILL_RECEIVED, "2026-10-06");
    const debit = await Transaction.findById(paid._id).orFail();
    assert.equal(debit.cardPaymentFor?.toString(), card._id.toString());
    assert.equal(debit.countedAmountMinor, 0);
    assert.equal(await spent(userId), 0);
    assert.equal(await extraIncome(userId), 0);
  });
});

describe("the backfill over rows imported before", () => {
  async function imported(userId: Types.ObjectId, fields: Record<string, unknown>) {
    // Created directly, the way the rows already in the database were:
    // nothing recognised them when they arrived.
    return Transaction.create({ userId, source: "SMS", currency: "INR", ...fields });
  }

  it("marks what it recognises, leaves what a person decided, and is safe to run twice", async () => {
    const userId = await makeUser();
    const card = await makeCard(userId, "HDFC Bank", "5678");

    const purchase = await imported(userId, {
      type: "DEBIT", amountMinor: 2_000_00, rawText: PURCHASE, accountId: card._id, occurredAt: on("2026-10-03"),
    });
    const bill = await imported(userId, {
      type: "DEBIT", amountMinor: 15_000_00, rawText: BILL_PAID, occurredAt: on("2026-10-05"),
    });
    // Recategorised by hand, which says nothing about what kind it is.
    const recategorised = await imported(userId, {
      type: "DEBIT", amountMinor: 7_000_00, rawText: BILL_PAID.replace("15,000.00", "7,000.00"),
      occurredAt: on("2026-10-07"), editedAt: on("2026-10-08"),
    });
    // Somebody said this one was real spending.
    const insisted = await imported(userId, {
      type: "DEBIT", amountMinor: 3_000_00, rawText: BILL_PAID.replace("15,000.00", "3,000.00"),
      occurredAt: on("2026-10-04"), editedAt: on("2026-10-08"), kindEditedAt: on("2026-10-08"),
    });
    // Typed in, card link and all - or rather, without one.
    const typed = await imported(userId, {
      type: "DEBIT", amountMinor: 1_000_00, merchant: "Credit card bill", source: "MANUAL", occurredAt: on("2026-10-02"),
    });
    const received = await imported(userId, {
      type: "CREDIT", amountMinor: 15_000_00, rawText: BILL_RECEIVED, accountId: card._id, occurredAt: on("2026-10-06"),
    });

    assert.equal(await spent(userId), 28_000_00);
    assert.equal(await extraIncome(userId), 15_000_00);

    assert.deepEqual(await backfillCardBills(userId), { payments: 2, received: 1 });

    const after = new Map(
      (await Transaction.find({ userId })).map((row) => [row._id.toString(), row])
    );
    assert.equal(after.get(bill._id.toString())!.cardPaymentFor?.toString(), card._id.toString());
    assert.equal(after.get(recategorised._id.toString())!.countedReason, "CARD_BILL");
    assert.equal(after.get(insisted._id.toString())!.countedAmountMinor, 3_000_00);
    assert.equal(after.get(typed._id.toString())!.countedAmountMinor, 1_000_00);
    assert.equal(after.get(purchase._id.toString())!.countedAmountMinor, 2_000_00);
    assert.equal(after.get(received._id.toString())!.transferPairId?.toString(), bill._id.toString());

    assert.equal(await spent(userId), 6_000_00);
    assert.equal(await extraIncome(userId), 0);

    // Nothing left for a second pass to do.
    assert.deepEqual(await backfillCardBills(userId), { payments: 0, received: 0 });
  });

  it("leaves a row alone once a person has changed its kind, and only then", async () => {
    const userId = await makeUser();
    await makeCard(userId, "HDFC Bank", "5678");
    const user = await User.findById(userId).orFail();
    const token = signSessionToken({ id: userId.toString(), email: user.email });
    const patch = (id: Types.ObjectId, body: Record<string, unknown>) =>
      fetch(`${baseUrl}/transactions/${id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const noted = await imported(userId, {
      type: "DEBIT", amountMinor: 15_000_00, rawText: BILL_PAID, occurredAt: on("2026-10-05"),
    });
    const unmarked = await imported(userId, {
      type: "DEBIT", amountMinor: 9_000_00, rawText: BILL_PAID.replace("15,000.00", "9,000.00"),
      occurredAt: on("2026-10-06"),
    });

    // A form sends every field, touched or not: the same isTransfer is no
    // change of kind.
    assert.equal((await patch(noted._id, { note: "October", isTransfer: false })).status, 200);
    // A transfer, then not: someone deciding it is real spending.
    assert.equal((await patch(unmarked._id, { isTransfer: true })).status, 200);
    assert.equal((await patch(unmarked._id, { isTransfer: false })).status, 200);

    const [first, second] = await Promise.all([Transaction.findById(noted._id), Transaction.findById(unmarked._id)]);
    assert.equal(first!.kindEditedAt ?? null, null);
    assert.ok(second!.kindEditedAt);

    assert.deepEqual(await backfillCardBills(userId), { payments: 1, received: 0 });
    assert.equal((await Transaction.findById(noted._id))!.countedReason, "CARD_BILL");
    assert.equal((await Transaction.findById(unmarked._id))!.countedAmountMinor, 9_000_00);
  });

  it("runs once per user at this version", async () => {
    const userId = await makeUser();
    await makeCard(userId, "HDFC Bank", "5678");
    await imported(userId, { type: "DEBIT", amountMinor: 15_000_00, rawText: BILL_PAID, occurredAt: on("2026-10-05") });

    assert.deepEqual(await runCardBillBackfill(), { users: 1, changed: 1 });
    const user = await User.findById(userId).orFail();
    assert.equal(user.backfills?.get(CARD_BILL_BACKFILL), CARD_BILL_BACKFILL_VERSION);

    assert.deepEqual(await runCardBillBackfill(), { users: 0, changed: 0 });
  });
});

describe("a card bill kept as a fixed commitment", () => {
  it("is not held back as a fixed cost still to go out", async () => {
    const userId = await makeUser({ salaryAmountMinor: 1_00_000_00 });
    const card = await makeCard(userId, "HDFC Bank", "5678");
    const bill = await FixedCommitment.create({
      userId, name: "HDFC credit card bill", amountMinor: 15_000_00, dayOfMonth: 20, kind: "OTHER",
    });
    await FixedCommitment.create({ userId, name: "Rent", amountMinor: 10_000_00, dayOfMonth: 25, kind: "RENT" });

    const status = await monthlyBudgetStatus(userId, undefined, NOW);
    assert.equal(status.pace?.fixedStillDueMinor, 10_000_00);

    // Paid, and linked to the commitment as well as the card: still nothing
    // spent, and the commitment reads as met by the money that went.
    await Transaction.create({
      userId, type: "DEBIT", amountMinor: 15_000_00, source: "MANUAL", occurredAt: on("2026-10-05"),
      cardPaymentFor: card._id, commitmentId: bill._id,
    });
    const after = await monthlyBudgetStatus(userId, undefined, NOW);
    assert.equal(after.spentMinor, 0);
    assert.equal(after.pace?.fixedStillDueMinor, 10_000_00);

    const pace = await budgetPace(userId, NOW);
    assert.ok(pace.configured);
    assert.equal(pace.commitmentsRemainingMinor, 10_000_00);
    const listed = pace.commitments.find((row) => row.name === "HDFC credit card bill")!;
    assert.equal(listed.isCardBill, true);
    assert.equal(listed.isPaid, true);
  });
});
