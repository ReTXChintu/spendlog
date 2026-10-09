import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { app } from "../../app";
import { signSessionToken } from "../../middleware/auth";
import { Account, CardStatement, Category, FixedCommitment, Transaction, User } from "../../models";
import { ingestRawMessage } from "../../parsing/ingest";
import { monthlyBudgetStatus, spentInMonth } from "../budget/budget.monthly";
import { extraIncomeMatch } from "../budget/budget.daily";
import { budgetPace } from "../budget/budget.pace";
import { userMonth } from "../budget/budget.months";
import { expectedBalances } from "../accounts/accounts.balance";
import { outstandingByCard } from "../statements/statements.bills";
import {
  CARD_BILL_ACCOUNT_BACKFILL,
  CARD_BILL_ACCOUNT_BACKFILL_VERSION,
  CARD_BILL_BACKFILL,
  CARD_BILL_BACKFILL_VERSION,
  backfillCardBillAccounts,
  backfillCardBills,
  runCardBillAccountBackfill,
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
    CardStatement.deleteMany({}),
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

async function makeBank(
  userId: Types.ObjectId,
  bankName: string,
  last4: string | null,
  fields: Record<string, unknown> = {}
) {
  return Account.create({ userId, bankName, last4, accountType: "BANK", ...fields });
}

describe("the account a card bill is filed under", () => {
  // The bank's side of a bill names two accounts - the one debited and the
  // card paid - and the parser alone took the card's number for the account.
  const bankSide: { name: string; text: string; bank: [string, string | null]; card: [string, string] }[] = [
    { name: "HDFC", text: BILL_PAID, bank: ["HDFC Bank", "9876"], card: ["HDFC Bank", "5678"] },
    {
      name: "ICICI, which masks its account to three digits",
      text: "ICICI Bank Acct XX876 debited for Rs 15000.00 on 05-Oct-26; ICICI Bank Credit Card XX2009 credited. UPI:627812345678. Call 18002662 for dispute.",
      bank: ["ICICI Bank", null],
      card: ["ICICI Bank", "2009"],
    },
    {
      name: "SBI",
      text: "Your A/C XXXXX9876 Debited INR 15,000.00 on 05/10/26 -Transferred to SBI Card. Avl Balance INR 40,000.00-SBI",
      bank: ["SBI", "9876"],
      card: ["SBI", "4321"],
    },
    {
      name: "Axis",
      text: "INR 15000.00 debited A/c no. XX9876 05-10-26, 11:22:33 UPI/P2M/627812345678/AXIS CC Not you? SMS BLOCKUPI Cust ID to 919951860002 Axis Bank",
      bank: ["Axis Bank", "9876"],
      card: ["Axis Bank", "7788"],
    },
  ];

  for (const { name, text, bank, card } of bankSide) {
    it(`files the bank's debit under the bank account, and links the card it paid: ${name}`, async () => {
      const userId = await makeUser();
      const account = await makeBank(userId, ...bank);
      const paidCard = await makeCard(userId, ...card);

      const paid = await sms(userId, text, "2026-10-05");
      assert.equal(paid.accountId?.toString(), account._id.toString());
      assert.equal(paid.cardPaymentFor?.toString(), paidCard._id.toString());
      assert.equal(paid.countedReason, "CARD_BILL");
    });
  }

  it("files the debit under no account when the message never says which paid", async () => {
    const userId = await makeUser();
    const card = await makeCard(userId, "ICICI Bank", "2009");

    const paid = await sms(
      userId,
      "Rs.15,000.00 paid towards your ICICI Bank Credit Card XX2009 via BBPS on 05-10-26.",
      "2026-10-05"
    );
    // The same as any debit naming no account - not the card it paid.
    assert.equal(paid.accountId ?? null, null);
    assert.equal(paid.cardPaymentFor?.toString(), card._id.toString());
  });

  it("files ICICI's 'Card Account 4XXX2009' credit under the card, not a bank account ending 2009", async () => {
    const userId = await makeUser();
    const card = await makeCard(userId, "ICICI Bank", "2009");
    // Where the parser alone would have put it.
    await makeBank(userId, "ICICI Bank", "2009");

    const received = await sms(userId, ICICI_RECEIVED, "2026-10-06");
    assert.equal(received.accountId?.toString(), card._id.toString());
    assert.equal(received.countedAmountMinor, 0);
  });

  it("files the card's credit under a card even before the card is known", async () => {
    const userId = await makeUser();

    const received = await sms(userId, ICICI_RECEIVED, "2026-10-06");
    const account = await Account.findById(received.accountId).orFail();
    assert.equal(account.accountType, "CARD");
    assert.equal(account.bankName, "ICICI Bank");
    assert.equal(account.last4, "2009");
  });

  it("still files a purchase on the card under the card", async () => {
    const userId = await makeUser();
    await makeBank(userId, "HDFC Bank", "9876");
    const card = await makeCard(userId, "HDFC Bank", "5678");

    const purchase = await sms(userId, PURCHASE, "2026-10-03");
    assert.equal(purchase.accountId?.toString(), card._id.toString());
    assert.equal(purchase.cardPaymentFor ?? null, null);
    assert.equal(purchase.countedAmountMinor, 2_000_00);
  });

  it("takes the payment out of the bank's balance once, and off what the card owes", async () => {
    const userId = await makeUser();
    const bank = await makeBank(userId, "HDFC Bank", "9876", {
      openingBalanceMinor: 1_00_000_00,
      openingBalanceAt: on("2026-10-01"),
    });
    const card = await makeCard(userId, "HDFC Bank", "5678");
    await CardStatement.create({
      userId, accountId: card._id, sourceRef: "statement-1", status: "PARSED",
      statementDate: on("2026-10-01"), totalDueMinor: 15_000_00, lines: [],
    });
    const owed = async () => (await outstandingByCard(userId, NOW)).get(card.id)?.owedMinor;
    const bankBalance = async () =>
      (await expectedBalances(userId, await Account.find({ userId }))).get(bank.id)!;
    assert.equal(await owed(), 15_000_00);

    await sms(userId, PURCHASE, "2026-10-03");
    const paid = await sms(userId, BILL_PAID, "2026-10-05");
    const received = await sms(userId, BILL_RECEIVED, "2026-10-06");

    // Paired, each leg on its own account and naming the other's.
    const [debit, credit] = await Promise.all([Transaction.findById(paid._id), Transaction.findById(received._id)]);
    assert.equal(credit!.accountId?.toString(), card._id.toString());
    assert.equal(credit!.transferAccountId?.toString(), bank._id.toString());
    assert.equal(debit!.transferPairId?.toString(), received._id.toString());

    // The purchase was on the card, so the bank only sees the bill, and
    // the card's credit moves no bank balance a second time.
    const balance = await bankBalance();
    assert.equal(balance.outMinor, 15_000_00);
    assert.equal(balance.inMinor, 0);
    assert.equal(balance.expectedMinor, 85_000_00);
    assert.equal(await owed(), 0);
  });
});

describe("the backfill over bill payments filed under the wrong account", () => {
  async function imported(userId: Types.ObjectId, fields: Record<string, unknown>) {
    return Transaction.create({ userId, source: "SMS", currency: "INR", ...fields });
  }

  it("moves each leg to its own account, leaves an edited row, and is safe to run twice", async () => {
    const userId = await makeUser();
    const bank = await makeBank(userId, "HDFC Bank", "9876");
    const hdfc = await makeCard(userId, "HDFC Bank", "5678");
    const icici = await makeCard(userId, "ICICI Bank", "2009");
    // Made by the parser out of ICICI's card number.
    const stray = await makeBank(userId, "ICICI Bank", "2009");

    // Both legs of one HDFC bill, paired - and both on the card.
    const debit = await imported(userId, {
      type: "DEBIT", amountMinor: 15_000_00, rawText: BILL_PAID, accountId: hdfc._id,
      cardPaymentFor: hdfc._id, occurredAt: on("2026-10-05"),
    });
    const credit = await imported(userId, {
      type: "CREDIT", amountMinor: 15_000_00, rawText: BILL_RECEIVED, accountId: hdfc._id,
      isTransfer: true, transferAccountId: null, transferPairId: debit._id, occurredAt: on("2026-10-06"),
    });
    debit.transferPairId = credit._id;
    await debit.save();
    // ICICI's payment received, on the stray bank account.
    const received = await imported(userId, {
      type: "CREDIT", amountMinor: 9_000_00, rawText: ICICI_RECEIVED.replace("15,000.00", "9,000.00"),
      accountId: stray._id, isTransfer: true, occurredAt: on("2026-10-07"),
    });
    // Someone looked at this one and left it where it is.
    const edited = await imported(userId, {
      type: "DEBIT", amountMinor: 7_000_00, rawText: BILL_PAID.replace("15,000.00", "7,000.00"),
      accountId: hdfc._id, cardPaymentFor: hdfc._id, occurredAt: on("2026-10-08"), editedAt: on("2026-10-09"),
    });
    const purchase = await imported(userId, {
      type: "DEBIT", amountMinor: 2_000_00, rawText: PURCHASE, accountId: hdfc._id, occurredAt: on("2026-10-03"),
    });

    assert.equal(await backfillCardBillAccounts(userId), 2);

    const after = new Map((await Transaction.find({ userId })).map((row) => [row._id.toString(), row]));
    const movedDebit = after.get(debit._id.toString())!;
    assert.equal(movedDebit.accountId?.toString(), bank._id.toString());
    assert.equal(movedDebit.cardPaymentFor?.toString(), hdfc._id.toString());
    // Already on the card; it now names the bank as the other side.
    const pairedCredit = after.get(credit._id.toString())!;
    assert.equal(pairedCredit.accountId?.toString(), hdfc._id.toString());
    assert.equal(pairedCredit.transferAccountId?.toString(), bank._id.toString());
    assert.equal(after.get(received._id.toString())!.accountId?.toString(), icici._id.toString());
    assert.equal(after.get(edited._id.toString())!.accountId?.toString(), hdfc._id.toString());
    assert.equal(after.get(purchase._id.toString())!.accountId?.toString(), hdfc._id.toString());

    assert.equal(await backfillCardBillAccounts(userId), 0);
  });

  it("leaves a row something else moved, and a statement's row", async () => {
    const userId = await makeUser();
    await makeBank(userId, "HDFC Bank", "9876");
    const hdfc = await makeCard(userId, "HDFC Bank", "5678");
    const other = await makeBank(userId, "Kotak Bank", "1111");

    // Not where the parser would have put it.
    const placed = await imported(userId, {
      type: "DEBIT", amountMinor: 15_000_00, rawText: BILL_PAID, accountId: other._id, occurredAt: on("2026-10-05"),
    });
    const fromStatement = await imported(userId, {
      type: "DEBIT", amountMinor: 15_000_00, rawText: BILL_PAID, accountId: hdfc._id, source: "STATEMENT",
      occurredAt: on("2026-10-05"),
    });

    assert.equal(await backfillCardBillAccounts(userId), 0);
    assert.equal((await Transaction.findById(placed._id))!.accountId?.toString(), other._id.toString());
    assert.equal((await Transaction.findById(fromStatement._id))!.accountId?.toString(), hdfc._id.toString());
  });

  it("runs once per user at this version", async () => {
    const userId = await makeUser();
    await makeBank(userId, "HDFC Bank", "9876");
    const hdfc = await makeCard(userId, "HDFC Bank", "5678");
    await imported(userId, {
      type: "DEBIT", amountMinor: 15_000_00, rawText: BILL_PAID, accountId: hdfc._id, occurredAt: on("2026-10-05"),
    });

    assert.deepEqual(await runCardBillAccountBackfill(), { users: 1, changed: 1 });
    const user = await User.findById(userId).orFail();
    assert.equal(user.backfills?.get(CARD_BILL_ACCOUNT_BACKFILL), CARD_BILL_ACCOUNT_BACKFILL_VERSION);
    assert.deepEqual(await runCardBillAccountBackfill(), { users: 0, changed: 0 });
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
