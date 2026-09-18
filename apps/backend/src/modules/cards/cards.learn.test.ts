import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Account, CardStatement, Transaction, User } from "../../models";
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
    CardStatement.deleteMany({}),
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

  it("puts a purchase made on the statement day into the new cycle", async () => {
    // The bill drawn on the 17th covers up to the 16th, so the 17th's
    // spending opens the next cycle rather than closing the last one.
    // This is the day the counter goes back to zero.
    const hdfc = await Account.create({
      userId,
      bankName: "HDFC",
      last4: "4321",
      accountType: "CARD",
      statementDay: 17,
      spendLimitMinor: 50_000_00,
    });

    await spend(hdfc._id, "2026-09-16", 5000);
    await spend(hdfc._id, "2026-09-17", 2000);

    // The 16th is the closing cycle's last day, and the 17th has not
    // happened yet as far as this moment is concerned.
    const [before] = await cardStatuses(userId, on("2026-09-16"));
    assert.equal(before.spentMinor, 5000_00);

    // Come the 17th the counter has reset, and the day's own spending is
    // the only thing on it.
    const [onTheDay] = await cardStatuses(userId, on("2026-09-17"));
    assert.equal(onTheDay.spentMinor, 2000_00);

    // And it is still there tomorrow - the same cycle, one day older.
    const [dayAfter] = await cardStatuses(userId, on("2026-09-18"));
    assert.equal(dayAfter.spentMinor, 2000_00);
  });
});

