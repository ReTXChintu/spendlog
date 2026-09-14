import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayStart } from "../../time";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "statement-routes-secret";
process.env.STATEMENT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let decryptPassword: typeof import("./statements.crypto").decryptPassword;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_statement_routes_test"));

  const [{ app }, auth, loaded, crypt] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./statements.crypto"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  decryptPassword = crypt.decryptPassword;

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
    models.CardStatement.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.Account.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser() {
  const email = `s${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

function call(path: string, token: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

type Counts = { matched: number; added: number; uncertain: number; skipped: number };
type Listed = { counts: Counts };
type Line = { kind: string; resolution: string; transaction: { merchant: string } | null };

async function makeCard(userId: Types.ObjectId, last4 = "1377") {
  return models.Account.create({ userId, bankName: "Example Bank", last4, accountType: "CARD" });
}

async function makeStatement(userId: Types.ObjectId, accountId: Types.ObjectId) {
  return models.CardStatement.create({
    userId,
    accountId,
    sourceRef: `msg-${crypto.randomUUID()}`,
    status: "PARSED",
    statementDate: istDayStart("2026-09-17"),
    lines: [
      {
        date: istDayStart("2026-09-01"),
        description: "FINANCE CHARGES",
        amountMinor: 31875,
        type: "DEBIT",
        kind: "FEE",
        resolution: "SKIPPED",
      },
      {
        date: istDayStart("2026-08-22"),
        description: "PAYMENT RECEIVED - THANK YOU",
        amountMinor: 2500000,
        type: "CREDIT",
        kind: "PAYMENT",
        resolution: "SKIPPED",
      },
    ],
  });
}

describe("statement password", () => {
  it("stores it encrypted and says only that it is set", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);

    const response = await call(`/statements/password/${card._id}`, user.token, {
      method: "PUT",
      body: JSON.stringify({ password: "ABCD1503" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: card._id.toString(),
      hasStatementPassword: true,
    });

    const stored = await models.Account.findById(card._id).orFail();
    assert.notEqual(stored.statementPassword, "ABCD1503");
    assert.equal(decryptPassword(stored.statementPassword), "ABCD1503");
  });

  it("never sends the stored value back out", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);
    await call(`/statements/password/${card._id}`, user.token, {
      method: "PUT",
      body: JSON.stringify({ password: "ABCD1503" }),
    });

    const accounts = await call("/accounts", user.token);
    const body = await accounts.text();
    assert.ok(!body.includes("ABCD1503"));
    assert.ok(!body.includes("statementPassword"), "not even the ciphertext");
    assert.ok(body.includes("hasStatementPassword"));
  });

  it("clears it when given nothing", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);
    const set = () =>
      call(`/statements/password/${card._id}`, user.token, {
        method: "PUT",
        body: JSON.stringify({ password: "ABCD1503" }),
      });

    await set();
    const cleared = await call(`/statements/password/${card._id}`, user.token, {
      method: "PUT",
      body: JSON.stringify({ password: "" }),
    });
    assert.equal((await json<{ hasStatementPassword: boolean }>(cleared)).hasStatementPassword, false);
    assert.equal((await models.Account.findById(card._id).orFail()).statementPassword, null);
  });

  it("will not set a password on someone else's card", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const card = await makeCard(owner.id);

    const response = await call(`/statements/password/${card._id}`, stranger.token, {
      method: "PUT",
      body: JSON.stringify({ password: "ABCD1503" }),
    });
    assert.equal(response.status, 404);
    assert.equal((await models.Account.findById(card._id).orFail()).statementPassword, null);
  });
});

describe("statement routes", () => {
  it("lists statements with what became of each line", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);
    const statement = await makeStatement(user.id, card._id);

    await call(`/statements/${statement._id}/reconcile`, user.token, { method: "POST" });

    const listed = await json<Listed[]>(await call("/statements", user.token));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].counts.added, 1, "the fee");
    assert.equal(listed[0].counts.skipped, 1, "the bill payment");
  });

  it("returns the lines with the transactions they resolved to", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);
    const statement = await makeStatement(user.id, card._id);
    await call(`/statements/${statement._id}/reconcile`, user.token, { method: "POST" });

    const detail = await json<{ lines: Line[] }>(await call(`/statements/${statement._id}`, user.token));
    const fee = detail.lines.find((line) => line.kind === "FEE")!;
    assert.equal(fee.resolution, "ADDED");
    assert.equal(fee.transaction?.merchant, "FINANCE CHARGES");

    const payment = detail.lines.find((line) => line.kind === "PAYMENT")!;
    assert.equal(payment.transaction, null);
  });

  it("takes back only what it added", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);
    const statement = await makeStatement(user.id, card._id);
    await call(`/statements/${statement._id}/reconcile`, user.token, { method: "POST" });
    assert.equal(await models.Transaction.countDocuments({ userId: user.id }), 1);

    const undone = await call(`/statements/${statement._id}/added`, user.token, { method: "DELETE" });
    assert.deepEqual(await undone.json(), { removed: 1 });
    assert.equal(await models.Transaction.countDocuments({ userId: user.id }), 0);
  });

  it("hides another user's statements entirely", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const card = await makeCard(owner.id);
    const statement = await makeStatement(owner.id, card._id);

    assert.equal((await call(`/statements/${statement._id}`, stranger.token)).status, 404);
    assert.equal(
      (await call(`/statements/${statement._id}/reconcile`, stranger.token, { method: "POST" })).status,
      404
    );
    assert.deepEqual(await (await call("/statements", stranger.token)).json(), []);
  });

  it("refuses to re-read one that already worked", async () => {
    // Replacing its lines would orphan the transactions it added, leaving
    // nothing saying where they came from or how to take them back.
    const user = await makeUser();
    const card = await makeCard(user.id);
    const statement = await makeStatement(user.id, card._id);
    await call(`/statements/${statement._id}/reconcile`, user.token, { method: "POST" });

    const response = await call(`/statements/${statement._id}/reread`, user.token, { method: "POST" });
    assert.equal(response.status, 409);
    assert.equal(await models.Transaction.countDocuments({ userId: user.id }), 1);
    assert.equal((await models.CardStatement.findById(statement._id).orFail()).lines.length, 2);
  });

  it("answers 404 for an id that is not one", async () => {
    const user = await makeUser();
    assert.equal((await call("/statements/not-an-id", user.token)).status, 404);
  });

  it("lists statements newest first, whether or not they could be read", async () => {
    // The order this comes back in is the order it is shown in, and the
    // bug was that an unread statement has no statementDate at all. Gmail
    // hands over the newest mail first, so those were created first, and
    // sorting the heap of them by createdAt descending put the oldest at
    // the top. Created here in that same order to keep the bug reachable.
    const user = await makeUser();
    const card = await makeCard(user.id);

    const dated = (day: string, received: string) =>
      models.CardStatement.create({
        userId: user.id,
        accountId: card._id,
        sourceRef: `msg-${crypto.randomUUID()}`,
        subject: day,
        status: "PARSED",
        statementDate: istDayStart(day),
        receivedAt: istDayStart(received),
        lines: [],
      });

    const unread = (received: string) =>
      models.CardStatement.create({
        userId: user.id,
        sourceRef: `msg-${crypto.randomUUID()}`,
        subject: received,
        status: "LOCKED",
        problem: "It is locked",
        receivedAt: istDayStart(received),
        lines: [],
      });

    await unread("2026-09-10");
    await dated("2026-08-01", "2026-08-02");
    await unread("2026-07-11");
    await dated("2026-06-01", "2026-06-02");

    const listed = await json<{ subject: string }[]>(await call("/statements", user.token));

    assert.deepEqual(
      listed.map((statement) => statement.subject),
      ["2026-09-10", "2026-08-01", "2026-07-11", "2026-06-01"]
    );
  });

  it("files statements under their card and their month", async () => {
    const user = await makeUser();
    const hdfc = await makeCard(user.id, "1377");
    const csb = await makeCard(user.id, "6623");

    const on = (accountId: Types.ObjectId | null, day: string) =>
      models.CardStatement.create({
        userId: user.id,
        accountId,
        sourceRef: `msg-${crypto.randomUUID()}`,
        subject: `${accountId === null ? "orphan" : accountId.equals(hdfc._id) ? "hdfc" : "csb"} ${day}`,
        status: "PARSED",
        statementDate: istDayStart(day),
        lines: [],
      });

    await on(hdfc._id, "2026-07-01");
    await on(hdfc._id, "2026-09-01");
    await on(csb._id, "2026-09-03");
    await on(hdfc._id, "2026-09-18");
    await on(null, "2026-08-04");

    type Group = {
      accountId: string;
      last4: string;
      months: { month: string; statements: { subject: string }[] }[];
    };
    const groups = await json<Group[]>(await call("/statements/filed", user.token));

    const filed = groups.find((group) => group.last4 === "1377")!;
    assert.deepEqual(
      filed.months.map((month) => month.month),
      ["2026-09", "2026-07"],
      "newest month first, and a month with nothing in it is not a month"
    );
    assert.deepEqual(
      filed.months[0].statements.map((statement) => statement.subject),
      ["hdfc 2026-09-18", "hdfc 2026-09-01"],
      "and newest first inside the month"
    );

    // One card's statements never appear under another's.
    const other = groups.find((group) => group.last4 === "6623")!;
    assert.equal(other.months.length, 1);
    assert.equal(other.months[0].statements.length, 1);

    // A statement whose card is not known yet is a to-do, not a secret.
    const unknown = groups.find((group) => group.accountId === "unfiled")!;
    assert.equal(unknown.months[0].statements[0].subject, "orphan 2026-08-04");
  });

  it("derives the month a statement is filed under from whatever date it has", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);

    // A locked statement has no statementDate at all, and the month its
    // mail arrived is the only thing left to file it under.
    const locked = await models.CardStatement.create({
      userId: user.id,
      accountId: card._id,
      sourceRef: `msg-${crypto.randomUUID()}`,
      status: "LOCKED",
      receivedAt: istDayStart("2026-09-20"),
      lines: [],
    });

    assert.equal(locked.monthKey, "2026-09");

    type Group = { last4: string; months: { month: string }[] };
    const groups = await json<Group[]>(await call("/statements/filed", user.token));
    assert.equal(groups.find((group) => group.last4 === "1377")!.months[0].month, "2026-09");
  });

  it("offers no file for a statement that has none", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);
    const statement = await makeStatement(user.id, card._id);

    const listed = await json<{ hasFile: boolean }[]>(await call("/statements", user.token));
    assert.equal(listed[0].hasFile, false);

    // And says which of the two reasons it is, rather than a bare 404.
    const response = await call(`/statements/${statement._id}/file`, user.token);
    assert.equal(response.status, 404);
    assert.match((await json<{ error: string }>(response)).error, /Read it again/);
  });

  it("turns nobody away without a token", async () => {
    assert.equal((await fetch(`${baseUrl}/statements`)).status, 401);
  });

  it("does nothing when no mailbox is connected", async () => {
    const user = await makeUser();
    const response = await call("/statements/sync", user.token, { method: "POST" });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      scanned: 0,
      read: 0,
      locked: 0,
      unidentified: 0,
      added: 0,
    });
  });
});
