import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "groups-shares-test-secret";

/**
 * Only the payer's own share of a group payment is their spending, whoever
 * else it was shared with: the other members' shares come back to them -
 * a contact's through People, a SpendLog user's through the group's
 * settlement - and never through the budget. Plus the pass that mends
 * rows saved under the old rule.
 */
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let backfill: typeof import("./groups.backfill");
let trippin: typeof import("../integrations/trippin.service");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_groups_shares_test"));

  const [{ app }, auth, loaded, loadedBackfill, loadedTrippin] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./groups.backfill"),
    import("../integrations/trippin.service"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  backfill = loadedBackfill;
  trippin = loadedTrippin;
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
    models.Category.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser(extra: Record<string, unknown> = {}) {
  const email = `s${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, name: `User ${userCount}`, ...extra });
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
    body: { type: "DEBIT", occurredAt: new Date().toISOString(), source: "MANUAL", ...body },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

async function row(id: string) {
  return models.Transaction.findById(id).orFail().lean();
}

/** Me and two flatmates on SpendLog, in one group. */
async function threeOnSpendLog() {
  const [me, asha, ben] = [await makeUser(), await makeUser(), await makeUser()];
  const group = (await call("/groups", me.token, { body: { name: "Goa" } })).body;
  for (const friend of [asha, ben]) await call("/groups/join", friend.token, { body: { code: group.joinCode } });
  return { me, asha, ben, group };
}

describe("a group payment I made", () => {
  it("counts only my third in the budget and analytics, and the rest is owed back through the group", async () => {
    const { me, asha, ben, group } = await threeOnSpendLog();
    const food = await models.Category.create({ userId: me.id, name: "Food" });
    const dinner = await spend(me.token, { amountMinor: 3000_00, groupId: group.id, categoryId: food.id.toString() });

    const stored = await row(dinner.id);
    assert.equal(stored.countedAmountMinor, 1000_00);
    assert.equal(stored.groupSplit, true);
    assert.equal(stored.split?.myShareMinor, 1000_00);
    assert.deepEqual(stored.people, [], "nobody on the People page: they are SpendLog users");

    assert.equal((await call("/budget/monthly", me.token)).body.spentMinor, 1000_00);
    const summary = (await call("/analytics/summary", me.token)).body;
    assert.equal(summary.totalSpendMinor, 1000_00);
    assert.deepEqual(
      summary.byCategory.map((c: Json) => [c.name, c.amountMinor]),
      [["Food", 1000_00]]
    );

    const settlement = (await call(`/groups/${group.id}/settlement`, me.token)).body;
    assert.equal(settlement.balances.find((b: Json) => b.isMe).netMinor, 2000_00);
    assert.deepEqual(
      settlement.transfers.map((t: Json) => [t.fromUserId, t.toUserId, t.amountMinor]).sort(),
      [
        [asha.id.toString(), me.id.toString(), 1000_00],
        [ben.id.toString(), me.id.toString(), 1000_00],
      ].sort()
    );

    // What SpendLog users owe settles in the group, not on People - and
    // so not in the pooled figures that agree with People.
    assert.equal((await call("/dashboard", me.token)).body.owed.balanceMinor, 0);
    assert.equal((await call("/analytics/owed", me.token)).body.balanceMinor, 0);

    const groupSummary = (await call(`/groups/${group.id}/summary`, me.token)).body;
    assert.equal(groupSummary.totalMinor, 3000_00, "the group still cost the whole bill");
    assert.equal(groupSummary.byMember[0].spentMinor, 3000_00);
    assert.equal((await call("/groups", me.token)).body[0].totalMinor, 3000_00);
  });

  it("sends a contact's share to People and a user's to the settlement, with the pooled figures agreeing", async () => {
    const me = await makeUser();
    const asha = await makeUser();
    const rahul = (await call("/contacts", me.token, { body: { name: "Rahul" } })).body;
    const group = (await call("/groups", me.token, { body: { name: "Flat", contactIds: [rahul.id] } })).body;
    await call("/groups/join", asha.token, { body: { code: group.joinCode } });

    const rent = await spend(me.token, { amountMinor: 3000_00, groupId: group.id });
    const stored = await row(rent.id);
    assert.equal(stored.countedAmountMinor, 1000_00);
    assert.deepEqual(stored.people.map((p) => [p.contactId.toString(), p.amountMinor]), [[rahul.id, 1000_00]]);

    const people = (await call("/contacts", me.token)).body;
    assert.equal(people.owedToYouMinor, 1000_00);
    assert.equal((await call("/dashboard", me.token)).body.owed.balanceMinor, 1000_00);
    assert.equal((await call("/analytics/owed", me.token)).body.balanceMinor, 1000_00);

    const settlement = (await call(`/groups/${group.id}/settlement`, me.token)).body;
    assert.equal(settlement.balances.find((b: Json) => b.userId === asha.id.toString()).netMinor, -1000_00);
  });

  it("follows 'just mine' and a narrower list the same way", async () => {
    const { me, asha, group } = await threeOnSpendLog();
    const souvenir = await spend(me.token, { amountMinor: 900_00, groupId: group.id, groupShareWith: [me.id.toString()] });
    const stored = await row(souvenir.id);
    assert.equal(stored.countedAmountMinor, 900_00);
    assert.equal(stored.groupSplit, false, "all mine: nothing to split");

    const forAsha = await spend(me.token, { amountMinor: 600_00, groupId: group.id, groupShareWith: [asha.id.toString()] });
    assert.equal((await row(forAsha.id)).countedAmountMinor, 0, "bought for her: none of it mine");

    const taxi = await spend(me.token, {
      amountMinor: 500_00,
      groupId: group.id,
      groupShareWith: [me.id.toString(), asha.id.toString()],
    });
    assert.equal((await row(taxi.id)).countedAmountMinor, 250_00);

    // Changed after the fact, the counted amount follows.
    await call(`/transactions/${taxi.id}`, me.token, { method: "PATCH", body: { groupShareWith: null } });
    assert.equal((await row(taxi.id)).countedAmountMinor, 16667, "a third, the odd paisa to the earliest");
    await call(`/transactions/${taxi.id}`, me.token, { method: "PATCH", body: { groupId: null } });
    const out = await row(taxi.id);
    assert.equal(out.countedAmountMinor, 500_00, "out of the group, all mine again");
    assert.equal(out.split, null);

    assert.equal((await call("/budget/monthly", me.token)).body.spentMinor, 900_00 + 0 + 500_00);
  });

  it("works the shares out again when someone joins or leaves", async () => {
    const me = await makeUser();
    const asha = await makeUser();
    const group = (await call("/groups", me.token, { body: { name: "Flat" } })).body;
    const rent = await spend(me.token, { amountMinor: 1000_00, groupId: group.id });
    assert.equal((await row(rent.id)).countedAmountMinor, 1000_00, "alone in it, all mine");

    await call("/groups/join", asha.token, { body: { code: group.joinCode } });
    assert.equal((await row(rent.id)).countedAmountMinor, 500_00);

    await call(`/groups/${group.id}/leave`, asha.token, { method: "POST" });
    assert.equal((await row(rent.id)).countedAmountMinor, 1000_00);
  });

  it("keeps a linked Trippin trip's summary right", async () => {
    const owner = await makeUser({ oidcSub: "sub-owner" });
    const ravi = await makeUser({ oidcSub: "sub-ravi" });
    const startedAt = new Date(Date.now() - 2 * 86_400_000);
    const trip = await models.Group.create({
      ownerId: owner.id,
      name: "Goa",
      startedAt,
      endedAt: new Date(Date.now() + 2 * 86_400_000),
      members: [
        { userId: owner.id, joinedAt: startedAt },
        { userId: ravi.id, joinedAt: startedAt },
      ],
      joinCode: "TRPS23",
      source: { app: "trippin", externalId: "trp_shares", linked: true, linkedAt: new Date() },
    });

    const hotel = await spend(owner.token, { amountMinor: 4000_00 });
    assert.equal(hotel.groupId, trip.id, "taken in by its dates");
    assert.equal((await row(hotel.id)).countedAmountMinor, 2000_00);

    const summary = await trippin.trippinSummary("trp_shares", "sub-ravi");
    assert.equal(summary?.totalSpentMinor, 4000_00);
    assert.equal(summary?.myShareMinor, 2000_00);
    assert.equal(summary?.iOweMinor, 2000_00);
    const ownerView = await trippin.trippinSummary("trp_shares", "sub-owner");
    assert.equal(ownerView?.myShareMinor, 2000_00);
    assert.equal(ownerView?.owedToMeMinor, 2000_00);
  });
});

describe("the group shares backfill", () => {
  it("counts old rows at my share, once", async () => {
    const { me, group } = await threeOnSpendLog();
    const dinner = await spend(me.token, { amountMinor: 3000_00, groupId: group.id });
    const souvenir = await spend(me.token, { amountMinor: 500_00, groupId: group.id, groupShareWith: [me.id.toString()] });
    // As the old rule left them: counted in full, with no split.
    await models.Transaction.updateOne(
      { _id: dinner.id },
      { $set: { split: null, people: [], groupSplit: false, countedAmountMinor: 3000_00, countedReason: "FULL" } }
    );
    assert.equal((await call("/budget/monthly", me.token)).body.spentMinor, 3500_00);

    assert.equal(await backfill.backfillGroupShares(me.id), 1, "the dinner only");
    const mended = await row(dinner.id);
    assert.equal(mended.countedAmountMinor, 1000_00);
    assert.equal(mended.countedReason, "SPLIT");
    assert.equal(mended.split?.myShareMinor, 1000_00);
    assert.equal((await row(souvenir.id)).countedAmountMinor, 500_00);
    assert.equal((await call("/budget/monthly", me.token)).body.spentMinor, 1500_00);

    assert.equal(await backfill.backfillGroupShares(me.id), 0, "nothing left the second time");

    // Through runOncePerUser, it is marked done per user and not run again.
    const first = await backfill.runGroupSharesBackfill();
    assert.ok(first.users >= 3);
    assert.equal(first.changed, 0);
    assert.deepEqual(await backfill.runGroupSharesBackfill(), { users: 0, changed: 0 });
  });
});
