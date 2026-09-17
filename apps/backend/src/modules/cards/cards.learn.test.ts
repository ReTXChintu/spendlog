import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Account, Transaction, User } from "../../models";
import { dayFromStatement, learnCycleFromStatement } from "./cards.learn";
import { cardStatuses } from "./cards.status";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_cards_learn_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let userId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    Account.deleteMany({}),
    Transaction.deleteMany({}),
    User.deleteMany({}),
  ]);
  const user = await User.create({ email: `c${(userCount += 1)}@example.com` });
  userId = user._id;
});

/** An IST calendar day, as an instant at noon so no boundary is grazed. */
function on(day: string): Date {
  return new Date(`${day}T12:00:00+05:30`);
}

describe("the day a statement was drawn", () => {
  it("learns it when the card has never been told", () => {
    assert.equal(dayFromStatement(on("2026-09-17"), null), 17);
  });

  it("says nothing when the card already knows", () => {
    assert.equal(dayFromStatement(on("2026-09-17"), 17), null);
  });

  it("corrects a day that was typed in wrong", () => {
    assert.equal(dayFromStatement(on("2026-09-17"), 4), 17);
  });

  it("reads the day in IST, not UTC", () => {
    // Half past six on the evening of the 16th, UTC, is midnight on the
    // 17th in Delhi - and the bank drew the statement in Delhi.
    assert.equal(dayFromStatement(new Date("2026-09-16T18:30:00.000Z"), null), 17);
  });

  describe("a short month", () => {
    it("does not take February's 28th as the billing day of a card that bills on the 31st", () => {
      // The bank clamps its own statement date exactly as cycleFor does.
      // Learning 28 here would move the cycle permanently, in February,
      // on the strength of a date that was never the card's billing day.
      assert.equal(dayFromStatement(on("2026-02-28"), 31), null);
    });

    it("leaves a 30th alone in a 30-day month too", () => {
      assert.equal(dayFromStatement(on("2026-09-30"), 31), null);
    });

    it("still corrects a smaller day, which nothing clamps upward", () => {
      assert.equal(dayFromStatement(on("2026-02-28"), 15), 28);
    });

    it("learns the last of the month when the card knows nothing at all", () => {
      // The best guess available. A March statement on the 31st corrects
      // it, because 31 is larger and so cannot be a clamp of anything.
      assert.equal(dayFromStatement(on("2026-02-28"), null), 28);
      assert.equal(dayFromStatement(on("2026-03-31"), 28), 31);
    });
  });
});

describe("a statement teaching its card the cycle", () => {
  async function card(fields: Record<string, unknown> = {}) {
    return Account.create({
      userId,
      bankName: "HDFC",
      last4: "4321",
      accountType: "CARD",
      ...fields,
    });
  }

  it("sets the statement day and the due day from the statement", async () => {
    const hdfc = await card();

    const learned = await learnCycleFromStatement(hdfc, {
      kind: "CARD",
      statementDate: on("2026-09-17"),
      dueDate: on("2026-10-06"),
    });

    assert.deepEqual(learned, { statementDay: 17, dueDay: 6 });

    const saved = await Account.findById(hdfc._id);
    assert.equal(saved?.statementDay, 17);
    assert.equal(saved?.dueDay, 6);
  });

  it("says nothing changed when the card already knew", async () => {
    const hdfc = await card({ statementDay: 17, dueDay: 6 });

    assert.equal(
      await learnCycleFromStatement(hdfc, {
        kind: "CARD",
        statementDate: on("2026-09-17"),
        dueDate: on("2026-10-06"),
      }),
      null
    );
  });

  it("learns one when only one is printed", async () => {
    const hdfc = await card();

    assert.deepEqual(
      await learnCycleFromStatement(hdfc, {
        kind: "CARD",
        statementDate: on("2026-09-17"),
        dueDate: null,
      }),
      { statementDay: 17 }
    );
    assert.equal((await Account.findById(hdfc._id))?.dueDay, null);
  });

  it("keeps its hands off a bank statement", async () => {
    // A bank account has a period but no billing cycle, and no personal
    // spend limit resetting on the back of one.
    const bank = await Account.create({
      userId,
      bankName: "CSB",
      last4: "9876",
      accountType: "BANK",
    });

    assert.equal(
      await learnCycleFromStatement(bank, {
        kind: "BANK",
        statementDate: on("2026-09-17"),
        dueDate: null,
      }),
      null
    );
    assert.equal((await Account.findById(bank._id))?.statementDay, null);
  });

  it("updates the copy in memory, so the next statement compares against the truth", async () => {
    // A sync reads several statements against one array of cards. A stale
    // copy would hand February's statement an out-of-date day to compare
    // against, which is the value the short-month guard depends on.
    const hdfc = await card();

    await learnCycleFromStatement(hdfc, {
      kind: "CARD",
      statementDate: on("2026-01-31"),
      dueDate: null,
    });
    assert.equal(hdfc.statementDay, 31);

    assert.equal(
      await learnCycleFromStatement(hdfc, {
        kind: "CARD",
        statementDate: on("2026-02-28"),
        dueDate: null,
      }),
      null
    );
    assert.equal(hdfc.statementDay, 31);
  });
});

