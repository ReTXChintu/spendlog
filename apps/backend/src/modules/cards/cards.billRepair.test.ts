import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "card-bill-repair-secret";

// Three ways card bill recognition went wrong in production, each checked
// where it now refuses and where the backfill mends it:
//
//   - CSB card purchases (through Jupiter) read as the card paying itself;
//   - HDFC's second "payment received" counted as a second payment;
//   - "credited to your Credit Card from a/c no. XX1614" not read as one.
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let ingest: typeof import("../../parsing/ingest");
let service: typeof import("./cards.billPayment.service");
let repair: typeof import("./cards.billRepair");
let legs: typeof import("./cards.billLeg");
let bills: typeof import("../statements/statements.bills");
let status: typeof import("./cards.status");
let reconcile: typeof import("../statements/statements.reconcile");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_card_bill_repair_test"));

  const loaded = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../../parsing/ingest"),
    import("./cards.billPayment.service"),
    import("./cards.billRepair"),
    import("./cards.billLeg"),
    import("../statements/statements.bills"),
    import("./cards.status"),
    import("../statements/statements.reconcile"),
  ]);
  const [{ app }, auth] = loaded;
  signToken = auth.signSessionToken;
  [, , models, ingest, service, repair, legs, bills, status, reconcile] = loaded;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

/** An IST moment on a calendar day, at noon unless said otherwise. */
function on(day: string, time = "12:00"): Date {
  return new Date(`${day}T${time}:00+05:30`);
}

const NOW = on("2026-10-16");
const SINCE = on("2026-10-01");

const CSB_PURCHASE = (rupees: string) =>
  `Rs.${rupees} debited to your Edge CSB Bank RuPay Credit Card ending 6623 on 9/10/26, 8:40 PM - (UPI Ref no.123456789012). To dispute, call 18002667. Thanks for using the Jupiter App.`;
// Jupiter writes the month first: 10/11/26 is 11 October, the day these
// tests deliver it.
const CSB_FROM_ACCOUNT =
  "Rs 677.00 credited to your Edge CSB Bank RuPay Credit Card ending 6623 from a/c no. XX1614 on 10/11/26, 4:08 PM - (UPI Ref no. 123456789012). Thanks for using the Jupiter App.";
const HDFC_PAID = "Rs.4031.00 debited from A/c XX5130 on 15-10-26 towards HDFC Bank Credit Card XX1377. -Federal Bank";
const HDFC_RECEIVED_1 =
  "DEAR HDFCBANK CARDMEMBER, PAYMENT OF Rs. 4031.00 RECEIVED TOWARDS YOUR CREDIT CARD ENDING WITH 1377 ON 15-10-2026.YOUR AVAILABLE LIMIT IS RS. 17099.80";
const HDFC_RECEIVED_2 =
  "HDFC Bank Cardmember, Online Payment of Rs.4031 vide Ref# 344PUS8PO was credited to your card ending 1377 On 15/OCT/2026_value Date 15/OCT/2026";

let token: string;
let userId: Types.ObjectId;
let federalId: Types.ObjectId;
let hdfcCardId: Types.ObjectId;
let csbCardId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.Category.deleteMany({}),
    models.CardStatement.deleteMany({}),
  ]);
  const email = `repair${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ledgerFrom: "2026-01" });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });

  federalId = (await models.Account.create({ userId, bankName: "Federal Bank", last4: "5130", accountType: "BANK" }))._id;
  hdfcCardId = (
    await models.Account.create({
      userId, bankName: "HDFC Bank", last4: "1377", accountType: "CARD", statementDay: 1, dueDay: 20, creditLimitMinor: 50_000_00,
    })
  )._id;
  csbCardId = (
    await models.Account.create({
      userId, bankName: "CSB Bank", nickname: "Edge CSB RuPay", last4: "6623", accountType: "CARD", statementDay: 1, dueDay: 20,
      creditLimitMinor: 50_000_00,
    })
  )._id;
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function patch(id: Types.ObjectId | string, body: Record<string, unknown>) {
  return call(`/transactions/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

