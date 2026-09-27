import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "loan-routes-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_loan_routes_test"));

  const [{ app }, auth, loaded] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;

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
    models.Account.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser() {
  const email = `l${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
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

async function debit(userId: Types.ObjectId, amountMinor: number, occurredAt = new Date()) {
  return models.Transaction.create({
    userId,
    amountMinor,
    currency: "INR",
    type: "DEBIT",
    merchant: "test",
    source: "MANUAL",
    occurredAt,
  });
}

describe("adding a loan directly, with no purchase to convert", () => {
  it("builds a schedule from the monthly amount given", async () => {
    const user = await makeUser();

    const response = await call("/loans", user.token, {
      method: "POST",
      body: JSON.stringify({
        label: "Personal loan",
        principalMinor: 6_00_000_00,
        months: 12,
        monthlyAmountMinor: 50_000_00,
        startDate: "2026-01-15T00:00:00.000Z",
      }),
    });
    assert.equal(response.status, 201);
    const loan = await json<{ id: string; totalPayableMinor: number }>(response);
    assert.equal(loan.totalPayableMinor, 50_000_00 * 12);

    const list = await json<{ id: string; instalments: { seq: number; amountMinor: number }[] }[]>(
      await call("/loans", user.token)
    );
    assert.equal(list.length, 1);
    assert.equal(list[0].instalments.length, 12);
    assert.equal(list[0].instalments[0].amountMinor, 50_000_00);
  });

  it("computes the monthly amount from a rate when none is given", async () => {
    const user = await makeUser();
    const response = await call("/loans", user.token, {
      method: "POST",
      body: JSON.stringify({
        label: "Bank loan",
        principalMinor: 12_00_000_00,
        months: 24,
        interestRatePctAnnual: 12,
      }),
    });
    assert.equal(response.status, 201);
    const loan = await json<{ monthlyAmountMinor: number }>(response);
    assert.ok(loan.monthlyAmountMinor > 0);
  });

  it("refuses a loan with neither a monthly amount nor a rate", async () => {
    const user = await makeUser();
    const response = await call("/loans", user.token, {
      method: "POST",
      body: JSON.stringify({ label: "Mystery loan", principalMinor: 1_00_000_00, months: 12 }),
    });
    assert.equal(response.status, 400);
  });

  it("turns nobody away without a token", async () => {
    const response = await fetch(`${baseUrl}/loans`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x", principalMinor: 1000, months: 1, monthlyAmountMinor: 1000 }),
    });
    assert.equal(response.status, 401);
  });
});

describe("closing and deleting a loan", () => {
  async function makeLoan(token: string) {
    const response = await call("/loans", token, {
      method: "POST",
      body: JSON.stringify({
        label: "Personal loan",
        principalMinor: 6_00_000_00,
        months: 3,
        monthlyAmountMinor: 2_00_000_00,
        startDate: "2026-01-15T00:00:00.000Z",
      }),
    });
    return json<{ id: string }>(response);
  }

  it("closing early skips what is left rather than leaving it due forever", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);

    const response = await call(`/loans/${loan.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "CLOSED" }),
    });
    assert.equal((await json<{ status: string }>(response)).status, "CLOSED");

    const list = await json<{ id: string; instalments: { status: string }[] }[]>(
      await call("/loans", user.token)
    );
    assert.ok(list[0].instalments.every((row) => row.status === "SKIPPED"));
  });

  it("deleting frees any transaction that was claiming an instalment", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);
    const payment = await debit(user.id, 2_00_000_00, new Date("2026-01-15T00:00:00.000Z"));

    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: loan.id }),
    });

    const response = await call(`/loans/${loan.id}`, user.token, { method: "DELETE" });
    assert.equal(response.status, 204);

    const stored = await models.Transaction.findById(payment._id).orFail();
    assert.equal(stored.loanId, null);
    assert.equal(await models.LoanInstalment.countDocuments({ loanId: loan.id }), 0);
  });
});

interface ListedLoan {
  id: string;
  status: string;
  months: number;
  monthlyAmountMinor: number;
  totalPayableMinor: number;
  paidCount: number;
  remainingMinor: number;
  nextDue: { seq: number; dueDate: string; amountMinor: number } | null;
  instalments: { seq: number; status: string; amountMinor: number; dueDate: string }[];
}