describe("what is actually left on the card", () => {
  async function cardWithBill(billMinor: number) {
    const hdfc = await Account.create({
      userId,
      bankName: "HDFC",
      last4: "4321",
      accountType: "CARD",
      statementDay: 17,
      dueDay: 6,
      creditLimitMinor: 25_000_00,
      spendLimitMinor: 10_000_00,
    });

    await CardStatement.create({
      userId,
      accountId: hdfc._id,
      sourceRef: "m1#a1",
      kind: "CARD",
      status: "PARSED",
      statementDate: on("2026-09-17"),
      dueDate: on("2026-10-06"),
      totalDueMinor: billMinor,
    });

    return hdfc;
  }

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

  it("takes the unpaid bill off the limit as well as this cycle's spending", async () => {
    // The whole picture on the 20th: a 25,000 card, a 14,000 bill drawn on
    // the 17th and not yet paid, and 3,000 spent since. The bank is
    // holding 17,000 of the limit, so 8,000 is what is really left.
    const hdfc = await cardWithBill(14_000_00);
    await spend(hdfc._id, "2026-09-20", 3000);

    const [status] = await cardStatuses(userId, on("2026-09-20"));

    assert.equal(status.creditLimitMinor, 25_000_00);
    assert.equal(status.outstandingMinor, 14_000_00);
    assert.equal(status.spentMinor, 3000_00);
    assert.equal(status.availableMinor, 8000_00);

    // The personal budget is a separate question with a separate answer:
    // 3,000 of the 10,000 allowed, and the bill has nothing to do with it.
    assert.equal(status.limitMinor, 10_000_00);
    assert.equal(status.remainingMinor, 7000_00);
  });

  it("gives the limit back when the bill is paid", async () => {
    const hdfc = await cardWithBill(14_000_00);
    await spend(hdfc._id, "2026-09-20", 3000);

    // Paid from somewhere else, marked as paying this card. That marking
    // is the only thing that says a bill has been cleared: the money
    // leaving produces one message, on the account being debited, with
    // nothing on the card side to pair it with.
    await Transaction.create({
      userId,
      accountId: hdfc._id,
      cardPaymentFor: hdfc._id,
      type: "DEBIT",
      amountMinor: 14_000_00,
      occurredAt: on("2026-09-25"),
      description: "card bill paid",
      source: "MANUAL",
    });

    const [status] = await cardStatuses(userId, on("2026-09-26"));

    assert.equal(status.outstandingMinor, 0);
    assert.equal(status.availableMinor, 22_000_00, "the 14,000 came back");

    // And paying the bill is not spending: it must not eat the budget.
    assert.equal(status.spentMinor, 3000_00);
  });

  it("counts a bill paid in two goes", async () => {
    const hdfc = await cardWithBill(14_000_00);

    for (const [day, rupees] of [["2026-09-22", 6000], ["2026-09-28", 5000]] as [string, number][]) {
      await Transaction.create({
        userId,
        accountId: hdfc._id,
        cardPaymentFor: hdfc._id,
        type: "DEBIT",
        amountMinor: rupees * 100,
        occurredAt: on(day),
        description: "part payment",
        source: "MANUAL",
      });
    }

    const [status] = await cardStatuses(userId, on("2026-09-30"));
    assert.equal(status.outstandingMinor, 3000_00);
    assert.equal(status.availableMinor, 22_000_00);
  });

  it("says nothing rather than zero when no statement has been read", async () => {
    // A card with no statement is not a card with no bill. Reporting 0
    // would put the whole limit on the screen as available on the one day
    // of the month when it is least likely to be.
    const hdfc = await Account.create({
      userId,
      bankName: "Axis",
      last4: "1111",
      accountType: "CARD",
      statementDay: 17,
      creditLimitMinor: 25_000_00,
    });
    await spend(hdfc._id, "2026-09-20", 3000);

    const [status] = await cardStatuses(userId, on("2026-09-20"));
    assert.equal(status.outstandingMinor, null);
    assert.equal(status.availableMinor, 22_000_00);
  });

  it("falls back to the statement's rows when the total was never printed", async () => {
    // The real failure this comes from. The total due is found by matching
    // a printed label, and an issuer that words it differently, or lays it
    // out in a way the reader cannot follow, used to produce no bill at
    // all - so the card showed its whole limit as free with 14,000
    // outstanding on it.
    const hdfc = await Account.create({
      userId,
      bankName: "Jupiter",
      last4: "6623",
      accountType: "CARD",
      statementDay: 17,
      creditLimitMinor: 25_000_00,
    });

    await CardStatement.create({
      userId,
      accountId: hdfc._id,
      sourceRef: "m2#a2",
      kind: "CARD",
      status: "PARSED",
      statementDate: on("2026-09-17"),
      dueDate: on("2026-10-06"),
      // No totalDueMinor at all, which is the whole point.
      lines: [
        { date: on("2026-09-01"), description: "swiggy", amountMinor: 10_000_00, type: "DEBIT", kind: "SPEND" },
        { date: on("2026-09-05"), description: "amazon", amountMinor: 5000_00, type: "DEBIT", kind: "SPEND" },
        { date: on("2026-09-09"), description: "refund", amountMinor: 1000_00, type: "CREDIT", kind: "REVERSAL" },
      ],
    });

    const [status] = await cardStatuses(userId, on("2026-09-17"));

    // 10,000 + 5,000 spent, 1,000 back.
    assert.equal(status.outstandingMinor, 14_000_00);
    assert.equal(status.outstandingIsEstimate, true, "worked out, not printed");
    assert.equal(status.availableMinor, 11_000_00);
  });

  it("prefers the printed total over the rows", async () => {
    // The bank's own figure includes interest, fees and anything carried
    // forward. Where it was read, it is the answer.
    const hdfc = await Account.create({
      userId,
      bankName: "Jupiter",
      last4: "6623",
      accountType: "CARD",
      statementDay: 17,
      creditLimitMinor: 25_000_00,
    });

    await CardStatement.create({
      userId,
      accountId: hdfc._id,
      sourceRef: "m3#a3",
      kind: "CARD",
      status: "PARSED",
      statementDate: on("2026-09-17"),
      totalDueMinor: 14_500_00,
      lines: [
        { date: on("2026-09-01"), description: "swiggy", amountMinor: 14_000_00, type: "DEBIT", kind: "SPEND" },
      ],
    });

    const [status] = await cardStatuses(userId, on("2026-09-17"));
    assert.equal(status.outstandingMinor, 14_500_00);
    assert.equal(status.outstandingIsEstimate, false);
  });

  it("says nothing for a statement with neither a total nor any rows", async () => {
    const hdfc = await Account.create({
      userId,
      bankName: "Jupiter",
      last4: "6623",
      accountType: "CARD",
      statementDay: 17,
      creditLimitMinor: 25_000_00,
    });

    await CardStatement.create({
      userId,
      accountId: hdfc._id,
      sourceRef: "m4#a4",
      kind: "CARD",
      status: "PARSED",
      statementDate: on("2026-09-17"),
      lines: [],
    });

    const [status] = await cardStatuses(userId, on("2026-09-17"));
    assert.equal(status.outstandingMinor, null);
    assert.equal(status.availableMinor, 25_000_00);
  });

  it("still counts a bill whose statement date could not be read", async () => {
    // The other way a real bill vanished. The bills lookup required a
    // statement date, and a reader that cannot find the "Statement Date"
    // label leaves it null - so the statement was filtered out before the
    // rows fallback ever ran. Dated from the close of its period instead,
    // the same way the model files it under a month.
    const hdfc = await Account.create({
      userId,
      bankName: "Jupiter",
      last4: "6623",
      accountType: "CARD",
      statementDay: 17,
      creditLimitMinor: 25_000_00,
    });

    await CardStatement.create({
      userId,
      accountId: hdfc._id,
      sourceRef: "m5#a5",
      kind: "CARD",
      status: "PARSED",
      statementDate: null,
      periodEnd: on("2026-09-16"),
      receivedAt: on("2026-09-17"),
      totalDueMinor: 14_000_00,
      lines: [],
    });

    const [status] = await cardStatuses(userId, on("2026-09-18"));
    assert.equal(status.outstandingMinor, 14_000_00);
    assert.equal(status.availableMinor, 11_000_00);
  });

  it("handles the statement that had neither a date nor a total, only rows", async () => {
    // The Jupiter statement as it actually sits in the database: read by
    // the generic reader, 134 lines reconciled, and both summary fields
    // null. Yesterday's fix covered the total; today's covers the date;
    // this is the two together, which is the case that was live.
    const jupiter = await Account.create({
      userId,
      bankName: "Jupiter",
      last4: "6623",
      accountType: "CARD",
      statementDay: 17,
      creditLimitMinor: 25_000_00,
    });

    await CardStatement.create({
      userId,
      accountId: jupiter._id,
      sourceRef: "m7#a7",
      kind: "CARD",
      status: "PARSED",
      issuer: "generic",
      statementDate: null,
      totalDueMinor: null,
      periodEnd: on("2026-09-13"),
      receivedAt: on("2026-09-17"),
      lines: [
        { date: on("2026-09-01"), description: "a", amountMinor: 9000_00, type: "DEBIT", kind: "SPEND" },
        { date: on("2026-09-08"), description: "b", amountMinor: 6000_00, type: "DEBIT", kind: "SPEND" },
        { date: on("2026-09-12"), description: "c", amountMinor: 1000_00, type: "CREDIT", kind: "REVERSAL" },
      ],
    });

    const [status] = await cardStatuses(userId, on("2026-09-18"));
    assert.equal(status.outstandingMinor, 14_000_00);
    assert.equal(status.outstandingIsEstimate, true);
    assert.equal(status.availableMinor, 11_000_00);
  });

  it("has no available figure without a credit limit to count from", async () => {
    await Account.create({
      userId,
      bankName: "Axis",
      last4: "1111",
      accountType: "CARD",
      statementDay: 17,
    });

    const [status] = await cardStatuses(userId, on("2026-09-20"));
    assert.equal(status.availableMinor, null);
  });
});