function sms(rawText: string, receivedAt: Date) {
  return ingest.ingestRawMessage({ userId, rawText, source: "SMS", sourceRef: null, receivedAt });
}

/** A row as a message, or an old backfill, left it. */
function row(fields: Record<string, unknown>) {
  return models.Transaction.create({ userId, type: "DEBIT", source: "SMS", occurredAt: on("2026-10-09"), ...fields });
}

/** A CSB purchase as production has it: marked as paying the CSB card itself. */
function selfPaid(amountMinor: number, day: string) {
  return row({
    accountId: csbCardId, amountMinor, occurredAt: on(day), rawText: CSB_PURCHASE((amountMinor / 100).toFixed(2)),
    cardPaymentFor: csbCardId, kindEditedAt: on("2026-10-09"),
  });
}

const fresh = (id: Types.ObjectId) => models.Transaction.findById(id);
const cardCredits = (cardId: Types.ObjectId) => models.Transaction.find({ userId, accountId: cardId, type: "CREDIT" });

async function outstanding(cardId: Types.ObjectId): Promise<number | null> {
  const card = (await status.cardStatuses(userId, NOW)).find((entry) => entry.accountId === cardId.toString());
  return card?.outstandingMinor ?? null;
}

describe("a debit on a card never pays that card's bill", () => {
  it("is a purchase when the CSB card's message arrives", async () => {
    const result = await sms(CSB_PURCHASE("600.00"), on("2026-10-09", "20:40"));
    assert.equal(result.status, "created");
    const purchase = result.transaction!;
    assert.equal(purchase.accountId?.toString(), csbCardId.toString());
    assert.equal(purchase.cardPaymentFor ?? null, null);
    assert.equal(purchase.countedAmountMinor, 600_00);
    assert.equal(purchase.countedReason, "FULL");
    assert.equal((await cardCredits(csbCardId)).length, 0);
  });

  it("is not marked by recognition, even when its words read as a bill paid", async () => {
    // A bank's wording, filed under the card it names.
    const misfiled = await row({
      accountId: csbCardId, amountMinor: 900_00,
      rawText: "Rs 900.00 debited from A/c XX5130 towards Edge CSB Bank RuPay Credit Card XX6623 via UPI",
    });
    assert.equal(await service.markCardBillPayment(misfiled), false);
    assert.equal((await fresh(misfiled._id))!.cardPaymentFor ?? null, null);
    assert.equal((await fresh(misfiled._id))!.countedAmountMinor, 900_00);

    // Nor by the backfill that runs the recogniser over old rows.
    assert.deepEqual(await service.backfillCardBills(userId), { payments: 0, received: 0 });
    assert.equal((await fresh(misfiled._id))!.cardPaymentFor ?? null, null);
  });

  it("is not paired with the card's payment arriving", async () => {
    const misfiled = await row({
      accountId: csbCardId, amountMinor: 677_00, occurredAt: on("2026-10-10"),
      rawText: "Rs 677.00 debited from A/c XX5130 towards Edge CSB Bank RuPay Credit Card XX6623 via UPI",
    });
    const received = await sms(CSB_FROM_ACCOUNT, on("2026-10-11"));
    assert.equal(received.transaction!.isTransfer, true);
    assert.equal(received.transaction!.transferPairId ?? null, null);
    assert.equal((await fresh(misfiled._id))!.transferPairId ?? null, null);
    assert.equal((await fresh(misfiled._id))!.cardPaymentFor ?? null, null);
  });

  it("is given no card side", async () => {
    const purchase = await selfPaid(600_00, "2026-10-09");
    assert.equal(await legs.ensureCardBillLeg(purchase), null);
    assert.equal((await cardCredits(csbCardId)).length, 0);
  });

  it("is not linked by a statement read against the card", async () => {
    const statement = await models.CardStatement.create({
      userId, accountId: csbCardId, kind: "BANK", sourceRef: "statement-csb", status: "PARSED",
      statementDate: on("2026-10-12"), periodStart: on("2026-10-01"), periodEnd: on("2026-10-12"),
      lines: [{ date: on("2026-10-10"), description: "CC PAYMENT CSB 6623", amountMinor: 1_500_00, type: "DEBIT", kind: "SPEND" }],
    });
    await reconcile.reconcileStatement(statement);
    const [added] = await models.Transaction.find({ userId, statementId: statement._id });
    assert.equal(added.cardPaymentFor ?? null, null);
    assert.equal(added.countedAmountMinor, 1_500_00);

    // Read against the bank it left, the same line is the card's bill.
    const right = await models.CardStatement.create({
      userId, accountId: federalId, kind: "BANK", sourceRef: "statement-federal", status: "PARSED",
      statementDate: on("2026-10-12"), periodStart: on("2026-10-01"), periodEnd: on("2026-10-12"),
      lines: [{ date: on("2026-10-10"), description: "CC PAYMENT CSB 6623", amountMinor: 1_500_00, type: "DEBIT", kind: "SPEND" }],
    });
    await reconcile.reconcileStatement(right);
    const [paid] = await models.Transaction.find({ userId, statementId: right._id });
    assert.equal(paid.cardPaymentFor?.toString(), csbCardId.toString());
  });

  it("is refused when a person marks it so, with a reason", async () => {
    const purchase = await row({ accountId: csbCardId, amountMinor: 600_00, rawText: CSB_PURCHASE("600.00") });
    const refused = await patch(purchase._id, { cardPaymentFor: csbCardId.toString() });
    assert.equal(refused.status, 400);
    assert.match((await json(refused)).error, /cannot be paid from the card itself/);
    assert.equal((await fresh(purchase._id))!.cardPaymentFor ?? null, null);

    // Moving a bill payment onto the card it paid is the same thing.
    const bill = await row({ accountId: federalId, amountMinor: 4_031_00, merchant: "NEFT HDFC CARDS", cardPaymentFor: hdfcCardId });
    assert.equal((await patch(bill._id, { accountId: hdfcCardId.toString() })).status, 400);

    // So is typing one in.
    const typed = await call("/transactions", {
      method: "POST",
      body: JSON.stringify({
        type: "DEBIT", amountMinor: 600_00, currency: "INR", occurredAt: on("2026-10-09").toISOString(),
        accountId: csbCardId.toString(), cardPaymentFor: csbCardId.toString(),
      }),
    });
    assert.equal(typed.status, 400);
  });

  it("still lets a person mark a payment from the bank, or move a misfiled one off the card", async () => {
    const misfiled = await row({ accountId: csbCardId, amountMinor: 900_00 });
    const moved = await patch(misfiled._id, { accountId: federalId.toString(), cardPaymentFor: csbCardId.toString() });
    assert.equal(moved.status, 200);
    assert.equal((await fresh(misfiled._id))!.cardPaymentFor?.toString(), csbCardId.toString());

    // A row old data left wrong can still be edited for anything else.
    const old = await selfPaid(300_00, "2026-10-09");
    assert.equal((await patch(old._id, { note: "groceries", cardPaymentFor: csbCardId.toString() })).status, 200);
  });

  it("is a rule on the debit card's account as well", () => {
    const context = { ownerOf: new Map([["debit-card", "card"]]) };
    assert.equal(service.paysItself("card", "card", context), true);
    assert.equal(service.paysItself("debit-card", "card", context), true);
    assert.equal(service.paysItself("bank", "card", context), false);
    assert.equal(service.paysItself(null, "card", context), false);
  });
});

