import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayEnd, istDayStart } from "../../time";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "bank-checkpoint-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let parse: typeof import("./statements.parse");
let reconcile: typeof import("./statements.reconcile");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_bank_checkpoint_test"));

  const [{ app }, auth, loaded, loadedParse, loadedReconcile] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./statements.parse"),
    import("./statements.reconcile"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  parse = loadedParse;
  reconcile = loadedReconcile;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

/** The bank statement from statements.bank.test.ts, with its running balance column. */
const BANK_ROWS = [
  "HDFC BANK LTD - STATEMENT OF ACCOUNT",
  "Account No: 50100XXXXXX4821",
  "Date Narration Chq/Ref No Value Dt Withdrawal Amt Deposit Amt Closing Balance",
  "13/09/26 OPENING BALANCE 45,752.60",
  "14/09/26 UPI-SWIGGY-SWIGGY@ICICI-123456 UPI-123456789 14/09/26 432.50 45,320.10",
  "15/09/26 SALARY SEP 2026 NEFT-0099887 15/09/26 96,000.00 1,41,320.10",
  "16/09/26 CC PAYMENT ICICI 2009 BBPS-556677 16/09/26 29,693.53 1,11,626.57",
  "17/09/26 UPI-MUKHWAS PAN PARLOUR-Q@ybl UPI-778899 17/09/26 102.00 1,11,524.57",
];

let token: string;
let userId: Types.ObjectId;
let bankId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.CardStatement.deleteMany({}),
    models.BalanceCheckpoint.deleteMany({}),
  ]);
  const email = `bc${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ledgerFrom: "2026-01" });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  const bank = await models.Account.create({
    userId,
    bankName: "HDFC Bank",
    last4: "4821",
    accountType: "BANK",
    openingBalanceMinor: 45_752_60,
    openingBalanceAt: istDayStart("2026-09-13"),
  });
  bankId = bank._id;
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

async function bankStatement() {
  const parsed = parse.parseStatementRows(BANK_ROWS);
  assert.equal(parsed.kind, "BANK");
  return models.CardStatement.create({
    userId,
    accountId: bankId,
    sourceRef: `msg-${crypto.randomUUID()}#att`,
    kind: "BANK",
    status: "PARSED",
    statementDate: istDayStart("2026-09-18"),
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    lines: parsed.lines.map((line) => ({ ...line, resolution: "SKIPPED", transactionId: null })),
  });
}

/** The Swiggy payment, already in from its SMS, with no balance in it. */
async function swiggyFromSms() {
  return models.Transaction.create({
    userId,
    accountId: bankId,
    type: "DEBIT",
    amountMinor: 432_50,
    merchant: "swiggy@icici",
    source: "SMS",
    occurredAt: new Date("2026-09-14T13:00:00+05:30"),
  });
}

describe("a bank statement's balances", () => {
  it("keeps the balance column on the lines", async () => {
    const statement = await bankStatement();
    assert.deepEqual(
      statement.lines.map((line) => line.balanceMinor),
      [45_320_10, 1_41_320_10, 1_11_626_57, 1_11_524_57]
    );
  });

  it("become stated balances on the rows, and the close becomes a checkpoint", async () => {
    const swiggy = await swiggyFromSms();
    const statement = await bankStatement();

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.matched, 1);
    assert.equal(summary.added, 3);

    assert.equal((await models.Transaction.findById(swiggy._id))?.statedBalanceMinor, 45_320_10, "filled where the SMS had none");
    const salary = await models.Transaction.findOne({ userId, merchant: /SALARY/ }).orFail();
    assert.equal(salary.statedBalanceMinor, 1_41_320_10);

    const checkpoints = await models.BalanceCheckpoint.find({ userId });
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].source, "STATEMENT");
    assert.equal(checkpoints[0].balanceMinor, 1_11_524_57);
    assert.ok(checkpoints[0].accountId.equals(bankId));
    assert.ok(checkpoints[0].statementId?.equals(statement._id));
    assert.equal(checkpoints[0].on.toISOString(), istDayEnd("2026-09-17").toISOString());

    // Read again: still one.
    await reconcile.reconcileStatement(statement);
    assert.equal(await models.BalanceCheckpoint.countDocuments({ userId }), 1);
  });

  it("does not overwrite a balance the SMS already gave", async () => {
    const swiggy = await swiggyFromSms();
    swiggy.statedBalanceMinor = 45_320_00;
    await swiggy.save();
    await reconcile.reconcileStatement(await bankStatement());
    assert.equal((await models.Transaction.findById(swiggy._id))?.statedBalanceMinor, 45_320_00);
  });

  it("shows in the passbook as a checkpoint the app is set against", async () => {
    await swiggyFromSms();
    await reconcile.reconcileStatement(await bankStatement());

    const page = await json(await call(`/accounts/${bankId}/passbook`));
    assert.equal(page.rows[0].kind, "checkpoint");
    assert.equal(page.rows[0].source, "STATEMENT");
    assert.equal(page.rows[0].statedMinor, 1_11_524_57);
    assert.equal(page.rows[0].driftMinor, 0);
    assert.equal(page.firstDrift, null);
  });

  it("goes when the statement's rows are taken back", async () => {
    const statement = await bankStatement();
    await reconcile.reconcileStatement(statement);
    await reconcile.unpickStatement(userId, statement._id);
    assert.equal(await models.BalanceCheckpoint.countDocuments({ userId }), 0);
  });

  it("is left alone on a card statement", async () => {
    const card = await models.Account.create({ userId, bankName: "ICICI Bank", last4: "2009", accountType: "CARD" });
    const statement = await models.CardStatement.create({
      userId,
      accountId: card._id,
      sourceRef: `msg-${crypto.randomUUID()}#att`,
      kind: "CARD",
      status: "PARSED",
      statementDate: istDayStart("2026-09-18"),
      lines: [{ date: istDayStart("2026-09-01"), description: "FINANCE CHARGES", amountMinor: 318_75, type: "DEBIT", kind: "FEE", resolution: "SKIPPED" }],
    });
    await reconcile.reconcileStatement(statement);
    assert.equal(await models.BalanceCheckpoint.countDocuments({ userId }), 0);
  });
});

