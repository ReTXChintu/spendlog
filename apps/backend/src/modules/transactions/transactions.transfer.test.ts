import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "transfer-legs-secret";

// Both legs of a transfer, end to end: through the routes the app calls,
// ingest as the phone feeds it, and the balances the overview and the
// passbook read back.
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let ingest: typeof import("../../parsing/ingest");
let legs: typeof import("./transactions.transfer");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_transfer_legs_test"));

  const [{ app }, auth, loadedModels, loadedIngest, loadedLegs] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../../parsing/ingest"),
    import("./transactions.transfer"),
  ]);
  signToken = auth.signSessionToken;
  models = loadedModels;
  ingest = loadedIngest;
  legs = loadedLegs;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

let token: string;
let userId: Types.ObjectId;
let hdfcId: Types.ObjectId;
let federalId: Types.ObjectId;
let cashId: Types.ObjectId;
let cardId: Types.ObjectId;
let userCount = 0;

const OPENING_AT = new Date("2026-10-01T00:00:00+05:30");
const SENT_AT = new Date("2026-10-05T10:00:00+05:30");

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.Category.deleteMany({}),
  ]);
  const email = `t${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ledgerFrom: "2026-01" });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });

  const opening = { openingBalanceAt: OPENING_AT, userId };
  hdfcId = (await models.Account.create({ ...opening, bankName: "HDFC Bank", last4: "8342", accountType: "BANK", openingBalanceMinor: 10_000_00 }))._id;
  federalId = (await models.Account.create({ ...opening, bankName: "Federal Bank", last4: "3295", accountType: "BANK", openingBalanceMinor: 5_000_00 }))._id;
  cashId = (await models.Account.create({ ...opening, bankName: "Cash", last4: null, accountType: "CASH", openingBalanceMinor: 500_00 }))._id;
  cardId = (await models.Account.create({ userId, bankName: "ICICI Bank", last4: "2009", accountType: "CARD" }))._id;
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

async function balanceOf(accountId: Types.ObjectId): Promise<number> {
  const rows = await json<{ id: string; balance: { expectedMinor: number } | null }[]>(await call("/accounts/overview"));
  return rows.find((row) => row.id === accountId.toString())!.balance!.expectedMinor;
}

async function passbookRows(accountId: Types.ObjectId) {
  return (await json<{ rows: any[] }>(await call(`/accounts/${accountId}/passbook`))).rows;
}

/** A row as a message would have left it: not a transfer, nobody's leg. */
function row(fields: Record<string, unknown>) {
  return models.Transaction.create({
    userId,
    type: "DEBIT",
    amountMinor: 3_000_00,
    source: "SMS",
    occurredAt: SENT_AT,
    ...fields,
  });
}

/** The one-row transfer every transfer used to be: no other leg, the far side moved by the ledger alone. */
function oneRowTransfer(fields: Record<string, unknown> = {}) {
  return row({ accountId: hdfcId, isTransfer: true, transferAccountId: federalId, ...fields });
}

function sms(rawText: string, receivedAt: Date) {
  return ingest.ingestRawMessage({ userId, rawText, source: "SMS", sourceRef: null, receivedAt });
}

const FEDERAL_IN = "Rs 3000.00 credited to A/c XX3295 on 07-10-26 from HDFC Bank NEFT. Avl Bal Rs 8,000.00 -Federal Bank";

describe("marking a transfer when the other side is already here", () => {
  it("pairs the two, so the receiving account counts the money once", async () => {
    const out = await row({ accountId: hdfcId });
    const inn = await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-06T09:00:00+05:30") });

    const response = await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString() });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.transferLeg, {
      action: "paired",
      transactionId: inn._id.toString(),
      accountId: federalId.toString(),
      accountName: "Federal Bank ••3295",
      type: "CREDIT",
      amountMinor: 3_000_00,
    });
    assert.equal(body.transferPairId, inn._id.toString());

    const paired = await models.Transaction.findById(inn._id).orFail();
    assert.equal(paired.isTransfer, true);
    assert.ok(paired.transferPairId?.equals(out._id));
    assert.ok(paired.transferAccountId?.equals(hdfcId));
    assert.equal(paired.countedAmountMinor, 0, "money arriving from your own account is not income");
    assert.equal(await models.Transaction.countDocuments({ userId }), 2, "nothing written in");

    assert.equal(await balanceOf(hdfcId), 7_000_00);
    assert.equal(await balanceOf(federalId), 8_000_00, "once, not 11,000");
  });

  it("removes the double count a one-row transfer and the other bank's own row made", async () => {
    const out = await oneRowTransfer();
    await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-06T09:00:00+05:30") });
    assert.equal(await balanceOf(federalId), 11_000_00, "counted twice: the far side, and the credit");

    const result = await legs.ensureTransferLegs(out);
    assert.equal(result?.action, "paired");
    assert.equal(await balanceOf(federalId), 8_000_00);
    assert.equal(await balanceOf(hdfcId), 7_000_00);
  });

  it("takes the closest in time, and only a row on that account", async () => {
    const out = await row({ accountId: hdfcId });
    const far = await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-07T09:00:00+05:30") });
    const near = await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-04T18:00:00+05:30") });
    await row({ accountId: cashId, type: "CREDIT", occurredAt: SENT_AT });
    await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-09T10:00:00+05:30") });

    const body = await json(await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString() }));
    assert.equal(body.transferLeg.transactionId, near._id.toString());
    assert.equal((await models.Transaction.findById(far._id).orFail()).isTransfer, false);
  });

  it("claims a row nobody could place, and puts it on the account", async () => {
    const out = await row({ accountId: hdfcId });
    const unknown = await row({ accountId: null, accountUnknown: true, type: "CREDIT", occurredAt: new Date("2026-10-05T10:02:00+05:30") });
    assert.equal(await balanceOf(federalId), 5_000_00);

    const body = await json(await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString() }));
    assert.equal(body.transferLeg.action, "paired");
    assert.equal(body.transferLeg.transactionId, unknown._id.toString());

    const claimed = await models.Transaction.findById(unknown._id).orFail();
    assert.ok(claimed.accountId?.equals(federalId));
    assert.equal(claimed.accountUnknown, false);
    assert.ok(claimed.transferPairId?.equals(out._id));
    assert.equal(await balanceOf(federalId), 8_000_00);
  });

  it("leaves the month's pay, a refund, a card bill and someone else's transfer alone", async () => {
    const out = await row({ accountId: hdfcId });
    const salary = await row({ accountId: federalId, type: "CREDIT", isSalary: true });
    const refund = await row({
      accountId: federalId,
      type: "CREDIT",
      refundOf: [{ transactionId: new Types.ObjectId(), amountMinor: 3_000_00 }],
    });
    const elsewhere = await row({ accountId: federalId, type: "CREDIT", isTransfer: true, transferAccountId: cashId });

    const body = await json(await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString() }));
    assert.equal(body.transferLeg.action, "created");
    for (const id of [salary._id, refund._id, elsewhere._id]) {
      assert.equal((await models.Transaction.findById(id).orFail()).transferPairId, null);
    }

    // The other way round: a card bill on the bank is never the leg of a
    // transfer into it.
    const into = await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-08T10:00:00+05:30") });
    const bill = await row({ accountId: hdfcId, cardPaymentFor: cardId, occurredAt: new Date("2026-10-08T10:00:00+05:30") });
    const reply = await json(await patch(into._id, { isTransfer: true, transferAccountId: hdfcId.toString() }));
    assert.equal(reply.transferLeg.action, "created");
    assert.equal((await models.Transaction.findById(bill._id).orFail()).transferPairId, null);
  });
});

describe("marking a transfer when the other bank sent nothing", () => {
  it("writes the leg in, and the balances stay what the one row made them", async () => {
    const out = await oneRowTransfer();
    const hdfcBefore = await balanceOf(hdfcId);
    const federalBefore = await balanceOf(federalId);
    assert.equal(federalBefore, 8_000_00, "the far side, moved by the ledger alone");

    const result = await legs.ensureTransferLegs(out);
    assert.equal(result?.action, "created");
    assert.equal(await balanceOf(hdfcId), hdfcBefore);
    assert.equal(await balanceOf(federalId), federalBefore);

    const leg = await models.Transaction.findById(result!.transactionId).orFail();
    assert.equal(leg.type, "CREDIT");
    assert.equal(leg.amountMinor, 3_000_00);
    assert.equal(leg.occurredAt.getTime(), SENT_AT.getTime());
    assert.ok(leg.accountId?.equals(federalId));
    assert.equal(leg.merchant, "Transfer from HDFC Bank ••8342");
    assert.equal(leg.source, "MANUAL");
    assert.equal(leg.autoLeg, true);
    assert.ok(leg.autoLegOf?.equals(out._id));
    assert.equal(leg.isTransfer, true);
    assert.ok(leg.transferAccountId?.equals(hdfcId));
    assert.ok(leg.transferPairId?.equals(out._id));
    assert.equal(leg.countedAmountMinor, 0);
    assert.ok((await models.Transaction.findById(out._id).orFail()).transferPairId?.equals(leg._id));

    // A real row on the receiving account now, not a shadow of one.
    const rows = await passbookRows(federalId);
    const shown = rows.find((entry) => entry.transactionId === leg._id.toString());
    assert.ok(shown, "in the Federal Bank passbook");
    assert.equal(shown.type, "CREDIT");
    assert.equal(shown.autoLeg, true);
    assert.equal(shown.merchant, "Transfer from HDFC Bank ••8342");
    assert.equal(rows.filter((entry) => entry.kind === "txn").length, 1, "and only once");
  });

  it("says what it wrote, when the transfer is marked in the app", async () => {
    const out = await row({ accountId: hdfcId });
    const body = await json(await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString() }));
    assert.equal(body.transferLeg.action, "created");
    assert.equal(body.transferLeg.accountName, "Federal Bank ••3295");
    assert.equal(body.transferLeg.type, "CREDIT");
    assert.equal(await balanceOf(federalId), 8_000_00);

    // Saving the same transfer again changes nothing.
    const again = await json(await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString(), note: "rent pot" }));
    assert.equal(again.transferLeg, null);
    assert.equal(await models.Transaction.countDocuments({ userId }), 2);
  });

  it("writes it for a transfer added by hand, too", async () => {
    const response = await call("/transactions", {
      method: "POST",
      body: JSON.stringify({
        amountMinor: 3_000_00,
        type: "CREDIT",
        accountId: federalId.toString(),
        occurredAt: SENT_AT.toISOString(),
        isTransfer: true,
        transferAccountId: hdfcId.toString(),
      }),
    });
    assert.equal(response.status, 201);
    const body = await json(response);
    assert.equal(body.transferLeg.action, "created");
    const leg = await models.Transaction.findById(body.transferLeg.transactionId).orFail();
    assert.equal(leg.type, "DEBIT");
    assert.ok(leg.accountId?.equals(hdfcId));
    assert.equal(leg.merchant, "Transfer to Federal Bank ••3295");
    assert.equal(await balanceOf(hdfcId), 7_000_00);
    assert.equal(await balanceOf(federalId), 8_000_00);
  });

  it("puts a cash withdrawal's other side on the cash account, and a deposit's on the bank", async () => {
    const withdrawal = await row({ accountId: hdfcId, amountMinor: 2_000_00 });
    const first = await json(await patch(withdrawal._id, { isTransfer: true, transferAccountId: cashId.toString() }));
    assert.equal(first.transferLeg.accountName, "Cash");
    const cashLeg = await models.Transaction.findById(first.transferLeg.transactionId).orFail();
    assert.ok(cashLeg.accountId?.equals(cashId));
    assert.equal(cashLeg.merchant, "Transfer from HDFC Bank ••8342");
    assert.equal(await balanceOf(cashId), 2_500_00);

    // Typed in with no account, which has always meant cash.
    const deposit = await row({ accountId: null, source: "MANUAL", amountMinor: 1_000_00, occurredAt: new Date("2026-10-08T10:00:00+05:30") });
    const second = await json(await patch(deposit._id, { isTransfer: true, transferAccountId: federalId.toString() }));
    const bankLeg = await models.Transaction.findById(second.transferLeg.transactionId).orFail();
    assert.ok(bankLeg.accountId?.equals(federalId));
    assert.equal(bankLeg.type, "CREDIT");
    assert.ok(bankLeg.transferAccountId?.equals(cashId));
    assert.equal(bankLeg.merchant, "Transfer from Cash");
    assert.equal(await balanceOf(cashId), 1_500_00);
    assert.equal(await balanceOf(federalId), 6_000_00);
  });

  it("writes nothing for a credit card, either side", async () => {
    const out = await row({ accountId: hdfcId });
    const body = await json(await patch(out._id, { isTransfer: true, transferAccountId: cardId.toString() }));
    assert.equal(body.transferLeg, null);

    const received = await row({ accountId: cardId, type: "CREDIT", isTransfer: true, transferAccountId: hdfcId });
    assert.equal(await legs.ensureTransferLegs(received), null);
    assert.equal(await models.Transaction.countDocuments({ userId }), 2);
  });
});

describe("the other bank's message arriving after all", () => {
  async function markedWithLeg() {
    const out = await row({ accountId: hdfcId });
    const body = await json(await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString() }));
    return { out, legId: body.transferLeg.transactionId as string };
  }

  it("becomes the written-in leg two days later, not a second row", async () => {
    const { out, legId } = await markedWithLeg();
    const result = await sms(FEDERAL_IN, new Date("2026-10-07T11:00:00+05:30"));

    assert.equal(result.status, "duplicate");
    assert.equal(result.transaction?._id.toString(), legId);
    assert.equal(await models.Transaction.countDocuments({ userId }), 2);

    const leg = await models.Transaction.findById(legId).orFail();
    assert.equal(leg.autoLeg, false);
    assert.equal(leg.source, "SMS");
    assert.equal(leg.rawText, FEDERAL_IN);
    assert.deepEqual(leg.sources.map((entry) => entry.source), ["SMS"]);
    assert.equal(leg.occurredAt.getTime(), new Date("2026-10-07T11:00:00+05:30").getTime(), "the bank's moment");
    assert.equal(leg.statedBalanceMinor, 8_000_00);
    assert.ok(leg.transferPairId?.equals(out._id), "still paired");
    assert.equal(leg.merchant, "Transfer from HDFC Bank ••8342");
    assert.equal(await balanceOf(federalId), 8_000_00);
  });

  it("becomes it minutes later, through the usual duplicate check", async () => {
    const { legId } = await markedWithLeg();
    const result = await sms(FEDERAL_IN, new Date("2026-10-05T10:05:00+05:30"));
    assert.equal(result.transaction?._id.toString(), legId);
    assert.equal((await models.Transaction.findById(legId).orFail()).autoLeg, false);
    assert.equal(await models.Transaction.countDocuments({ userId }), 2);
  });

  it("is not taken for a message about another account", async () => {
    const { legId } = await markedWithLeg();
    await models.Account.create({ userId, bankName: "Axis Bank", last4: "7777", accountType: "BANK" });
    const result = await sms(
      "Rs 3000.00 credited to A/c XX7777 on 05-10-26 from NEFT. -Axis Bank",
      new Date("2026-10-05T10:05:00+05:30")
    );
    assert.equal(result.status, "created");
    assert.notEqual(result.transaction?._id.toString(), legId);
    assert.equal((await models.Transaction.findById(legId).orFail()).autoLeg, true);
  });
});

describe("a written-in leg follows its transfer until someone vouches for it", () => {
  async function markedWithLeg() {
    const out = await row({ accountId: hdfcId });
    const body = await json(await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString() }));
    return { out, legId: body.transferLeg.transactionId as string };
  }

  it("takes the transfer's new amount and day", async () => {
    const { out, legId } = await markedWithLeg();
    const moved = new Date("2026-10-06T08:00:00+05:30");
    await patch(out._id, { amountMinor: 3_500_00, occurredAt: moved.toISOString() });

    const leg = await models.Transaction.findById(legId).orFail();
    assert.equal(leg.amountMinor, 3_500_00);
    assert.equal(leg.occurredAt.getTime(), moved.getTime());
    assert.equal(leg.autoLeg, true);
    assert.equal(await balanceOf(federalId), 8_500_00);
    assert.equal(await balanceOf(hdfcId), 6_500_00);
  });

  it("moves to the transfer's new account", async () => {
    const { out, legId } = await markedWithLeg();
    const body = await json(await patch(out._id, { isTransfer: true, transferAccountId: cashId.toString() }));

    assert.equal(await models.Transaction.findById(legId), null, "the old leg is gone");
    assert.equal(body.transferLeg.action, "created");
    const leg = await models.Transaction.findById(body.transferLeg.transactionId).orFail();
    assert.ok(leg.accountId?.equals(cashId));
    assert.equal(await balanceOf(federalId), 5_000_00);
    assert.equal(await balanceOf(cashId), 3_500_00);
  });

  it("goes when the transfer is un-marked", async () => {
    const { out, legId } = await markedWithLeg();
    await patch(out._id, { isTransfer: false });

    assert.equal(await models.Transaction.findById(legId), null);
    const plain = await models.Transaction.findById(out._id).orFail();
    assert.equal(plain.transferPairId, null);
    assert.equal(plain.transferAccountId, null);
    assert.equal(await balanceOf(federalId), 5_000_00);
  });

  it("goes when the transfer is deleted", async () => {
    const { out, legId } = await markedWithLeg();
    assert.equal((await call(`/transactions/${out._id}`, { method: "DELETE" })).status, 204);
    assert.equal(await models.Transaction.findById(legId), null);
    assert.equal(await models.Transaction.countDocuments({ userId }), 0);
  });

  it("is only unpaired, never deleted, once the user has edited it", async () => {
    const { out, legId } = await markedWithLeg();
    await patch(legId, { note: "it did arrive, Federal app shows it" });
    assert.equal((await models.Transaction.findById(legId).orFail()).autoLeg, false);

    // Edits to the transfer no longer reach it...
    await patch(out._id, { amountMinor: 3_200_00 });
    assert.equal((await models.Transaction.findById(legId).orFail()).amountMinor, 3_000_00);

    // ...and un-marking it lets go rather than deleting.
    await patch(out._id, { isTransfer: false });
    const kept = await models.Transaction.findById(legId).orFail();
    assert.equal(kept.transferPairId, null);
    assert.equal(kept.transferAccountId, null, "no longer says the money came from HDFC");
    assert.equal(await balanceOf(federalId), 8_000_00, "its own money, once");
  });

  it("is only unpaired when a message confirmed it and the transfer is deleted", async () => {
    const { out, legId } = await markedWithLeg();
    await sms(FEDERAL_IN, new Date("2026-10-06T11:00:00+05:30"));
    await call(`/transactions/${out._id}`, { method: "DELETE" });

    const kept = await models.Transaction.findById(legId).orFail();
    assert.equal(kept.transferPairId, null);
    assert.equal(kept.legDeclined, true);
  });

  it("deleted by hand, leaves the transfer moving both accounts by itself, and is not written back", async () => {
    const { out, legId } = await markedWithLeg();
    assert.equal((await call(`/transactions/${legId}`, { method: "DELETE" })).status, 204);

    const transfer = await models.Transaction.findById(out._id).orFail();
    assert.equal(transfer.transferPairId, null);
    assert.equal(transfer.legDeclined, true);
    assert.equal(await balanceOf(federalId), 8_000_00, "the one-row behaviour: the far side still moves");

    const edited = await json(await patch(out._id, { isTransfer: true, transferAccountId: federalId.toString(), amountMinor: 3_100_00 }));
    assert.equal(edited.transferLeg, null);
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);

    // Pointed somewhere new, it is a new answer, and gets its leg.
    const retargeted = await json(await patch(out._id, { isTransfer: true, transferAccountId: cashId.toString() }));
    assert.equal(retargeted.transferLeg.action, "created");
  });

  it("merged with the bank's own row, which came too late to adopt it, hands that row the pairing", async () => {
    const { out, legId } = await markedWithLeg();
    const late = await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-10T10:00:00+05:30") });
    assert.equal(await balanceOf(federalId), 11_000_00, "the leg and the late row both");

    const response = await call(`/transactions/${late._id}/merge`, { method: "POST", body: JSON.stringify({ sourceIds: [legId] }) });
    assert.equal(response.status, 200);

    const survivor = await models.Transaction.findById(late._id).orFail();
    assert.equal(survivor.isTransfer, true);
    assert.ok(survivor.transferPairId?.equals(out._id));
    assert.ok(survivor.transferAccountId?.equals(hdfcId));
    assert.ok((await models.Transaction.findById(out._id).orFail()).transferPairId?.equals(late._id));
    assert.equal(await balanceOf(federalId), 8_000_00);
  });

  it("goes when the transfer is paired with a different row by hand", async () => {
    const { out, legId } = await markedWithLeg();
    const real = await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-09T10:00:00+05:30") });
    const response = await call(`/transactions/${out._id}/pair`, { method: "POST", body: JSON.stringify({ withId: real._id.toString() }) });
    assert.equal(response.status, 200);
    assert.equal(await models.Transaction.findById(legId), null);
    assert.equal(await balanceOf(federalId), 8_000_00);
  });
});

describe("ingest's own transfer pairing", () => {
  it("still pairs both messages itself, with nothing written in", async () => {
    await sms("Rs 3000.00 debited from A/c XX8342 on 05-10-26 to self. -HDFC Bank", SENT_AT);
    await sms("Rs.3000 credited to A/c XX3295 on 05-10-26 from self. -Federal Bank", new Date(SENT_AT.getTime() + 60_000));

    const rows = await models.Transaction.find({ userId });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((entry) => entry.isTransfer && entry.transferPairId && !entry.autoLeg));
    assert.equal(await balanceOf(hdfcId), 7_000_00);
    assert.equal(await balanceOf(federalId), 8_000_00);
  });
});

describe("the backfill", () => {
  it("pairs where the other row is here, writes in where it is not, and runs once", async () => {
    const paired = await oneRowTransfer();
    const credit = await row({ accountId: federalId, type: "CREDIT", occurredAt: new Date("2026-10-05T12:00:00+05:30") });
    const lonely = await oneRowTransfer({ amountMinor: 1_200_00, occurredAt: new Date("2026-10-07T10:00:00+05:30") });
    const nowhere = await row({ accountId: hdfcId, isTransfer: true, transferAccountId: null, amountMinor: 900_00 });
    const cardSide = await row({ accountId: cardId, type: "CREDIT", isTransfer: true, transferAccountId: hdfcId, amountMinor: 4_000_00 });
    const before = { hdfc: await balanceOf(hdfcId), federal: await balanceOf(federalId) };

    const first = await legs.runTransferLegBackfill();
    assert.equal(first.paired, 1);
    assert.equal(first.created, 1);

    assert.ok((await models.Transaction.findById(paired._id).orFail()).transferPairId?.equals(credit._id));
    const written = await models.Transaction.findOne({ autoLegOf: lonely._id }).orFail();
    assert.equal(written.amountMinor, 1_200_00);
    assert.equal((await models.Transaction.findById(nowhere._id).orFail()).transferPairId, null);
    assert.equal((await models.Transaction.findById(cardSide._id).orFail()).transferPairId, null);

    assert.equal(await balanceOf(hdfcId), before.hdfc);
    assert.equal(await balanceOf(federalId), before.federal - 3_000_00, "the double count gone, nothing else");

    const count = await models.Transaction.countDocuments({ userId });
    const second = await legs.runTransferLegBackfill();
    assert.equal(second.users, 0, "done for this user");
    assert.deepEqual(await legs.backfillTransferLegs(userId), { paired: 0, created: 0 }, "and nothing left if run again");
    assert.equal(await models.Transaction.countDocuments({ userId }), count);
  });
});
