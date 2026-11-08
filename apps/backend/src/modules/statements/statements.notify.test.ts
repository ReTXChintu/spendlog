import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { statementNotice } from "./statements.notify";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "statement-notify-secret";

const line = (resolution: string) => ({ resolution });

describe("what a new statement says", () => {
  it("a card's bill, its due date, and what was matched and added", () => {
    const notice = statementNotice(
      {
        status: "PARSED",
        kind: "CARD",
        totalDueMinor: 1_854_30_00,
        dueDate: new Date("2026-11-21T00:00:00+05:30"),
        lines: [line("MATCHED"), line("UNCERTAIN"), line("ADDED"), line("SKIPPED")],
        fileName: "statement.pdf",
        subject: null,
      },
      "Tata Neu Plus HDFC ••1377"
    );
    assert.equal(notice.title, "Tata Neu Plus HDFC ••1377 bill: ₹1,85,430, due 21 Nov");
    assert.equal(notice.body, "Statement read. 2 payments matched, 1 added that SpendLog hadn't seen.");
  });

  it("a bank statement, read", () => {
    const notice = statementNotice(
      { status: "PARSED", kind: "BANK", totalDueMinor: null, dueDate: null, lines: [line("MATCHED")], fileName: null, subject: null },
      "Federal Bank ••3295"
    );
    assert.equal(notice.title, "Federal Bank ••3295 statement read");
    assert.equal(notice.body, "1 payment matched.");
  });

  it("one waiting for its password, and one for an account SpendLog lacks", () => {
    const base = { kind: "CARD" as const, totalDueMinor: null, dueDate: null, lines: [], subject: null };
    assert.equal(statementNotice({ ...base, status: "LOCKED", fileName: "6529XX77.pdf" }, null).title, "A statement needs its password");
    assert.match(statementNotice({ ...base, status: "UNIDENTIFIED", fileName: "acct.pdf" }, null).body, /^acct\.pdf: no card or account/);
  });
});

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let notify: typeof import("./statements.notify");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_statement_notify_test"));
  [models, notify] = await Promise.all([import("../../models"), import("./statements.notify")]);
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([models.CardStatement.deleteMany({}), models.User.deleteMany({})]);
});

const statement = (userId: Types.ObjectId, extra: Record<string, unknown>) =>
  models.CardStatement.create({ userId, sourceRef: `m${Math.random()}`, status: "PARSED", kind: "BANK", lines: [], ...extra });

describe("telling the user", () => {
  it("tells each new statement once, and an unreadable PDF never", async () => {
    const user = await models.User.create({ email: "n@example.com" });
    const read = await statement(user._id, {});
    const junk = await statement(user._id, { status: "UNREADABLE" });

    // No phone registered: the notice goes nowhere, but each is told once.
    assert.equal(await notify.notifyNewStatements(user._id), 1);
    assert.ok((await models.CardStatement.findById(read._id))!.notifiedAt);
    assert.ok((await models.CardStatement.findById(junk._id))!.notifiedAt);
    assert.equal(await notify.notifyNewStatements(user._id), 0);
  });

  it("does not tell about statements that were in before it began", async () => {
    const user = await models.User.create({ email: "old@example.com" });
    await statement(user._id, {});
    await notify.runStatementNoticeBackfill();
    assert.equal(await notify.notifyNewStatements(user._id), 0);
  });
});