describe("the repair of purchases marked as paying their own card", () => {
  it("counts them again, takes away what was written in for them, and leaves a real bill alone", async () => {
    const plain = await selfPaid(600_00, "2026-10-03");
    // One given a card side by an older rule, one paired with a real credit.
    const withLeg = await selfPaid(1_200_00, "2026-10-05");
    const leg = await row({
      accountId: csbCardId, type: "CREDIT", amountMinor: 1_200_00, occurredAt: on("2026-10-05"), source: "MANUAL",
      isTransfer: true, transferPairId: withLeg._id, autoLeg: true, autoLegOf: withLeg._id,
    });
    withLeg.transferPairId = leg._id;
    await withLeg.save();
    const withCredit = await selfPaid(677_00, "2026-10-10");
    const credit = await row({
      accountId: csbCardId, type: "CREDIT", amountMinor: 677_00, occurredAt: on("2026-10-11"), rawText: CSB_FROM_ACCOUNT,
      isTransfer: true, transferPairId: withCredit._id,
    });
    withCredit.transferPairId = credit._id;
    await withCredit.save();
    for (const marked of [plain, withLeg, withCredit]) {
      assert.equal((await fresh(marked._id))!.countedReason, "CARD_BILL");
    }

    // A genuine bill payment: the bank's debit, and its card side.
    await row({ accountId: hdfcCardId, amountMinor: 10_000_00, occurredAt: on("2026-09-20"), merchant: "Purchase" });
    const bill = await row({ accountId: federalId, amountMinor: 4_031_00, merchant: "NEFT HDFC CARDS", cardPaymentFor: hdfcCardId, occurredAt: on("2026-10-15") });
    await legs.ensureCardBillLeg(bill);
    const billBefore = (await fresh(bill._id))!.toObject();
    const hdfcBefore = await outstanding(hdfcCardId);

    assert.deepEqual(await repair.repairSelfPayments(userId), { rows: 3, amountMinor: 2_477_00 });

    for (const [marked, amount] of [[plain, 600_00], [withLeg, 1_200_00], [withCredit, 677_00]] as const) {
      const mended = await fresh(marked._id);
      assert.equal(mended!.cardPaymentFor ?? null, null);
      assert.equal(mended!.transferPairId ?? null, null);
      assert.equal(mended!.countedAmountMinor, amount);
      assert.equal(mended!.countedReason, "FULL");
    }
    assert.equal(await fresh(leg._id), null);
    const released = await fresh(credit._id);
    assert.equal(released!.transferPairId ?? null, null);
    // The credit was a payment from an account that does not text: it is
    // what was paid towards the card. The purchases are this cycle's, all
    // of them owed, and none of them a payment any more.
    assert.equal(await bills.paidTowards(userId, csbCardId, SINCE), 677_00);
    assert.equal(await outstanding(csbCardId), 2_477_00);

    // The real bill, and its card, as they were.
    const billAfter = (await fresh(bill._id))!.toObject();
    assert.equal(billAfter.cardPaymentFor?.toString(), hdfcCardId.toString());
    assert.equal(billAfter.transferPairId?.toString(), billBefore.transferPairId?.toString());
    assert.equal(billAfter.countedReason, "CARD_BILL");
    assert.equal(await outstanding(hdfcCardId), hdfcBefore);
    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), 4_031_00);

    // Safe to run twice.
    assert.deepEqual(await repair.repairSelfPayments(userId), { rows: 0, amountMinor: 0 });
  });

  it("runs once per user", async () => {
    await selfPaid(600_00, "2026-10-03");
    await selfPaid(7_308_00, "2026-10-04");
    const first = await repair.runSelfPaymentRepair();
    assert.equal(first.changed, 2);
    assert.equal(first.amountMinor, 7_908_00);
    assert.equal((await repair.runSelfPaymentRepair()).users, 0);
  });
});

