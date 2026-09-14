import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayStart } from "../../time";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "statement-reset-secret";

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let planStatementReset: typeof import("./statements.reset").planStatementReset;
let resetStatements: typeof import("./statements.reset").resetStatements;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_statement_reset_test"));

  const [loaded, reset] = await Promise.all([import("../../models"), import("./statements.reset")]);
  models = loaded;
  planStatementReset = reset.planStatementReset;
  resetStatements = reset.resetStatements;
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let userId: Types.ObjectId;
let statementId: Types.ObjectId;

beforeEach(async () => {
  await Promise.all([models.CardStatement.deleteMany({}), models.Transaction.deleteMany({})]);

  userId = new Types.ObjectId();
  const statement = await models.CardStatement.create({
    userId,
    sourceRef: "msg-1#att-whatever",
    mailKey: "msg-1#statement.pdf",
    status: "PARSED",
    statementDate: istDayStart("2026-08-17"),
    reconciledAt: new Date(),
    lines: [],
  });
  statementId = statement._id;
});

/** A row the statement created, because SpendLog had never seen it. */
async function added(merchant: string, categorised = false) {
  return models.Transaction.create({
    userId,
    amountMinor: 10000,
    type: "DEBIT",
    merchant,
    source: "STATEMENT",
    statementId,
    statementLineId: new Types.ObjectId(),
    categoryId: categorised ? new Types.ObjectId() : null,
    occurredAt: istDayStart("2026-08-02"),
    sources: [{ source: "STATEMENT", sourceRef: `msg-1#${merchant}`, receivedAt: new Date() }],
  });
}

/** A row an SMS created, that the statement then recognised. */
async function matched(merchant: string) {
  return models.Transaction.create({
    userId,
    amountMinor: 20000,
    type: "DEBIT",
    merchant,
    source: "SMS",
    rawText: "Rs 200 spent on your card",
    // Set by the reconciler on a matched row as well as an added one,
    // which is exactly why it cannot be the thing a reset deletes on.
    statementId,
    statementLineId: new Types.ObjectId(),
    occurredAt: istDayStart("2026-08-03"),
    sources: [
      { source: "SMS", sourceRef: "sms-1", receivedAt: new Date() },
      { source: "STATEMENT", sourceRef: `msg-1#${merchant}`, receivedAt: new Date() },
    ],
  });
}

describe("starting the statement ledger over", () => {
  it("counts what it would remove without removing any of it", async () => {
    await added("ZEPTO");
    await added("BLINKIT", true);
    await matched("SWIGGY");

    const plan = await planStatementReset(userId);

    assert.equal(plan.statements, 1);
    assert.equal(plan.addedTransactions, 2);
    assert.equal(plan.matchedTransactions, 1, "a matched row is not one of the casualties");
    assert.equal(plan.categorisedAmongThem, 1);

    assert.equal(await models.Transaction.countDocuments({ userId }), 3, "and nothing was touched");
    assert.equal(await models.CardStatement.countDocuments({ userId }), 1);
  });

  it("never deletes a row a statement only recognised", async () => {
    await added("ZEPTO");
    const survivor = await matched("SWIGGY");

    await resetStatements(userId);

    const left = await models.Transaction.findById(survivor._id);
    assert.ok(left, "the SMS row is still there");
    assert.equal(left.merchant, "SWIGGY");

    // And it no longer claims a provenance that no longer exists.
    assert.equal(left.statementId, null);
    assert.equal(left.statementLineId, null);
    assert.deepEqual(
      left.sources.map((source) => source.source),
      ["SMS"],
      "the statement's mark is lifted, the SMS's is not"
    );
  });

  it("removes every row a statement created, and every statement", async () => {
    await added("ZEPTO");
    await added("BLINKIT");
    await matched("SWIGGY");

    const result = await resetStatements(userId);

    assert.equal(result.statementsDeleted, 1);
    assert.equal(result.transactionsDeleted, 2);
    assert.equal(result.sourcesCleared, 1);

    assert.equal(await models.CardStatement.countDocuments({ userId }), 0);
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);
  });

  it("leaves another person's ledger alone", async () => {
    const stranger = new Types.ObjectId();
    await models.Transaction.create({
      userId: stranger,
      amountMinor: 5000,
      type: "DEBIT",
      merchant: "NOT MINE",
      source: "STATEMENT",
      occurredAt: istDayStart("2026-08-04"),
    });

    await added("ZEPTO");
    await resetStatements(userId);

    assert.equal(await models.Transaction.countDocuments({ userId: stranger }), 1);
  });

  it("counts the duplicates the old identity let through", async () => {
    // What a mailbox scanned three times actually left behind: one mail,
    // three records, a fresh attachment id on each - and no mailKey at all,
    // because they were written before there was one. Counted on the
    // message id, which is the half of the old key that was ever stable.
    for (const attachment of ["att-a", "att-b"]) {
      await models.CardStatement.create({
        userId,
        sourceRef: `msg-legacy#${attachment}`,
        status: "PARSED",
        lines: [],
      });
    }

    const plan = await planStatementReset(userId);
    assert.equal(plan.statements, 3);
    assert.equal(plan.duplicateGroups, 1, "two records of one mail is one copy too many");
  });
});

describe("what identifies a statement", () => {
  it("will not let the same mail be filed twice", async () => {
    await models.CardStatement.init();

    await assert.rejects(
      models.CardStatement.create({
        userId,
        // A different attachment id, which is what Gmail hands back on
        // every fetch, and the same mail and file - which is what it is.
        sourceRef: "msg-1#a-completely-different-token",
        mailKey: "msg-1#statement.pdf",
        status: "PARSED",
        lines: [],
      }),
      /duplicate key/i
    );
  });

  it("will not let the same file be filed twice", async () => {
    await models.CardStatement.init();
    const hash = crypto.createHash("sha256").update("the same statement").digest("hex");

    await models.CardStatement.create({
      userId,
      sourceRef: "msg-2#att",
      mailKey: "msg-2#statement.pdf",
      fileHash: hash,
      status: "PARSED",
      lines: [],
    });

    // A bank re-sending the same statement under a new message id. Nothing
    // about the mail says it is the same; the bytes do.
    await assert.rejects(
      models.CardStatement.create({
        userId,
        sourceRef: "msg-3#att",
        mailKey: "msg-3#statement.pdf",
        fileHash: hash,
        status: "PARSED",
        lines: [],
      }),
      /duplicate key/i
    );
  });

  it("still files statements that have neither yet", async () => {
    await models.CardStatement.init();

    // Two kinds of statement have no fileHash: one written before the
    // field existed, and one whose attachment never downloaded. A compound
    // sparse index would index both of their nulls and reject the second,
    // because sparse skips a document only when every indexed field is
    // missing - and userId never is.
    for (const ref of ["old-1#att", "old-2#att"]) {
      await models.CardStatement.create({ userId, sourceRef: ref, status: "LOCKED", lines: [] });
    }

    await models.CardStatement.create({
      userId,
      sourceRef: "new-1#att",
      mailKey: "new-1#too-big.pdf",
      fileHash: null,
      status: "UNREADABLE",
      lines: [],
    });

    assert.equal(await models.CardStatement.countDocuments({ userId, fileHash: null }), 4);
  });
});
