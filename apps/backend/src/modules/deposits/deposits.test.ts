import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "deposits-test-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_deposits_test"));
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
  await Promise.all([models.Deposit.deleteMany({}), models.Transaction.deleteMany({}), models.User.deleteMany({})]);
});

let userCount = 0;
type Json = Record<string, any>;

async function makeUser() {
  const email = `d${(userCount += 1)}@example.com`;
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

const pay = (token: string, body: Json) =>
  call("/transactions", token, {
    body: { type: "DEBIT", occurredAt: new Date().toISOString(), source: "MANUAL", merchant: "TIKI TRIPATH", ...body },
  });

describe("RDs and FDs", () => {
  it("grow from the total given by every payment put into them, one payment split across two", async () => {
    const user = await makeUser();
    const big = (await call("/deposits", user.token, { body: { name: "RD 1", kind: "RD", monthlyMinor: 2000_00, totalMinor: 40_000_00 } })).body;
    const small = (await call("/deposits", user.token, { body: { name: "RD 2", kind: "RD", monthlyMinor: 1000_00, totalMinor: 12_000_00 } })).body;
    await call("/deposits", user.token, { body: { name: "SBI FD", kind: "FD", institution: "SBI", monthlyMinor: 500_00, totalMinor: 1_00_000_00 } });

    const payment = await pay(user.token, {
      amountMinor: 3000_00,
      depositParts: [{ depositId: big.id, amountMinor: 2000_00 }, { depositId: small.id, amountMinor: 1000_00 }],
    });
    assert.equal(payment.status, 201, JSON.stringify(payment.body));
    assert.equal(payment.body.countedAmountMinor, 3000_00, "still spending, like any fixed cost");

    const list = (await call("/deposits", user.token)).body;
    const byName = Object.fromEntries(list.deposits.map((d: Json) => [d.name, d]));
    assert.equal(byName["RD 1"].totalMinor, 42_000_00);
    assert.equal(byName["RD 2"].totalMinor, 13_000_00);
    assert.equal(byName["RD 1"].addedThisMonthMinor, 2000_00);
    assert.equal(byName["SBI FD"].monthlyMinor, null, "an FD has nothing going in each month");
    assert.equal(list.totalMinor, 1_55_000_00);
    assert.equal(list.monthlyMinor, 3000_00);

    const payments = (await call(`/deposits/${big.id}/payments`, user.token)).body;
    assert.deepEqual(payments.map((p: Json) => [p.merchant, p.amountMinor, p.paymentMinor]), [["TIKI TRIPATH", 2000_00, 3000_00]]);
  });

  it("starts again from a corrected total, counting only what goes in after", async () => {
    const user = await makeUser();
    const rd = (await call("/deposits", user.token, { body: { name: "RD", kind: "RD", totalMinor: 10_000_00 } })).body;
    await pay(user.token, { amountMinor: 1000_00, depositParts: [{ depositId: rd.id, amountMinor: 1000_00 }] });

    const corrected = await call(`/deposits/${rd.id}`, user.token, { method: "PATCH", body: { totalMinor: 11_500_00 } });
    assert.equal(corrected.body.totalMinor, 11_500_00);

    await pay(user.token, {
      amountMinor: 1000_00,
      occurredAt: new Date(Date.now() + 60_000).toISOString(),
      depositParts: [{ depositId: rd.id, amountMinor: 1000_00 }],
    });
    assert.equal((await call("/deposits", user.token)).body.deposits[0].totalMinor, 12_500_00);
  });

  it("is put in or taken out on an edit, and refused more than the payment", async () => {
    const user = await makeUser();
    const rd = (await call("/deposits", user.token, { body: { name: "RD", kind: "RD", totalMinor: 0 } })).body;
    const payment = (await pay(user.token, { amountMinor: 3000_00 })).body;

    const over = await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: { depositParts: [{ depositId: rd.id, amountMinor: 3500_00 }] },
    });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /₹3500\.00 into deposits, but the payment is ₹3000\.00/);

    await call(`/transactions/${payment.id}`, user.token, {
      method: "PATCH",
      body: { depositParts: [{ depositId: rd.id, amountMinor: 3000_00 }] },
    });
    assert.equal((await call("/deposits", user.token)).body.deposits[0].totalMinor, 3000_00);

    // An edit that says nothing about deposits keeps them.
    await call(`/transactions/${payment.id}`, user.token, { method: "PATCH", body: { note: "Oct" } });
    assert.equal((await call("/deposits", user.token)).body.deposits[0].totalMinor, 3000_00);

    await call(`/transactions/${payment.id}`, user.token, { method: "PATCH", body: { depositParts: [] } });
    assert.equal((await call("/deposits", user.token)).body.deposits[0].totalMinor, 0);
  });

  it("refuses another user's deposit, and deleting one takes it off its payments", async () => {
    const [user, other] = [await makeUser(), await makeUser()];
    const theirs = (await call("/deposits", other.token, { body: { name: "Theirs", kind: "FD", totalMinor: 100 } })).body;
    const refused = await pay(user.token, { amountMinor: 100_00, depositParts: [{ depositId: theirs.id, amountMinor: 100_00 }] });
    assert.equal(refused.status, 400);

    const mine = (await call("/deposits", user.token, { body: { name: "Mine", kind: "RD", totalMinor: 0 } })).body;
    const payment = (await pay(user.token, { amountMinor: 100_00, depositParts: [{ depositId: mine.id, amountMinor: 100_00 }] })).body;
    assert.equal((await call(`/deposits/${mine.id}`, user.token, { method: "DELETE" })).status, 204);
    const after = await models.Transaction.findById(payment.id).lean();
    assert.deepEqual(after!.depositParts, []);
    assert.equal(after!.countedAmountMinor, 100_00);
  });

  it("keeps one user's deposits from another", async () => {
    const [user, other] = [await makeUser(), await makeUser()];
    const rd = (await call("/deposits", user.token, { body: { name: "RD", kind: "RD", totalMinor: 0 } })).body;
    assert.equal((await call(`/deposits/${rd.id}`, other.token, { method: "PATCH", body: { name: "x" } })).status, 404);
    assert.deepEqual((await call("/deposits", other.token)).body.deposits, []);
  });
});