describe("a card's second 'payment received'", () => {
  beforeEach(async () => {
    // Last cycle's purchases, so there is a bill for the payment to pay.
    await row({ accountId: hdfcCardId, amountMinor: 10_000_00, occurredAt: on("2026-09-20"), merchant: "Purchase" });
  });

  it("is the same payment, end to end through ingest: outstanding drops once", async () => {
    const owedBefore = await outstanding(hdfcCardId);
    assert.equal(owedBefore, 10_000_00);

    const paid = await sms(HDFC_PAID, on("2026-10-15", "18:50"));
    assert.equal(paid.transaction!.cardPaymentFor?.toString(), hdfcCardId.toString());
    const first = await sms(HDFC_RECEIVED_1, on("2026-10-15", "19:05"));
    assert.equal(first.status, "duplicate");
    const afterFirst = await outstanding(hdfcCardId);

    const second = await sms(HDFC_RECEIVED_2, on("2026-10-16", "09:10"));
    assert.equal(second.status, "duplicate");
    assert.equal(second.transaction!._id.toString(), first.transaction!._id.toString());

    const credits = await cardCredits(hdfcCardId);
    assert.equal(credits.length, 1);
    assert.equal(credits[0].sources.length, 2);
    assert.equal(credits[0].transferPairId?.toString(), paid.transaction!._id.toString());
    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), 4_031_00);
    // The first message states what is left of the limit after the
    // payment, so from then on the card owes its limit less that figure -
    // and the second message, the same payment, changes nothing.
    assert.equal(afterFirst, 50_000_00 - 17_099_80);
    assert.equal(await outstanding(hdfcCardId), afterFirst);
  });

  it("is not a second payment of the same amount, made and reported on its own", async () => {
    await sms(HDFC_PAID, on("2026-10-15", "18:50"));
    await sms(HDFC_RECEIVED_1, on("2026-10-15", "19:05"));
    // Paid again the next day: its own debit, its own card side.
    const again = await sms(HDFC_PAID.replace("15-10-26", "16-10-26"), on("2026-10-16", "10:00"));
    assert.equal(again.status, "created");
    await sms(HDFC_RECEIVED_1.replace("15-10-2026", "16-10-2026"), on("2026-10-16", "10:20"));

    const credits = await cardCredits(hdfcCardId);
    assert.equal(credits.length, 2);
    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), 2 * 4_031_00);
  });

  it("is not a refund of the same amount", async () => {
    await sms(HDFC_PAID, on("2026-10-15", "18:50"));
    await sms(HDFC_RECEIVED_1, on("2026-10-15", "19:05"));
    const refund = await sms("Rs 4031.00 refund credited to your HDFC Bank Credit Card XX1377 from AMAZON", on("2026-10-16"));
    assert.equal(refund.status, "created");
    assert.equal((await cardCredits(hdfcCardId)).length, 2);
  });
});

