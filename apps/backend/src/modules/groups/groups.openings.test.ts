import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "groups-openings-test-secret";

/**
 * Opening balances on a group, over real HTTP: what members already owed
 * each other when a running "Flatmates" came into SpendLog. Where the
 * group's settlement starts, the People page's distinct row and balance
 * for a contact (and the pooled figures agreeing with it), the mirror a
 * SpendLog user sees, editing and removing, and that none of it is
 * spending.
 */
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let monthlyBudgetStatus: typeof import("../budget/budget.monthly").monthlyBudgetStatus;
let expectedBalances: typeof import("../accounts/accounts.balance").expectedBalances;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_groups_openings_test"));

  const [{ app }, auth, loaded, monthly, balance] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../budget/budget.monthly"),
    import("../accounts/accounts.balance"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  monthlyBudgetStatus = monthly.monthlyBudgetStatus;
  expectedBalances = balance.expectedBalances;
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
    models.ContactClearance.deleteMany({}),
    models.Account.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser() {
  const email = `o${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, name: `User ${userCount}` });
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

async function people(token: string) {
  return (await call("/contacts", token)).body;
}

async function balanceOf(token: string, contactId: string): Promise<number> {
  return (await people(token)).contacts.find((contact: Json) => contact.id === contactId)?.balanceMinor ?? 0;
}

/** The pooled figures and the People page, which must all say the same. */
async function owedEverywhere(token: string) {
  const [list, dashboard, analytics] = await Promise.all([
    people(token),
    call("/dashboard", token),
    call("/analytics/owed", token),
  ]);
  return {
    people: list.owedToYouMinor - list.youOweMinor,
    dashboard: dashboard.body.owed.balanceMinor as number,
    analytics: analytics.body.balanceMinor as number,
  };
}

/** "Flatmates", already running: Rahul owes me 1,200 and I owe Priya 450. */
async function flatmates() {
  const me = await makeUser();
  const rahul = (await call("/contacts", me.token, { body: { name: "Rahul" } })).body;
  const priya = (await call("/contacts", me.token, { body: { name: "Priya" } })).body;
  const created = await call("/groups", me.token, {
    body: {
      name: "Flatmates",
      contactIds: [rahul.id, priya.id],
      openingBalances: [
        { memberKind: "contact", contactId: rahul.id, direction: "owes_me", amountMinor: 1200_00, note: "March rent" },
        { memberKind: "contact", contactId: priya.id, direction: "i_owe", amountMinor: 450_00 },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { me, rahul, priya, group: created.body };
}

describe("an opening balance with a contact", () => {
  it("moves the People balance as its own row, and starts the group's settlement", async () => {
    const { me, rahul, priya, group } = await flatmates();

    assert.equal(await balanceOf(me.token, rahul.id), 1200_00);
    assert.equal(await balanceOf(me.token, priya.id), -450_00);

    const person = (await call(`/contacts/${rahul.id}`, me.token)).body;
    assert.equal(person.balanceMinor, 1200_00);
    assert.equal(person.openingBalanceMinor, 0, "not merged into the contact's own opening balance");
    assert.equal(person.groupOpeningMinor, 1200_00);
    assert.deepEqual(person.history, []);
    assert.deepEqual(
      person.groupOpenings.map((o: Json) => [o.groupName, o.direction, o.amountMinor, o.effectMinor, o.note]),
      [["Flatmates", "owes_me", 1200_00, 1200_00, "March rent"]]
    );
    const toPriya = (await call(`/contacts/${priya.id}`, me.token)).body.groupOpenings[0];
    assert.equal(toPriya.effectMinor, -450_00, "I owe her: signed the way her paying for me is");

    const settlement = (await call(`/groups/${group.id}/settlement`, me.token)).body;
    const byName = new Map(settlement.balances.map((b: Json) => [b.name, b]));
    const mine = settlement.balances.find((b: Json) => b.isMe);
    assert.equal(mine.netMinor, 750_00);
    assert.equal(mine.openingMinor, 750_00);
    assert.equal(mine.paidMinor, 0, "nothing paid");
    assert.equal(mine.shareMinor, 0, "nothing spent");
    assert.equal((byName.get("Rahul") as Json).netMinor, -1200_00);
    assert.equal((byName.get("Priya") as Json).netMinor, 450_00);
    assert.deepEqual(
      settlement.transfers.map((t: Json) => [t.fromName, t.toName, t.amountMinor]).sort(),
      [
        ["Rahul", "Priya", 450_00],
        ["Rahul", `User ${userCount}`, 750_00],
      ].sort()
    );

    assert.deepEqual(await owedEverywhere(me.token), { people: 750_00, dashboard: 750_00, analytics: 750_00 });
  });

  it("adds to what the group's payments already put on them", async () => {
    const { me, rahul, group } = await flatmates();
    const dinner = await call("/transactions", me.token, {
      body: { type: "DEBIT", amountMinor: 3000_00, occurredAt: new Date().toISOString(), source: "MANUAL", groupId: group.id },
    });
    assert.equal(dinner.status, 201);

    assert.equal(await balanceOf(me.token, rahul.id), 2200_00);
    const person = (await call(`/contacts/${rahul.id}`, me.token)).body;
    assert.equal(person.history.length, 1, "the dinner, as before");
    assert.equal(person.groupOpenings.length, 1, "and the opening, apart from it");

    const settlement = (await call(`/groups/${group.id}/settlement`, me.token)).body;
    assert.equal(settlement.balances.find((b: Json) => b.name === "Rahul").netMinor, -2200_00);

    const owed = await owedEverywhere(me.token);
    assert.equal(owed.people, 1200_00 + 1000_00 - 450_00 + 1000_00);
    assert.equal(owed.dashboard, owed.people);
    assert.equal(owed.analytics, owed.people);
  });

  it("is in the group's detail and summary, from my side", async () => {
    const { me, group } = await flatmates();
    const detail = (await call(`/groups/${group.id}`, me.token)).body;
    assert.deepEqual(
      detail.openingBalances.map((o: Json) => [o.memberName, o.direction, o.amountMinor, o.isMine, o.viewerDirection]),
      [
        ["Rahul", "owes_me", 1200_00, true, "owes_me"],
        ["Priya", "i_owe", 450_00, true, "i_owe"],
      ]
    );
    const summary = (await call(`/groups/${group.id}/summary`, me.token)).body;
    assert.equal(summary.openingBalances.length, 2);
    assert.equal(summary.totalMinor, 0, "nothing was spent");
    assert.equal(summary.group.openingBalances, undefined, "named only where it is shown");
  });

  it("goes with the contact, out of the group or deleted", async () => {
    const { me, rahul, priya, group } = await flatmates();
    assert.equal((await call(`/groups/${group.id}/contacts/${rahul.id}`, me.token, { method: "DELETE" })).status, 204);
    assert.equal(await balanceOf(me.token, rahul.id), 0);

    await call(`/contacts/${priya.id}`, me.token, { method: "DELETE" });
    const stored = await models.Group.findById(group.id).orFail().lean();
    assert.deepEqual(stored.openingBalances, []);
    assert.deepEqual(await owedEverywhere(me.token), { people: 0, dashboard: 0, analytics: 0 });
  });
});

describe("an opening balance with a SpendLog user", () => {
  async function withFriend() {
    const me = await makeUser();
    const friend = await makeUser();
    const group = (await call("/groups", me.token, { body: { name: "Flatmates" } })).body;
    await call("/groups/join", friend.token, { body: { code: group.joinCode } });
    return { me, friend, group };
  }

  it("settles inside the group, and they see the mirror of it", async () => {
    const { me, friend, group } = await withFriend();
    const set = await call(`/groups/${group.id}/openings`, me.token, {
      method: "PUT",
      body: { openingBalances: [{ memberKind: "user", userId: friend.id.toString(), direction: "owes_me", amountMinor: 1200_00 }] },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));

    for (const viewer of [me, friend]) {
      const settlement = (await call(`/groups/${group.id}/settlement`, viewer.token)).body;
      assert.deepEqual(
        settlement.transfers.map((t: Json) => [t.fromUserId, t.toUserId, t.amountMinor]),
        [[friend.id.toString(), me.id.toString(), 1200_00]]
      );
    }
    const theirs = (await call(`/groups/${group.id}`, friend.token)).body.openingBalances[0];
    assert.equal(theirs.isMine, false);
    assert.equal(theirs.viewerDirection, "i_owe", "you owe them");
    assert.equal(theirs.setByName, `User ${userCount - 1}`);

    // Not a contact: nobody's People page moves.
    assert.deepEqual(await owedEverywhere(me.token), { people: 0, dashboard: 0, analytics: 0 });
    assert.deepEqual(await owedEverywhere(friend.token), { people: 0, dashboard: 0, analytics: 0 });

    // The same debt from their side would count twice.
    const twice = await call(`/groups/${group.id}/openings`, friend.token, {
      method: "PUT",
      body: { openingBalances: [{ memberKind: "user", userId: me.id.toString(), direction: "i_owe", amountMinor: 1200_00 }] },
    });
    assert.equal(twice.status, 400);
  });

  it("runs the other way for 'I owe'", async () => {
    const { me, friend, group } = await withFriend();
    await call(`/groups/${group.id}/openings`, me.token, {
      method: "PUT",
      body: { openingBalances: [{ memberKind: "user", memberId: friend.id.toString(), direction: "i_owe", amountMinor: 450_00 }] },
    });
    const settlement = (await call(`/groups/${group.id}/settlement`, friend.token)).body;
    assert.deepEqual(
      settlement.transfers.map((t: Json) => [t.fromUserId, t.toUserId, t.amountMinor]),
      [[me.id.toString(), friend.id.toString(), 450_00]]
    );
    assert.equal(settlement.balances.find((b: Json) => b.isMe).openingMinor, 450_00);
    assert.equal((await call(`/groups/${group.id}`, friend.token)).body.openingBalances[0].viewerDirection, "owes_me");
  });

  it("refuses myself, someone not in the group, someone else's contact, and the same person twice", async () => {
    const { me, friend, group } = await withFriend();
    const theirContact = (await call(`/groups/${group.id}/contacts`, friend.token, { body: { name: "Karan" } })).body.contacts[0];
    const outsider = await makeUser();
    const put = (entry: Json, token = me.token) =>
      call(`/groups/${group.id}/openings`, token, { method: "PUT", body: { openingBalances: Array.isArray(entry) ? entry : [entry] } });

    assert.equal((await put({ memberKind: "user", userId: me.id.toString(), direction: "owes_me", amountMinor: 1 })).status, 400);
    assert.equal((await put({ memberKind: "user", userId: outsider.id.toString(), direction: "owes_me", amountMinor: 1 })).status, 400);
    assert.equal((await put({ memberKind: "contact", contactId: theirContact.id, direction: "owes_me", amountMinor: 1 })).status, 400);
    const entry = { memberKind: "user", userId: friend.id.toString(), direction: "owes_me", amountMinor: 1 };
    assert.equal((await put([entry, entry])).status, 400);
    assert.equal((await put({ ...entry, amountMinor: -5 })).status, 400);
    assert.equal((await put(entry, outsider.token)).status, 404, "not their group");
  });
});

describe("editing and removing", () => {
  it("moves everything to match, and leaves other people's alone", async () => {
    const { me, rahul, priya, group } = await flatmates();
    const friend = await makeUser();
    await call("/groups/join", friend.token, { body: { code: group.joinCode } });
    await call(`/groups/${group.id}/openings`, friend.token, {
      method: "PUT",
      body: { openingBalances: [{ memberKind: "user", userId: me.id.toString(), direction: "owes_me", amountMinor: 100_00 }] },
    });
    const before = (await call(`/contacts/${priya.id}`, me.token)).body.groupOpenings[0];

    const edited = await call(`/groups/${group.id}/openings`, me.token, {
      method: "PUT",
      body: {
        openingBalances: [
          { memberKind: "contact", contactId: rahul.id, direction: "i_owe", amountMinor: 300_00 },
          { memberKind: "contact", contactId: priya.id, direction: "i_owe", amountMinor: 450_00 },
        ],
      },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.openingBalances.length, 3, "my two and my friend's");
    assert.equal(await balanceOf(me.token, rahul.id), -300_00);
    assert.equal((await call(`/contacts/${priya.id}`, me.token)).body.groupOpenings[0].id, before.id, "unchanged keeps its id");
    assert.deepEqual(await owedEverywhere(me.token), { people: -750_00, dashboard: -750_00, analytics: -750_00 });
    const settlement = (await call(`/groups/${group.id}/settlement`, me.token)).body;
    assert.equal(settlement.balances.find((b: Json) => b.isMe).netMinor, -300_00 - 450_00 - 100_00);

    const removed = await call(`/groups/${group.id}/openings`, me.token, { method: "PUT", body: { openingBalances: [] } });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.openingBalances.length, 1, "only my friend's is left");
    assert.equal(await balanceOf(me.token, rahul.id), 0);
    assert.deepEqual((await call(`/contacts/${rahul.id}`, me.token)).body.groupOpenings, []);
    assert.deepEqual(await owedEverywhere(me.token), { people: 0, dashboard: 0, analytics: 0 });

    // A zero is the same as leaving it out.
    await call(`/groups/${group.id}/openings`, me.token, {
      method: "PUT",
      body: { openingBalances: [{ memberKind: "contact", contactId: rahul.id, direction: "owes_me", amountMinor: 0 }] },
    });
    assert.equal(await balanceOf(me.token, rahul.id), 0);
  });
});

describe("what an opening balance is not", () => {
  it("is never spending, income, an account's money or a transaction", async () => {
    const me = await makeUser();
    const cash = await models.Account.create({
      userId: me.id,
      bankName: "Cash",
      accountType: "CASH",
      openingBalanceMinor: 5000_00,
      openingBalanceAt: new Date(Date.now() - 86_400_000),
    });
    const rahul = (await call("/contacts", me.token, { body: { name: "Rahul" } })).body;
    const created = await call("/groups", me.token, {
      body: {
        name: "Flatmates",
        contactIds: [rahul.id],
        openingBalances: [{ memberKind: "contact", contactId: rahul.id, direction: "owes_me", amountMinor: 1200_00 }],
      },
    });
    assert.equal(created.status, 201);

    assert.equal(await models.Transaction.countDocuments({}), 0);
    const budget = await monthlyBudgetStatus(me.id);
    assert.equal(budget.spentMinor, 0);
    const summary = (await call("/analytics/summary", me.token)).body;
    assert.equal(summary.totalSpendMinor, 0);
    assert.equal(summary.totalIncomeMinor, 0);
    assert.equal((await expectedBalances(me.id, [cash])).get(cash.id)?.expectedMinor, 5000_00);
    const passbook = await call(`/accounts/${cash.id}/passbook`, me.token);
    assert.equal(passbook.status, 200);
    assert.ok(!JSON.stringify(passbook.body).includes("Flatmates"));
  });
});

describe("settling up", () => {
  it("brings a contact's opening to zero, by money back or by clearing it", async () => {
    const { me, rahul, priya } = await flatmates();
    const cash = await models.Account.create({ userId: me.id, bankName: "Cash", accountType: "CASH" });

    const back = await call("/transactions", me.token, {
      body: {
        type: "CREDIT",
        amountMinor: 1200_00,
        accountId: cash.id.toString(),
        occurredAt: new Date().toISOString(),
        source: "MANUAL",
        isSettlement: true,
        people: [{ contactId: rahul.id, amountMinor: 1200_00 }],
      },
    });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    assert.equal(back.body.countedAmountMinor, 0, "not income");
    assert.equal(await balanceOf(me.token, rahul.id), 0);

    const cleared = await call(`/contacts/${priya.id}/clear`, me.token, { body: { amountMinor: 450_00 } });
    assert.equal(cleared.status, 201, JSON.stringify(cleared.body));
    assert.equal(await balanceOf(me.token, priya.id), 0);
    assert.deepEqual(await owedEverywhere(me.token), { people: 0, dashboard: 0, analytics: 0 });
  });
});

describe("the old /trips paths", () => {
  it("take and show openings, and otherwise answer as they did", async () => {
    const me = await makeUser();
    const rahul = (await call("/contacts", me.token, { body: { name: "Rahul" } })).body;
    const started = await call("/trips", me.token, {
      body: {
        name: "Goa",
        contactIds: [rahul.id],
        openingBalances: [{ memberKind: "contact", contactId: rahul.id, direction: "owes_me", amountMinor: 500_00 }],
      },
    });
    assert.equal(started.status, 201);
    assert.equal(started.body.isActive, true, "still running from now");
    assert.equal((await call("/trips", me.token, { body: { name: "Again" } })).status, 409, "still one at a time");

    const trip = (await call(`/trips/${started.body.id}`, me.token)).body;
    assert.equal(trip.openingBalances[0].amountMinor, 500_00);
    assert.equal(await balanceOf(me.token, rahul.id), 500_00);
    const put = await call(`/trips/${started.body.id}/openings`, me.token, { method: "PUT", body: { openingBalances: [] } });
    assert.equal(put.status, 200);
    assert.equal(await balanceOf(me.token, rahul.id), 0);
    assert.equal((await call("/trips/active", me.token)).body.id, started.body.id);
  });
});
