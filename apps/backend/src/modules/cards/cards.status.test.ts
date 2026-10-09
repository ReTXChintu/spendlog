import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayKey } from "../../time";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "card-status-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let status: typeof import("./cards.status");
let backfill: typeof import("../accounts/accounts.backfill");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_card_status_test"));

  const [{ app }, auth, loadedModels, loadedStatus, loadedBackfill] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./cards.status"),
    import("../accounts/accounts.backfill"),
  ]);
  signToken = auth.signSessionToken;
  models = loadedModels;
  status = loadedStatus;
  backfill = loadedBackfill;

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
let bankId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.CardStatement.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
  ]);
  const email = `s${(userCount += 1)}@example.com`;
  // Paid on the 1st, so the salary month is the calendar month - and any
  // card figure that followed it would start on the 1st.
  const user = await models.User.create({ email, salaryDay: 1 });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  bankId = (await models.Account.create({ userId, bankName: "HDFC Bank", last4: "4821", accountType: "BANK" }))._id;
});

/** An IST calendar day, as an instant at noon so no boundary is grazed. */
function on(day: string): Date {
  return new Date(`${day}T12:00:00+05:30`);
}

const TODAY = on("2026-10-10");

function card(fields: Record<string, unknown>) {
  return models.Account.create({ userId, bankName: "HDFC", accountType: "CARD", ...fields });
}

function charge(accountId: Types.ObjectId, day: string, rupees: number, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    accountId,
    type: "DEBIT",
    amountMinor: rupees * 100,
    occurredAt: on(day),
    source: "MANUAL",
    ...extra,
  });
}

/** A bill paid from the bank account, marked as paying the card. */
function pay(cardId: Types.ObjectId, day: string, rupees: number) {
  return charge(bankId, day, rupees, { cardPaymentFor: cardId });
}

function statement(cardId: Types.ObjectId, fields: Record<string, unknown>) {
  return models.CardStatement.create({
    userId,
    accountId: cardId,
    sourceRef: `m${Math.random()}`,
    kind: "CARD",
    status: "PARSED",
    lines: [],
    ...fields,
  });
}

async function statusOf(accountId: Types.ObjectId, now = TODAY) {
  const all = await status.cardStatuses(userId, now);
  return all.find((row) => row.accountId === accountId.toString())!;
}

describe("each card on its own cycle", () => {
  it("gives two cards with different statement days different cycles on the same day", async () => {
    const early = await card({ nickname: "Early", last4: "1111", statementDay: 5, creditLimitMinor: 100_000_00 });
    const late = await card({ nickname: "Late", last4: "2222", statementDay: 20, creditLimitMinor: 100_000_00 });

    await charge(early._id, "2026-10-03", 1000); // Early's last cycle
    await charge(early._id, "2026-10-07", 2000); // Early's current one
    await charge(late._id, "2026-09-25", 3000); // Late's current one, last month
    await charge(late._id, "2026-10-08", 4000);

    const e = await statusOf(early._id);
    const l = await statusOf(late._id);

    assert.equal(istDayKey(e.cycleStart!), "2026-10-05");
    assert.equal(istDayKey(e.cycleEnd!), "2026-11-04");
    assert.equal(istDayKey(l.cycleStart!), "2026-09-20");
    assert.equal(istDayKey(l.cycleEnd!), "2026-10-19");

    // Neither starts on the 1st, the salary month's first day.
    assert.equal(e.unbilledMinor, 2000_00);
    assert.equal(l.unbilledMinor, 7000_00);
    // Early's 1,000 on the 3rd closed into its bill on the 5th.
    assert.equal(e.billedUnpaidMinor, 1000_00);
  });

  it("marks a card with no statement day as having no cycle, not the salary month", async () => {
    const bare = await card({ nickname: "Bare", last4: "3333", creditLimitMinor: 50_000_00 });
    await charge(bare._id, "2026-10-02", 5000);

    const row = await statusOf(bare._id);
    assert.equal(row.cycleKnown, false);
    assert.equal(row.cycleStart, null);
    assert.equal(row.unbilledMinor, null);
    assert.equal(row.billedUnpaidMinor, null);
    assert.equal(row.availableMinor, null);
    assert.equal(row.state, "unset");
    assert.equal(row.floatDays, null);
  });

  it("reads a missing statement day off the newest statement", async () => {
    const learned = await card({ nickname: "Learned", last4: "4444", creditLimitMinor: 50_000_00 });
    await statement(learned._id, {
      statementDate: on("2026-09-12"),
      dueDate: on("2026-10-01"),
      totalDueMinor: 9000_00,
    });

    const row = await statusOf(learned._id);
    assert.equal(row.cycleKnown, true);
    assert.equal(row.statementDay, 12);
    assert.equal(row.dueDay, 1);
    assert.equal(row.statementDayInferred, true);
    assert.equal(istDayKey(row.cycleStart!), "2026-09-12");
  });
});