describe("the repair of second 'payment received' rows", () => {
  it("merges each into the payment it repeats, and runs once", async () => {
    await row({ accountId: hdfcCardId, amountMinor: 10_000_00, occurredAt: on("2026-09-20"), merchant: "Purchase" });
    const nineCardId = (
      await models.Account.create({ userId, bankName: "HDFC Bank", last4: "9249", accountType: "CARD", statementDay: 1, creditLimitMinor: 20_000_00 })
    )._id;

    // ₹4,031 on ••1377: paired with its debit, then the second message on
    // its own, as production has it.
    const debit = await row({ accountId: federalId, amountMinor: 4_031_00, occurredAt: on("2026-10-15", "18:50"), cardPaymentFor: hdfcCardId });
    const kept = await row({
      accountId: hdfcCardId, type: "CREDIT", amountMinor: 4_031_00, occurredAt: on("2026-10-15", "19:05"), rawText: HDFC_RECEIVED_1,
      isTransfer: true, transferAccountId: federalId, transferPairId: debit._id,
    });
    debit.transferPairId = kept._id;
    await debit.save();
    const repeat = await row({
      accountId: hdfcCardId, type: "CREDIT", amountMinor: 4_031_00, occurredAt: on("2026-10-16", "09:10"), rawText: HDFC_RECEIVED_2,
      isTransfer: true,
    });
    // ₹435 on ••9249: both messages unpaired, from an account that does not text.
    const earlier = await row({
      accountId: nineCardId, type: "CREDIT", amountMinor: 435_00, occurredAt: on("2026-10-12", "20:00"),
      rawText: "DEAR HDFCBANK CARDMEMBER, PAYMENT OF Rs. 435.00 RECEIVED TOWARDS YOUR CREDIT CARD ENDING WITH 9249 ON 12-10-2026.",
      isTransfer: true,
    });
    const later = await row({
      accountId: nineCardId, type: "CREDIT", amountMinor: 435_00, occurredAt: on("2026-10-13", "08:00"),
      rawText: "HDFC Bank Cardmember, Online Payment of Rs.435 vide Ref# 123ABC was credited to your card ending 9249 On 12/OCT/2026",
      isTransfer: true,
    });
    // Not a payment's words, the same amount: left alone.
    const transfer = await row({ accountId: nineCardId, type: "CREDIT", amountMinor: 435_00, occurredAt: on("2026-10-13"), isTransfer: true, merchant: "Moved" });

    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), 2 * 4_031_00);
    assert.deepEqual(await repair.mergePaymentTwins(userId), { merged: 2, amountMinor: 4_466_00 });

    assert.equal(await fresh(repeat._id), null);
    assert.equal(await fresh(later._id), null);
    assert.ok(await fresh(transfer._id));
    const survivor = await fresh(kept._id);
    assert.equal(survivor!.sources.length, 2);
    assert.equal(survivor!.mergedFrom.length, 1);
    assert.equal(survivor!.transferPairId?.toString(), debit._id.toString());
    assert.equal((await fresh(earlier._id))!.sources.length, 2);
    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), 4_031_00);
    assert.equal(await outstanding(hdfcCardId), 10_000_00 - 4_031_00);

    assert.deepEqual(await repair.mergePaymentTwins(userId), { merged: 0, amountMinor: 0 });
    const run = await repair.runPaymentTwinBackfill();
    assert.equal(run.changed, 0);
    assert.equal((await repair.runPaymentTwinBackfill()).users, 0);
  });
});

