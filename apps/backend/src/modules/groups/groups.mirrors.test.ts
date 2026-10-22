import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "groups-mirrors-test-secret";

/**
 * My share of a group payment somebody else on SpendLog made shows in my
 * own ledger and counts in my budget, as a mirror of their row that
 * follows it everywhere and goes when it does - without ever being
 * counted a second time in the group.
 */
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let mirrors: typeof import("./groups.mirrors");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_groups_mirrors_test"));

  const [{ app }, auth, loaded, loadedMirrors] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./groups.mirrors"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  mirrors = loadedMirrors;
  await models.Group.init();
  await models.Transaction.init();

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
    models.Category.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser(name?: string) {
  const email = `m${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, name: name ?? `User ${userCount}` });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

type Json = Record<string, any>;

async function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Json };
}

async function spend(token: string, body: Json) {
  const response = await call("/transactions", token, {
    body: { type: "DEBIT", occurredAt: new Date().toISOString(), ...body },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

const mirrorsOf = (sourceId: string) => models.Transaction.find({ mirrorOf: sourceId }).sort({ userId: 1 }).lean();
const mine = (userId: mongoose.Types.ObjectId) => models.Transaction.find({ userId }).lean();

/** Me and two flatmates on SpendLog, in one group. */
async function threeOnSpendLog() {
  const [me, asha, ben] = [await makeUser("Biswajit"), await makeUser("Asha"), await makeUser("Ben")];
  const group = (await call("/groups", me.token, { body: { name: "Goa" } })).body;
  for (const friend of [asha, ben]) await call("/groups/join", friend.token, { body: { code: group.joinCode } });
  return { me, asha, ben, group };
}

describe("a group payment somebody else made", () => {
  it("shows in my ledger as my share, counts in my budget, and is never counted again in the group", async () => {
    const { me, asha, ben, group } = await threeOnSpendLog();
    const food = await models.Category.create({ userId: me.id, name: "Food" });
    const dinner = await spend(me.token, {
      amountMinor: 3000_00,
      groupId: group.id,
      categoryId: food.id.toString(),
      merchant: "Fisherman's Wharf",
    });

    const written = await mirrorsOf(dinner.id);
    assert.equal(written.length, 2);
    for (const mirror of written) {
      assert.equal(mirror.offLedger, true);
      assert.equal(mirror.amountMinor, 3000_00, "the whole bill, like a payment a contact made");
      assert.equal(mirror.split?.myShareMinor, 1000_00);
      assert.equal(mirror.split?.groupLabel, "Goa");
      assert.equal(mirror.countedAmountMinor, 1000_00);
      assert.equal(mirror.countedReason, "SPLIT");
      assert.equal(mirror.merchant, "Fisherman's Wharf");
      assert.equal(String(mirror.categoryId), food.id.toString(), "starts with the payer's category");
      assert.equal(String(mirror.paidBy?.userId), me.id.toString());
      assert.equal(mirror.mirrorPayerName, "Biswajit");
      assert.equal(String(mirror.groupId), group.id);
      assert.equal(mirror.accountId, null);
      assert.deepEqual(mirror.people, []);
    }
    assert.deepEqual(
      written.map((m) => m.userId.toString()).sort(),
      [asha.id.toString(), ben.id.toString()].sort()
    );

    // Asha's side of it.
    assert.equal((await call("/budget/monthly", asha.token)).body.spentMinor, 1000_00);
    const list = (await call("/transactions", asha.token)).body;
    assert.equal(list.total, 1);
    assert.equal(list.items[0].paidByName, "Biswajit");
    assert.equal(list.items[0].offLedger, true);
    assert.equal(list.items[0].mirrorOf, dinner.id);
    assert.equal(list.items[0].group?.name, "Goa");

    // The group itself is unchanged: one payment of 3,000, and the same
    // settlement as before mirrors existed.
    const summary = (await call(`/groups/${group.id}/summary`, me.token)).body;
    assert.equal(summary.totalMinor, 3000_00);
    assert.equal(summary.transactionCount, 1);
    assert.equal((await call("/groups", asha.token)).body[0].totalMinor, 3000_00);
    const rows = (await call(`/groups/${group.id}/transactions`, asha.token)).body;
    assert.equal(rows.length, 1, "the group's list shows the payment once, from the payer's side");
    const settlement = (await call(`/groups/${group.id}/settlement`, asha.token)).body;
    assert.equal(settlement.balances.find((b: Json) => b.isMe).netMinor, -1000_00);
    assert.equal(settlement.balances.find((b: Json) => b.userId === me.id.toString()).netMinor, 2000_00);

    // Nobody's People page knows about it: a user's share settles in the group.
    assert.equal((await call("/contacts", asha.token)).body.youOweMinor, 0);
    assert.equal((await call("/contacts", me.token)).body.owedToYouMinor, 0);
  });

  it("follows the payer's row: amount, who it is shared with, the group, and deletion", async () => {
    const { me, asha, ben, group } = await threeOnSpendLog();
    const taxi = await spend(me.token, { amountMinor: 900_00, groupId: group.id });
    assert.equal((await mirrorsOf(taxi.id)).length, 2);

    await call(`/transactions/${taxi.id}`, me.token, { method: "PATCH", body: { amountMinor: 1800_00 } });
    for (const mirror of await mirrorsOf(taxi.id)) {
      assert.equal(mirror.amountMinor, 1800_00);
      assert.equal(mirror.countedAmountMinor, 600_00);
    }

    // Shared with Asha alone: Ben's goes, Asha's share is half.
    await call(`/transactions/${taxi.id}`, me.token, {
      method: "PATCH",
      body: { groupShareWith: [me.id.toString(), asha.id.toString()] },
    });
    let left = await mirrorsOf(taxi.id);
    assert.equal(left.length, 1);
    assert.equal(left[0].userId.toString(), asha.id.toString());
    assert.equal(left[0].countedAmountMinor, 900_00);
    assert.equal((await mine(ben.id)).length, 0);

    // Just mine: nobody's share but my own.
    await call(`/transactions/${taxi.id}`, me.token, { method: "PATCH", body: { groupShareWith: [me.id.toString()] } });
    assert.equal((await mirrorsOf(taxi.id)).length, 0);

    // Everyone again, then out of the group altogether.
    await call(`/transactions/${taxi.id}`, me.token, { method: "PATCH", body: { groupShareWith: null } });
    assert.equal((await mirrorsOf(taxi.id)).length, 2);
    await call(`/transactions/${taxi.id}`, me.token, { method: "PATCH", body: { groupId: null } });
    assert.equal((await mirrorsOf(taxi.id)).length, 0);
    assert.equal((await call("/budget/monthly", asha.token)).body.spentMinor, 0);

    // Back in, then deleted.
    await call(`/transactions/${taxi.id}`, me.token, { method: "PATCH", body: { groupId: group.id } });
    assert.equal((await mirrorsOf(taxi.id)).length, 2);
    const gone = await call(`/transactions/${taxi.id}`, me.token, { method: "DELETE" });
    assert.equal(gone.status, 204);
    left = await mirrorsOf(taxi.id);
    assert.equal(left.length, 0);
  });

  it("is written for whoever joins and taken away from whoever leaves", async () => {
    const me = await makeUser("Biswajit");
    const asha = await makeUser("Asha");
    const group = (await call("/groups", me.token, { body: { name: "Flat" } })).body;
    const rent = await spend(me.token, { amountMinor: 1000_00, groupId: group.id });
    assert.equal((await mirrorsOf(rent.id)).length, 0, "alone in it");

    await call("/groups/join", asha.token, { body: { code: group.joinCode } });
    const written = await mirrorsOf(rent.id);
    assert.equal(written.length, 1);
    assert.equal(written[0].countedAmountMinor, 500_00);

    await call(`/groups/${group.id}/leave`, asha.token, { method: "POST" });
    assert.equal((await mirrorsOf(rent.id)).length, 0);
    assert.equal((await mine(asha.id)).length, 0);
  });

  it("can be given a category by its holder, and nothing else; and never deleted by them", async () => {
    const { me, asha, group } = await threeOnSpendLog();
    const dinner = await spend(me.token, { amountMinor: 3000_00, groupId: group.id, merchant: "Dinner" });
    const [mirror] = (await call("/transactions", asha.token)).body.items;
    const outing = await models.Category.create({ userId: asha.id, name: "Outings" });

    const recategorised = await call(`/transactions/${mirror.id}`, asha.token, {
      method: "PATCH",
      body: { categoryId: outing.id.toString() },
    });
    assert.equal(recategorised.status, 200, JSON.stringify(recategorised.body));
    assert.equal(recategorised.body.category?.name, "Outings");

    // The form sends everything back as it loaded it: that is no change.
    const resent = await call(`/transactions/${mirror.id}`, asha.token, {
      method: "PATCH",
      body: { amountMinor: 3000_00, merchant: "Dinner", categoryId: outing.id.toString(), note: null, groupId: group.id },
    });
    assert.equal(resent.status, 200, JSON.stringify(resent.body));

    const refused = await call(`/transactions/${mirror.id}`, asha.token, { method: "PATCH", body: { amountMinor: 1_00 } });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /only its category/);
    const moved = await call(`/transactions/${mirror.id}`, asha.token, { method: "PATCH", body: { groupId: null } });
    assert.equal(moved.status, 400);

    const deleted = await call(`/transactions/${mirror.id}`, asha.token, { method: "DELETE" });
    assert.equal(deleted.status, 400);
    assert.match(deleted.body.error, /share of a payment someone else made/);
    assert.equal((await mirrorsOf(dinner.id)).length, 2);

    // Her category stays hers when the payer changes theirs.
    const food = await models.Category.create({ userId: me.id, name: "Food" });
    await call(`/transactions/${dinner.id}`, me.token, { method: "PATCH", body: { categoryId: food.id.toString() } });
    const kept = await models.Transaction.findById(mirror.id).orFail().lean();
    assert.equal(String(kept.categoryId), outing.id.toString());
  });

  it("names a contact who paid, on the mirror the other users get", async () => {
    const me = await makeUser("Biswajit");
    const asha = await makeUser("Asha");
    const rahul = (await call("/contacts", me.token, { body: { name: "Rahul" } })).body;
    const group = (await call("/groups", me.token, { body: { name: "Flat", contactIds: [rahul.id] } })).body;
    await call("/groups/join", asha.token, { body: { code: group.joinCode } });

    const paid = await call(`/groups/${group.id}/payments`, me.token, {
      body: {
        paidBy: { contactId: rahul.id },
        amountMinor: 3000_00,
        occurredAt: new Date().toISOString(),
        merchant: "Groceries",
      },
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));

    const written = await mirrorsOf(paid.body.id);
    assert.equal(written.length, 1);
    assert.equal(written[0].userId.toString(), asha.id.toString());
    assert.equal(written[0].countedAmountMinor, 1000_00);
    assert.equal(written[0].mirrorPayerName, "Rahul");
    assert.equal(written[0].paidBy?.userId, null);
    assert.equal((await call("/transactions", asha.token)).body.items[0].paidByName, "Rahul");

    // My own offLedger row is not a mirror, and never gets one of its own.
    const own = await models.Transaction.findById(paid.body.id).orFail().lean();
    assert.equal(own.mirrorOf, null);
    assert.equal((await mirrorsOf(written[0]._id.toString())).length, 0);
  });

  it("goes with the group when it is deleted", async () => {
    const { me, asha, group } = await threeOnSpendLog();
    await spend(me.token, { amountMinor: 3000_00, groupId: group.id });
    assert.equal((await mine(asha.id)).length, 1);
    assert.equal((await call(`/groups/${group.id}`, me.token, { method: "DELETE" })).status, 204);
    assert.equal((await mine(asha.id)).length, 0);
  });

  it("is written for the payments made before mirrors existed, once", async () => {
    const { me, asha, ben, group } = await threeOnSpendLog();
    const dinner = await spend(me.token, { amountMinor: 3000_00, groupId: group.id });
    const hers = await spend(asha.token, { amountMinor: 600_00, groupId: group.id });
    // As if written before: the payer's split there, the mirrors not.
    await models.Transaction.deleteMany({ mirrorOf: { $ne: null } });
    assert.equal((await mine(ben.id)).length, 0);

    assert.equal(await mirrors.backfillGroupMirrors(me.id), 2);
    assert.equal(await mirrors.backfillGroupMirrors(asha.id), 2);
    assert.equal((await mirrorsOf(dinner.id)).length, 2);
    assert.equal((await mirrorsOf(hers.id)).length, 2);
    assert.equal((await mine(ben.id)).length, 2);
    assert.equal((await call("/budget/monthly", ben.token)).body.spentMinor, 1000_00 + 200_00);

    assert.equal(await mirrors.backfillGroupMirrors(me.id), 0, "nothing left to do");
    assert.equal(await mirrors.backfillGroupMirrors(asha.id), 0);
    assert.equal(await mirrors.backfillGroupMirrors(ben.id), 0, "mirrors beget no mirrors");

    const run = await mirrors.runGroupMirrorsBackfill();
    assert.equal(run.users, 3);
    assert.equal(run.changed, 0);
    assert.equal((await mirrors.runGroupMirrorsBackfill()).users, 0);
  });
});

describe("what the group tells people's phones", () => {
  let notify: typeof import("./groups.notify");
  const sent: { userId: string; title: string; body: string; data: Record<string, string> }[] = [];

  before(async () => {
    notify = await import("./groups.notify");
    notify.setGroupNotifierForTests(async (userId, note) => {
      sent.push({ userId: userId.toString(), ...note });
    });
  });
  after(() => notify.setGroupNotifierForTests(null));
  beforeEach(() => {
    notify.flushShares();
    sent.length = 0;
  });

  it("the owner hears when someone joins with the code", async () => {
    const { me, group } = await threeOnSpendLog();
    const joined = sent.filter((s) => s.userId === me.id.toString());
    assert.deepEqual(
      joined.map((s) => s.title),
      ["Asha joined Goa", "Ben joined Goa"]
    );
    assert.deepEqual(joined[0].data, { type: "GROUP", groupId: group.id, link: `spendlog://app/groups/${group.id}` });
  });

  it("a payment with my share notifies me once a minute's shares are gathered, as one", async () => {
    const { me, asha, ben, group } = await threeOnSpendLog();
    sent.length = 0;
    await spend(me.token, { amountMinor: 3000_00, groupId: group.id, merchant: "Fisherman's Wharf" });
    assert.equal(sent.length, 0, "gathered first");
    notify.flushShares();
    const forAsha = sent.filter((s) => s.userId === asha.id.toString());
    assert.equal(forAsha.length, 1);
    assert.equal(forAsha[0].title, "Biswajit paid for Fisherman's Wharf");
    assert.equal(forAsha[0].body, "Your share: ₹1,000 · Goa");
    assert.equal(forAsha[0].data.link, `spendlog://app/groups/${group.id}`);
    assert.equal(sent.filter((s) => s.userId === me.id.toString()).length, 0, "the payer isn't told");

    sent.length = 0;
    await spend(me.token, { amountMinor: 300_00, groupId: group.id, merchant: "Chai" });
    await spend(me.token, { amountMinor: 600_00, groupId: group.id, note: "Taxi" });
    notify.flushShares();
    const forBen = sent.filter((s) => s.userId === ben.id.toString());
    assert.deepEqual(
      forBen.map((s) => [s.title, s.body]),
      [["2 payments include your share", "₹300 in all · Goa"]]
    );
  });

  it("an old payment (a backfill, a tidy-up) never notifies", async () => {
    const { me, group } = await threeOnSpendLog();
    sent.length = 0;
    await spend(me.token, { amountMinor: 900_00, groupId: group.id, occurredAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
    notify.flushShares();
    assert.equal(sent.length, 0);
  });

  it("the text for shares across groups", () => {
    const note = notify.shareNote([
      { groupId: "a", groupName: "Goa", payerName: "Asha", what: null, shareMinor: 150 },
      { groupId: "b", groupName: "Flat", payerName: "Ben", what: "Rent", shareMinor: 1000_00 },
    ]);
    assert.equal(note.title, "2 payments include your share");
    assert.equal(note.body, "₹1,001.50 in all · 2 groups");
    assert.deepEqual(note.data, { type: "GROUP" });
    assert.equal(notify.shareNote([{ groupId: "a", groupName: "Goa", payerName: "Asha", what: null, shareMinor: 250_00 }]).title, "Asha paid");
  });
});
