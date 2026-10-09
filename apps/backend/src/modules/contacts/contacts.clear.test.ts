import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "clear-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_clear_test"));
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

let token: string;
let userId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Contact.deleteMany({}),
    models.ContactClearance.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
  ]);
  const email = `k${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface Person {
  id: string;
  balanceMinor: number;
  clearedMinor: number;
}

interface Detail extends Person {
  history: unknown[];
  clearances: { id: string; amountMinor: number; direction: string; note: string | null; effectMinor: number }[];
}

/** Someone who owes the user `owedMinor` - or, negative, whom the user owes. */
async function owing(name: string, owedMinor: number) {
  return json<Person>(
    await call("/contacts", { method: "POST", body: JSON.stringify({ name, openingBalanceMinor: owedMinor }) })
  );
}

function clear(contactId: string, body: Record<string, unknown>) {
  return call(`/contacts/${contactId}/clear`, { method: "POST", body: JSON.stringify(body) });
}

async function detail(contactId: string) {
  return json<Detail>(await call(`/contacts/${contactId}`));
}

describe("clearing what someone owes", () => {
  it("clears all of it", async () => {
    const rahul = await owing("Rahul", 1_000_00);
    const response = await clear(rahul.id, { amountMinor: 1_000_00 });
    assert.equal(response.status, 201);
    const after = await json<Person>(response);
    assert.equal(after.balanceMinor, 0);
    assert.equal(after.clearedMinor, 1_000_00);

    const listed = await json<{ owedToYouMinor: number; youOweMinor: number }>(await call("/contacts"));
    assert.equal(listed.owedToYouMinor, 0);
    assert.equal(listed.youOweMinor, 0);
  });

  it("clears part of it, with a note, and shows it in their history", async () => {
    const rahul = await owing("Rahul", 1_000_00);
    // He bought a 999 watch; a rupee is still owed.
    await clear(rahul.id, { amountMinor: 999_00, note: "Bought me a watch", on: "2026-10-01T12:00:00+05:30" });

    const person = await detail(rahul.id);
    assert.equal(person.balanceMinor, 1_00);
    assert.equal(person.history.length, 0, "no transaction was made");
    assert.equal(person.clearances.length, 1);
    assert.equal(person.clearances[0].note, "Bought me a watch");
    assert.equal(person.clearances[0].direction, "OWED_TO_ME");
    assert.equal(person.clearances[0].effectMinor, -999_00);
  });

  it("clears what the user owes them, the other way", async () => {
    const asha = await owing("Asha", -500_00);
    const response = await clear(asha.id, { amountMinor: 200_00 });
    assert.equal(response.status, 201);
    const after = await json<Person>(response);
    assert.equal(after.balanceMinor, -300_00);
    assert.equal(after.clearedMinor, -200_00);

    const person = await detail(asha.id);
    assert.equal(person.clearances[0].direction, "OWED_BY_ME");
    assert.equal(person.clearances[0].effectMinor, 200_00);
  });

  it("refuses more than is outstanding, and says how much is", async () => {
    const rahul = await owing("Rahul", 1_000_00);
    const response = await clear(rahul.id, { amountMinor: 1_001_00 });
    assert.equal(response.status, 400);
    assert.match((await json<{ error: string }>(response)).error, /Rahul owes you ₹1,000/);

    const asha = await owing("Asha", -250_00);
    const theirs = await clear(asha.id, { amountMinor: 300_00 });
    assert.equal(theirs.status, 400);
    assert.match((await json<{ error: string }>(theirs)).error, /You owe Asha ₹250/);

    const square = await owing("Bala", 0);
    assert.equal((await clear(square.id, { amountMinor: 1_00 })).status, 400);
    assert.equal((await clear(rahul.id, { amountMinor: 0 })).status, 400);
    assert.equal((await detail(rahul.id)).balanceMinor, 1_000_00);
  });

  it("can be undone", async () => {
    const rahul = await owing("Rahul", 1_000_00);
    const cleared = await json<{ clearance: { id: string } }>(await clear(rahul.id, { amountMinor: 600_00 }));
    assert.equal((await detail(rahul.id)).balanceMinor, 400_00);

    const undone = await call(`/contacts/${rahul.id}/clear/${cleared.clearance.id}`, { method: "DELETE" });
    assert.equal(undone.status, 204);
    const person = await detail(rahul.id);
    assert.equal(person.balanceMinor, 1_000_00);
    assert.equal(person.clearances.length, 0);
    assert.equal(
      (await call(`/contacts/${rahul.id}/clear/${cleared.clearance.id}`, { method: "DELETE" })).status,
      404
    );
  });

  it("stays a clearance of what was owed after later transactions move the balance", async () => {
    const rahul = await owing("Rahul", 1_000_00);
    await clear(rahul.id, { amountMinor: 1_000_00 });
    // Then the user borrows 300 from him.
    const borrowed = await models.Transaction.create({
      userId,
      type: "CREDIT",
      amountMinor: 300_00,
      source: "MANUAL",
      occurredAt: new Date(),
      isSettlement: true,
      people: [{ contactId: new Types.ObjectId(rahul.id), amountMinor: 300_00 }],
    });
    assert.ok(borrowed);
    assert.equal((await detail(rahul.id)).balanceMinor, -300_00);
  });

  it("touches no total, no budget and no account", async () => {
    const before = {
      summary: await json<Record<string, number>>(await call("/analytics/summary")),
      budget: await json<{ spentMinor: number }>(await call("/budget/monthly")),
    };
    const rahul = await owing("Rahul", 1_000_00);
    const dashboardBefore = await json<{ owed: { balanceMinor: number } }>(await call("/dashboard"));
    assert.equal(dashboardBefore.owed.balanceMinor, 1_000_00);

    await clear(rahul.id, { amountMinor: 999_00 });

    assert.equal(await models.Transaction.countDocuments({ userId }), 0);
    const summary = await json<Record<string, number>>(await call("/analytics/summary"));
    assert.equal(summary.totalSpendMinor, before.summary.totalSpendMinor);
    assert.equal(summary.totalIncomeMinor, before.summary.totalIncomeMinor);
    const budget = await json<{ spentMinor: number }>(await call("/budget/monthly"));
    assert.equal(budget.spentMinor, before.budget.spentMinor);
    // Only what is owed moves, the same on the dashboard as on People.
    const dashboard = await json<{ owed: { balanceMinor: number } }>(await call("/dashboard"));
    assert.equal(dashboard.owed.balanceMinor, 1_00);
    const owed = await json<{ balanceMinor: number }>(await call("/analytics/owed"));
    assert.equal(owed.balanceMinor, 1_00);
  });

  it("goes when the person does", async () => {
    const rahul = await owing("Rahul", 1_000_00);
    await clear(rahul.id, { amountMinor: 500_00 });
    await call(`/contacts/${rahul.id}`, { method: "DELETE" });
    assert.equal(await models.ContactClearance.countDocuments({ userId }), 0);
  });
});
