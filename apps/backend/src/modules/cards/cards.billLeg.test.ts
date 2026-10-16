import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "card-bill-legs-secret";

// The card's side of every card bill payment, end to end: marked in the
// app, imported from SMS, kept in step through edits, filled in for old
// data - and what the card is owed, which none of it may change.
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let ingest: typeof import("../../parsing/ingest");
let legs: typeof import("./cards.billLeg");
let bills: typeof import("../statements/statements.bills");
let status: typeof import("./cards.status");
let compare: typeof import("../statements/statements.compare");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_card_bill_legs_test"));

  const [{ app }, auth, loadedModels, loadedIngest, loadedLegs, loadedBills, loadedStatus, loadedCompare] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../../parsing/ingest"),
    import("./cards.billLeg"),
    import("../statements/statements.bills"),
    import("./cards.status"),
    import("../statements/statements.compare"),
  ]);
  signToken = auth.signSessionToken;
  models = loadedModels;
  ingest = loadedIngest;
  legs = loadedLegs;
  bills = loadedBills;
  status = loadedStatus;
  compare = loadedCompare;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

/** An IST calendar day, as an instant at noon so no boundary is grazed. */
function on(day: string): Date {
  return new Date(`${day}T12:00:00+05:30`);
}

const NOW = on("2026-10-09");
const PAID_AT = on("2026-10-05");
const BILL = 12_000_00;

