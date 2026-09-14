import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { HydratedDocument, Types } from "mongoose";
import { istDayKey, istDayStart } from "../../time";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "reconcile-test-secret";

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let reconcile: typeof import("./statements.reconcile");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_reconcile_test"));
  [models, reconcile] = await Promise.all([import("../../models"), import("./statements.reconcile")]);
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    models.Transaction.deleteMany({}),
    models.CardStatement.deleteMany({}),
    models.Account.deleteMany({}),
  ]);
});

const userId = new Types.ObjectId();

async function makeCard() {
  return models.Account.create({
    userId,
    bankName: "Example Bank",
    last4: "1377",
    accountType: "CARD",
  });
}

type LineSpec = {
  day: string;
  description: string;
  amountMinor: number;
  type?: "DEBIT" | "CREDIT";
  kind?: "SPEND" | "FEE" | "PAYMENT" | "REVERSAL" | "NOISE";
};

let statementCount = 0;

async function makeStatement(accountId: Types.ObjectId | null, lines: LineSpec[]) {
  return models.CardStatement.create({
    userId,
    accountId,
    sourceRef: `message-${(statementCount += 1)}`,
    status: "PARSED",
    statementDate: istDayStart("2026-09-17"),
    lines: lines.map((line) => ({
      date: istDayStart(line.day),
      description: line.description,
      amountMinor: line.amountMinor,
      type: line.type ?? "DEBIT",
      kind: line.kind ?? "SPEND",
      resolution: "SKIPPED",
    })),
  });
}

async function makeTransaction(accountId: Types.ObjectId, day: string, amountMinor: number, merchant?: string) {
  return models.Transaction.create({
    userId,
    accountId,
    amountMinor,
    type: "DEBIT",
    merchant: merchant ?? "Known merchant",
    source: "SMS",
    occurredAt: istDayStart(day),
  });
}

