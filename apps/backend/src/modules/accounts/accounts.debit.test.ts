import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayStart } from "../../time";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "debit-card-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let reconcileStatement: typeof import("../statements/statements.reconcile").reconcileStatement;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_debit_test"));

  const [{ app }, auth, loaded, reconcile] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../statements/statements.reconcile"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  reconcileStatement = reconcile.reconcileStatement;

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
// Only what the tests read off it. Account.create resolves to its array
// overload under this typing, so naming the whole document costs more
// than it explains.
let bank: { _id: Types.ObjectId; id?: string };
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.CardStatement.deleteMany({}),
    models.User.deleteMany({}),
  ]);

  const email = `d${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });

  bank = await models.Account.create({
    userId,
    bankName: "HDFC Bank",
    last4: "4821",
    accountType: "BANK",
  });
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

const body = (value: unknown) => ({ body: JSON.stringify(value) });

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("a debit card", () => {
  it("can be linked to the bank account it draws on", async () => {
    const response = await call("/accounts", {
      method: "POST",
      ...body({
        bankName: "HDFC Bank",
        last4: "9012",
        accountType: "DEBIT",
        nickname: "HDFC Debit",
        cardNetwork: "RUPAY",
        linkedAccountId: bank._id.toString(),
      }),
    });

    assert.equal(response.status, 201);
    assert.equal((await json<{ linkedAccountId: string }>(response)).linkedAccountId, bank._id.toString());
  });

  it("can stand alone, for an account SpendLog has never seen", async () => {
    const response = await call("/accounts", {
      method: "POST",
      ...body({ bankName: "Some Bank", last4: "9012", accountType: "DEBIT" }),
    });

    assert.equal(response.status, 201);
    assert.equal((await json<{ linkedAccountId: string | null }>(response)).linkedAccountId, null);
  });

  it("will not draw on a credit card", async () => {
    const card = await models.Account.create({
      userId,
      bankName: "ICICI",
      last4: "1377",
      accountType: "CARD",
    });

    const response = await call("/accounts", {
      method: "POST",
      ...body({
        bankName: "HDFC Bank",
        last4: "9012",
        accountType: "DEBIT",
        linkedAccountId: card._id.toString(),
      }),
    });

    assert.equal(response.status, 400);
    assert.match((await json<{ error: string }>(response)).error, /not one of your bank accounts/);
  });

  it("will not draw on somebody else's account", async () => {
    const stranger = await models.User.create({ email: "stranger@example.com" });
    const theirs = await models.Account.create({
      userId: stranger._id,
      bankName: "Their Bank",
      last4: "0001",
      accountType: "BANK",
    });

    const response = await call("/accounts", {
      method: "POST",
      ...body({
        bankName: "HDFC Bank",
        last4: "9012",
        accountType: "DEBIT",
        linkedAccountId: theirs._id.toString(),
      }),
    });

    assert.equal(response.status, 400);
  });

  it("is only a thing a debit card has", async () => {
    const response = await call("/accounts", {
      method: "POST",
      ...body({
        bankName: "ICICI",
        last4: "1377",
        accountType: "CARD",
        linkedAccountId: bank._id.toString(),
      }),
    });

    assert.equal(response.status, 400);
    assert.match((await json<{ error: string }>(response)).error, /Only a debit card/);
  });

  it("shows on both sides of the link", async () => {
    await call("/accounts", {
      method: "POST",
      ...body({
        bankName: "HDFC Bank",
        last4: "9012",
        accountType: "DEBIT",
        nickname: "HDFC Debit",
        linkedAccountId: bank._id.toString(),
      }),
    });

    type Row = {
      id: string;
      accountType: string;
      linkedAccount: string | null;
      debitCards: { last4: string }[];
    };
    const overview = await json<Row[]>(await call("/accounts/overview"));

    const card = overview.find((row) => row.accountType === "DEBIT")!;
    assert.equal(card.linkedAccount, "HDFC Bank", "the card says what it draws on");

    const account = overview.find((row) => row.id === bank._id.toString())!;
    assert.deepEqual(
      account.debitCards.map((one) => one.last4),
      ["9012"],
      "and the account says which cards reach it"
    );
  });
});

describe("a bank statement, against a debit card's spending", () => {
  it("counts a purchase made on the card once, not twice", async () => {
    const card = await models.Account.create({
      userId,
      bankName: "HDFC Bank",
      last4: "9012",
      accountType: "DEBIT",
      linkedAccountId: bank._id,
    });

    // An SMS about a debit card purchase, filed under the card rather than
    // the account it drew on. Before the reconciler looked through the
    // link, the account's own statement could not see this row and would
    // decide the purchase was missing.
    await models.Transaction.create({
      userId,
      accountId: card._id,
      amountMinor: 43250,
      type: "DEBIT",
      merchant: "SWIGGY",
      source: "SMS",
      occurredAt: istDayStart("2026-09-14"),
    });

    const statement = await models.CardStatement.create({
      userId,
      accountId: bank._id,
      sourceRef: `msg-${crypto.randomUUID()}`,
      mailKey: `msg-${crypto.randomUUID()}#statement.pdf`,
      kind: "BANK",
      status: "PARSED",
      statementDate: istDayStart("2026-09-30"),
      lines: [
        {
          date: istDayStart("2026-09-14"),
          description: "POS SWIGGY BANGALORE",
          amountMinor: 43250,
          type: "DEBIT",
          kind: "SPEND",
          resolution: "SKIPPED",
        },
      ],
    });

    const summary = await reconcileStatement(statement);

    assert.equal(summary.matched, 1, "the statement recognised the row it already had");
    assert.equal(summary.added, 0, "and added nothing");
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);
  });

  it("still adds one the ledger genuinely does not have", async () => {
    const statement = await models.CardStatement.create({
      userId,
      accountId: bank._id,
      sourceRef: `msg-${crypto.randomUUID()}`,
      mailKey: `msg-${crypto.randomUUID()}#statement.pdf`,
      kind: "BANK",
      status: "PARSED",
      statementDate: istDayStart("2026-09-30"),
      lines: [
        {
          date: istDayStart("2026-09-14"),
          description: "POS SWIGGY BANGALORE",
          amountMinor: 43250,
          type: "DEBIT",
          kind: "SPEND",
          resolution: "SKIPPED",
        },
      ],
    });

    const summary = await reconcileStatement(statement);
    assert.equal(summary.added, 1);

    const added = await models.Transaction.findOne({ userId });
    assert.equal(
      added?.accountId?.toString(),
      bank._id.toString(),
      "filed under the account, which is where the money moved"
    );
  });
});
