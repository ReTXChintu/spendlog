import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayKey } from "../../time";
import { budgetPeriodFor } from "./budget.period";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "budget-test-secret";

describe("budgetPeriodFor", () => {
  const on = (day: string) => new Date(`${day}T12:00:00+05:30`);

  it("runs from the salary day to the next one", () => {
    const period = budgetPeriodFor(15, on("2026-09-20"));

    assert.equal(istDayKey(period.start), "2026-09-15");
    assert.equal(istDayKey(period.end), "2026-10-15");
  });

  it("belongs to last month's salary before this month's has landed", () => {
    const period = budgetPeriodFor(15, on("2026-09-10"));

    assert.equal(istDayKey(period.start), "2026-08-15");
    assert.equal(istDayKey(period.end), "2026-09-15");
  });

  it("starts a new period on payday itself", () => {
    assert.equal(istDayKey(budgetPeriodFor(15, on("2026-09-15")).start), "2026-09-15");
  });

  it("does not skip payday in a short month", () => {
    // Paid on the 31st: February pays on the 28th rather than not at all.
    assert.equal(istDayKey(budgetPeriodFor(31, on("2026-03-01")).start), "2026-02-28");
  });

  it("counts today as a day money can still be spent", () => {
    // Otherwise the last day of a period divides by zero, or by a day
    // that has supposedly already gone.
    const period = budgetPeriodFor(15, on("2026-10-14"));
    assert.equal(period.daysLeft, 1);
  });

  it("counts the whole period on payday", () => {
    const period = budgetPeriodFor(15, on("2026-09-15"));
    assert.equal(period.daysLeft, 30, "15 Sep to 15 Oct");
    assert.equal(period.daysElapsed, 1);
  });

  it("rolls over the year", () => {
    const period = budgetPeriodFor(15, on("2026-12-20"));
    assert.equal(istDayKey(period.end), "2027-01-15");
  });
});

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_budget_test"));

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
    models.Transaction.deleteMany({}),
    models.Account.deleteMany({}),
    models.FixedCommitment.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser(salary = 10000000, salaryDay = 15) {
  const email = `u${(userCount += 1)}@example.com`;
  const user = await models.User.create({
    email,
    name: `User ${userCount}`,
    salaryAmountMinor: salary,
    salaryDay,
  });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

function call(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

type Pace = {
  configured: boolean;
  spentMinor: number;
  commitmentsRemainingMinor: number;
  remainingMinor: number;
  state: string;
  commitments: { id: string; isPaid: boolean }[];
};

/** Inside the current period whatever today happens to be. */
function withinPeriod(): Date {
  return new Date(Date.now() - 60 * 1000);
}

async function spend(userId: Types.ObjectId, amountMinor: number, accountId?: Types.ObjectId) {
  return models.Transaction.create({
    userId,
    accountId: accountId ?? null,
    amountMinor,
    currency: "INR",
    type: "DEBIT",
    source: "MANUAL",
    occurredAt: withinPeriod(),
  });
}

describe("the spending pace", () => {
  it("says nothing until a salary is set", async () => {
    const email = `nosalary${(userCount += 1)}@example.com`;
    const user = await models.User.create({ email });
    const token = signToken({ id: user._id.toString(), email });

    const pace = await json<Pace>(await call("/budget/pace", token));
    assert.equal(pace.configured, false);
  });

  it("takes spending off the salary", async () => {
    const user = await makeUser(10000000);
    await spend(user.id, 250000);

    const pace = await json<Pace>(await call("/budget/pace", user.token));
    assert.equal(pace.spentMinor, 250000);
    assert.equal(pace.remainingMinor, 10000000 - 250000);
  });

  it("holds back commitments that have not been ticked off", async () => {
    const user = await makeUser(10000000);
    await call("/budget/commitments", user.token, {
      method: "POST",
      body: JSON.stringify({ name: "Rent", amountMinor: 3000000, dayOfMonth: 5 }),
    });

    const pace = await json<Pace>(await call("/budget/pace", user.token));
    assert.equal(pace.commitmentsRemainingMinor, 3000000);
    assert.equal(pace.remainingMinor, 7000000);
  });

  it("releases one once it is ticked off", async () => {
    const user = await makeUser(10000000);
    const created = await json<{ id: string }>(
      await call("/budget/commitments", user.token, {
        method: "POST",
        body: JSON.stringify({ name: "Rent", amountMinor: 3000000, dayOfMonth: 5 }),
      })
    );

    await call(`/budget/commitments/${created.id}/paid`, user.token, {
      method: "POST",
      body: JSON.stringify({ paid: true }),
    });

    const pace = await json<Pace>(await call("/budget/pace", user.token));
    assert.equal(pace.commitmentsRemainingMinor, 0);
    assert.equal(pace.commitments.find((c) => c.id === created.id)?.isPaid, true);
  });

  it("never counts a card payment twice", async () => {
    // The trap this whole design is arranged around: a card bill is not
    // new spending, it is an earlier cycle's spending reaching the bank.
    const user = await makeUser(10000000);
    const card = await models.Account.create({
      userId: user.id,
      bankName: "HDFC Bank",
      last4: "1377",
      accountType: "CARD",
    });

    await spend(user.id, 200000, card._id);
    const beforePaying = await json<Pace>(await call("/budget/pace", user.token));

    // Now the bill goes out of the bank, into the card.
    await models.Transaction.create({
      userId: user.id,
      accountId: card._id,
      amountMinor: 200000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: withinPeriod(),
      isTransfer: true,
    });

    const afterPaying = await json<Pace>(await call("/budget/pace", user.token));
    assert.equal(
      afterPaying.spentMinor,
      beforePaying.spentMinor,
      "paying the bill is not more spending"
    );
  });

  it("counts card spending at the moment it happens", async () => {
    const user = await makeUser(10000000);
    const card = await models.Account.create({
      userId: user.id,
      bankName: "HDFC Bank",
      last4: "1377",
      accountType: "CARD",
    });

    await spend(user.id, 200000, card._id);

    const pace = await json<Pace>(await call("/budget/pace", user.token));
    assert.equal(pace.spentMinor, 200000, "not waiting for the bill");
  });

  it("says so when the spending has outrun the salary", async () => {
    const user = await makeUser(500000);
    await spend(user.id, 600000);

    const pace = await json<Pace>(await call("/budget/pace", user.token));
    assert.equal(pace.state, "over");
    assert.ok(pace.remainingMinor < 0);
  });

  it("leaves out money that never counted anyway", async () => {
    // A transfer between the user's own accounts, and settling up with a
    // friend, are both already zero in countedAmountMinor.
    const user = await makeUser(10000000);
    await models.Transaction.create({
      userId: user.id,
      amountMinor: 900000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: withinPeriod(),
      isTransfer: true,
    });

    const pace = await json<Pace>(await call("/budget/pace", user.token));
    assert.equal(pace.spentMinor, 0);
  });

  it("keeps one person's salary out of another's figures", async () => {
    const [user, other] = await Promise.all([makeUser(10000000), makeUser(500000)]);
    await spend(other.id, 400000);

    const pace = await json<Pace>(await call("/budget/pace", user.token));
    assert.equal(pace.spentMinor, 0);
  });

  it("will not let anyone tick off somebody else's commitment", async () => {
    const [user, other] = await Promise.all([makeUser(), makeUser()]);
    const created = await json<{ id: string }>(
      await call("/budget/commitments", user.token, {
        method: "POST",
        body: JSON.stringify({ name: "Rent", amountMinor: 3000000, dayOfMonth: 5 }),
      })
    );

    const response = await call(`/budget/commitments/${created.id}/paid`, other.token, {
      method: "POST",
      body: JSON.stringify({ paid: true }),
    });
    assert.equal(response.status, 404);
  });
});