describe("reconcileStatement", () => {
  it("adds a line the ledger never had", async () => {
    const card = await makeCard();
    const statement = await makeStatement(card._id, [
      { day: "2026-09-01", description: "FINANCE CHARGES", amountMinor: 31875, kind: "FEE" },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.added, 1);

    const created = await models.Transaction.findOne({ userId, amountMinor: 31875 }).orFail();
    assert.equal(created.source, "STATEMENT");
    assert.equal(created.merchant, "FINANCE CHARGES");
    assert.equal(istDayKey(created.occurredAt), "2026-09-01", "dated to the day the statement says");
    assert.equal(created.statementId?.toString(), statement._id.toString());
    assert.equal(created.categoryId, null, "left for a person to answer");
  });

  it("matches a line the ledger already had instead of adding it again", async () => {
    const card = await makeCard();
    await makeTransaction(card._id, "2026-09-05", 389010);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "BIGBASKET BANGALORE", amountMinor: 389010 },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.matched, 1);
    assert.equal(summary.added, 0);
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);
  });

  it("matches across the days a transaction takes to post", async () => {
    const card = await makeCard();
    // Spent on the Friday, posted on the Tuesday.
    await makeTransaction(card._id, "2026-09-04", 124000);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-08", description: "AMZNIN MUMBAI IN", amountMinor: 124000 },
    ]);

    assert.equal((await reconcile.reconcileStatement(statement)).matched, 1);
  });

  it("does not reach past the drift window for a match", async () => {
    const card = await makeCard();
    await makeTransaction(card._id, "2026-08-20", 124000);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-08", description: "AMZNIN MUMBAI IN", amountMinor: 124000 },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.matched, 0);
    assert.equal(summary.added, 1, "a month apart is a different payment");
  });

  it("never invents a transaction for the bill being paid", async () => {
    // The one that would do real damage: a credit on the card against the
    // debit already recorded on the account it was paid from.
    const card = await makeCard();
    const statement = await makeStatement(card._id, [
      {
        day: "2026-08-22",
        description: "PAYMENT RECEIVED - THANK YOU",
        amountMinor: 2500000,
        type: "CREDIT",
        kind: "PAYMENT",
      },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.added, 0);
    assert.equal(await models.Transaction.countDocuments({ userId }), 0);
  });

  it("drops the summary rows that look like transactions", async () => {
    const card = await makeCard();
    const statement = await makeStatement(card._id, [
      { day: "2026-09-17", description: "Total Amount Due", amountMinor: 4785025, kind: "NOISE" },
    ]);

    assert.equal((await reconcile.reconcileStatement(statement)).added, 0);
    assert.equal(await models.Transaction.countDocuments({ userId }), 0);
  });

  it("lets one transaction answer for one line only", async () => {
    // Two coffees at the same price in the same week. The ledger caught
    // one of them, so exactly one is missing.
    const card = await makeCard();
    await makeTransaction(card._id, "2026-09-05", 25000);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "THIRD WAVE COFFEE", amountMinor: 25000 },
      { day: "2026-09-06", description: "THIRD WAVE COFFEE", amountMinor: 25000 },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.matched + summary.uncertain, 1);
    assert.equal(summary.added, 1);
    assert.equal(await models.Transaction.countDocuments({ userId }), 2);
  });

  it("records a guess as a guess when more than one row fits", async () => {
    const card = await makeCard();
    await makeTransaction(card._id, "2026-09-05", 25000);
    await makeTransaction(card._id, "2026-09-06", 25000);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-06", description: "THIRD WAVE COFFEE", amountMinor: 25000 },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.uncertain, 1);
    assert.equal(summary.added, 0);
  });

  it("adds nothing the second time it runs", async () => {
    const card = await makeCard();
    const statement = await makeStatement(card._id, [
      { day: "2026-09-01", description: "ANNUAL FEE", amountMinor: 250000, kind: "FEE" },
      { day: "2026-09-02", description: "AMZNIN MUMBAI IN", amountMinor: 124000 },
    ]);

    const first = await reconcile.reconcileStatement(statement);
    assert.equal(first.added, 2);

    const again = await reconcile.reconcileStatement(
      (await models.CardStatement.findById(statement._id).orFail()) as HydratedDocument<
        import("../../models").CardStatementDoc
      >
    );
    assert.equal(again.added, 2, "counted, not created");
    assert.equal(await models.Transaction.countDocuments({ userId }), 2);
  });

  it("fills in a merchant the alert never named, but not one a person set", async () => {
    const card = await makeCard();
    const unnamed = await models.Transaction.create({
      userId,
      accountId: card._id,
      amountMinor: 124000,
      type: "DEBIT",
      merchant: null,
      source: "SMS",
      occurredAt: istDayStart("2026-09-02"),
    });
    const corrected = await models.Transaction.create({
      userId,
      accountId: card._id,
      amountMinor: 432500,
      type: "DEBIT",
      merchant: "Lunch with Priya",
      source: "SMS",
      occurredAt: istDayStart("2026-09-03"),
      editedAt: new Date(),
    });

    const statement = await makeStatement(card._id, [
      { day: "2026-09-02", description: "AMZNIN MUMBAI IN", amountMinor: 124000 },
      { day: "2026-09-03", description: "SWIGGY BANGALORE IN", amountMinor: 432500 },
    ]);
    await reconcile.reconcileStatement(statement);

    assert.equal((await models.Transaction.findById(unnamed).orFail()).merchant, "AMZNIN MUMBAI IN");
    assert.equal(
      (await models.Transaction.findById(corrected).orFail()).merchant,
      "Lunch with Priya",
      "a person's answer outranks the statement"
    );
  });

  it("reports what the ledger holds that the statement does not list", async () => {
    const card = await makeCard();
    await makeTransaction(card._id, "2026-09-05", 99900, "Attributed to the wrong card");
    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "BIGBASKET BANGALORE", amountMinor: 389010 },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.notOnStatement.length, 1);
    assert.equal(summary.notOnStatement[0].merchant, "Attributed to the wrong card");
  });

  it("measures the gap between the statement and what was known", async () => {
    const card = await makeCard();
    await makeTransaction(card._id, "2026-09-05", 389010);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "BIGBASKET BANGALORE", amountMinor: 389010 },
      { day: "2026-09-01", description: "FINANCE CHARGES", amountMinor: 31875, kind: "FEE" },
      {
        day: "2026-08-22",
        description: "PAYMENT RECEIVED - THANK YOU",
        amountMinor: 2500000,
        type: "CREDIT",
        kind: "PAYMENT",
      },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    // Spend against spend: the payment is in neither figure, so the
    // difference is exactly the charge nobody was told about.
    assert.equal(summary.statementSpendMinor, 389010 + 31875);
    assert.equal(summary.knownSpendMinor, 389010);
  });

  it("does nothing at all until it knows which card it is", async () => {
    const statement = await makeStatement(null, [
      { day: "2026-09-01", description: "FINANCE CHARGES", amountMinor: 31875, kind: "FEE" },
    ]);

    assert.equal((await reconcile.reconcileStatement(statement)).added, 0);
    assert.equal(await models.Transaction.countDocuments({ userId }), 0);
  });

  it("keeps one user's statement away from another's ledger", async () => {
    const card = await makeCard();
    const stranger = new Types.ObjectId();
    await models.Transaction.create({
      userId: stranger,
      accountId: card._id,
      amountMinor: 124000,
      type: "DEBIT",
      source: "SMS",
      occurredAt: istDayStart("2026-09-02"),
    });

    const statement = await makeStatement(card._id, [
      { day: "2026-09-02", description: "AMZNIN MUMBAI IN", amountMinor: 124000 },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.matched, 0, "someone else's row is not a match");
    assert.equal(summary.added, 1);
  });
});