describe("the personal spend limit, once the cycle is known", () => {
  async function spend(accountId: Types.ObjectId, day: string, rupees: number) {
    await Transaction.create({
      userId,
      accountId,
      type: "DEBIT",
      amountMinor: rupees * 100,
      occurredAt: on(day),
      description: `spend on ${day}`,
      source: "MANUAL",
    });
  }

  it("counts the calendar month while the card has no statement day", async () => {
    const hdfc = await Account.create({
      userId,
      bankName: "HDFC",
      last4: "4321",
      accountType: "CARD",
      spendLimitMinor: 50_000_00,
    });

    await spend(hdfc._id, "2026-09-03", 4000);
    await spend(hdfc._id, "2026-09-20", 1000);

    const [status] = await cardStatuses(userId, on("2026-09-25"));
    assert.equal(status.periodIsCycle, false);
    assert.equal(status.spentMinor, 5000_00);
  });

  it("resets on the statement day once a statement has taught it one", async () => {
    const hdfc = await Account.create({
      userId,
      bankName: "HDFC",
      last4: "4321",
      accountType: "CARD",
      spendLimitMinor: 50_000_00,
    });

    // Before the statement day, and after it.
    await spend(hdfc._id, "2026-09-03", 4000);
    await spend(hdfc._id, "2026-09-20", 1000);

    await learnCycleFromStatement(hdfc, {
      kind: "CARD",
      statementDate: on("2026-09-17"),
      dueDate: on("2026-10-06"),
    });

    const [status] = await cardStatuses(userId, on("2026-09-25"));

    // The 4,000 was billed on the 17th and is somebody else's problem now.
    assert.equal(status.periodIsCycle, true);
    assert.equal(status.spentMinor, 1000_00);
    assert.equal(status.remainingMinor, 49_000_00);
    assert.equal(status.state, "ok");
  });

  it("still counts a purchase made on the statement day itself", async () => {
    // The bill drawn on the 17th includes the 17th, so that spending
    // belongs to the cycle that is closing, not the one opening.
    const hdfc = await Account.create({
      userId,
      bankName: "HDFC",
      last4: "4321",
      accountType: "CARD",
      statementDay: 17,
      spendLimitMinor: 50_000_00,
    });

    await spend(hdfc._id, "2026-09-17", 2000);

    const [onTheDay] = await cardStatuses(userId, on("2026-09-17"));
    assert.equal(onTheDay.spentMinor, 2000_00);

    const [dayAfter] = await cardStatuses(userId, on("2026-09-18"));
    assert.equal(dayAfter.spentMinor, 0);
  });
});