describe("a loan that was already running before it was added", () => {
  it("takes the instalments already paid when it is added", async () => {
    const user = await makeUser();
    const response = await call("/loans", user.token, {
      method: "POST",
      body: JSON.stringify({
        label: "Bike loan",
        principalMinor: 1_20_000_00,
        months: 12,
        monthlyAmountMinor: 10_000_00,
        startDate: "2026-04-05T00:00:00.000Z",
        alreadyPaidCount: 5,
      }),
    });
    assert.equal(response.status, 201);

    const [loan] = await json<ListedLoan[]>(await call("/loans", user.token));
    assert.equal(loan.paidCount, 5);
    assert.equal(loan.remainingMinor, 7 * 10_000_00);
    assert.equal(loan.nextDue?.seq, 6);
    assert.equal(loan.status, "ACTIVE");
  });

  it("refuses more paid than the loan has", async () => {
    const user = await makeUser();
    const response = await call("/loans", user.token, {
      method: "POST",
      body: JSON.stringify({ label: "x", principalMinor: 1000, months: 3, monthlyAmountMinor: 1000, alreadyPaidCount: 4 }),
    });
    assert.equal(response.status, 400);
  });
});

describe("editing a loan", () => {
  async function makeLoan(token: string, extra: Record<string, unknown> = {}) {
    const response = await call("/loans", token, {
      method: "POST",
      body: JSON.stringify({
        label: "Personal loan",
        principalMinor: 1_20_000_00,
        months: 12,
        monthlyAmountMinor: 10_000_00,
        startDate: "2026-01-15T00:00:00.000Z",
        ...extra,
      }),
    });
    return json<{ id: string }>(response);
  }

  async function patch(token: string, id: string, body: Record<string, unknown>) {
    return call(`/loans/${id}`, token, { method: "PATCH", body: JSON.stringify(body) });
  }

  async function listed(token: string): Promise<ListedLoan> {
    return (await json<ListedLoan[]>(await call("/loans", token)))[0];
  }

  it("marks and unmarks instalments by count", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);

    assert.equal((await patch(user.token, loan.id, { paidCount: 5 })).status, 200);
    let state = await listed(user.token);
    assert.equal(state.paidCount, 5);
    assert.deepEqual(
      state.instalments.filter((row) => row.status === "PAID").map((row) => row.seq),
      [1, 2, 3, 4, 5]
    );

    await patch(user.token, loan.id, { paidCount: 3 });
    state = await listed(user.token);
    assert.equal(state.paidCount, 3);
    assert.equal(state.nextDue?.seq, 4);
  });

  it("closes a loan once every instalment is marked paid, and reopens it when lowered", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);

    await patch(user.token, loan.id, { paidCount: 12 });
    assert.equal((await listed(user.token)).status, "CLOSED");

    await patch(user.token, loan.id, { paidCount: 11 });
    assert.equal((await listed(user.token)).status, "ACTIVE");
  });

  it("will not unmark an instalment matched to a real payment", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);
    const payment = await debit(user.id, 10_000_00);
    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: loan.id }),
    });

    const response = await patch(user.token, loan.id, { paidCount: 0 });
    assert.equal(response.status, 400);
    assert.equal((await listed(user.token)).paidCount, 1);
  });

  it("re-lays the schedule for a new term and monthly figure, keeping what was paid", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);
    await patch(user.token, loan.id, { paidCount: 2 });

    const response = await patch(user.token, loan.id, { months: 18, monthlyAmountMinor: 8_000_00 });
    assert.equal(response.status, 200);
    const body = await json<{ totalPayableMinor: number }>(response);
    assert.equal(body.totalPayableMinor, 18 * 8_000_00);

    const state = await listed(user.token);
    assert.equal(state.instalments.length, 18);
    assert.equal(state.paidCount, 2);
    assert.equal(state.instalments[0].amountMinor, 10_000_00, "a paid one keeps what it was paid at");
    assert.equal(state.instalments[5].amountMinor, 8_000_00);
    assert.equal(state.remainingMinor, 16 * 8_000_00);
  });

  it("re-dates the schedule from a new start date", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);

    await patch(user.token, loan.id, { startDate: "2025-11-10T00:00:00.000Z" });
    const state = await listed(user.token);
    assert.equal(state.instalments[0].dueDate.slice(0, 10), "2025-11-10");
    assert.equal(state.instalments[2].dueDate.slice(0, 10), "2026-01-10");
  });

  it("refuses a shorter term that would drop a paid instalment", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);
    await patch(user.token, loan.id, { paidCount: 6 });

    const response = await patch(user.token, loan.id, { months: 4 });
    assert.equal(response.status, 400);
    assert.equal((await listed(user.token)).months, 12);
  });

  it("reopens a loan closed early", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);
    await patch(user.token, loan.id, { status: "CLOSED" });

    await patch(user.token, loan.id, { status: "ACTIVE" });
    const state = await listed(user.token);
    assert.equal(state.status, "ACTIVE");
    assert.equal(state.remainingMinor, 12 * 10_000_00);
  });
});