describe("what a card owes, and what is left", () => {
  async function billedCard() {
    const hdfc = await card({ last4: "5555", statementDay: 20, dueDay: 8, creditLimitMinor: 50_000_00 });
    await statement(hdfc._id, {
      statementDate: on("2026-09-20"),
      // Midnight, the way a statement's printed date is read.
      dueDate: new Date("2026-10-08T00:00:00+05:30"),
      totalDueMinor: 20_000_00,
      minimumDueMinor: 1000_00,
    });
    return hdfc;
  }

  it("owes an unpaid bill and everything charged since", async () => {
    const hdfc = await billedCard();
    await charge(hdfc._id, "2026-09-25", 2000);

    const row = await statusOf(hdfc._id);
    assert.equal(row.billedUnpaidMinor, 20_000_00);
    assert.equal(row.unbilledMinor, 2000_00);
    assert.equal(row.outstandingMinor, 22_000_00);
    assert.equal(row.availableMinor, 28_000_00);
    assert.equal(row.billIsPaid, false);
    assert.equal(row.outstandingIsEstimate, false);
    assert.equal(istDayKey(row.lastBill!.dueOn!), "2026-10-08");
    assert.equal(row.lastBill!.daysUntilDue, -2, "two days late on the 10th");
  });

  it("takes a part payment off the bill", async () => {
    const hdfc = await billedCard();
    await charge(hdfc._id, "2026-09-25", 2000);
    await pay(hdfc._id, "2026-09-28", 5000);

    const row = await statusOf(hdfc._id);
    assert.equal(row.lastBill!.paidMinor, 5000_00);
    assert.equal(row.billedUnpaidMinor, 15_000_00);
    assert.equal(row.outstandingMinor, 17_000_00);
    assert.equal(row.availableMinor, 33_000_00);
    assert.equal(row.billIsPaid, false);
  });

  it("drops the billed part once the bill is paid in full", async () => {
    const hdfc = await billedCard();
    await charge(hdfc._id, "2026-09-25", 2000);
    await pay(hdfc._id, "2026-09-28", 15_000);
    await pay(hdfc._id, "2026-10-05", 5000);

    const row = await statusOf(hdfc._id);
    assert.equal(row.billedUnpaidMinor, 0);
    assert.equal(row.billIsPaid, true);
    assert.equal(row.outstandingMinor, 2000_00, "only the running cycle");
    assert.equal(row.availableMinor, 48_000_00);
  });

  it("counts a payment only the card reported", async () => {
    // Paid from an account that never texts: the card's "payment received"
    // is the only sign of it.
    const hdfc = await billedCard();
    await models.Transaction.create({
      userId,
      accountId: hdfc._id,
      type: "CREDIT",
      amountMinor: 20_000_00,
      isTransfer: true,
      occurredAt: on("2026-10-01"),
      source: "MANUAL",
    });

    const row = await statusOf(hdfc._id);
    assert.equal(row.billIsPaid, true);
    assert.equal(row.unbilledMinor, 0, "a payment is not a refund");
  });

  it("estimates the bill from the cycle just closed when no statement was read", async () => {
    const axis = await card({ bankName: "Axis", last4: "6666", statementDay: 20, dueDay: 8, creditLimitMinor: 50_000_00 });

    // The cycle 20 Aug - 19 Sep: 8,000 charged, 1,000 refunded onto the card.
    await charge(axis._id, "2026-09-01", 8000);
    await models.Transaction.create({
      userId,
      accountId: axis._id,
      type: "CREDIT",
      amountMinor: 1000_00,
      occurredAt: on("2026-09-05"),
      source: "MANUAL",
    });
    // Before that cycle, so on a bill already gone.
    await charge(axis._id, "2026-08-10", 9000);
    await pay(axis._id, "2026-09-25", 3000);
    // This cycle: the whole dinner is on the card, whatever my share was.
    await charge(axis._id, "2026-10-01", 3000, { split: { myShareMinor: 1000_00 } });

    const row = await statusOf(axis._id);
    assert.equal(row.outstandingIsEstimate, true);
    assert.equal(row.lastBill!.fromStatement, false);
    assert.equal(row.lastBill!.amountMinor, 7000_00);
    assert.equal(row.billedUnpaidMinor, 4000_00);
    assert.equal(row.unbilledMinor, 3000_00);
    assert.equal(row.outstandingMinor, 7000_00);
    assert.equal(row.availableMinor, 43_000_00);
    assert.equal(istDayKey(row.lastBill!.dueOn!), "2026-10-08");
  });

  it("does not take last month's statement for the cycle that has just closed", async () => {
    const hdfc = await card({ last4: "7777", statementDay: 20, creditLimitMinor: 50_000_00 });
    await statement(hdfc._id, { statementDate: on("2026-08-20"), totalDueMinor: 30_000_00 });
    await charge(hdfc._id, "2026-09-10", 4000);

    const row = await statusOf(hdfc._id);
    assert.equal(row.outstandingIsEstimate, true);
    assert.equal(row.billedUnpaidMinor, 4000_00);
  });
});