describe("two cards on one limit", () => {
  async function card(fields: Record<string, unknown>) {
    return Account.create({ userId, accountType: "CARD", statementDay: 17, ...fields });
  }

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

  it("answers both cards with the one pot, less what either has used", async () => {
    // Two HDFC cards on a single 1,00,000 limit. Spend on either and the
    // other has less, which is what the bank does.
    const regalia = await card({ bankName: "HDFC", nickname: "Regalia", last4: "1111", creditLimitMinor: 100_000_00 });
    const millennia = await card({ bankName: "HDFC", nickname: "Millennia", last4: "2222", sharesLimitWith: regalia._id });

    await spend(regalia._id, "2026-09-20", 30_000);
    await spend(millennia._id, "2026-09-21", 10_000);

    const statuses = await cardStatuses(userId, on("2026-09-22"));
    const byName = new Map(statuses.map((status) => [status.name, status]));

    for (const name of ["Regalia", "Millennia"]) {
      const status = byName.get(name)!;
      assert.equal(status.creditLimitMinor, 100_000_00, `${name} sees the shared limit`);
      assert.equal(status.groupUsedMinor, 40_000_00, `${name} sees what both have used`);
      assert.equal(status.availableMinor, 60_000_00, `${name} has the pot less both`);
    }

    // Each still knows its own spending, which is what its own personal
    // limit is measured against.
    assert.equal(byName.get("Regalia")!.spentMinor, 30_000_00);
    assert.equal(byName.get("Millennia")!.spentMinor, 10_000_00);

    assert.deepEqual(byName.get("Regalia")!.sharesLimitWith, ["Millennia"]);
    assert.deepEqual(byName.get("Millennia")!.sharesLimitWith, ["Regalia"]);
  });

  it("counts a member's unpaid bill against the pot too", async () => {
    const regalia = await card({ bankName: "HDFC", nickname: "Regalia", last4: "1111", creditLimitMinor: 100_000_00 });
    const millennia = await card({ bankName: "HDFC", nickname: "Millennia", last4: "2222", sharesLimitWith: regalia._id });

    await CardStatement.create({
      userId,
      accountId: millennia._id,
      sourceRef: "m6#a6",
      kind: "CARD",
      status: "PARSED",
      statementDate: on("2026-09-17"),
      totalDueMinor: 25_000_00,
      lines: [],
    });
    await spend(regalia._id, "2026-09-20", 5000);

    const [first] = await cardStatuses(userId, on("2026-09-22"));
    assert.equal(first.availableMinor, 70_000_00, "100,000 less a 25,000 bill less 5,000");
  });

  it("leaves a card with a limit of its own alone", async () => {
    await card({ bankName: "Axis", last4: "3333", creditLimitMinor: 50_000_00 });

    const [status] = await cardStatuses(userId, on("2026-09-22"));
    assert.deepEqual(status.sharesLimitWith, []);
    assert.equal(status.groupUsedMinor, null);
    assert.equal(status.availableMinor, 50_000_00);
  });
});
