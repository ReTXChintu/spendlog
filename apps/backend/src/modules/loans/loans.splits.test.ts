import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "loan-splits-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let matching: typeof import("./loans.matching");
let backfill: typeof import("./loans.backfill");
let monthly: typeof import("../budget/budget.monthly");
let allocation: typeof import("./loans.allocation");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_loan_splits_test"));

  const [{ app }, auth, loadedModels, loadedMatching, loadedBackfill, loadedMonthly, loadedAllocation] =
    await Promise.all([
      import("../../app"),
      import("../../middleware/auth"),
      import("../../models"),
      import("./loans.matching"),
      import("./loans.backfill"),
      import("../budget/budget.monthly"),
      import("./loans.allocation"),
    ]);
  signToken = auth.signSessionToken;
  models = loadedModels;
  matching = loadedMatching;
  backfill = loadedBackfill;
  monthly = loadedMonthly;
  allocation = loadedAllocation;

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
    models.Loan.deleteMany({}),
    models.LoanInstalment.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser(fields: Record<string, unknown> = {}) {
  const email = `s${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ...fields });
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

/** Midnight UTC, `days` before today: an instalment that fell due then. */
function daysAgo(days: number): Date {
  const today = new Date();
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days));
}

/**
 * A loan whose first instalment fell due three days ago - so it is owed
 * now - and whose second is a month after that.
 */
async function makeLoan(token: string, monthlyRupees: number, extra: Record<string, unknown> = {}) {
  const response = await call("/loans", token, {
    method: "POST",
    body: JSON.stringify({
      label: `Loan ${monthlyRupees}`,
      principalMinor: monthlyRupees * 100 * 12,
      months: 12,
      monthlyAmountMinor: monthlyRupees * 100,
      startDate: daysAgo(3).toISOString(),
      ...extra,
    }),
  });
  assert.equal(response.status, 201);
  return json<{ id: string }>(response);
}

async function pay(token: string, rupees: number, splits: [string, number][], occurredAt = new Date()) {
  return call("/transactions", token, {
    method: "POST",
    body: JSON.stringify({
      amountMinor: rupees * 100,
      currency: "INR",
      type: "DEBIT",
      merchant: "Loan repayments",
      occurredAt: occurredAt.toISOString(),
      loanSplits: splits.map(([loanId, amount]) => ({ loanId, amountMinor: amount * 100 })),
    }),
  });
}

interface Tabbed {
  id: string;
  status: string;
  paidCount: number;
  paidMinor: number;
  dueToDateMinor: number;
  balanceMinor: number;
  aheadMinor: number;
  behindMinor: number;
  remainingMinor: number;
  nextDue: { seq: number; on: string; amountMinor: number; alreadyCoveredMinor: number } | null;
  instalments: { seq: number; status: string; amountMinor: number; paidMinor: number }[];
  payments: { transactionId: string; amountMinor: number; totalMinor: number }[];
}

async function listed(token: string) {
  return json<{ loans: Tabbed[]; totals: { balanceMinor: number; aheadMinor: number; behindMinor: number } }>(
    await call("/loans?totals=1", token)
  );
}

async function loanById(token: string, id: string): Promise<Tabbed> {
  return (await listed(token)).loans.find((loan) => loan.id === id)!;
}

describe("one payment across several loans", () => {
  it("covers three loans' dues exactly, and the tab reads even", async () => {
    const user = await makeUser();
    const a = await makeLoan(user.token, 5_000);
    const b = await makeLoan(user.token, 7_000);
    const c = await makeLoan(user.token, 3_000);

    const suggestion = await json<{
      loans: { loanId: string; dueMinor: number }[];
      totalDueMinor: number;
      remainderMinor: number;
      matches: { loanIds: string[] }[];
    }>(await call(`/loans/split-suggestion?amountMinor=${15_000_00}`, user.token));
    assert.equal(suggestion.totalDueMinor, 15_000_00);
    assert.equal(suggestion.remainderMinor, 0);
    assert.deepEqual(suggestion.matches.map((match) => match.loanIds.length), [3]);

    const response = await pay(user.token, 15_000, [
      [a.id, 5_000],
      [b.id, 7_000],
      [c.id, 3_000],
    ]);
    assert.equal(response.status, 201);
    const payment = await json<{ id: string; loanId: string; loanSplits: unknown[]; loanUnassignedMinor: number }>(response);
    assert.equal(payment.loanSplits.length, 3);
    assert.equal(payment.loanId, a.id, "loanId names the first loan, for older readers");
    assert.equal(payment.loanUnassignedMinor, 0);

    const { loans, totals } = await listed(user.token);
    for (const loan of loans) {
      assert.equal(loan.instalments[0].status, "PAID");
      assert.equal(loan.instalments[1].status, "DUE");
      assert.equal(loan.balanceMinor, 0);
      assert.equal(loan.paidCount, 1);
    }
    assert.equal(totals.balanceMinor, 0);

    const share = loans.find((loan) => loan.id === b.id)!.payments[0];
    assert.equal(share.amountMinor, 7_000_00);
    assert.equal(share.totalMinor, 15_000_00, "each loan sees its share of the whole payment");
  });

  it("rolls extra on one loan into its next instalment - ahead, not prepaid", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token, 10_000);

    await pay(user.token, 10_500, [[loan.id, 10_500]]);

    const state = await loanById(user.token, loan.id);
    assert.equal(state.instalments[0].status, "PAID");
    assert.equal(state.instalments[1].status, "PARTIAL");
    assert.equal(state.instalments[1].paidMinor, 500_00);
    assert.equal(state.instalments[1].amountMinor, 10_000_00, "the schedule itself is untouched");
    assert.equal(state.balanceMinor, 500_00);
    assert.equal(state.aheadMinor, 500_00);
    assert.equal(state.behindMinor, 0);
    assert.equal(state.nextDue?.seq, 2);
    assert.equal(state.nextDue?.alreadyCoveredMinor, 500_00);
    assert.equal(state.paidCount, 1);
    assert.equal(state.remainingMinor, 12 * 10_000_00 - 10_500_00);
  });

  it("leaves an instalment partly paid when less goes in, and the next payment finishes it first", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token, 10_000);

    await pay(user.token, 9_700, [[loan.id, 9_700]]);
    let state = await loanById(user.token, loan.id);
    assert.equal(state.instalments[0].status, "PARTIAL");
    assert.equal(state.instalments[0].paidMinor, 9_700_00);
    assert.equal(state.behindMinor, 300_00);
    assert.equal(state.nextDue?.seq, 1);
    assert.equal(state.nextDue?.alreadyCoveredMinor, 9_700_00);
    assert.equal(state.status, "ACTIVE");

    await pay(user.token, 10_000, [[loan.id, 10_000]]);
    state = await loanById(user.token, loan.id);
    assert.equal(state.instalments[0].status, "PAID");
    assert.equal(state.instalments[1].status, "PARTIAL");
    assert.equal(state.instalments[1].paidMinor, 9_700_00);
    assert.equal(state.balanceMinor, 9_700_00, "a month's money in hand before the second falls due");
  });

  it("saves a remainder put down to no loan, and says how much", async () => {
    const user = await makeUser();
    const a = await makeLoan(user.token, 10_000);
    const b = await makeLoan(user.token, 4_500);

    const response = await pay(user.token, 15_000, [
      [a.id, 10_000],
      [b.id, 4_500],
    ]);
    assert.equal(response.status, 201);
    const payment = await json<{ id: string; loanUnassignedMinor: number; countedAmountMinor: number }>(response);
    assert.equal(payment.loanUnassignedMinor, 500_00);
    assert.equal(payment.countedAmountMinor, 15_000_00, "a loan repayment is real spending, all of it");

    const fetched = await json<{ loanUnassignedMinor: number }>(await call(`/transactions/${payment.id}`, user.token));
    assert.equal(fetched.loanUnassignedMinor, 500_00);
  });

  it("gives the money back to the schedule when the payment is deleted", async () => {
    const user = await makeUser();
    const a = await makeLoan(user.token, 5_000);
    const b = await makeLoan(user.token, 5_000);
    const payment = await json<{ id: string }>(await pay(user.token, 10_000, [[a.id, 5_000], [b.id, 5_000]]));

    assert.equal((await call(`/transactions/${payment.id}`, user.token, { method: "DELETE" })).status, 204);

    const { loans } = await listed(user.token);
    for (const loan of loans) assert.equal(loan.instalments[0].status, "DUE");
  });

  it("deleting one loan leaves the payment's other loans, and its share unassigned", async () => {
    const user = await makeUser();
    const a = await makeLoan(user.token, 5_000);
    const b = await makeLoan(user.token, 5_000);
    const payment = await json<{ id: string }>(await pay(user.token, 10_000, [[a.id, 5_000], [b.id, 5_000]]));

    await call(`/loans/${a.id}`, user.token, { method: "DELETE" });

    const stored = await json<{ loanId: string; loanSplits: { loanId: string }[]; loanUnassignedMinor: number }>(
      await call(`/transactions/${payment.id}`, user.token)
    );
    assert.deepEqual(stored.loanSplits.map((split) => split.loanId), [b.id]);
    assert.equal(stored.loanId, b.id);
    assert.equal(stored.loanUnassignedMinor, 5_000_00);
  });
});

describe("checking a split", () => {
  it("refuses loans that add up to more than the payment", async () => {
    const user = await makeUser();
    const a = await makeLoan(user.token, 5_000);
    const b = await makeLoan(user.token, 5_000);

    const response = await pay(user.token, 9_000, [[a.id, 5_000], [b.id, 5_000]]);
    assert.equal(response.status, 400);
    assert.match((await json<{ error: string }>(response)).error, /more than the payment/);
    assert.equal(await models.Transaction.countDocuments({}), 0, "nothing half-written");
  });

  it("refuses someone else's loan", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const loan = await makeLoan(owner.token, 5_000);

    const response = await pay(stranger.token, 5_000, [[loan.id, 5_000]]);
    assert.equal(response.status, 400);
    assert.equal((await json<{ error: string }>(response)).error, "Unknown loan");
  });

  it("refuses a closed loan, unless the payment already repays it", async () => {
    const user = await makeUser();
    const open = await makeLoan(user.token, 5_000);
    const closed = await makeLoan(user.token, 5_000);
    const payment = await json<{ id: string }>(await pay(user.token, 10_000, [[open.id, 5_000], [closed.id, 5_000]]));

    await call(`/loans/${closed.id}`, user.token, { method: "PATCH", body: JSON.stringify({ status: "CLOSED" }) });

    // Saving it again as it stands is fine - closing a loan does not make
    // its old payments uneditable.
    const resaved = await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({
        loanSplits: [
          { loanId: open.id, amountMinor: 4_000_00 },
          { loanId: closed.id, amountMinor: 5_000_00 },
        ],
      }),
    });
    assert.equal(resaved.status, 200);

    const fresh = await pay(user.token, 5_000, [[closed.id, 5_000]]);
    assert.equal(fresh.status, 400);
    assert.match((await json<{ error: string }>(fresh)).error, /closed/);
  });

  it("refuses the same loan twice", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token, 5_000);
    const response = await pay(user.token, 10_000, [[loan.id, 5_000], [loan.id, 5_000]]);
    assert.equal(response.status, 400);
  });
});

describe("a repayment from before loanSplits", () => {
  it("reads as one loan for the whole amount, and the backfill writes it so", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token, 10_000, { months: 3, principalMinor: 30_000_00 });
    const [first, second] = await models.LoanInstalment.find({ loanId: loan.id }).sort({ seq: 1 });

    // Written the way the old code left things: the payment naming its
    // loan, the instalment it claimed marked paid, and one ticked by hand.
    const legacyId = new Types.ObjectId();
    await models.Transaction.collection.insertOne({
      _id: legacyId,
      userId: user.id,
      amountMinor: 10_000_00,
      countedAmountMinor: 10_000_00,
      currency: "INR",
      type: "DEBIT",
      source: "SMS",
      occurredAt: daysAgo(2),
      loanId: new Types.ObjectId(loan.id),
    });
    await models.LoanInstalment.collection.updateOne(
      { _id: first._id },
      { $set: { status: "PAID", transactionId: legacyId }, $unset: { paidMinor: "", byHand: "" } }
    );
    await models.LoanInstalment.collection.updateOne(
      { _id: second._id },
      { $set: { status: "PAID", transactionId: null }, $unset: { paidMinor: "", byHand: "" } }
    );

    let state = await loanById(user.token, loan.id);
    assert.equal(state.paidMinor, 20_000_00, "the old payment counts before any backfill");
    assert.equal(state.payments[0].amountMinor, 10_000_00);

    await backfill.backfillLoanSplits(user.id);

    const migrated = await models.Transaction.findById(legacyId).orFail();
    assert.equal(migrated.loanSplits.length, 1);
    assert.equal(migrated.loanSplits[0].amountMinor, 10_000_00);

    state = await loanById(user.token, loan.id);
    assert.equal(state.paidCount, 2, "the tick by hand stays a tick");
    assert.equal(state.instalments[0].status, "PAID");
    assert.equal(state.instalments[1].status, "PAID");
    assert.equal(state.instalments[2].status, "DUE");
    assert.equal(
      String((await models.LoanInstalment.findById(first._id).orFail()).transactionId),
      String(legacyId)
    );

    // Twice is the same as once.
    await backfill.backfillLoanSplits(user.id);
    assert.equal((await models.Transaction.findById(legacyId).orFail()).loanSplits.length, 1);
  });

  it("an older client naming the loan a combined payment leads with does not flatten it", async () => {
    const user = await makeUser();
    const a = await makeLoan(user.token, 5_000);
    const b = await makeLoan(user.token, 5_000);
    const payment = await json<{ id: string }>(await pay(user.token, 10_000, [[a.id, 5_000], [b.id, 5_000]]));

    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: a.id, note: "edited on the web" }),
    });
    const stored = await models.Transaction.findById(payment.id).orFail();
    assert.equal(stored.loanSplits.length, 2);

    // Naming a different loan is the old "the whole payment to this one".
    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: b.id }),
    });
    const repointed = await models.Transaction.findById(payment.id).orFail();
    assert.deepEqual(
      repointed.loanSplits.map((split) => [String(split.loanId), split.amountMinor]),
      [[b.id, 10_000_00]]
    );
  });

  it("a single-loan repayment follows its amount when that is corrected", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token, 5_000);
    const payment = await json<{ id: string }>(await pay(user.token, 5_000, [[loan.id, 5_000]]));

    const response = await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ amountMinor: 4_000_00 }),
    });
    assert.equal(response.status, 200);
    const stored = await models.Transaction.findById(payment.id).orFail();
    assert.equal(stored.loanSplits[0].amountMinor, 4_000_00);
    assert.equal((await loanById(user.token, loan.id)).instalments[0].status, "PARTIAL");
  });
});

describe("suggesting a split", () => {
  it("nets out what an earlier extra payment already covers", async () => {
    const user = await makeUser();
    const ahead = await makeLoan(user.token, 10_000);
    const owing = await makeLoan(user.token, 5_000);
    const earlier = await json<{ id: string }>(await pay(user.token, 10_500, [[ahead.id, 10_500]], daysAgo(3)));

    const suggestion = await json<{
      loans: { loanId: string; dueMinor: number; aheadMinor: number; instalments: { seq: number }[] }[];
      totalDueMinor: number;
      remainderMinor: number;
    }>(await call(`/loans/split-suggestion?amountMinor=${15_000_00}`, user.token));

    const forAhead = suggestion.loans.find((loan) => loan.loanId === ahead.id)!;
    assert.equal(forAhead.dueMinor, 9_500_00, "next month's, less the ₹500 already in hand");
    assert.deepEqual(forAhead.instalments.map((row) => row.seq), [2]);
    assert.equal(forAhead.aheadMinor, 500_00);
    assert.equal(suggestion.loans.find((loan) => loan.loanId === owing.id)!.dueMinor, 5_000_00);
    assert.equal(suggestion.totalDueMinor, 14_500_00);
    assert.equal(suggestion.remainderMinor, 500_00, "₹500 more than is owing");

    // Re-suggesting for that same payment leaves its own money out.
    const again = await json<{ loans: { loanId: string; dueMinor: number }[] }>(
      await call(`/loans/split-suggestion?amountMinor=${10_500_00}&transactionId=${earlier.id}`, user.token)
    );
    assert.equal(again.loans.find((loan) => loan.loanId === ahead.id)!.dueMinor, 10_000_00);
  });
});

describe("matching a combined debit", () => {
  async function dueLoans(userId: Types.ObjectId, rupees: number[]) {
    const ids: Types.ObjectId[] = [];
    for (const amount of rupees) {
      const loan = await models.Loan.create({
        userId,
        label: `Loan ${amount}`,
        principalMinor: amount * 100 * 12,
        months: 12,
        monthlyAmountMinor: amount * 100,
        totalPayableMinor: amount * 100 * 12,
        startDate: daysAgo(3),
        status: "ACTIVE",
      });
      await models.LoanInstalment.insertMany(
        [0, 1].map((index) => ({
          userId,
          loanId: loan._id,
          seq: index + 1,
          dueDate: new Date(daysAgo(3).getTime() + index * 31 * 24 * 60 * 60 * 1000),
          amountMinor: amount * 100,
          status: "DUE",
        }))
      );
      ids.push(loan._id);
    }
    return ids;
  }

  async function debit(userId: Types.ObjectId, rupees: number) {
    return models.Transaction.create({
      userId,
      amountMinor: rupees * 100,
      currency: "INR",
      type: "DEBIT",
      merchant: "NACH debit",
      source: "SMS",
      occurredAt: new Date(),
    });
  }

  it("splits a debit that is exactly what several loans owe", async () => {
    const { id: userId } = await makeUser();
    const [a, b, c] = await dueLoans(userId, [5_000, 7_000, 3_000]);

    const payment = await debit(userId, 15_000);
    assert.equal(await matching.matchLoanInstalment(payment), true);

    const stored = await models.Transaction.findById(payment._id).orFail();
    assert.deepEqual(
      stored.loanSplits.map((split) => [String(split.loanId), split.amountMinor]).sort(),
      [
        [String(a), 5_000_00],
        [String(b), 7_000_00],
        [String(c), 3_000_00],
      ].sort()
    );
    assert.equal(await models.LoanInstalment.countDocuments({ seq: 1, status: "PAID" }), 3);
  });

  it("allows a rupee of rounding, keeping the split inside the debit", async () => {
    const { id: userId } = await makeUser();
    await dueLoans(userId, [5_000, 7_000]);

    const payment = await models.Transaction.create({
      userId,
      amountMinor: 11_999_50,
      currency: "INR",
      type: "DEBIT",
      source: "SMS",
      occurredAt: new Date(),
    });
    assert.equal(await matching.matchLoanInstalment(payment), true);
    const stored = await models.Transaction.findById(payment._id).orFail();
    assert.equal(
      stored.loanSplits.reduce((sum, split) => sum + split.amountMinor, 0),
      11_999_50
    );
  });

  it("leaves it alone when two different sets of loans would both add up", async () => {
    const { id: userId, token } = await makeUser();
    await dueLoans(userId, [4_000, 6_000, 3_000, 7_000]);

    const payment = await debit(userId, 10_000);
    assert.equal(await matching.matchLoanInstalment(payment), false);
    assert.equal((await models.Transaction.findById(payment._id).orFail()).loanSplits.length, 0);

    // The editor still offers both.
    const suggestion = await json<{ matches: { loanIds: string[] }[] }>(
      await call(`/loans/split-suggestion?amountMinor=${10_000_00}`, token)
    );
    assert.equal(suggestion.matches.length, 2);
  });

  it("still prefers a single loan whose instalment matches on its own", async () => {
    const { id: userId } = await makeUser();
    const [single] = await dueLoans(userId, [10_000, 4_000, 6_000]);

    const payment = await debit(userId, 10_000);
    assert.equal(await matching.matchLoanInstalment(payment), true);
    const stored = await models.Transaction.findById(payment._id).orFail();
    assert.deepEqual(stored.loanSplits.map((split) => String(split.loanId)), [String(single)]);
  });
});

describe("the budget, with split and partial repayments", () => {
  /** An IST calendar day at noon. */
  const on = (day: string) => new Date(`${day}T12:00:00+05:30`);

  it("counts each loan's share as a fixed cost, and only a shortfall as still to go out", async () => {
    const { id: userId } = await makeUser({
      salaryDay: 1,
      monthlyBudgetHistory: [{ fromMonthKey: "2026-10", amountMinor: 1_00_000_00, categoryLimits: [] }],
    });
    const makeOne = async (label: string, rupees: number, start: string) => {
      const loan = await models.Loan.create({
        userId,
        label,
        principalMinor: rupees * 100 * 6,
        months: 6,
        monthlyAmountMinor: rupees * 100,
        totalPayableMinor: rupees * 100 * 6,
        startDate: new Date(`${start}T00:00:00Z`),
        status: "ACTIVE",
      });
      const { buildSchedule } = await import("../emi/emi.schedule");
      await models.LoanInstalment.insertMany(
        buildSchedule(loan.startDate, 6, rupees * 100).map((entry) => ({ userId, loanId: loan._id, ...entry }))
      );
      return loan;
    };
    const full = await makeOne("Car", 10_000, "2026-10-03");
    const short = await makeOne("Phone", 6_000, "2026-10-03");
    await makeOne("Gold", 4_000, "2026-10-20");

    // One ₹15,000 payment: the car in full, ₹4,000 of the phone's ₹6,000,
    // and ₹1,000 nobody has said the purpose of yet.
    const payment = await models.Transaction.create({
      userId,
      amountMinor: 15_000_00,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: on("2026-10-05"),
    });
    const { setLoanSplits } = await import("./loans.splits");
    await setLoanSplits(payment, [
      { loanId: full._id, amountMinor: 10_000_00 },
      { loanId: short._id, amountMinor: 4_000_00 },
    ]);
    // An older single-loan repayment, never backfilled: its one loan, in full.
    await models.Transaction.collection.insertOne({
      userId,
      amountMinor: 2_000_00,
      countedAmountMinor: 2_000_00,
      countedReason: "FULL",
      currency: "INR",
      type: "DEBIT",
      source: "SMS",
      occurredAt: on("2026-10-06"),
      loanId: short._id,
    });

    const status = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-09"));
    assert.equal(status.spentMinor, 17_000_00, "the whole debit counts, as any EMI does");
    assert.equal(status.pace!.fixedPaidMinor, 16_000_00, "the shares put down to loans, not the ₹1,000 left over");
    // The phone's ₹6,000 had ₹4,000 from the combined payment; the old row
    // is not in its tab yet (no reallocation ran for it), so ₹2,000 still
    // shows short. The gold loan's ₹4,000 falls due on the 20th.
    assert.equal(status.pace!.fixedStillDueMinor, 2_000_00 + 4_000_00);

    // Once the phone's tab is worked out again, the older ₹2,000 finishes it.
    const { reallocateLoan } = await import("./loans.splits");
    await reallocateLoan(short._id);
    const after = await monthly.monthlyBudgetStatus(userId, undefined, on("2026-10-09"));
    assert.equal(after.pace!.fixedStillDueMinor, 4_000_00);
  });
});

describe("the tab's arithmetic", () => {
  it("lets a lender's rounding on the last instalment finish the loan", () => {
    const due = (seq: number) => ({ seq, dueDate: new Date(Date.UTC(2026, seq, 5)), amountMinor: 5_000_00, status: "DUE" });
    const { coverage } = allocation.allocate(
      [due(1), due(2)],
      [{ transactionId: "t", amountMinor: 9_998_00, occurredAt: new Date() }]
    );
    assert.deepEqual(coverage.map((row) => row.status), ["PAID", "PAID"]);
  });

  it("reads ahead and behind against what has fallen due by today", () => {
    const now = new Date("2026-10-16T12:00:00+05:30");
    const rows = [
      { seq: 1, dueDate: new Date("2026-10-05T00:00:00Z"), amountMinor: 10_000_00, status: "PAID", paidMinor: 10_000_00, transactionId: "t" },
      { seq: 2, dueDate: new Date("2026-11-05T00:00:00Z"), amountMinor: 10_000_00, status: "PARTIAL", paidMinor: 1_200_00, transactionId: "t" },
    ];
    const tab = allocation.loanTab(rows, 11_200_00, now);
    assert.equal(tab.dueToDateMinor, 10_000_00);
    assert.equal(tab.balanceMinor, 1_200_00);
    assert.equal(tab.nextDue?.on, "2026-11-05");
    assert.equal(tab.coveredThrough, "2026-10-05");
    assert.deepEqual(allocation.tabTotals([tab, { paidMinor: 0, dueToDateMinor: 2_000_00 }]).balanceMinor, -800_00);
  });
});
