import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "paid-for-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_paid_for_test"));
  const [{ app }, auth, loaded] = await Promise.all([import("../../app"), import("../../middleware/auth"), import("../../models")]);
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
  await Promise.all([models.User.deleteMany({}), models.Contact.deleteMany({}), models.Transaction.deleteMany({})]);
});

type Json = Record<string, any>;

async function makeUser() {
  const user = await models.User.create({ email: `p${Math.random()}@example.com` });
  return { id: user._id, token: signToken({ id: user._id.toString(), email: user.email }) };
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

const now = () => new Date().toISOString();

describe("paid at the counter for someone", () => {
  it("is not spending, is owed back, and shows apart from what was lent", async () => {
    const user = await makeUser();
    const rahul = (await call("/contacts", user.token, { body: { name: "Rahul" } })).body;
    const counter = await call("/transactions", user.token, {
      body: {
        type: "DEBIT", amountMinor: 500_00, occurredAt: now(), source: "MANUAL", merchant: "Big Bazaar",
        split: { myShareMinor: 0 }, people: [{ contactId: rahul.id, amountMinor: 500_00 }], paidFor: true,
      },
    });
    assert.equal(counter.status, 201, JSON.stringify(counter.body));
    assert.equal(counter.body.countedAmountMinor, 0);
    assert.equal(counter.body.merchant, "Big Bazaar");
    await call("/transactions", user.token, {
      body: { type: "DEBIT", amountMinor: 1000_00, occurredAt: now(), source: "MANUAL", split: { myShareMinor: 0 }, people: [{ contactId: rahul.id, amountMinor: 1000_00 }] },
    });

    const list = (await call("/contacts", user.token)).body;
    const person = (Array.isArray(list) ? list : list.contacts).find((c: Json) => c.id === rahul.id);
    assert.equal(person.balanceMinor, 1500_00);
    assert.equal(person.givenMinor, 1500_00);
    assert.equal(person.paidForMinor, 500_00);

    // Paid back the next day: not income, and the balance comes down.
    const back = await call("/transactions", user.token, {
      body: { type: "CREDIT", amountMinor: 500_00, occurredAt: now(), source: "MANUAL", isSettlement: true, people: [{ contactId: rahul.id, amountMinor: 500_00 }] },
    });
    assert.equal(back.body.countedAmountMinor, 0);
  });

  it("is a payment's only", async () => {
    const user = await makeUser();
    const income = await call("/transactions", user.token, {
      body: { type: "CREDIT", amountMinor: 100_00, occurredAt: now(), source: "MANUAL", paidFor: true },
    });
    assert.equal(income.body.paidFor, false);
  });
});

describe("a gift", () => {
  it("is spending, and says who it was for - one of the user's contacts only", async () => {
    const [user, other] = [await makeUser(), await makeUser()];
    const mum = (await call("/contacts", user.token, { body: { name: "Mum" } })).body;
    const gift = await call("/transactions", user.token, {
      body: { type: "DEBIT", amountMinor: 2500_00, occurredAt: now(), source: "MANUAL", merchant: "Tanishq", giftForContactId: mum.id },
    });
    assert.equal(gift.status, 201);
    assert.equal(gift.body.giftForContactId, mum.id);
    assert.equal(gift.body.countedAmountMinor, 2500_00);

    const theirs = (await call("/contacts", other.token, { body: { name: "Not yours" } })).body;
    const refused = await call(`/transactions/${gift.body.id}`, user.token, { method: "PATCH", body: { giftForContactId: theirs.id } });
    assert.equal(refused.status, 400);
  });
});