describe("marking a payment as a loan repayment, from the transaction itself", () => {
  async function makeLoan(token: string, months = 3) {
    const response = await call("/loans", token, {
      method: "POST",
      body: JSON.stringify({
        label: "Personal loan",
        principalMinor: 2_00_000_00 * months,
        months,
        monthlyAmountMinor: 2_00_000_00,
        startDate: "2026-01-15T00:00:00.000Z",
      }),
    });
    return json<{ id: string }>(response);
  }

  it("claims the oldest due instalment when a loan is picked", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);
    const payment = await debit(user.id, 2_00_000_00);

    const response = await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: loan.id }),
    });
    assert.equal(response.status, 200);
    const body = await json<{ loanId: string }>(response);
    assert.equal(body.loanId, loan.id);

    const instalments = await json<{ id: string; instalments: { seq: number; status: string }[] }[]>(
      await call("/loans", user.token)
    );
    assert.equal(instalments[0].instalments[0].status, "PAID");
  });

  it("gives the instalment back when the loan is cleared", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token);
    const payment = await debit(user.id, 2_00_000_00);

    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: loan.id }),
    });
    const response = await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: null }),
    });
    assert.equal(response.status, 200);
    const body = await json<{ loanId: string | null }>(response);
    assert.equal(body.loanId, null);

    const instalments = await json<{ instalments: { status: string }[] }[]>(await call("/loans", user.token));
    assert.ok(instalments[0].instalments.every((row) => row.status === "DUE"));
  });

  it("moves the claim when a payment is repointed at a different loan", async () => {
    const user = await makeUser();
    const first = await makeLoan(user.token);
    const second = await makeLoan(user.token);
    const payment = await debit(user.id, 2_00_000_00);

    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: first.id }),
    });
    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: second.id }),
    });

    const loans = await json<{ id: string; instalments: { status: string }[] }[]>(
      await call("/loans", user.token)
    );
    const firstLoan = loans.find((loan) => loan.id === first.id)!;
    const secondLoan = loans.find((loan) => loan.id === second.id)!;
    assert.ok(firstLoan.instalments.every((row) => row.status === "DUE"), "given back");
    assert.equal(secondLoan.instalments[0].status, "PAID");
  });

  it("reopens a loan that had closed, once its instalment is given back", async () => {
    const user = await makeUser();
    const loan = await makeLoan(user.token, 1);
    const payment = await debit(user.id, 2_00_000_00);

    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: loan.id }),
    });
    const closed = await models.Loan.findById(loan.id).orFail();
    assert.equal(closed.status, "CLOSED");

    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: null }),
    });
    const reopened = await models.Loan.findById(loan.id).orFail();
    assert.equal(reopened.status, "ACTIVE");
  });

  it("refuses a loan that is not this user's own", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const loan = await makeLoan(owner.token);
    const payment = await debit(stranger.id, 2_00_000_00);

    const response = await call(`/transactions/${payment.id}`, stranger.token, {
      method: "PATCH",
      body: JSON.stringify({ loanId: loan.id }),
    });
    assert.equal(response.status, 400);
  });
});