describe("unpickStatement", () => {
  it("removes only the rows the statement created", async () => {
    const card = await makeCard();
    const known = await makeTransaction(card._id, "2026-09-05", 389010);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "BIGBASKET BANGALORE", amountMinor: 389010 },
      { day: "2026-09-01", description: "FINANCE CHARGES", amountMinor: 31875, kind: "FEE" },
    ]);
    await reconcile.reconcileStatement(statement);
    assert.equal(await models.Transaction.countDocuments({ userId }), 2);

    const removed = await reconcile.unpickStatement(userId, statement._id);
    assert.equal(removed, 1);
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);
    assert.ok(await models.Transaction.findById(known), "the matched row is untouched");
  });

  it("leaves the statement able to be read again", async () => {
    const card = await makeCard();
    const statement = await makeStatement(card._id, [
      { day: "2026-09-01", description: "FINANCE CHARGES", amountMinor: 31875, kind: "FEE" },
    ]);
    await reconcile.reconcileStatement(statement);
    await reconcile.unpickStatement(userId, statement._id);

    const reread = await models.CardStatement.findById(statement._id).orFail();
    assert.equal((await reconcile.reconcileStatement(reread)).added, 1);
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);
  });
});

describe("what the ledger remembers about a statement", () => {
  it("records the statement as a witness on a row it only matched", async () => {
    // Two payments of the same amount days apart are indistinguishable
    // from a statement's side. Knowing a statement confirmed a row is what
    // lets the ledger show a third icon beside the SMS and the email.
    const card = await makeCard();
    const known = await makeTransaction(card._id, "2026-09-05", 389010);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "BIGBASKET BANGALORE", amountMinor: 389010 },
    ]);

    await reconcile.reconcileStatement(statement);

    const after = await models.Transaction.findById(known).orFail();
    const fromStatement = after.sources.filter((entry) => entry.source === "STATEMENT");
    assert.equal(fromStatement.length, 1);
    assert.equal(fromStatement[0].rawText, "BIGBASKET BANGALORE");
    assert.equal(after.statementId?.toString(), statement._id.toString());
  });

  it("does not claim two witnesses where there was one", async () => {
    const card = await makeCard();
    const known = await makeTransaction(card._id, "2026-09-05", 389010);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "BIGBASKET BANGALORE", amountMinor: 389010 },
    ]);

    await reconcile.reconcileStatement(statement);
    await reconcile.reconcileStatement(await models.CardStatement.findById(statement._id).orFail());

    const after = await models.Transaction.findById(known).orFail();
    assert.equal(after.sources.filter((entry) => entry.source === "STATEMENT").length, 1);
  });

  it("matches on the amount and the day, never on the merchant's name", async () => {
    // So renaming a merchant by hand cannot stop a statement recognising
    // the payment it belongs to.
    const card = await makeCard();
    await models.Transaction.create({
      userId,
      accountId: card._id,
      amountMinor: 389010,
      type: "DEBIT",
      merchant: "Weekly shop",
      source: "SMS",
      occurredAt: istDayStart("2026-09-05"),
      editedAt: new Date(),
    });

    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "BIGBASKET BANGALORE", amountMinor: 389010 },
    ]);

    const summary = await reconcile.reconcileStatement(statement);
    assert.equal(summary.matched, 1);
    assert.equal(summary.added, 0);
  });
});

