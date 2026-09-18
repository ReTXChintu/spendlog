import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Account, Loan, LoanInstalment, Transaction, User } from "../../models";
import { buildSchedule } from "../emi/emi.schedule";
import { attachToLoan, matchLoanInstalment } from "./loans.matching";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_loans_matching_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    Transaction.deleteMany({}),
    Loan.deleteMany({}),
    LoanInstalment.deleteMany({}),
    Account.deleteMany({}),
    User.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `u${(userCount += 1)}@example.com`, name: "Test" });
  return user._id;
}

const START_DATE = new Date("2026-09-10T10:00:00Z");

async function makeLoan(
  userId: Types.ObjectId,
  options: { accountId?: Types.ObjectId | null; monthlyAmountMinor?: number; months?: number } = {}
) {
  const monthlyAmountMinor = options.monthlyAmountMinor ?? 500000;
  const months = options.months ?? 12;

  const loan = await Loan.create({
    userId,
    label: "Personal loan",
    accountId: options.accountId ?? null,
    principalMinor: monthlyAmountMinor * months,
    months,
    monthlyAmountMinor,
    totalPayableMinor: monthlyAmountMinor * months,
    startDate: START_DATE,
    status: "ACTIVE",
  });

  await LoanInstalment.insertMany(
    buildSchedule(START_DATE, months, monthlyAmountMinor).map((entry) => ({
      userId,
      loanId: loan._id,
      ...entry,
    }))
  );

  return loan;
}

async function debit(userId: Types.ObjectId, amountMinor: number, occurredAt: Date, accountId?: Types.ObjectId) {
  return Transaction.create({
    userId,
    accountId: accountId ?? null,
    amountMinor,
    currency: "INR",
    type: "DEBIT",
    merchant: "Loan repayment",
    source: "SMS",
    occurredAt,
  });
}

describe("matching a monthly debit to its loan instalment", () => {
  it("ticks off the instalment it pays", async () => {
    const userId = await makeUser();
    const loan = await makeLoan(userId);

    const payment = await debit(userId, 500000, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchLoanInstalment(payment), true);

    const second = await LoanInstalment.findOne({ loanId: loan._id, seq: 2 }).orFail();
    assert.equal(second.status, "PAID");
    assert.equal(String(second.transactionId), String(payment._id));
  });

  it("counts the payment in full - a loan has no parent to keep out of the totals", async () => {
    const userId = await makeUser();
    await makeLoan(userId);

    const payment = await debit(userId, 500000, new Date("2026-10-10T06:00:00Z"));
    await matchLoanInstalment(payment);

    const stored = await Transaction.findById(payment._id).orFail();
    assert.equal(String(stored.loanId), String((await Loan.findOne({ userId }).orFail())._id));
    assert.equal(stored.countedAmountMinor, 500000);
    assert.equal(stored.countedReason, "FULL");
  });

  it("allows for a lender rounding the last rupee differently", async () => {
    const userId = await makeUser();
    await makeLoan(userId);

    const payment = await debit(userId, 500003, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchLoanInstalment(payment), true);
  });

  it("ignores a debit for a clearly different amount", async () => {
    const userId = await makeUser();
    await makeLoan(userId);

    const payment = await debit(userId, 700000, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchLoanInstalment(payment), false);
  });

  it("ignores a debit nowhere near a due date", async () => {
    const userId = await makeUser();
    await makeLoan(userId);

    const payment = await debit(userId, 500000, new Date("2026-10-25T06:00:00Z"));
    assert.equal(await matchLoanInstalment(payment), false);
  });

  it("prefers the loan repaid from the same account when two could fit", async () => {
    const userId = await makeUser();
    const [bankA, bankB] = await Promise.all([
      Account.create({ userId, bankName: "HDFC Bank", last4: "1111", accountType: "BANK" }),
      Account.create({ userId, bankName: "ICICI Bank", last4: "2222", accountType: "BANK" }),
    ]);

    await makeLoan(userId, { accountId: bankA._id });
    const loanB = await makeLoan(userId, { accountId: bankB._id });

    const payment = await debit(userId, 500000, new Date("2026-10-10T06:00:00Z"), bankB._id);
    await matchLoanInstalment(payment);

    const matched = await LoanInstalment.findOne({ transactionId: payment._id }).orFail();
    assert.equal(String(matched.loanId), String(loanB._id));
  });

  it("does not match the same payment twice", async () => {
    const userId = await makeUser();
    await makeLoan(userId);

    const payment = await debit(userId, 500000, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchLoanInstalment(payment), true);
    assert.equal(await matchLoanInstalment(payment), false, "already spoken for");

    assert.equal(await LoanInstalment.countDocuments({ status: "PAID" }), 1);
  });

  it("closes the loan when the last instalment is paid", async () => {
    const userId = await makeUser();
    const loan = await makeLoan(userId);

    // Everything but the last, settled without a matching debit.
    await LoanInstalment.updateMany({ loanId: loan._id, seq: { $lt: 12 } }, { $set: { status: "PAID" } });

    const last = await LoanInstalment.findOne({ loanId: loan._id, seq: 12 }).orFail();
    const payment = await debit(userId, 500000, last.dueDate);
    await matchLoanInstalment(payment);

    const closed = await Loan.findById(loan._id).orFail();
    assert.equal(closed.status, "CLOSED");
  });

  it("keeps one user's loans away from another's payments", async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await makeLoan(a);

    const payment = await debit(b, 500000, new Date("2026-10-10T06:00:00Z"));
    assert.equal(await matchLoanInstalment(payment), false);
  });
});

