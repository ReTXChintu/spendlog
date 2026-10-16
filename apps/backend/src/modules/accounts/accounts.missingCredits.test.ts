import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "missing-credit-secret";
process.env.FIREBASE_SERVICE_ACCOUNT_FILE = "";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let found: typeof import("./accounts.missingCredits");
let drift: typeof import("./accounts.drift");
let ingest: typeof import("../../parsing/ingest");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_missing_credit_test"));

  const [{ app }, auth, loaded, loadedFound, loadedDrift, loadedIngest] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./accounts.missingCredits"),
    import("./accounts.drift"),
    import("../../parsing/ingest"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  found = loadedFound;
  drift = loadedDrift;
  ingest = loadedIngest;

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
/// Federal Bank ••5130: texts debits with the balance after, never credits.
let federalId: Types.ObjectId;
/// HDFC ••8342: the user's other bank, which texts its debits too.
let hdfcId: Types.ObjectId;
let userCount = 0;

const OPENING_AT = "2026-10-01T00:00:00+05:30";
// A quarter to eleven at night, IST, on the 15th: tonight's check is due.
const TONIGHT = new Date("2026-10-15T22:45:00+05:30");

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.BalanceAlert.deleteMany({}),
    models.BalanceCheckpoint.deleteMany({}),
    models.MissingCredit.deleteMany({}),
    models.Contact.deleteMany({}),
    models.CardStatement.deleteMany({}),
    models.JobRun.deleteMany({}),
  ]);
  const email = `m${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ledgerFrom: "2026-01" });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  federalId = (
    await models.Account.create({
      userId,
      bankName: "Federal Bank",
      last4: "5130",
      accountType: "BANK",
      openingBalanceMinor: 10_000_00,
      openingBalanceAt: new Date(OPENING_AT),
    })
  )._id;
  hdfcId = (
    await models.Account.create({
      userId,
      bankName: "HDFC",
      last4: "8342",
      accountType: "BANK",
      openingBalanceMinor: 50_000_00,
      openingBalanceAt: new Date(OPENING_AT),
    })
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

/** A row as a bank's SMS would leave it. */
function row(
  accountId: Types.ObjectId,
  type: "DEBIT" | "CREDIT",
  amountMinor: number,
  occurredAt: string,
  statedBalanceMinor: number | null = null,
  extra: Record<string, unknown> = {}
) {
  return models.Transaction.create({
    userId,
    accountId,
    type,
    amountMinor,
    merchant: type === "DEBIT" ? "shop@upi" : "someone@upi",
    source: "SMS",
    sources: [{ source: "SMS", rawText: "text", receivedAt: new Date(occurredAt) }],
    occurredAt: new Date(occurredAt),
    statedBalanceMinor,
    ...extra,
  });
}

/**
 * The Federal Bank story: ₹500 out on the 5th, and the bank agrees
 * (₹9,500); ₹200 out on the 12th, and the bank says ₹14,300 - ₹5,000 more
 * than the ₹9,300 SpendLog expects. Money came in between, untexted.
 */
async function fiveThousandCameIn() {
  const first = await row(federalId, "DEBIT", 500_00, "2026-10-05T10:00:00+05:30", 9_500_00);
  const second = await row(federalId, "DEBIT", 200_00, "2026-10-12T10:00:00+05:30", 14_300_00);
  return { first, second };
}

const detect = () => found.detectMissingCredits(userId);

async function openCredits() {
  return models.MissingCredit.find({ userId, status: "open" });
}

async function passbook(accountId = federalId) {
  return json(await call(`/accounts/${accountId}/passbook?limit=200`));
}

describe("finding money that came in without a text", () => {
  it("records exactly the amount the bank's two figures say arrived between them", async () => {
    const { first, second } = await fiveThousandCameIn();
    const result = await detect();

    assert.equal(result.created.length, 1);
    const [credit] = await openCredits();
    assert.equal(credit.amountMinor, 5_000_00);
    assert.ok(credit.accountId.equals(federalId));
    assert.equal(credit.after.toISOString(), first.occurredAt.toISOString());
    assert.equal(credit.before.toISOString(), second.occurredAt.toISOString());
    assert.ok(credit.afterTransactionId?.equals(first._id));
    assert.ok(credit.beforeTransactionId?.equals(second._id));
    // A to-do, not a transaction: nothing was written to the ledger.
    assert.equal(await models.Transaction.countDocuments({ userId, type: "CREDIT" }), 0);
  });

  it("measures from the starting balance and from checkpoints too", async () => {
    // Nothing moved, and a checkpoint typed in says ₹2,000 more.
    await models.BalanceCheckpoint.create({
      userId,
      accountId: federalId,
      on: new Date("2026-10-08T21:00:00+05:30"),
      balanceMinor: 12_000_00,
      source: "MANUAL",
    });
    await detect();
    const [credit] = await openCredits();
    assert.equal(credit.amountMinor, 2_000_00);
    assert.equal(credit.after.toISOString(), new Date(OPENING_AT).toISOString());
    assert.equal(credit.afterTransactionId, null);
    assert.ok(credit.beforeCheckpointId);
  });

  it("ignores a rupee of rounding", async () => {
    await row(federalId, "DEBIT", 500_00, "2026-10-05T10:00:00+05:30", 9_500_80);
    await row(federalId, "DEBIT", 200_00, "2026-10-12T10:00:00+05:30", 9_301_00);
    await detect();
    assert.equal((await openCredits()).length, 0);
  });

  it("finds no missing credit where money went out unexplained", async () => {
    await row(federalId, "DEBIT", 500_00, "2026-10-05T10:00:00+05:30", 9_500_00);
    await row(federalId, "DEBIT", 200_00, "2026-10-12T10:00:00+05:30", 8_300_00);
    await detect();
    assert.equal((await openCredits()).length, 0);

    // The reconciler still names the days a payment went missing in.
    const reconcile = await json(await call(`/accounts/${federalId}/reconcile`));
    assert.ok(reconcile.suspects.some((suspect: any) => suspect.kind === "missing_days"));
    assert.ok(!reconcile.suspects.some((suspect: any) => suspect.kind === "missing_credit"));
  });

  it("is one record however often the same gap is found", async () => {
    await fiveThousandCameIn();
    await detect();
    const again = await detect();
    assert.equal(again.created.length, 0);
    await drift.runNightlyDriftCheck(TONIGHT);
    assert.equal(await models.MissingCredit.countDocuments({ userId }), 1);
  });

  it("closes on its own once the user adds the row that explains it", async () => {
    await fiveThousandCameIn();
    await detect();

    const added = await post("/transactions", {
      type: "CREDIT",
      amountMinor: 5_000_00,
      merchant: "Dad",
      accountId: federalId.toString(),
      occurredAt: "2026-10-08T12:00:00+05:30",
    });
    assert.equal(added.status, 201);

    assert.deepEqual(await json(await call("/accounts/missing-credits")), []);
    const credit = await models.MissingCredit.findOne({ userId });
    assert.equal(credit!.status, "resolved");
    assert.equal(credit!.resolvedAs, "gap_closed");
    const dashboard = await json(await call("/dashboard"));
    assert.ok(!dashboard.todos.some((todo: any) => todo.kind === "missing_credit"));

    // Deleted again, the gap is back - and so is the same record.
    await call(`/transactions/${(await json(added)).id}`, { method: "DELETE" });
    await detect();
    const reopened = await models.MissingCredit.find({ userId });
    assert.equal(reopened.length, 1);
    assert.equal(reopened[0].status, "open");
  });

  it("is found as soon as a message stating a balance arrives", async () => {
    const hdfc = await models.Account.create({
      userId,
      bankName: "HDFC Bank",
      last4: "4821",
      accountType: "BANK",
      openingBalanceMinor: 10_000_00,
      openingBalanceAt: new Date(OPENING_AT),
    });
    const sms = (rawText: string, at: string) =>
      ingest.ingestRawMessage({ userId, rawText, source: "SMS", sourceRef: null, receivedAt: new Date(at) });
    await sms(
      "Rs 500.00 debited from A/c XX4821 on 02-10-26 to VPA zepto@ybl Ref 111222333. Avl Bal Rs 9,500.00 -HDFC Bank",
      "2026-10-02T10:00:00+05:30"
    );
    assert.equal((await openCredits()).length, 0);
    await sms(
      "Rs 200.00 debited from A/c XX4821 on 04-10-26 to VPA swiggy@icici Ref 777888999. Avl Bal Rs 12,300.00 -HDFC Bank",
      "2026-10-04T10:00:00+05:30"
    );
    const [credit] = await openCredits();
    assert.ok(credit.accountId.equals(hdfc._id));
    assert.equal(credit.amountMinor, 3_000_00);
  });

  it("counts toward nothing until it is answered", async () => {
    await fiveThousandCameIn();
    await detect();
    const before = await json(await call("/budget/monthly"));
    const transactions = await json(await call("/transactions"));
    assert.equal(transactions.total, 2);
    assert.ok(!transactions.items.some((item: any) => item.type === "CREDIT"));
    // Found or not, the month reads the same: it is not income.
    await models.MissingCredit.deleteMany({});
    assert.deepEqual(await json(await call("/budget/monthly")), before);
  });
});

describe("the passbook and the balances, with money still unexplained", () => {
  it("shows an amber row just before the figure that revealed it, so the column matches the bank", async () => {
    const { second } = await fiveThousandCameIn();
    await detect();
    const page = await passbook();

    const kinds = [...page.rows].reverse().map((entry: any) => entry.kind);
    assert.deepEqual(kinds, ["opening", "txn", "missing_credit", "txn"]);
    const provisional = page.rows.find((entry: any) => entry.kind === "missing_credit");
    assert.equal(provisional.amountMinor, 5_000_00);
    assert.equal(provisional.type, "CREDIT");
    assert.equal(provisional.runningMinor, 14_500_00);
    assert.ok(provisional.missingCreditId);
    assert.equal(new Date(provisional.windowStart).toISOString(), new Date("2026-10-05T10:00:00+05:30").toISOString());
    const revealing = page.rows.find((entry: any) => entry.transactionId === second._id.toString());
    assert.equal(revealing.runningMinor, 14_300_00);
    assert.equal(revealing.driftMinor, 0);
    assert.equal(page.expectedNowMinor, 14_300_00);
    assert.equal(page.provisionalMinor, 5_000_00);
    assert.equal(page.firstDrift, null);
  });

  it("is in the overview's and the dashboard's balance, and said as provisional", async () => {
    await fiveThousandCameIn();
    await detect();
    const overview = await json(await call("/accounts/overview"));
    const federal = overview.find((account: any) => account.id === federalId.toString());
    assert.equal(federal.balance.expectedMinor, 14_300_00);
    assert.equal(federal.balance.provisionalMinor, 5_000_00);
    // Not money in: it is not a transaction.
    assert.equal(federal.balance.inMinor, 0);
    assert.equal(federal.balance.drift, null);

    const dashboard = await json(await call("/dashboard"));
    const face = dashboard.wallet.banks.find((bank: any) => bank.accountId === federalId.toString());
    assert.equal(face.balanceMinor, 14_300_00);
    assert.equal(face.provisionalMinor, 5_000_00);
    assert.equal(face.drift, null);
  });

  it("is not alerted a second time as a drift", async () => {
    await fiveThousandCameIn();
    const run = await drift.runNightlyDriftCheck(TONIGHT);
    assert.equal(run.missingCredits, 1);
    assert.equal(run.alerts, 0);
  });
});

describe("answering what came in", () => {
  async function theCredit() {
    await fiveThousandCameIn();
    await detect();
    return (await openCredits())[0];
  }

  async function resolve(id: Types.ObjectId, body: Record<string, unknown>) {
    return post(`/accounts/missing-credits/${id}/resolve`, body);
  }

  it("from my other account, pairing with the debit that bank already texted", async () => {
    const credit = await theCredit();
    const debit = await row(hdfcId, "DEBIT", 5_000_00, "2026-10-11T09:00:00+05:30", 45_000_00);

    const response = await resolve(credit._id, { as: "transfer", fromAccountId: hdfcId.toString() });
    assert.equal(response.status, 201);
    const body = await json(response);
    assert.equal(body.transferLeg.action, "paired");
    assert.equal(body.transferLeg.transactionId, debit._id.toString());
    assert.equal(body.transaction.isTransfer, true);
    assert.equal(body.transaction.countedReason, "TRANSFER");
    assert.equal(body.transaction.amountMinor, 5_000_00);
    assert.equal(body.missingCredit.status, "resolved");
    assert.equal(body.missingCredit.resolvedAs, "transfer");

    // Dated inside the window, so the bank's figure on the 12th agrees.
    const at = new Date(body.transaction.occurredAt).getTime();
    assert.ok(at > credit.after.getTime() && at < credit.before.getTime());
    const page = await passbook();
    assert.ok(!page.rows.some((entry: any) => entry.kind === "missing_credit"));
    assert.equal(page.expectedNowMinor, 14_300_00);
    assert.equal(page.provisionalMinor, 0);
    assert.equal((await models.Transaction.findById(debit._id))!.transferPairId?.toString(), body.transaction.id);
  });

  it("from my other account, writing its side in when that bank sent nothing", async () => {
    const credit = await theCredit();
    const body = await json(await resolve(credit._id, { as: "transfer", fromAccountId: hdfcId.toString() }));
    assert.equal(body.transferLeg.action, "created");
    const leg = await models.Transaction.findById(body.transferLeg.transactionId);
    assert.ok(leg!.autoLeg);
    assert.ok(leg!.accountId!.equals(hdfcId));
    assert.equal(leg!.type, "DEBIT");
  });

  it("refuses a transfer from the account it came into", async () => {
    const credit = await theCredit();
    const response = await resolve(credit._id, { as: "transfer", fromAccountId: federalId.toString() });
    assert.equal(response.status, 400);
    assert.equal((await models.MissingCredit.findById(credit._id))!.status, "open");
  });

  it("salary", async () => {
    const credit = await theCredit();
    const body = await json(await resolve(credit._id, { as: "salary" }));
    assert.equal(body.transaction.isSalary, true);
    assert.equal(body.transaction.merchant, "Salary");
    assert.equal(body.transaction.countedReason, "FULL");
  });

  it("a refund, linked to the purchase", async () => {
    const credit = await theCredit();
    const purchase = await row(hdfcId, "DEBIT", 6_000_00, "2026-10-03T10:00:00+05:30", null, { merchant: "Amazon" });
    const body = await json(await resolve(credit._id, { as: "refund", refundOf: purchase._id.toString() }));
    assert.equal(body.transaction.countedReason, "REFUND");
    assert.equal(body.transaction.merchant, "Refund from Amazon");
    const after = await models.Transaction.findById(purchase._id);
    assert.equal(after!.refundedMinor, 5_000_00);
    assert.equal(after!.countedAmountMinor, 1_000_00);
  });

  it("a refund with no purchase named yet", async () => {
    const credit = await theCredit();
    const body = await json(await resolve(credit._id, { as: "refund" }));
    assert.equal(body.transaction.merchant, "Refund");
    assert.deepEqual(body.transaction.refundOf, []);
  });

  it("someone paying me back, as a settlement with them", async () => {
    const credit = await theCredit();
    const contact = await models.Contact.create({ userId, name: "Rahul", openingBalanceMinor: 5_000_00 });
    const body = await json(await resolve(credit._id, { as: "paid_back", contactId: contact._id.toString() }));
    assert.equal(body.transaction.isSettlement, true);
    assert.equal(body.transaction.countedReason, "SETTLEMENT");
    assert.deepEqual(
      body.transaction.people.map((person: any) => [person.contactId, person.amountMinor]),
      [[contact._id.toString(), 5_000_00]]
    );
    const rahul = await json(await call(`/contacts/${contact._id}`));
    assert.equal(rahul.balanceMinor, 0);
  });

  it("other income, in the category picked", async () => {
    const credit = await theCredit();
    const category = await models.Category.create({ userId, name: "Freelance", direction: "IN" });
    const body = await json(await resolve(credit._id, { as: "income", categoryId: category._id.toString(), note: "Logo" }));
    assert.equal(body.transaction.categoryId, category._id.toString());
    assert.equal(body.transaction.merchant, "Freelance");
    assert.equal(body.transaction.note, "Logo");
    assert.equal(body.transaction.countedReason, "FULL");
  });

  it("on a day the user names, held to the window", async () => {
    const credit = await theCredit();
    const outside = await resolve(credit._id, { as: "salary", on: "2026-10-20T12:00:00+05:30" });
    assert.equal(outside.status, 400);
    const body = await json(await resolve(credit._id, { as: "salary", on: "2026-10-09T12:00:00+05:30" }));
    assert.equal(new Date(body.transaction.occurredAt).toISOString(), new Date("2026-10-09T12:00:00+05:30").toISOString());
    // Once answered, it cannot be answered again.
    assert.equal((await resolve(credit._id, { as: "salary" })).status, 409);
  });

  it("not sure: dismissed, and the gap is a gap again", async () => {
    const credit = await theCredit();
    const response = await post(`/accounts/missing-credits/${credit._id}/dismiss`);
    assert.equal(response.status, 200);
    assert.equal((await json(response)).status, "dismissed");
    assert.deepEqual(await json(await call("/accounts/missing-credits")), []);

    const page = await passbook();
    assert.ok(!page.rows.some((entry: any) => entry.kind === "missing_credit"));
    assert.equal(page.lastStated.driftMinor, 5_000_00);
    // And it is not found again.
    await detect();
    assert.equal((await openCredits()).length, 0);
  });
});

describe("what it most likely was", () => {
  it("names the matching debit on another account, the salary, and who owes that much", async () => {
    await models.User.updateOne({ _id: userId }, { $set: { salaryDay: 10, salaryAmountMinor: 5_200_00 } });
    await fiveThousandCameIn();
    const debit = await row(hdfcId, "DEBIT", 5_000_00, "2026-10-11T09:00:00+05:30");
    // Already someone's leg: not a candidate.
    await row(hdfcId, "DEBIT", 5_000_00, "2026-10-10T09:00:00+05:30", null, { transferPairId: new Types.ObjectId() });
    const rahul = await models.Contact.create({ userId, name: "Rahul", openingBalanceMinor: 5_000_00 });
    await models.Contact.create({ userId, name: "Asha", openingBalanceMinor: 2_000_00 });
    await detect();

    const [listed] = await json(await call("/accounts/missing-credits?status=open"));
    assert.equal(listed.title, "₹5,000 came into Federal Bank ••5130 between 5 and 12 Oct");
    assert.deepEqual(
      listed.suggestions.map((suggestion: any) => suggestion.as),
      ["transfer", "salary", "paid_back"]
    );
    const [transfer, , paidBack] = listed.suggestions;
    assert.equal(transfer.fromAccountId, hdfcId.toString());
    assert.equal(transfer.transactionId, debit._id.toString());
    assert.equal(transfer.label, "From HDFC ••8342 — you sent ₹5,000 on 11 Oct");
    assert.equal(paidBack.contactId, rahul._id.toString());

    const dashboard = await json(await call("/dashboard"));
    const todo = dashboard.todos.find((entry: any) => entry.kind === "missing_credit");
    assert.equal(todo.title, "₹5,000 came into Federal Bank ••5130 between 5 and 12 Oct");
    assert.equal(todo.body, "What was it?");
    assert.equal(todo.missingCreditId, listed.id);
    assert.equal(todo.suggestions.length, 3);
  });

  it("offers no salary when pay day is outside the window or the amount is far off", async () => {
    await models.User.updateOne({ _id: userId }, { $set: { salaryDay: 20, salaryAmountMinor: 5_000_00 } });
    await fiveThousandCameIn();
    await detect();
    const [listed] = await json(await call("/accounts/missing-credits"));
    assert.deepEqual(listed.suggestions, []);

    assert.equal(found.windowHasPayDay(new Date("2026-10-05T10:00:00+05:30"), new Date("2026-10-12T10:00:00+05:30"), 10), true);
    assert.equal(found.windowHasPayDay(new Date("2026-10-05T10:00:00+05:30"), new Date("2026-10-12T10:00:00+05:30"), 20), false);
    // The 31st in a 30-day month is the 30th.
    assert.equal(found.windowHasPayDay(new Date("2026-09-29T10:00:00+05:30"), new Date("2026-10-01T09:00:00+05:30"), 31), true);
  });
});

describe("a bank that doesn't text money in", () => {
  beforeEach(async () => {
    await models.Account.updateOne({ _id: federalId }, { $set: { noCreditAlerts: true, last4: "3295" } });
  });

  it("says in the drift alert that the gap is probably money in", async () => {
    await fiveThousandCameIn();
    await detect();
    // Not sure what it was: the gap is a drift again, and alerted.
    const [credit] = await openCredits();
    await post(`/accounts/missing-credits/${credit._id}/dismiss`);
    const alerts = await drift.checkDriftForUser(userId);
    assert.equal(alerts.length, 1);

    const [listed] = await json(await call("/accounts/alerts"));
    assert.equal(
      listed.title,
      "Federal Bank ••3295 is ₹5,000 short of the bank since 12 Oct — probably money that came in without a text"
    );
    assert.match(listed.body, /doesn't text about money coming in/);

    // An account whose bank does text credits keeps the plain wording.
    const plain = drift.alertTitle(
      { bankName: "HDFC", last4: "8342", nickname: null },
      { driftMinor: 5_000_00, since: new Date("2026-10-12T10:00:00+05:30"), statedAt: new Date() }
    );
    assert.equal(plain, "HDFC ••8342 is ₹5,000 off since 12 Oct");
  });

  it("puts a missing credit first when the app shows less than the bank", async () => {
    await fiveThousandCameIn();
    // A doubled debit that is exactly the gap would otherwise lead.
    await row(federalId, "DEBIT", 1_000_00, "2026-10-06T10:00:00+05:30");
    await row(federalId, "DEBIT", 1_000_00, "2026-10-06T10:02:00+05:30");
    const reconcile = await json(await call(`/accounts/${federalId}/reconcile`));
    assert.equal(reconcile.suspects[0].kind, "missing_credit");
    assert.match(reconcile.suspects[0].explanation, /doesn't text you about money coming in/);
  });

  it("asks for last month's statement once a month, after the 5th", async () => {
    const on16th = new Date("2026-10-16T10:00:00+05:30");
    const todos = await drift.statementDueTodos(userId, on16th);
    assert.equal(todos.length, 1);
    assert.deepEqual(
      { ...todos[0] },
      {
        kind: "statement_due",
        title: "Upload Federal Bank ••3295's statement for September to catch credits it didn't text you about",
        body: todos[0].body,
        accountId: federalId.toString(),
        month: "2026-09",
      }
    );
    // Before the 6th, nothing; a bank that texts credits, never.
    assert.deepEqual(await drift.statementDueTodos(userId, new Date("2026-10-05T10:00:00+05:30")), []);
    assert.equal((await drift.balanceTodos(userId, on16th)).filter((todo) => todo.kind === "statement_due").length, 1);
  });

  it("stops asking once a statement covering the month is read, or the month is waved away", async () => {
    const on16th = new Date("2026-10-16T10:00:00+05:30");
    await models.CardStatement.create({
      userId,
      accountId: federalId,
      sourceRef: "mail-1",
      kind: "BANK",
      status: "PARSED",
      periodStart: new Date("2026-09-01T00:00:00+05:30"),
      periodEnd: new Date("2026-09-30T00:00:00+05:30"),
    });
    assert.deepEqual(await drift.statementDueTodos(userId, on16th), []);

    // November asks for October, until dismissed for October.
    const on8thNov = new Date("2026-11-08T10:00:00+05:30");
    assert.equal((await drift.statementDueTodos(userId, on8thNov) as any[])[0].month, "2026-10");
    const dismissed = await post(`/accounts/${federalId}/statement-due/dismiss`, { month: "2026-10" });
    assert.equal(dismissed.status, 200);
    assert.deepEqual(await drift.statementDueTodos(userId, on8thNov), []);
  });

  it("is suggested, never set, for a bank with many debits and almost no credits by text", async () => {
    await models.Account.updateOne({ _id: federalId }, { $set: { noCreditAlerts: false } });
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 1; i <= 15; i += 1) await row(federalId, "DEBIT", 100_00, daysAgo(i));
    await row(federalId, "CREDIT", 100_00, daysAgo(3));
    // A row typed in by hand is not a text.
    await models.Transaction.create({
      userId,
      accountId: federalId,
      type: "CREDIT",
      amountMinor: 1_00,
      source: "MANUAL",
      occurredAt: new Date(daysAgo(2)),
    });
    // Older than ninety days does not count.
    await row(federalId, "CREDIT", 100_00, daysAgo(120));

    const federal = async () =>
      (await json(await call("/accounts/overview"))).find((account: any) => account.id === federalId.toString());
    const shown = await federal();
    assert.equal(shown.suggestNoCreditAlerts, true);
    assert.deepEqual(shown.textMessages, { debits: 15, credits: 1, days: 90 });
    assert.equal(shown.noCreditAlerts, false, "only suggested");

    // A second credit by text and it is a bank that does text them.
    await row(federalId, "CREDIT", 100_00, daysAgo(4));
    assert.equal((await federal()).suggestNoCreditAlerts, false);

    // Turned on, it is no longer suggested.
    const patched = await call(`/accounts/${federalId}`, { method: "PATCH", body: JSON.stringify({ noCreditAlerts: true }) });
    assert.equal((await json(patched)).noCreditAlerts, true);
    const hdfc = (await json(await call("/accounts/overview"))).find((account: any) => account.id === hdfcId.toString());
    assert.equal(hdfc.suggestNoCreditAlerts, false);
  });
});

describe("the first pass over the last ninety days", () => {
  it("runs once per user and says how many it found", async () => {
    await fiveThousandCameIn();
    const first = await found.runMissingCreditBackfill(new Date("2026-10-15T12:00:00+05:30"));
    assert.deepEqual(first, { users: 1, found: 1 });
    const second = await found.runMissingCreditBackfill(new Date("2026-10-15T12:00:00+05:30"));
    assert.deepEqual(second, { users: 0, found: 0 });
  });

  it("leaves gaps older than ninety days alone", async () => {
    await fiveThousandCameIn();
    const result = await found.runMissingCreditBackfill(new Date("2027-03-01T12:00:00+05:30"));
    assert.deepEqual(result, { users: 1, found: 0 });
  });
});
