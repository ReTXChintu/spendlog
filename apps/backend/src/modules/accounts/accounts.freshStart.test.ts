import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "fresh-start-secret";
process.env.FIREBASE_SERVICE_ACCOUNT_FILE = "";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let found: typeof import("./accounts.missingCredits");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_fresh_start_test"));

  const [{ app }, auth, loaded, loadedFound] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./accounts.missingCredits"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  found = loadedFound;

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
let bankId: Types.ObjectId;
let cashId: Types.ObjectId;
let savingsId: Types.ObjectId;
let userCount = 0;

const OPENING_AT = "2026-10-01T00:00:00+05:30";

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.BalanceAlert.deleteMany({}),
    models.BalanceCheckpoint.deleteMany({}),
    models.MissingCredit.deleteMany({}),
  ]);
  const email = `f${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ledgerFrom: "2026-01" });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  const opening = { openingBalanceMinor: 10_000_00, openingBalanceAt: new Date(OPENING_AT) };
  bankId = (await models.Account.create({ userId, bankName: "HDFC", last4: "8342", accountType: "BANK", ...opening }))._id;
  cashId = (await models.Account.create({ userId, bankName: "Cash", accountType: "CASH", ...opening }))._id;
  savingsId = (
    await models.Account.create({ userId, bankName: "SBI", last4: "1111", accountType: "BANK", isSavings: true, ...opening })
  )._id;
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

const post = (path: string, body: unknown = {}) => call(path, { method: "POST", body: JSON.stringify(body) });

async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function row(accountId: Types.ObjectId, type: "DEBIT" | "CREDIT", amountMinor: number, occurredAt: string, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    accountId,
    type,
    amountMinor,
    merchant: "shop@upi",
    source: "SMS",
    occurredAt: new Date(occurredAt),
    ...extra,
  });
}

async function passbook(accountId = bankId) {
  return json(await call(`/accounts/${accountId}/passbook?limit=200`));
}

/**
 * A month of mismatches on the bank: a payment the bank disagrees with, a
 * ₹5,000 credit nobody texted (an open missing credit), an alert about the
 * drift, and an unexplained difference written in to match.
 */
async function aMessyMonth() {
  await row(bankId, "DEBIT", 500_00, "2026-10-05T10:00:00+05:30", { statedBalanceMinor: 9_500_00 });
  await row(bankId, "DEBIT", 200_00, "2026-10-12T10:00:00+05:30", { statedBalanceMinor: 14_300_00 });
  await row(bankId, "DEBIT", 1_000_00, "2026-10-13T10:00:00+05:30", { statedBalanceMinor: 12_000_00 });
  await found.detectMissingCredits(userId);
  const alert = await models.BalanceAlert.create({
    userId,
    accountId: bankId,
    driftMinor: -1_300_00,
    statedMinor: 12_000_00,
    expectedMinor: 13_300_00,
    statedAt: new Date("2026-10-13T10:00:00+05:30"),
  });
  const adjustment = await row(bankId, "DEBIT", 300_00, "2026-10-14T10:00:00+05:30", {
    source: "MANUAL",
    isAdjustment: true,
    needsExplanation: true,
    merchant: "Unexplained difference",
  });
  return { alert, adjustment };
}

describe("starting one account fresh", () => {
  it("makes the figure the new start, now, and keeps the old one", async () => {
    const before = Date.now();
    const response = await post(`/accounts/${bankId}/start-fresh`, { balanceMinor: 12_345_00 });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.openingMinor, 12_345_00);
    assert.ok(new Date(body.openingAt).getTime() >= before);
    assert.deepEqual(body.previous, { minor: 10_000_00, at: new Date(OPENING_AT).toISOString() });

    const account = await models.Account.findById(bankId);
    assert.equal(account!.openingBalanceMinor, 12_345_00);
    assert.equal(account!.openingHistory.length, 1);
    assert.equal(account!.openingHistory[0].minor, 10_000_00);
  });

  it("clears the alerts and missing credits of the old start, and says what stays", async () => {
    const { alert, adjustment } = await aMessyMonth();
    assert.equal((await models.MissingCredit.find({ status: "open" })).length, 1);

    const body = await json(await post(`/accounts/${bankId}/start-fresh`, { balanceMinor: 11_700_00 }));
    assert.equal(body.alertsCleared, 1);
    assert.equal(body.missingCreditsDismissed, 1);
    assert.equal(body.adjustmentsBefore, 1);
    assert.match(body.note, /stays as a transaction, but no longer moves the balance/);

    assert.ok((await models.BalanceAlert.findById(alert._id))!.seenAt);
    const credit = await models.MissingCredit.findOne({ userId });
    assert.equal(credit!.status, "dismissed");
    assert.equal(credit!.dismissedReason, "fresh_start");
    // The adjustment is a transaction like any other, and stays one.
    assert.ok(await models.Transaction.exists({ _id: adjustment._id, needsExplanation: true }));
    const dashboard = await json(await call("/dashboard"));
    assert.ok(!dashboard.todos.some((todo: any) => todo.kind === "balance_alert" || todo.kind === "missing_credit"));
  });

  it("touches no transaction, and no spending figure", async () => {
    await aMessyMonth();
    const rowsBefore = await models.Transaction.find({ userId }).sort({ _id: 1 }).lean();
    const budgetBefore = await json(await call("/budget/monthly"));
    // The list as the app shows it, less the account each row embeds -
    // whose starting balance is the one thing meant to change.
    const list = async () =>
      (await json(await call("/transactions"))).items.map(({ account: _account, ...rest }: any) => rest);
    const listBefore = await list();

    await post(`/accounts/${bankId}/start-fresh`, { balanceMinor: 11_700_00 });

    const rowsAfter = await models.Transaction.find({ userId }).sort({ _id: 1 }).lean();
    assert.deepEqual(rowsAfter, rowsBefore);
    assert.deepEqual(await json(await call("/budget/monthly")), budgetBefore);
    assert.deepEqual(await list(), listBefore);
  });

  it("begins the passbook at the new start, with nothing before it moving the balance", async () => {
    const at = "2026-10-10T00:00:00+05:30";
    // Before the new start: a payment whose message stated a balance, a
    // checkpoint, a written-in transfer leg, and one in the same instant.
    await row(bankId, "DEBIT", 500_00, "2026-10-05T10:00:00+05:30", { statedBalanceMinor: 1_00 });
    await models.BalanceCheckpoint.create({ userId, accountId: bankId, on: new Date("2026-10-08T21:00:00+05:30"), balanceMinor: 99_00, source: "MANUAL" });
    await row(bankId, "CREDIT", 2_000_00, "2026-10-09T10:00:00+05:30", { source: "MANUAL", autoLeg: true, isTransfer: true });
    await row(bankId, "DEBIT", 50_00, at);
    // After it: counted.
    await row(bankId, "DEBIT", 300_00, "2026-10-11T10:00:00+05:30", { statedBalanceMinor: 4_700_00 });

    await post(`/accounts/${bankId}/start-fresh`, { balanceMinor: 5_000_00, at });
    const page = await passbook();
    assert.deepEqual([...page.rows].reverse().map((entry: any) => entry.kind), ["opening", "txn"]);
    assert.equal(page.openingMinor, 5_000_00);
    assert.equal(page.expectedNowMinor, 4_700_00);
    assert.equal(page.firstDrift, null);
    assert.equal(page.lastStated.driftMinor, 0);
    assert.equal(page.account.canUndoFreshStart, true);
  });

  it("is refused for a debit card, an unknown account, or a moment in the future", async () => {
    const card = await models.Account.create({ userId, bankName: "HDFC", last4: "9999", accountType: "DEBIT", linkedAccountId: bankId });
    assert.equal((await post(`/accounts/${card._id}/start-fresh`, { balanceMinor: 1 })).status, 400);
    assert.equal((await post(`/accounts/${new Types.ObjectId()}/start-fresh`, { balanceMinor: 1 })).status, 400);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    assert.equal((await post(`/accounts/${bankId}/start-fresh`, { balanceMinor: 1, at: future })).status, 400);
    assert.equal((await models.Account.findById(bankId))!.openingBalanceMinor, 10_000_00);
  });
});

describe("starting every account fresh at once", () => {
  it("starts each one given, and none left out", async () => {
    const response = await post("/accounts/start-fresh", {
      accounts: [
        { accountId: bankId.toString(), balanceMinor: 20_000_00 },
        { accountId: cashId.toString(), balanceMinor: 1_500_00 },
      ],
    });
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.deepEqual(body.accounts.map((entry: any) => entry.openingMinor), [20_000_00, 1_500_00]);
    assert.equal((await models.Account.findById(bankId))!.openingBalanceMinor, 20_000_00);
    assert.equal((await models.Account.findById(cashId))!.openingBalanceMinor, 1_500_00);
    // The savings account was left empty, so it was left alone.
    assert.equal((await models.Account.findById(savingsId))!.openingHistory.length, 0);
  });

  it("changes nothing when one of them is bad", async () => {
    for (const bad of [new Types.ObjectId().toString(), "not-an-id", bankId.toString()]) {
      const response = await post("/accounts/start-fresh", {
        accounts: [
          { accountId: bankId.toString(), balanceMinor: 20_000_00 },
          { accountId: bad, balanceMinor: 1_500_00 },
        ],
      });
      assert.equal(response.status, 400, bad);
    }
    const bank = await models.Account.findById(bankId);
    assert.equal(bank!.openingBalanceMinor, 10_000_00);
    assert.equal(bank!.openingHistory.length, 0);
  });

  it("lists every bank and cash account with SpendLog's figure and today's word from the bank", async () => {
    await row(bankId, "DEBIT", 500_00, new Date().toISOString(), { statedBalanceMinor: 9_400_00 });
    await row(cashId, "DEBIT", 100_00, "2026-10-03T10:00:00+05:30");
    const rows = await json(await call("/accounts/start-fresh"));
    const bank = rows.find((entry: any) => entry.accountId === bankId.toString());
    assert.equal(bank.expectedMinor, 9_500_00);
    assert.equal(bank.lastStated.minor, 9_400_00);
    assert.equal(bank.statedToday, true);
    const cash = rows.find((entry: any) => entry.accountId === cashId.toString());
    assert.equal(cash.lastStated, null);
    assert.equal(cash.statedToday, false);
    assert.equal(rows.find((entry: any) => entry.accountId === savingsId.toString()).isSavings, true);
  });
});

describe("undoing a fresh start", () => {
  it("puts back the old start and everything it cleared", async () => {
    const { alert } = await aMessyMonth();
    await post(`/accounts/${bankId}/start-fresh`, { balanceMinor: 11_700_00 });

    const response = await post(`/accounts/${bankId}/start-fresh/undo`);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.openingMinor, 10_000_00);
    assert.equal(new Date(body.openingAt).toISOString(), new Date(OPENING_AT).toISOString());
    assert.equal(body.canUndo, false);

    assert.equal((await models.BalanceAlert.findById(alert._id))!.seenAt, null);
    assert.equal((await models.MissingCredit.findOne({ userId }))!.status, "open");
    const page = await passbook();
    assert.ok(page.rows.some((entry: any) => entry.kind === "missing_credit"));

    // Nothing left to undo.
    assert.equal((await post(`/accounts/${bankId}/start-fresh/undo`)).status, 400);
  });

  it("can undo a first-ever start back to no starting balance", async () => {
    const fresh = await models.Account.create({ userId, bankName: "Kotak", last4: "2222", accountType: "BANK" });
    await post(`/accounts/${fresh._id}/start-fresh`, { balanceMinor: 1_000_00 });
    assert.equal((await models.Account.findById(fresh._id))!.openingBalanceMinor, 1_000_00);
    await post(`/accounts/${fresh._id}/start-fresh/undo`);
    const undone = await models.Account.findById(fresh._id);
    assert.equal(undone!.openingBalanceMinor, null);
    assert.equal(undone!.openingBalanceAt, null);
  });
});