describe("money onto a card from a bank account", () => {
  it("is a payment, counted once, when no debit for it was seen", async () => {
    const result = await sms(CSB_FROM_ACCOUNT, on("2026-10-11", "16:08"));
    assert.equal(result.status, "created");
    const credit = result.transaction!;
    assert.equal(credit.accountId?.toString(), csbCardId.toString());
    assert.equal(credit.isTransfer, true);
    assert.equal(credit.countedAmountMinor, 0);
    assert.equal(await bills.paidTowards(userId, csbCardId, SINCE), 677_00);
  });

  it("pairs with the bank's debit for it, and still counts once", async () => {
    await sms("Rs.677.00 debited from A/c XX5130 on 11-10-26 towards CSB Bank Credit Card XX6623. -Federal Bank", on("2026-10-11", "16:00"));
    const received = await sms(CSB_FROM_ACCOUNT, on("2026-10-11", "16:08"));
    assert.equal(received.status, "duplicate");
    assert.equal((await cardCredits(csbCardId)).length, 1);
    assert.equal(await bills.paidTowards(userId, csbCardId, SINCE), 677_00);
  });

  it("is recognised in old data by the backfill, once", async () => {
    const old = await row({ accountId: csbCardId, type: "CREDIT", amountMinor: 677_00, occurredAt: on("2026-10-11"), rawText: CSB_FROM_ACCOUNT });
    const refund = await row({
      accountId: csbCardId, type: "CREDIT", amountMinor: 677_00, occurredAt: on("2026-10-11"),
      rawText: "Rs 677.00 refund credited to your Edge CSB Bank RuPay Credit Card ending 6623 from a/c no. XX1614",
    });
    assert.equal((await fresh(old._id))!.countedAmountMinor, 677_00);

    assert.equal(await repair.recogniseCardCredits(userId), 1);
    const marked = await fresh(old._id);
    assert.equal(marked!.isTransfer, true);
    assert.equal(marked!.countedAmountMinor, 0);
    assert.equal((await fresh(refund._id))!.isTransfer, false);
    assert.equal(await bills.paidTowards(userId, csbCardId, SINCE), 677_00);

    assert.equal(await repair.recogniseCardCredits(userId), 0);
    assert.equal((await repair.runCardCreditBackfill()).changed, 0);
  });
});
