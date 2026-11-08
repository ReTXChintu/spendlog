import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { monthsBetween } from "./savingsGoals.service";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "goals-test-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_goals_test"));
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
    models.SavingsGoal.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.Account.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

let userCount = 0;
type Json = Record<string, any>;

async function makeUser() {
  const email = `g${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

async function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Json };
}

const inAYear = () => {
  const d = new Date();
  return `${d.getFullYear() + 1}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
};

describe("savings goals", () => {
  it("counts months to save in, the month running now included", () => {
    assert.equal(monthsBetween("2026-11-08", "2027-10-01"), 11);
    assert.equal(monthsBetween("2026-11-08", "2026-11-20"), 1);
    assert.equal(monthsBetween("2026-11-08", "2026-12-05"), 1);
    assert.equal(monthsBetween("2026-11-08", "2026-12-08"), 2);
  });

  it("adds up what was there, transfers marked for it, and money by hand, and says what a month it needs", async () => {
    const user = await makeUser();
    const savings = await models.Account.create({ userId: user.id, bankName: "SBI", last4: "1234", accountType: "BANK", isSavings: true });
    const ps5 = (
      await call("/savings-goals", user.token, {
        body: { name: "PS5", targetMinor: 55_000_00, targetOn: inAYear(), accountId: savings.id, openingMinor: 5_000_00 },
      })
    ).body;
    assert.equal(ps5.savedMinor, 5_000_00);
    assert.equal(ps5.accountLabel, "SBI ••1234");

    const transfer = await call("/transactions", user.token, {
      body: {
        type: "CREDIT",
        amountMinor: 10_000_00,
        isTransfer: true,
        accountId: savings.id,
        occurredAt: new Date().toISOString(),
        goalParts: [{ goalId: ps5.id, amountMinor: 8_000_00 }],
      },
    });
    assert.equal(transfer.status, 201, JSON.stringify(transfer.body));

    const added = await call(`/savings-goals/${ps5.id}/adjustments`, user.token, { body: { amountMinor: 2_000_00, note: "Birthday money" } });
    assert.equal(added.body.savedMinor, 15_000_00);
    assert.equal(added.body.addedThisMonthMinor, 10_000_00);
    assert.equal(added.body.leftMinor, 40_000_00);
    // Twelve or thirteen months to go, depending on today; rounded up to the rupee.
    assert.equal(added.body.perMonthMinor, Math.ceil(40_000_00 / added.body.monthsLeft / 100) * 100);

    const entries = (await call(`/savings-goals/${ps5.id}/entries`, user.token)).body.entries;
    assert.deepEqual(entries.map((entry: Json) => [entry.kind, entry.amountMinor]).sort(), [["BY_HAND", 2_000_00], ["TRANSFER", 8_000_00]]);

    // The savings account shows what of it is spoken for.
    const dashboard = (await call("/dashboard", user.token)).body;
    const face = dashboard.wallet.banks.find((f: Json) => f.accountId === savings.id);
    assert.equal(face.forGoalsMinor, 15_000_00);
  });

  it("refuses more for goals than the transfer was, a goal not the user's, and spending marked for one", async () => {
    const user = await makeUser();
    const other = await makeUser();
    const mine = (await call("/savings-goals", user.token, { body: { name: "Trip", targetMinor: 20_000_00, targetOn: inAYear() } })).body;
    const theirs = (await call("/savings-goals", other.token, { body: { name: "Bike", targetMinor: 90_000_00, targetOn: inAYear() } })).body;
    const base = { type: "CREDIT", isTransfer: true, occurredAt: new Date().toISOString() };

    const tooMuch = await call("/transactions", user.token, { body: { ...base, amountMinor: 100_00, goalParts: [{ goalId: mine.id, amountMinor: 200_00 }] } });
    assert.equal(tooMuch.status, 400);
    const notMine = await call("/transactions", user.token, { body: { ...base, amountMinor: 100_00, goalParts: [{ goalId: theirs.id, amountMinor: 100_00 }] } });
    assert.equal(notMine.status, 400);

    const spend = await call("/transactions", user.token, {
      body: { type: "DEBIT", amountMinor: 100_00, occurredAt: new Date().toISOString(), goalParts: [{ goalId: mine.id, amountMinor: 100_00 }] },
    });
    assert.equal(spend.status, 201);
    assert.deepEqual((await models.Transaction.findById(spend.body.id))!.goalParts, []);
  });

  it("an edit marks a transfer for a goal, and deleting the goal takes it off", async () => {
    const user = await makeUser();
    const goal = (await call("/savings-goals", user.token, { body: { name: "PS5", targetMinor: 55_000_00, targetOn: inAYear() } })).body;
    const row = (
      await call("/transactions", user.token, {
        body: { type: "DEBIT", isTransfer: true, amountMinor: 3_000_00, occurredAt: new Date().toISOString() },
      })
    ).body;
    const edited = await call(`/transactions/${row.id}`, user.token, { method: "PATCH", body: { goalParts: [{ goalId: goal.id, amountMinor: 3_000_00 }] } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal((await call("/savings-goals", user.token)).body.savedMinor, 3_000_00);

    // Taking out more than it has is refused.
    assert.equal((await call(`/savings-goals/${goal.id}/adjustments`, user.token, { body: { amountMinor: -5_000_00 } })).status, 400);

    assert.equal((await call(`/savings-goals/${goal.id}`, user.token, { method: "DELETE" })).status, 204);
    assert.deepEqual((await models.Transaction.findById(row.id))!.goalParts, []);
  });
});