describe("the bar against the credit limit", () => {
  it("is ok below 70%, close from 70%, over from 90% or past the limit", () => {
    assert.equal(status.creditState(6900, 10_000), "ok");
    assert.equal(status.creditState(7000, 10_000), "close");
    assert.equal(status.creditState(9000, 10_000), "over");
    assert.equal(status.creditState(12_000, 10_000), "over");
    assert.equal(status.creditState(5000, null), "unset");
    assert.equal(status.creditState(null, 10_000), "unset");
  });

  it("is worked out on the server from what is outstanding", async () => {
    const hdfc = await card({ last4: "8888", statementDay: 20, creditLimitMinor: 10_000_00 });
    await charge(hdfc._id, "2026-09-22", 9500);

    const row = await statusOf(hdfc._id);
    assert.equal(row.state, "over");
    assert.equal(row.availableMinor, 500_00);

    // And a card nearly out of credit is not suggested.
    assert.equal(status.pickCards([row]).best, null);
  });
});

describe("the spend limit, retired", () => {
  function call(path: string, init?: RequestInit) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  }

  it("is in none of the card payloads", async () => {
    const hdfc = await card({ last4: "9999", statementDay: 20, creditLimitMinor: 50_000_00 });
    // As an account saved before the field went would still have it.
    await models.Account.collection.updateOne({ _id: hdfc._id }, { $set: { spendLimitMinor: 30_000_00 } });

    const [row] = await status.cardStatuses(userId, TODAY);
    for (const key of ["spendLimitMinor", "limitMinor", "remainingMinor", "periodIsCycle"]) {
      assert.equal(key in row, false, `${key} is gone from the status`);
    }

    const dashboard = (await (await call("/dashboard")).json()) as { wallet: { cards: Record<string, unknown>[] } };
    const face = dashboard.wallet.cards[0];
    assert.equal("spendLimitMinor" in face, false);
    assert.equal(face.cycleKnown, true);
    assert.equal(typeof face.availableMinor, "number");

    const overview = (await (await call("/accounts/overview")).json()) as {
      id: string;
      cycle: Record<string, unknown> | null;
      month: Record<string, unknown>;
    }[];
    const panel = overview.find((account) => account.id === hdfc.id)!;
    assert.equal("limitMinor" in panel.cycle!, false);
    assert.equal("limitMinor" in panel.month, false);
  });

  it("is cleared off stored accounts, and ignored when sent", async () => {
    const hdfc = await card({ last4: "1234", statementDay: 20 });
    await models.Account.collection.updateOne({ _id: hdfc._id }, { $set: { spendLimitMinor: 30_000_00 } });

    assert.equal(await backfill.dropSpendLimits(userId), 1);
    assert.equal(await backfill.dropSpendLimits(userId), 0, "a second pass finds nothing");
    const listed = (await (await call("/accounts")).json()) as Record<string, unknown>[];
    assert.ok(listed.every((account) => !("spendLimitMinor" in account)));

    const patched = await call(`/accounts/${hdfc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ spendLimitMinor: 10_000_00, statementDay: 18 }),
    });
    assert.equal(patched.status, 200);
    const raw = await models.Account.collection.findOne({ _id: hdfc._id });
    assert.equal(raw?.spendLimitMinor, undefined);
    assert.equal(raw?.statementDay, 18);
  });

  it("offers no cycles for a card whose billing date is unknown", async () => {
    const bare = await card({ last4: "4321" });
    const body = (await (await call(`/accounts/${bare.id}/cycles`)).json()) as {
      cycleKnown: boolean;
      cycles: unknown[];
    };
    assert.equal(body.cycleKnown, false);
    assert.deepEqual(body.cycles, []);
  });
});