describe("comparing a bank statement with the ledger", () => {
  it("lists both sides and sets the close against the app's running balance", async () => {
    const swiggy = await swiggyFromSms();
    // In the app, not on the statement.
    const stray = await models.Transaction.create({
      userId,
      accountId: bankId,
      type: "DEBIT",
      amountMinor: 999_00,
      merchant: "Stray",
      source: "MANUAL",
      occurredAt: new Date("2026-09-15T10:00:00+05:30"),
    });
    const statement = await bankStatement();
    await reconcile.reconcileStatement(statement);

    const result = await json(await call(`/statements/${statement._id}/compare`));
    assert.equal(result.kind, "BANK");
    assert.equal(result.matched, 1);
    assert.deepEqual(result.pairs, [{ lineId: statement.lines[0]._id.toString(), transactionId: swiggy._id.toString() }]);

    // What the statement found missing - now in, and saying which row each became.
    assert.deepEqual(
      result.onStatementNotInApp.map((line: any) => [line.description, line.amountMinor, line.type]),
      [
        ["SALARY SEP 2026", 96_000_00, "CREDIT"],
        ["CC PAYMENT ICICI 2009", 29_693_53, "DEBIT"],
        ["UPI-MUKHWAS PAN PARLOUR-Q@ybl", 102_00, "DEBIT"],
      ]
    );
    assert.ok(result.onStatementNotInApp.every((line: any) => typeof line.addedTransactionId === "string"));

    assert.deepEqual(result.inAppNotOnStatement.map((row: any) => row.transactionId), [stray._id.toString()]);

    assert.equal(result.closingBalanceMinor, 1_11_524_57);
    assert.equal(result.closingOn, istDayEnd("2026-09-17").toISOString());
    // Opening less Swiggy, plus salary, less the card bill, less the pan
    // parlour, less the stray row the bank never saw.
    assert.equal(result.expectedAtClosingMinor, 45_752_60 - 432_50 + 96_000_00 - 29_693_53 - 102_00 - 999_00);
    assert.equal(result.differenceMinor, 999_00);
  });

  it("has nothing to set a card statement's close against", async () => {
    const card = await models.Account.create({ userId, bankName: "ICICI Bank", last4: "2009", accountType: "CARD" });
    const statement = await models.CardStatement.create({
      userId,
      accountId: card._id,
      sourceRef: `msg-${crypto.randomUUID()}#att`,
      kind: "CARD",
      status: "PARSED",
      totalDueMinor: 12_000_00,
      statementDate: istDayStart("2026-09-18"),
      lines: [{ date: istDayStart("2026-09-01"), description: "AMAZON", amountMinor: 1_240_00, type: "DEBIT", kind: "SPEND", resolution: "SKIPPED" }],
    });
    const result = await json(await call(`/statements/${statement._id}/compare`));
    assert.equal(result.kind, "CARD");
    assert.equal(result.onStatementNotInApp.length, 1);
    assert.equal(result.closingBalanceMinor, 12_000_00);
    assert.equal(result.expectedAtClosingMinor, null);
    assert.equal(result.differenceMinor, null);
  });
});