describe("saying by hand what a line is", () => {
  it("links a line to a transaction the matcher passed over", async () => {
    const card = await makeCard();
    // Too far out for the matcher's window, but the right payment.
    const actual = await makeTransaction(card._id, "2026-08-28", 124000);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-08", description: "AMZNIN MUMBAI IN", amountMinor: 124000 },
    ]);

    await reconcile.reconcileStatement(statement);
    assert.equal(await models.Transaction.countDocuments({ userId }), 2, "it added its own row");

    const reread = await models.CardStatement.findById(statement._id).orFail();
    const result = await reconcile.resolveLineByHand({
      userId,
      statementId: statement._id,
      lineId: reread.lines[0]._id.toString(),
      action: "link",
      transactionId: actual._id.toString(),
    });

    assert.equal(result?.resolution, "MATCHED");
    // The row it had added is gone, rather than left beside the real one.
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);

    const after = await models.Transaction.findById(actual).orFail();
    assert.equal(after.sources.filter((entry) => entry.source === "STATEMENT").length, 1);
  });

  it("adds a row for a line the matcher wrongly tied to something else", async () => {
    const card = await makeCard();
    await makeTransaction(card._id, "2026-09-05", 25000);
    const statement = await makeStatement(card._id, [
      { day: "2026-09-05", description: "THIRD WAVE COFFEE", amountMinor: 25000 },
    ]);

    await reconcile.reconcileStatement(statement);
    assert.equal(await models.Transaction.countDocuments({ userId }), 1, "matched, nothing added");

    const reread = await models.CardStatement.findById(statement._id).orFail();
    await reconcile.resolveLineByHand({
      userId,
      statementId: statement._id,
      lineId: reread.lines[0]._id.toString(),
      action: "add",
    });

    assert.equal(await models.Transaction.countDocuments({ userId }), 2, "two separate payments");
  });

  it("takes back what it added when a line is ignored", async () => {
    const card = await makeCard();
    const statement = await makeStatement(card._id, [
      { day: "2026-09-01", description: "FINANCE CHARGES", amountMinor: 31875, kind: "FEE" },
    ]);
    await reconcile.reconcileStatement(statement);
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);

    const reread = await models.CardStatement.findById(statement._id).orFail();
    const result = await reconcile.resolveLineByHand({
      userId,
      statementId: statement._id,
      lineId: reread.lines[0]._id.toString(),
      action: "ignore",
    });

    assert.equal(result?.resolution, "SKIPPED");
    assert.equal(await models.Transaction.countDocuments({ userId }), 0);
  });

  it("offers what a line might be, beyond the window the matcher used", async () => {
    const card = await makeCard();
    await makeTransaction(card._id, "2026-08-30", 124000, "Nine days earlier");
    const statement = await makeStatement(card._id, [
      { day: "2026-09-08", description: "AMZNIN MUMBAI IN", amountMinor: 124000 },
    ]);

    const reread = await models.CardStatement.findById(statement._id).orFail();
    const candidates = await reconcile.candidatesForLine(
      userId,
      statement._id,
      reread.lines[0]._id.toString()
    );

    assert.ok(candidates.some((row) => row.merchant === "Nine days earlier"));
  });

  it("will not link to someone else's transaction", async () => {
    const card = await makeCard();
    const stranger = new Types.ObjectId();
    const theirs = await models.Transaction.create({
      userId: stranger,
      amountMinor: 124000,
      type: "DEBIT",
      source: "SMS",
      occurredAt: istDayStart("2026-09-08"),
    });

    const statement = await makeStatement(card._id, [
      { day: "2026-09-08", description: "AMZNIN MUMBAI IN", amountMinor: 124000 },
    ]);
    const reread = await models.CardStatement.findById(statement._id).orFail();

    const result = await reconcile.resolveLineByHand({
      userId,
      statementId: statement._id,
      lineId: reread.lines[0]._id.toString(),
      action: "link",
      transactionId: theirs._id.toString(),
    });
    assert.equal(result, null);
  });
});
