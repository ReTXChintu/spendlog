import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayStart, istMonthKey } from "../../time";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "ledger-secret";

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let horizon: typeof import("./ledger.horizon");
let ingestRawMessage: typeof import("../../parsing/ingest").ingestRawMessage;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_ledger_test"));

  const [loaded, mod, ingest] = await Promise.all([
    import("../../models"),
    import("./ledger.horizon"),
    import("../../parsing/ingest"),
  ]);
  models = loaded;
  horizon = mod;
  ingestRawMessage = ingest.ingestRawMessage;
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let userId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Transaction.deleteMany({}),
    models.Account.deleteMany({}),
    models.CardStatement.deleteMany({}),
    models.User.deleteMany({}),
  ]);

  const user = await models.User.create({
    email: `l${(userCount += 1)}@example.com`,
    ledgerFrom: "2026-09",
  });
  userId = user._id;
});

/** A real HDFC card alert, dated. */
function alert(day: string): string {
  return `Rs 432.50 spent on HDFC Bank Card x1377 at SWIGGY on ${day}. Avl bal Rs 10000.`;
}

async function ingest(rawText: string, occurredOn: string) {
  return ingestRawMessage({
    userId,
    rawText,
    source: "SMS",
    sourceRef: `sms-${rawText.length}-${occurredOn}`,
    receivedAt: istDayStart(occurredOn),
  });
}

describe("where the ledger starts", () => {
  it("is the month the account was made, when nothing says otherwise", async () => {
    const joined = await models.User.create({
      email: "joined@example.com",
      createdAt: istDayStart("2026-09-13"),
    });

    assert.equal(horizon.defaultHorizon(joined.createdAt), "2026-09");
    assert.equal(await horizon.horizonMonthFor(joined._id), "2026-09");
  });

  it("names the month before it, for the button that offers one", () => {
    assert.equal(horizon.monthBefore("2026-09"), "2026-08");
    assert.equal(horizon.monthBefore("2026-01"), "2025-12", "and over a new year");
  });

  it("imports nothing from before it", async () => {
    // The mailbox and the phone both hold months of these. Somebody who
    // joined in September did not ask for August.
    const august = await ingest(alert("28-08-26"), "2026-08-28");
    assert.equal(august.status, "ignored");
    assert.equal(august.transaction, null);

    assert.equal(await models.Transaction.countDocuments({ userId }), 0);
  });

  it("imports what falls on or after it", async () => {
    const september = await ingest(alert("02-09-26"), "2026-09-02");
    assert.equal(september.status, "created");
    assert.equal(await models.Transaction.countDocuments({ userId }), 1);
  });

  it("lets the first of the month through", async () => {
    // The boundary itself, which a `>` rather than a `>=` would eat.
    const first = await ingest(alert("01-09-26"), "2026-09-01");
    assert.equal(first.status, "created");
  });

  it("opens the month up once it moves back", async () => {
    assert.equal((await ingest(alert("28-08-26"), "2026-08-28")).status, "ignored");

    await models.User.findByIdAndUpdate(userId, { $set: { ledgerFrom: "2026-08" } });

    assert.equal((await ingest(alert("28-08-26"), "2026-08-28")).status, "created");
  });

  it("imports nothing at all for an account that is gone", async () => {
    // Not everything: a sync for a deleted account should do less rather
    // than more, and "no horizon" must not read as "no limit".
    await models.User.findByIdAndDelete(userId);
    assert.equal(await horizon.horizonFor(userId), null);
    assert.equal((await ingest(alert("02-09-26"), "2026-09-02")).status, "ignored");
  });
});

describe("clearing out what came in before it", () => {
  /** A transaction of a given source, dated. */
  async function put(day: string, source: "SMS" | "MANUAL") {
    return models.Transaction.create({
      userId,
      amountMinor: 10000,
      type: "DEBIT",
      merchant: "SOMETHING",
      source,
      occurredAt: istDayStart(day),
    });
  }

  it("counts what would go, and what would stay, without touching either", async () => {
    await put("2026-08-02", "SMS");
    await put("2026-07-30", "SMS");
    await put("2026-08-11", "MANUAL");
    await put("2026-09-04", "SMS");

    const plan = (await horizon.planPurge(userId))!;
    assert.equal(plan.month, "2026-09");
    assert.equal(plan.imported, 2);
    assert.equal(plan.manual, 1, "typed in by hand, so not a casualty");

    assert.equal(await models.Transaction.countDocuments({ userId }), 4, "and nothing moved");
  });

  it("removes the imported ones and keeps the ones typed by hand", async () => {
    await put("2026-08-02", "SMS");
    const byHand = await put("2026-08-11", "MANUAL");
    const after = await put("2026-09-04", "SMS");

    const result = (await horizon.purgeBeforeHorizon(userId))!;
    assert.equal(result.transactionsDeleted, 1);

    const left = await models.Transaction.find({ userId }).sort({ occurredAt: 1 });
    assert.deepEqual(
      left.map((one) => one._id.toString()),
      [byHand._id.toString(), after._id.toString()],
      "the horizon says what to fetch, not what somebody is allowed to remember"
    );
  });

  it("takes the statements whose whole period is before it", async () => {
    const old = await models.CardStatement.create({
      userId,
      sourceRef: "msg-old#att",
      mailKey: "msg-old#statement.pdf",
      status: "PARSED",
      periodStart: istDayStart("2026-07-17"),
      periodEnd: istDayStart("2026-08-16"),
      lines: [],
    });
    const current = await models.CardStatement.create({
      userId,
      sourceRef: "msg-new#att",
      mailKey: "msg-new#statement.pdf",
      status: "PARSED",
      periodStart: istDayStart("2026-08-17"),
      periodEnd: istDayStart("2026-09-16"),
      lines: [],
    });

    const plan = (await horizon.planPurge(userId))!;
    assert.equal(plan.statements, 1);

    const result = (await horizon.purgeBeforeHorizon(userId))!;
    assert.equal(result.statementsDeleted, 1);

    const left = await models.CardStatement.find({ userId });
    assert.deepEqual(
      left.map((one) => one._id.toString()),
      [current._id.toString()],
      "one that straddles the boundary is this month's, and stays"
    );
    assert.ok(!left.some((one) => one._id.equals(old._id)));
  });

  it("leaves another person's ledger alone", async () => {
    const stranger = await models.User.create({ email: "stranger@example.com" });
    await models.Transaction.create({
      userId: stranger._id,
      amountMinor: 5000,
      type: "DEBIT",
      merchant: "NOT MINE",
      source: "SMS",
      occurredAt: istDayStart("2026-08-04"),
    });

    await put("2026-08-02", "SMS");
    await horizon.purgeBeforeHorizon(userId);

    assert.equal(await models.Transaction.countDocuments({ userId: stranger._id }), 1);
  });
});

describe("a month key", () => {
  it("is four digits, a dash and a real month", () => {
    for (const good of ["2026-01", "2026-09", "2026-12", istMonthKey(new Date())]) {
      assert.ok(horizon.isMonthKey(good), good);
    }
    for (const bad of ["2026-00", "2026-13", "2026-9", "26-09", "2026/09", "", null, 202609]) {
      assert.ok(!horizon.isMonthKey(bad), String(bad));
    }
  });
});