let token: string;
let userId: Types.ObjectId;
let federalId: Types.ObjectId;
let hdfcCardId: Types.ObjectId;
let iciciCardId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.Category.deleteMany({}),
    models.CardStatement.deleteMany({}),
  ]);
  const email = `legs${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ledgerFrom: "2026-01" });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });

  federalId = (await models.Account.create({ userId, bankName: "Federal Bank", last4: "5130", accountType: "BANK" }))._id;
  hdfcCardId = (
    await models.Account.create({
      userId, bankName: "HDFC Bank", last4: "1377", accountType: "CARD", statementDay: 1, dueDay: 20, creditLimitMinor: 1_00_000_00,
    })
  )._id;
  iciciCardId = (
    await models.Account.create({
      userId, bankName: "ICICI Bank", last4: "2009", accountType: "CARD", statementDay: 1, dueDay: 20, creditLimitMinor: 50_000_00,
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

/** A row as a message would have left it. */
function row(fields: Record<string, unknown>) {
  return models.Transaction.create({
    userId,
    type: "DEBIT",
    amountMinor: BILL,
    source: "SMS",
    occurredAt: PAID_AT,
    ...fields,
  });
}

/** The bank's debit, not yet said to be a card bill. */
function bankDebit(fields: Record<string, unknown> = {}) {
  return row({ accountId: federalId, merchant: "NEFT HDFC CARDS", ...fields });
}

function cardCredits(cardId: Types.ObjectId) {
  return models.Transaction.find({ userId, accountId: cardId, type: "CREDIT" });
}

const fresh = (id: Types.ObjectId) => models.Transaction.findById(id);

describe("marking a payment as a card bill", () => {
  it("pairs it with the card's credit already there", async () => {
    const debit = await bankDebit();
    const credit = await row({
      accountId: hdfcCardId, type: "CREDIT", occurredAt: on("2026-10-07"),
      rawText: "Rs 12000.00 credited to your HDFC Bank Credit Card XX1377 on 07-10-26",
    });

    const response = await patch(debit._id, { cardPaymentFor: hdfcCardId.toString() });
    assert.equal(response.status, 200);
    assert.deepEqual((await json(response)).transferLeg, {
      action: "paired",
      transactionId: credit._id.toString(),
      accountId: hdfcCardId.toString(),
      accountName: "HDFC Bank ••1377",
      type: "CREDIT",
      amountMinor: BILL,
      kind: "CARD_BILL",
    });

    const [paid, arrived] = await Promise.all([fresh(debit._id), fresh(credit._id)]);
    assert.equal(paid!.transferPairId?.toString(), credit._id.toString());
    assert.equal(arrived!.transferPairId?.toString(), debit._id.toString());
    assert.equal(arrived!.isTransfer, true);
    assert.equal(arrived!.transferAccountId?.toString(), federalId.toString());
    assert.equal(arrived!.countedAmountMinor, 0);
    assert.equal((await cardCredits(hdfcCardId)).length, 1);
    assert.equal(await bills.paidTowards(userId, hdfcCardId, on("2026-10-01")), BILL);
  });

  it("writes the card's side in when there is none", async () => {
    const debit = await bankDebit();

    const response = await patch(debit._id, { cardPaymentFor: hdfcCardId.toString() });
    const body = await json(response);
    assert.equal(body.transferLeg.action, "created");
    assert.equal(body.transferLeg.kind, "CARD_BILL");
    assert.equal(body.transferLeg.accountName, "HDFC Bank ••1377");

    const [leg] = await cardCredits(hdfcCardId);
    assert.equal(leg.amountMinor, BILL);
    assert.equal(leg.occurredAt.getTime(), PAID_AT.getTime());
    assert.equal(leg.merchant, "Payment from Federal Bank ••5130");
    assert.equal(leg.source, "MANUAL");
    assert.equal(leg.autoLeg, true);
    assert.equal(leg.autoLegOf?.toString(), debit._id.toString());
    assert.equal(leg.isTransfer, true);
    assert.equal(leg.transferAccountId?.toString(), federalId.toString());
    assert.equal(leg.transferPairId?.toString(), debit._id.toString());
    assert.equal(leg.countedAmountMinor, 0);
    assert.equal(leg.countedReason, "TRANSFER");
    assert.equal((await fresh(debit._id))!.transferPairId?.toString(), leg._id.toString());
    assert.equal(await bills.paidTowards(userId, hdfcCardId, on("2026-10-01")), BILL);
  });

  it("does not take a refund, cashback or someone else's transfer for the card's side", async () => {
    const debit = await bankDebit();
    await row({ accountId: hdfcCardId, type: "CREDIT", occurredAt: on("2026-10-06"), rawText: "Refund of Rs 12000 credited to HDFC Bank Credit Card XX1377" });
    await row({ accountId: hdfcCardId, type: "CREDIT", occurredAt: on("2026-10-06"), merchant: "Cashback" });
    await row({ accountId: hdfcCardId, type: "CREDIT", occurredAt: on("2026-10-06"), isTransfer: true, transferAccountId: iciciCardId });
    // Too long after: a payment the card posted a week later is not this one.
    await row({ accountId: hdfcCardId, type: "CREDIT", occurredAt: on("2026-10-12") });

    const body = await json(await patch(debit._id, { cardPaymentFor: hdfcCardId.toString() }));
    assert.equal(body.transferLeg.action, "created");
    assert.equal((await cardCredits(hdfcCardId)).filter((credit) => credit.autoLeg).length, 1);
  });

  it("writes it for a card bill typed in by hand, too", async () => {
    const response = await call("/transactions", {
      method: "POST",
      body: JSON.stringify({
        type: "DEBIT", amountMinor: BILL, currency: "INR", occurredAt: PAID_AT.toISOString(),
        accountId: federalId.toString(), cardPaymentFor: hdfcCardId.toString(), merchant: "Card bill",
      }),
    });
    assert.equal(response.status, 201);
    assert.equal((await json(response)).transferLeg.action, "created");
    assert.equal((await cardCredits(hdfcCardId)).length, 1);
  });
});

describe("a card bill imported from SMS", () => {
  const BILL_PAID =
    "Rs.15,000.00 debited from A/c **9876 on 05-10-26 towards HDFC Bank Credit Card XX5678. Avl bal Rs 42,000.00 -HDFC Bank";
  const BILL_RECEIVED =
    "DEAR CARDMEMBER, PAYMENT OF RS 15000.00 RECEIVED TOWARDS YOUR HDFC BANK CREDIT CARD ENDING 5678 ON 07/OCT/2026. YOUR AVAILABLE LIMIT IS RS 1,50,000.00";
  const REFUND =
    "Rs 15000.00 refund credited to your HDFC Bank Credit Card XX5678 on 06-10-26 from AMAZON.";

  let cardId: Types.ObjectId;
  beforeEach(async () => {
    await models.Account.create({ userId, bankName: "HDFC Bank", last4: "9876", accountType: "BANK" });
    cardId = (await models.Account.create({ userId, bankName: "HDFC Bank", last4: "5678", accountType: "CARD" }))._id;
  });

  function sms(rawText: string, day: string) {
    return ingest.ingestRawMessage({ userId, rawText, source: "SMS", sourceRef: null, receivedAt: on(day) });
  }

  it("writes the card's side in when the bank's message is the only one", async () => {
    const paid = await sms(BILL_PAID, "2026-10-05");
    assert.equal(paid.status, "created");
    assert.equal(paid.transaction!.cardPaymentFor?.toString(), cardId.toString());

    const [leg] = await cardCredits(cardId);
    assert.equal(leg.autoLeg, true);
    assert.equal(leg.merchant, "Payment from HDFC Bank ••9876");
    assert.equal(leg.transferPairId?.toString(), paid.transaction!._id.toString());
  });

  it("is adopted by the card's own message two days later, not doubled", async () => {
    const paid = await sms(BILL_PAID, "2026-10-05");
    const [leg] = await cardCredits(cardId);

    const received = await sms(BILL_RECEIVED, "2026-10-07");
    assert.equal(received.status, "duplicate");
    assert.equal(received.transaction!._id.toString(), leg._id.toString());

    const credits = await cardCredits(cardId);
    assert.equal(credits.length, 1);
    const adopted = credits[0];
    assert.equal(adopted.autoLeg, false);
    assert.equal(adopted.source, "SMS");
    assert.equal(adopted.occurredAt.getTime(), on("2026-10-07").getTime());
    assert.equal(adopted.transferPairId?.toString(), paid.transaction!._id.toString());
    assert.equal(await bills.paidTowards(userId, cardId, on("2026-10-01")), 15_000_00);
  });

  it("is not adopted by a refund of the same amount", async () => {
    await sms(BILL_PAID, "2026-10-05");
    const refund = await sms(REFUND, "2026-10-06");
    assert.equal(refund.status, "created");

    const credits = await cardCredits(cardId);
    assert.equal(credits.length, 2);
    assert.equal(credits.filter((credit) => credit.autoLeg).length, 1);
  });

  it("writes nothing when the card's message came first", async () => {
    const received = await sms(BILL_RECEIVED, "2026-10-04");
    const paid = await sms(BILL_PAID, "2026-10-05");
    assert.equal((await fresh(paid.transaction!._id))!.transferPairId?.toString(), received.transaction!._id.toString());
    assert.equal((await cardCredits(cardId)).length, 1);
    assert.equal((await cardCredits(cardId))[0].autoLeg, false);
  });
});

describe("a written-in card side follows its payment until someone vouches for it", () => {
  async function marked() {
    const debit = await bankDebit();
    await patch(debit._id, { cardPaymentFor: hdfcCardId.toString() });
    const [leg] = await cardCredits(hdfcCardId);
    return { debit, leg };
  }

  it("takes the payment's new amount and day", async () => {
    const { debit, leg } = await marked();
    await patch(debit._id, { amountMinor: 13_000_00, occurredAt: on("2026-10-06").toISOString() });
    const moved = await fresh(leg._id);
    assert.equal(moved!.amountMinor, 13_000_00);
    assert.equal(moved!.occurredAt.getTime(), on("2026-10-06").getTime());
    assert.equal(moved!.autoLeg, true);
  });

  it("moves to the card the payment is moved to", async () => {
    const { debit, leg } = await marked();
    const body = await json(await patch(debit._id, { cardPaymentFor: iciciCardId.toString() }));
    assert.equal(body.transferLeg.action, "created");
    assert.equal(body.transferLeg.accountName, "ICICI Bank ••2009");
    assert.equal(await fresh(leg._id), null);
    assert.equal((await cardCredits(hdfcCardId)).length, 0);
    const [moved] = await cardCredits(iciciCardId);
    assert.equal(moved.autoLeg, true);
    assert.equal((await fresh(debit._id))!.transferPairId?.toString(), moved._id.toString());
  });

  it("goes when the payment is no longer a card bill", async () => {
    const { debit, leg } = await marked();
    const body = await json(await patch(debit._id, { cardPaymentFor: null }));
    assert.equal(body.transferLeg, null);
    assert.equal(await fresh(leg._id), null);
    const plain = await fresh(debit._id);
    assert.equal(plain!.transferPairId ?? null, null);
    assert.equal(plain!.countedAmountMinor, BILL);
  });

  it("goes when the payment is deleted", async () => {
    const { debit, leg } = await marked();
    assert.equal((await call(`/transactions/${debit._id}`, { method: "DELETE" })).status, 204);
    assert.equal(await fresh(leg._id), null);
  });

  it("is only unpaired, never deleted, once the user has edited it", async () => {
    const { debit, leg } = await marked();
    await patch(leg._id, { note: "seen it on the card app" });
    assert.equal((await fresh(leg._id))!.autoLeg, false);

    await patch(debit._id, { cardPaymentFor: null });
    const kept = await fresh(leg._id);
    assert.ok(kept);
    assert.equal(kept!.transferPairId ?? null, null);
    // On its own now, it is a payment the card received from somewhere.
    assert.equal(await bills.paidTowards(userId, hdfcCardId, on("2026-10-01")), BILL);
  });

  it("is only unpaired when the payment is deleted after the card's message confirmed it", async () => {
    const { debit, leg } = await marked();
    await patch(leg._id, { note: "confirmed" });
    await call(`/transactions/${debit._id}`, { method: "DELETE" });
    const kept = await fresh(leg._id);
    assert.ok(kept);
    assert.equal(kept!.transferPairId ?? null, null);
  });

  it("deleted by hand, is not written back by a later edit", async () => {
    const { debit, leg } = await marked();
    assert.equal((await call(`/transactions/${leg._id}`, { method: "DELETE" })).status, 204);
    const declined = await fresh(debit._id);
    assert.equal(declined!.legDeclined, true);
    assert.equal(declined!.transferPairId ?? null, null);
    // Still the bill paid, counted once.
    assert.equal(await bills.paidTowards(userId, hdfcCardId, on("2026-10-01")), BILL);

    const body = await json(await patch(debit._id, { note: "paid early" }));
    assert.equal(body.transferLeg, null);
    assert.equal((await cardCredits(hdfcCardId)).length, 0);

    // A different card is a new answer, and gets its side.
    await patch(debit._id, { cardPaymentFor: iciciCardId.toString() });
    assert.equal((await cardCredits(iciciCardId)).length, 1);
  });

  it("keeps a confirmed pair through an edit that changes nothing about it", async () => {
    const debit = await bankDebit();
    const credit = await row({ accountId: hdfcCardId, type: "CREDIT", occurredAt: on("2026-10-06"), rawText: "Payment received on HDFC Bank Credit Card XX1377" });
    await patch(debit._id, { cardPaymentFor: hdfcCardId.toString() });

    await patch(debit._id, { note: "September's bill" });
    await patch(credit._id, { note: "landed" });
    assert.equal((await fresh(debit._id))!.transferPairId?.toString(), credit._id.toString());
    assert.equal((await fresh(credit._id))!.transferPairId?.toString(), debit._id.toString());
    assert.equal(await bills.paidTowards(userId, hdfcCardId, on("2026-10-01")), BILL);
  });
});

describe("what the card is owed", () => {
  const SINCE = on("2026-10-01");

  it("counts a payment once, however many of its sides are here", async () => {
    // The bank's debit alone, as old data has it.
    const alone = await bankDebit({ cardPaymentFor: hdfcCardId });
    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), BILL);

    // With its side written in.
    await legs.ensureCardBillLeg(alone);
    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), BILL);
    await models.Transaction.deleteMany({ userId });

    // With the card's own credit paired.
    await row({ accountId: hdfcCardId, type: "CREDIT", occurredAt: on("2026-10-06"), rawText: "Payment received on card XX1377" });
    const debit = await bankDebit({ cardPaymentFor: hdfcCardId });
    assert.equal((await legs.ensureCardBillLeg(debit))?.action, "paired");
    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), BILL);
    await models.Transaction.deleteMany({ userId });

    // The card's credit alone: paid from an account that does not text.
    await row({ accountId: hdfcCardId, type: "CREDIT", isTransfer: true, occurredAt: on("2026-10-06") });
    assert.equal(await bills.paidTowards(userId, hdfcCardId, SINCE), BILL);
  });

  it("is the same before and after the backfill, card by card", async () => {
    await models.CardStatement.create({
      userId, accountId: hdfcCardId, sourceRef: "statement-hdfc", status: "PARSED",
      statementDate: SINCE, totalDueMinor: 20_000_00, lines: [],
    });
    const axisCardId = (
      await models.Account.create({ userId, bankName: "Axis Bank", last4: "4444", accountType: "CARD", statementDay: 1, creditLimitMinor: 40_000_00 })
    )._id;

    // Last cycle's purchases, so the estimated bills have something in them.
    for (const cardId of [hdfcCardId, iciciCardId, axisCardId]) {
      await row({ accountId: cardId, amountMinor: 25_000_00, occurredAt: on("2026-09-15"), merchant: "Purchase" });
    }
    // HDFC: a debit alone, and an older one already paired with the card's
    // credit. ICICI: a debit alone, with a refund of the same amount beside
    // it. Axis: the card's credit alone.
    await bankDebit({ cardPaymentFor: hdfcCardId });
    const old = await bankDebit({ cardPaymentFor: hdfcCardId, amountMinor: 3_000_00, occurredAt: on("2026-10-02") });
    const oldCredit = await row({
      accountId: hdfcCardId, type: "CREDIT", amountMinor: 3_000_00, occurredAt: on("2026-10-03"),
      isTransfer: true, transferAccountId: federalId, transferPairId: old._id,
    });
    old.transferPairId = oldCredit._id;
    await old.save();
    await bankDebit({ cardPaymentFor: iciciCardId });
    await row({ accountId: iciciCardId, type: "CREDIT", occurredAt: on("2026-10-06"), merchant: "Refund AMAZON" });
    await row({ accountId: axisCardId, type: "CREDIT", isTransfer: true, occurredAt: on("2026-10-06") });

    const picture = async () =>
      (await status.cardStatuses(userId, NOW)).map((card) => ({
        id: card.accountId,
        outstandingMinor: card.outstandingMinor,
        availableMinor: card.availableMinor,
        billIsPaid: card.billIsPaid,
        paidMinor: card.lastBill?.paidMinor ?? null,
      }));
    const beforeBackfill = await picture();
    assert.equal(beforeBackfill.length, 3);
    assert.ok(beforeBackfill.every((card) => card.outstandingMinor !== null && card.availableMinor !== null));
    const owedBefore = [...(await bills.outstandingByCard(userId, NOW)).values()].map((bill) => bill.owedMinor);

    assert.deepEqual(await legs.backfillCardBillLegs(userId), { paired: 0, created: 2 });
    assert.deepEqual(await picture(), beforeBackfill);
    assert.deepEqual([...(await bills.outstandingByCard(userId, NOW)).values()].map((bill) => bill.owedMinor), owedBefore);

    // Safe to run twice.
    assert.deepEqual(await legs.backfillCardBillLegs(userId), { paired: 0, created: 0 });
    assert.deepEqual(await picture(), beforeBackfill);
  });
});

describe("the backfill", () => {
  it("pairs where the card's credit is here, writes in where it is not, and runs once", async () => {
    const pairs = await bankDebit({ cardPaymentFor: hdfcCardId });
    const credit = await row({ accountId: hdfcCardId, type: "CREDIT", occurredAt: on("2026-10-07") });
    const writes = await bankDebit({ cardPaymentFor: iciciCardId, amountMinor: 4_000_00 });
    // Its side deleted by hand: left without one.
    await bankDebit({ cardPaymentFor: iciciCardId, amountMinor: 5_000_00, legDeclined: true });

    const first = await legs.runCardBillLegBackfill();
    assert.equal(first.paired, 1);
    assert.equal(first.created, 1);
    assert.equal((await fresh(pairs._id))!.transferPairId?.toString(), credit._id.toString());
    const [written] = (await cardCredits(iciciCardId)).filter((row) => row.autoLeg);
    assert.equal(written.autoLegOf?.toString(), writes._id.toString());
    assert.equal((await cardCredits(iciciCardId)).length, 1);

    const second = await legs.runCardBillLegBackfill();
    assert.equal(second.users, 0);
    assert.deepEqual(await legs.backfillCardBillLegs(userId), { paired: 0, created: 0 });
  });
});

describe("the card's statement", () => {
  it("finds the written-in side as its payment line, neither missing nor extra", async () => {
    const debit = await bankDebit();
    await patch(debit._id, { cardPaymentFor: hdfcCardId.toString() });
    const [leg] = await cardCredits(hdfcCardId);
    const purchase = await row({ accountId: hdfcCardId, amountMinor: 800_00, occurredAt: on("2026-10-08"), merchant: "SWIGGY" });

    const statement = await models.CardStatement.create({
      userId, accountId: hdfcCardId, kind: "CARD", sourceRef: "statement-oct", status: "PARSED",
      statementDate: on("2026-10-20"), periodStart: on("2026-10-08"), periodEnd: on("2026-10-20"),
      lines: [
        // Posted four days after the bank let it go.
        { date: on("2026-10-09"), description: "PAYMENT RECEIVED - THANK YOU", amountMinor: BILL, type: "CREDIT", kind: "PAYMENT" },
        { date: on("2026-10-08"), description: "SWIGGY", amountMinor: 800_00, type: "DEBIT", kind: "SPEND" },
      ],
    });

    const result = await compare.compareStatement(statement);
    const matched = result.pairs.map((pair) => pair.transactionId).sort();
    assert.deepEqual(matched, [leg._id.toString(), purchase._id.toString()].sort());
    assert.deepEqual(result.onStatementNotInApp, []);
    assert.deepEqual(result.inAppNotOnStatement, []);
  });
});