describe("claiming a loan by hand", () => {
  it("claims the oldest still-due instalment, regardless of the amount", async () => {
    const userId = await makeUser();
    const loan = await makeLoan(userId);

    // Nothing about this figure lines up with the schedule - a hand pick
    // carries its own certainty about which loan is meant.
    const payment = await debit(userId, 99, new Date("2026-09-10T10:00:00Z"));
    await attachToLoan(payment, loan._id);

    const first = await LoanInstalment.findOne({ loanId: loan._id, seq: 1 }).orFail();
    assert.equal(first.status, "PAID");
    assert.equal(String(first.transactionId), String(payment._id));

    const stored = await Transaction.findById(payment._id).orFail();
    assert.equal(String(stored.loanId), String(loan._id));
  });

  it("claims instalments in order across repeated calls", async () => {
    const userId = await makeUser();
    const loan = await makeLoan(userId);

    const first = await debit(userId, 500000, new Date("2026-09-10T10:00:00Z"));
    const second = await debit(userId, 500000, new Date("2026-10-10T10:00:00Z"));
    await attachToLoan(first, loan._id);
    await attachToLoan(second, loan._id);

    assert.equal((await LoanInstalment.findOne({ loanId: loan._id, seq: 1 }).orFail()).status, "PAID");
    assert.equal((await LoanInstalment.findOne({ loanId: loan._id, seq: 2 }).orFail()).status, "PAID");
  });

  it("still links the transaction when nothing is left to claim", async () => {
    const userId = await makeUser();
    const loan = await makeLoan(userId, { months: 1 });
    await LoanInstalment.updateMany({ loanId: loan._id }, { $set: { status: "PAID" } });

    const extra = await debit(userId, 200000, new Date("2026-11-10T10:00:00Z"));
    await attachToLoan(extra, loan._id);

    const stored = await Transaction.findById(extra._id).orFail();
    assert.equal(String(stored.loanId), String(loan._id));
  });

  it("closes the loan once a hand-picked payment finishes the schedule", async () => {
    const userId = await makeUser();
    const loan = await makeLoan(userId, { months: 1 });

    const payment = await debit(userId, 500000, START_DATE);
    await attachToLoan(payment, loan._id);

    assert.equal((await Loan.findById(loan._id).orFail()).status, "CLOSED");
  });
});
