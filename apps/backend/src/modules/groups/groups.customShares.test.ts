import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { computeBalances, shareByAmounts, sharesOf } from "./groups.settlement";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "groups-custom-shares-secret";

/**
 * A group payment split by parts typed by hand rather than equally: the
 * payer's own part is their spending, a contact's is owed on People, a
 * SpendLog member's comes back through the group and shows as their share.
 */
describe("parts typed by hand", () => {
  const parts = [
    { memberId: "a", amountMinor: 600_00 },
    { memberId: "b", amountMinor: 200_00 },
    { memberId: "c", amountMinor: 200_00 },
  ];

  it("gives each exactly their part when they add up to the payment", () => {
    assert.deepEqual([...shareByAmounts(1000_00, parts)], [["a", 600_00], ["b", 200_00], ["c", 200_00]]);
  });

  it("keeps the proportions, to the paisa, when the payment's amount has changed since", () => {
    const shares = shareByAmounts(1001, parts);
    assert.equal([...shares.values()].reduce((sum, value) => sum + value, 0), 1001);
    assert.deepEqual([...shares], [["a", 601], ["b", 200], ["c", 200]]);
  });

  it("leaves out a part of nothing, and is equal when no parts are typed", () => {
    assert.deepEqual([...shareByAmounts(500_00, [{ memberId: "a", amountMinor: 500_00 }, { memberId: "b", amountMinor: 0 }])], [["a", 500_00]]);
    assert.deepEqual([...sharesOf(300_00, ["a", "b", "c"], null)], [["a", 100_00], ["b", 100_00], ["c", 100_00]]);
  });

  it("settles the group on the typed parts", () => {
    const balances = computeBalances([{ payerId: "a", amountMinor: 1000_00, sharerIds: ["a", "b", "c"], shareAmounts: parts }]);
    const net = Object.fromEntries(balances.map((b) => [b.userId, b.netMinor]));
    assert.deepEqual(net, { a: 400_00, b: -200_00, c: -200_00 });
  });
});

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_groups_custom_shares_test"));
  const [{ app }, auth, loaded] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  await models.Group.init();
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
    models.Group.deleteMany({}),
    models.User.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.Contact.deleteMany({}),
  ]);
});

let userCount = 0;
type Json = Record<string, any>;

async function makeUser() {
  const email = `cs${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, name: `User ${userCount}` });
  return { id: user._id.toString(), token: signToken({ id: user._id.toString(), email }) };
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

/** Me, a flatmate on SpendLog, and a contact of mine, in one group. */
async function flat() {
  const [me, asha] = [await makeUser(), await makeUser()];
  const group = (await call("/groups", me.token, { body: { name: "Flatmates" } })).body;
  await call("/groups/join", asha.token, { body: { code: group.joinCode } });
  const rahul = (await call("/contacts", me.token, { body: { name: "Rahul" } })).body;
  await call(`/groups/${group.id}/contacts`, me.token, { body: { contactId: rahul.id } });
  return { me, asha, rahul, group };
}

const row = (id: string) => models.Transaction.findById(id).orFail().lean();

describe("a group payment with typed parts", () => {
  it("counts my part, puts the contact's on People, and gives the member a mirror of theirs", async () => {
    const { me, asha, rahul, group } = await flat();
    const created = await call("/transactions", me.token, {
      body: {
        type: "DEBIT", amountMinor: 1000_00, occurredAt: new Date().toISOString(), source: "MANUAL", groupId: group.id,
        groupShareAmounts: [
          { memberId: me.id, amountMinor: 200_00 },
          { memberId: asha.id, amountMinor: 500_00 },
          { memberId: rahul.id, amountMinor: 300_00 },
        ],
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const stored = await row(created.body.id);
    assert.equal(stored.split?.myShareMinor, 200_00);
    assert.equal(stored.countedAmountMinor, 200_00);
    assert.deepEqual(stored.people.map((p) => [String(p.contactId), p.amountMinor]), [[rahul.id, 300_00]]);

    const mirror = await models.Transaction.findOne({ mirrorOf: created.body.id }).lean();
    assert.equal(String(mirror!.userId), asha.id);
    assert.equal(mirror!.split?.myShareMinor, 500_00);

    const settlement = (await call(`/groups/${group.id}/settlement`, me.token)).body;
    assert.equal(settlement.balances.find((b: Json) => b.isMe).netMinor, 800_00);
  });

  it("refuses parts that don't add up to the payment, or name someone outside the group", async () => {
    const { me, asha, group } = await flat();
    const base = { type: "DEBIT", amountMinor: 1000_00, occurredAt: new Date().toISOString(), source: "MANUAL", groupId: group.id };

    const short = await call("/transactions", me.token, {
      body: { ...base, groupShareAmounts: [{ memberId: me.id, amountMinor: 200_00 }, { memberId: asha.id, amountMinor: 500_00 }] },
    });
    assert.equal(short.status, 400);
    assert.match(short.body.error, /add up to ₹700\.00, but the payment is ₹1000\.00/);

    const stranger = await makeUser();
    const outside = await call("/transactions", me.token, {
      body: { ...base, groupShareAmounts: [{ memberId: me.id, amountMinor: 500_00 }, { memberId: stranger.id, amountMinor: 500_00 }] },
    });
    assert.equal(outside.status, 400);
  });

  it("sets parts on an edit, and picking who it was for again goes back to equal", async () => {
    const { me, asha, rahul, group } = await flat();
    const created = (await call("/transactions", me.token, {
      body: { type: "DEBIT", amountMinor: 900_00, occurredAt: new Date().toISOString(), source: "MANUAL", groupId: group.id },
    })).body;
    assert.equal((await row(created.id)).split?.myShareMinor, 300_00);

    const typed = await call(`/transactions/${created.id}`, me.token, {
      method: "PATCH",
      body: { groupShareAmounts: [{ memberId: me.id, amountMinor: 100_00 }, { memberId: asha.id, amountMinor: 800_00 }] },
    });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    let stored = await row(created.id);
    assert.equal(stored.split?.myShareMinor, 100_00);
    assert.deepEqual(stored.people, [], "Rahul's part is nothing now");
    assert.deepEqual((stored.groupShareWith ?? []).map(String).sort(), [me.id, asha.id].sort());

    await call(`/transactions/${created.id}`, me.token, { method: "PATCH", body: { groupShareWith: null } });
    stored = await row(created.id);
    assert.equal(stored.groupShareAmounts, null);
    assert.equal(stored.split?.myShareMinor, 300_00);
    assert.deepEqual(stored.people.map((p) => [String(p.contactId), p.amountMinor]), [[rahul.id, 300_00]]);
  });

  it("keeps the proportions when only the amount is edited", async () => {
    const { me, asha, group } = await flat();
    const created = (await call("/transactions", me.token, {
      body: {
        type: "DEBIT", amountMinor: 1000_00, occurredAt: new Date().toISOString(), source: "MANUAL", groupId: group.id,
        groupShareAmounts: [{ memberId: me.id, amountMinor: 250_00 }, { memberId: asha.id, amountMinor: 750_00 }],
      },
    })).body;

    await call(`/transactions/${created.id}`, me.token, { method: "PATCH", body: { amountMinor: 2000_00 } });
    assert.equal((await row(created.id)).split?.myShareMinor, 500_00);
  });
});
