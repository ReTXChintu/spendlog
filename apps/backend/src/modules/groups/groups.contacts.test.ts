import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "groups-contacts-test-secret";

/**
 * Groups with people who have no SpendLog account in them, over real HTTP:
 * how a payment is shared among the members, how a contact's share lands
 * on the People page, a payment one of them made, archiving, and the old
 * /trips paths answering the same.
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
  await mongoose.connect(mongod.getUri("spendlog_groups_contacts_test"));

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
  const email = `g${(userCount += 1)}@example.com`;
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

/** Me, with two contacts of mine - Rahul and Priya - in a new group. */
async function groupWithContacts(name = "Goa") {
  const me = await makeUser();
  const rahul = (await call("/contacts", me.token, { body: { name: "Rahul", phone: "+91 98765 43210" } })).body;
  const priya = (await call("/contacts", me.token, { body: { name: "Priya" } })).body;
  const created = await call("/groups", me.token, { body: { name, contactIds: [rahul.id, priya.id] } });
  assert.equal(created.status, 201);
  return { me, rahul, priya, group: created.body };
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

async function balanceOf(token: string, contactId: string): Promise<number> {
  const list = await call("/contacts", token);
  return list.body.contacts.find((contact: Json) => contact.id === contactId)?.balanceMinor ?? 0;
}

describe("making a group", () => {
  it("has no dates unless given, and is active", async () => {
    const me = await makeUser();
    const created = await call("/groups", me.token, { body: { name: "Flatmates" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.startedAt, null);
    assert.equal(created.body.isActive, true);
    assert.equal(created.body.autoAdds, false);
    assert.equal(created.body.memberCount, 1);
  });

  it("lets one person have several open at once", async () => {
    const me = await makeUser();
    for (const name of ["Goa", "Flatmates", "Office lunch"]) {
      assert.equal((await call("/groups", me.token, { body: { name, startedAt: new Date().toISOString() } })).status, 201);
    }
    assert.equal((await call("/groups/active", me.token)).body.length, 3);
  });

  it("refuses somebody else's contact", async () => {
    const [me, other] = await Promise.all([makeUser(), makeUser()]);
    const theirs = (await call("/contacts", other.token, { body: { name: "Not yours" } })).body;
    const refused = await call("/groups", me.token, { body: { name: "Goa", contactIds: [theirs.id] } });
    assert.equal(refused.status, 400);
  });
});

describe("no adding by date for an ordinary group", () => {
  it("leaves a payment inside its dates out until it is picked", async () => {
    const me = await makeUser();
    const group = (
      await call("/groups", me.token, {
        body: { name: "Goa", startedAt: new Date(Date.now() - 86_400_000).toISOString() },
      })
    ).body;

    const payment = await spend(me.token, { amountMinor: 50000 });
    assert.equal(payment.groupId, null);

    const picked = await spend(me.token, { amountMinor: 70000, groupId: group.id });
    assert.equal(picked.groupId, group.id);
    assert.equal(picked.tripId, group.id, "the old name says the same");
  });

  it("still adds one inside a Trippin group's dates", async () => {
    const me = await makeUser();
    const linked = await models.Group.create({
      ownerId: me.id,
      name: "Planned in Trippin",
      startedAt: new Date(Date.now() - 2 * 86_400_000),
      endedAt: new Date(Date.now() + 2 * 86_400_000),
      members: [{ userId: me.id, joinedAt: new Date(Date.now() - 2 * 86_400_000) }],
      joinCode: "TRPN23",
      source: { app: "trippin", externalId: "trp_x", linked: true, linkedAt: new Date() },
    });

    const payment = await spend(me.token, { amountMinor: 50000 });
    assert.equal(payment.groupId, linked.id);
  });
});

describe("sharing a payment", () => {
  it("shares it equally among everyone by default, and the contacts owe me their part", async () => {
    const { me, rahul, priya, group } = await groupWithContacts();
    const dinner = await spend(me.token, { amountMinor: 3000_00, groupId: group.id, split: null, people: [] });

    const stored = await row(dinner.id);
    assert.equal(stored.groupSplit, true);
    assert.equal(stored.split?.myShareMinor, 1000_00);
    assert.equal(stored.countedAmountMinor, 1000_00, "only my share is my spending");
    assert.deepEqual(
      stored.people.map((p) => [p.contactId.toString(), p.amountMinor]).sort(),
      [
        [rahul.id, 1000_00],
        [priya.id, 1000_00],
      ].sort()
    );

    assert.equal(await balanceOf(me.token, rahul.id), 1000_00);
    assert.equal(await balanceOf(me.token, priya.id), 1000_00);

    const settlement = (await call(`/groups/${group.id}/settlement`, me.token)).body;
    const mine = settlement.balances.find((b: Json) => b.isMe);
    assert.equal(mine.netMinor, 2000_00);
    assert.equal(settlement.balances.find((b: Json) => b.userId === rahul.id).kind, "contact");
    assert.equal(settlement.transfers.length, 2);

    const summary = (await call(`/groups/${group.id}/summary`, me.token)).body;
    assert.equal(summary.totalMinor, 3000_00, "the group cost the whole bill");
  });

  it("keeps a 'just mine' out of everyone else's part", async () => {
    const { me, rahul, group } = await groupWithContacts();
    const souvenir = await spend(me.token, { amountMinor: 1200_00, groupId: group.id });

    const patched = await call(`/transactions/${souvenir.id}`, me.token, {
      method: "PATCH",
      body: { groupShareWith: [me.id.toString()] },
    });
    assert.equal(patched.status, 200);

    const stored = await row(souvenir.id);
    assert.equal(stored.groupSplit, false);
    assert.equal(stored.split, null);
    assert.deepEqual(stored.people, []);
    assert.equal(stored.countedAmountMinor, 1200_00);
    assert.equal(await balanceOf(me.token, rahul.id), 0);
  });

  it("shares it equally among whoever is chosen", async () => {
    const { me, rahul, priya, group } = await groupWithContacts();
    const taxi = await spend(me.token, {
      amountMinor: 900_00,
      groupId: group.id,
      groupShareWith: [me.id.toString(), rahul.id],
    });

    const stored = await row(taxi.id);
    assert.equal(stored.countedAmountMinor, 450_00);
    assert.deepEqual(stored.people.map((p) => [p.contactId.toString(), p.amountMinor]), [[rahul.id, 450_00]]);
    assert.equal(await balanceOf(me.token, priya.id), 0);

    const outsider = await call(`/transactions/${taxi.id}`, me.token, {
      method: "PATCH",
      body: { groupShareWith: [new Types.ObjectId().toString()] },
    });
    assert.equal(outsider.status, 400, "only people in the group");
  });

  it("works the shares out again when someone joins, and gives them back when it leaves the group", async () => {
    const { me, rahul, group } = await groupWithContacts();
    const hotel = await spend(me.token, { amountMinor: 3000_00, groupId: group.id });
    assert.equal(await balanceOf(me.token, rahul.id), 1000_00);

    const friend = await makeUser();
    await call("/groups/join", friend.token, { body: { code: group.joinCode } });
    assert.equal(await balanceOf(me.token, rahul.id), 750_00, "four people now");
    assert.equal((await row(hotel.id)).countedAmountMinor, 750_00, "only my share: my friend's settles in the group, not as my spending");

    await call(`/transactions/${hotel.id}`, me.token, { method: "PATCH", body: { groupId: null } });
    const stored = await row(hotel.id);
    assert.equal(stored.groupId, null);
    assert.equal(stored.split, null);
    assert.equal(stored.countedAmountMinor, 3000_00);
    assert.equal(await balanceOf(me.token, rahul.id), 0);
  });

  it("leaves a group's split alone when an older app sends it back unchanged", async () => {
    const { me, group } = await groupWithContacts();
    const dinner = await spend(me.token, { amountMinor: 3000_00, groupId: group.id });
    const before = await row(dinner.id);

    const resent = await call(`/transactions/${dinner.id}`, me.token, {
      method: "PATCH",
      body: {
        merchant: "Fisherman's Wharf",
        split: { myShareMinor: before.split!.myShareMinor, groupLabel: before.split!.groupLabel },
        people: before.people.map((p) => ({ contactId: p.contactId.toString(), amountMinor: p.amountMinor })),
      },
    });
    assert.equal(resent.status, 200);
    assert.equal((await row(dinner.id)).groupSplit, true);
  });
});

describe("contacts as members", () => {
  it("adds one from my contacts, or by name and number, and takes one out", async () => {
    const me = await makeUser();
    const group = (await call("/groups", me.token, { body: { name: "Flatmates" } })).body;
    const asha = (await call("/contacts", me.token, { body: { name: "Asha" } })).body;

    const added = await call(`/groups/${group.id}/contacts`, me.token, { body: { contactId: asha.id } });
    assert.equal(added.status, 201);
    assert.deepEqual(
      added.body.contacts.map((c: Json) => [c.name, c.kind, c.isMine]),
      [["Asha", "contact", true]]
    );

    const typed = await call(`/groups/${group.id}/contacts`, me.token, { body: { name: "Karan", phone: "098765 11111" } });
    assert.equal(typed.status, 201);
    assert.equal(await models.Contact.countDocuments({ userId: me.id, name: "Karan" }), 1, "made a contact on the way");
    const again = await call(`/groups/${group.id}/contacts`, me.token, { body: { name: "Karan K", phone: "+91 98765 11111" } });
    assert.equal(again.body.contacts.length, 2, "the same number is the same person");

    const removed = await call(`/groups/${group.id}/contacts/${asha.id}`, me.token, { method: "DELETE" });
    assert.equal(removed.status, 204);
    assert.equal((await call(`/groups/${group.id}`, me.token)).body.contacts.length, 1);
  });

  it("names someone else's contact to the rest of the group, but only they can take them out", async () => {
    const { me, group } = await groupWithContacts();
    const friend = await makeUser();
    await call("/groups/join", friend.token, { body: { code: group.joinCode } });

    const seen = (await call(`/groups/${group.id}`, friend.token)).body;
    assert.deepEqual(
      seen.contacts.map((c: Json) => [c.name, c.isMine, c.phone]),
      [
        ["Rahul", false, null],
        ["Priya", false, null],
      ]
    );
    assert.equal(seen.contacts[0].addedByName, "User " + (userCount - 1));
    const refused = await call(`/groups/${group.id}/contacts/${seen.contacts[0].id}`, friend.token, { method: "DELETE" });
    assert.equal(refused.status, 403);
    assert.ok(me);
  });

  it("feeds the People page, where Clear works as it always has", async () => {
    const { me, rahul, group } = await groupWithContacts();
    await spend(me.token, { amountMinor: 3000_00, groupId: group.id });

    const person = (await call(`/contacts/${rahul.id}`, me.token)).body;
    assert.equal(person.balanceMinor, 1000_00);
    assert.equal(person.history[0].amountMinor, 1000_00);
    assert.equal(person.history[0].transaction.group.name, "Goa");

    const cleared = await call(`/contacts/${rahul.id}/clear`, me.token, { body: { amountMinor: 1000_00 } });
    assert.equal(cleared.status, 201);
    assert.equal(await balanceOf(me.token, rahul.id), 0);
  });

  it("leaves every group when the contact is deleted", async () => {
    const { me, rahul, group } = await groupWithContacts();
    const dinner = await spend(me.token, { amountMinor: 3000_00, groupId: group.id });
    await call(`/contacts/${rahul.id}`, me.token, { method: "DELETE" });

    const stored = await row(dinner.id);
    assert.equal(stored.people.length, 1, "Priya alone now");
    assert.equal(stored.people[0].amountMinor, 1500_00);
    assert.equal((await call(`/groups/${group.id}`, me.token)).body.contacts.length, 1);
  });
});

describe("a payment a contact made", () => {
  it("counts my share as my spending, moves no account, and leaves me owing Rahul", async () => {
    const me = await makeUser();
    const cash = await models.Account.create({
      userId: me.id,
      bankName: "Cash",
      accountType: "CASH",
      openingBalanceMinor: 5000_00,
      openingBalanceAt: new Date(Date.now() - 86_400_000),
    });
    const rahul = (await call("/contacts", me.token, { body: { name: "Rahul" } })).body;
    const group = (await call("/groups", me.token, { body: { name: "Dinner club", contactIds: [rahul.id] } })).body;

    const made = await call(`/groups/${group.id}/payments`, me.token, {
      body: { paidBy: { contactId: rahul.id }, amountMinor: 2000_00, merchant: "Dinner", occurredAt: new Date().toISOString() },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.paidByContact.name, "Rahul");

    const stored = await row(made.body.id);
    assert.equal(stored.offLedger, true);
    assert.equal(stored.accountId, null);
    assert.equal(stored.accountUnknown, false, "it isn't a payment of unknown account either");
    assert.equal(stored.paidBy?.contactId?.toString(), rahul.id);
    assert.equal(stored.countedAmountMinor, 1000_00);

    // In the month's spending, my half only.
    assert.equal((await monthlyBudgetStatus(me.id)).spentMinor, 1000_00);
    // Not out of my cash, which "no account" would otherwise mean.
    const balances = await expectedBalances(me.id, [cash]);
    assert.equal(balances.get(cash.id)?.expectedMinor, 5000_00);
    assert.equal(balances.get(cash.id)?.transactionCount, 0);
    const passbook = await call(`/accounts/${cash.id}/passbook`, me.token);
    assert.equal(passbook.status, 200);
    assert.ok(!JSON.stringify(passbook.body).includes(made.body.id), "not in the cash passbook");

    // Rahul is owed my share.
    assert.equal(await balanceOf(me.token, rahul.id), -1000_00);
    const history = (await call(`/contacts/${rahul.id}`, me.token)).body.history;
    assert.equal(history[0].amountMinor, -1000_00);
    // The pooled figures agree with the People page.
    assert.equal((await call("/analytics/owed", me.token)).body.balanceMinor, -1000_00);

    // Who owes whom in the group: I owe Rahul my half.
    const settlement = (await call(`/groups/${group.id}/settlement`, me.token)).body;
    assert.deepEqual(
      settlement.transfers.map((t: Json) => [t.fromKind, t.toName, t.amountMinor]),
      [["user", "Rahul", 1000_00]]
    );

    // Paying him back is settling up: nothing counted, and square.
    const back = await spend(me.token, {
      amountMinor: 1000_00,
      accountId: cash.id.toString(),
      isSettlement: true,
      people: [{ contactId: rahul.id, amountMinor: 1000_00 }],
    });
    assert.equal(back.countedAmountMinor, 0);
    assert.equal(await balanceOf(me.token, rahul.id), 0);
    assert.equal((await monthlyBudgetStatus(me.id)).spentMinor, 1000_00, "counted once, not twice");
    assert.equal((await expectedBalances(me.id, [cash])).get(cash.id)?.expectedMinor, 4000_00);
  });

  it("puts the whole of a 'just mine' on me, and nothing of one I wasn't in", async () => {
    const { me, rahul, priya, group } = await groupWithContacts();
    const mine = await call(`/groups/${group.id}/payments`, me.token, {
      body: { paidBy: { contactId: rahul.id }, amountMinor: 600_00, occurredAt: new Date().toISOString(), shareWith: [me.id.toString()] },
    });
    assert.equal((await row(mine.body.id)).countedAmountMinor, 600_00);

    const theirs = await call(`/groups/${group.id}/payments`, me.token, {
      body: { paidBy: { contactId: rahul.id }, amountMinor: 400_00, occurredAt: new Date().toISOString(), shareWith: [rahul.id, priya.id] },
    });
    const stored = await row(theirs.body.id);
    assert.equal(stored.countedAmountMinor, 0);
    assert.deepEqual(stored.people, []);
    assert.equal(await balanceOf(me.token, rahul.id), -600_00);
  });

  it("is only for one of my own contacts in the group, and stays off my accounts and in its group", async () => {
    const { me, rahul, group } = await groupWithContacts();
    const stranger = (await call("/contacts", me.token, { body: { name: "Not in it" } })).body;
    const refused = await call(`/groups/${group.id}/payments`, me.token, {
      body: { paidBy: { contactId: stranger.id }, amountMinor: 100_00, occurredAt: new Date().toISOString() },
    });
    assert.equal(refused.status, 400);

    const viaTransactions = await spend(me.token, { amountMinor: 900_00, groupId: group.id, paidBy: { contactId: rahul.id } });
    assert.equal(viaTransactions.offLedger, true);
    assert.equal(viaTransactions.countedAmountMinor, 300_00);

    const bank = await models.Account.create({ userId: me.id, bankName: "HDFC", accountType: "BANK" });
    const onAccount = await call(`/transactions/${viaTransactions.id}`, me.token, {
      method: "PATCH",
      body: { accountId: bank.id.toString() },
    });
    assert.equal(onAccount.status, 400);
    const outOfGroup = await call(`/transactions/${viaTransactions.id}`, me.token, { method: "PATCH", body: { groupId: null } });
    assert.equal(outOfGroup.status, 400);

    // A form re-sending everything, with a new amount, keeps it what it is.
    const edited = await call(`/transactions/${viaTransactions.id}`, me.token, {
      method: "PATCH",
      body: { amountMinor: 1200_00, accountId: null, isTransfer: false, split: null, people: [], loanSplits: [] },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const stored = await row(viaTransactions.id);
    assert.equal(stored.offLedger, true);
    assert.equal(stored.countedAmountMinor, 400_00);
    assert.equal(await balanceOf(me.token, rahul.id), -400_00);
  });
});

describe("archiving", () => {
  it("takes a group out of the editor's list until it is brought back", async () => {
    const me = await makeUser();
    const group = (await call("/groups", me.token, { body: { name: "Goa" } })).body;
    const payment = await spend(me.token, { amountMinor: 500_00, groupId: group.id });

    const archived = await call(`/groups/${group.id}/archive`, me.token, { method: "POST" });
    assert.equal(archived.body.isActive, false);
    assert.equal(archived.body.isArchived, true);
    assert.equal((await call("/groups/active", me.token)).body.length, 0);
    const listed = (await call("/groups", me.token)).body;
    assert.equal(listed[0].isArchived, true);
    assert.equal(listed[0].totalMinor, 500_00, "nothing on it changed");
    assert.equal((await row(payment.id)).groupId?.toString(), group.id);

    const back = await call(`/groups/${group.id}/unarchive`, me.token, { method: "POST" });
    assert.equal(back.body.isActive, true);
    assert.equal((await call("/groups/active", me.token)).body.length, 1);

    const viaPatch = await call(`/groups/${group.id}`, me.token, { method: "PATCH", body: { archived: true } });
    assert.equal(viaPatch.body.isArchived, true);
  });

  it("is the owner's to do", async () => {
    const me = await makeUser();
    const friend = await makeUser();
    const group = (await call("/groups", me.token, { body: { name: "Goa" } })).body;
    await call("/groups/join", friend.token, { body: { code: group.joinCode } });
    assert.equal((await call(`/groups/${group.id}/archive`, friend.token, { method: "POST" })).status, 404);
  });
});

describe("the old /trips paths", () => {
  it("answer with the same groups, the way an app from before groups reads them", async () => {
    const me = await makeUser();
    const group = (await call("/groups", me.token, { body: { name: "Flatmates" } })).body;

    const trips = (await call("/trips", me.token)).body;
    assert.equal(trips.length, 1);
    assert.equal(trips[0].id, group.id);
    assert.ok(trips[0].startedAt, "every trip has a start");
    assert.equal(trips[0].isActive, false, "not running: it has no dates");
    assert.equal((await call(`/trips/${group.id}`, me.token)).status, 200);
    assert.equal((await call("/trips/active", me.token)).body, null);

    // "Start a trip" makes a dated one, running from now.
    const started = await call("/trips", me.token, { body: { name: "Goa" } });
    assert.equal(started.status, 201);
    assert.equal(started.body.isActive, true);
    assert.equal((await call("/trips/active", me.token)).body.id, started.body.id);
    assert.equal((await call("/trips", me.token, { body: { name: "Again" } })).status, 409);

    // Filing a payment under the old name.
    const payment = await spend(me.token, { amountMinor: 100_00 });
    const patched = await call(`/transactions/${payment.id}`, me.token, {
      method: "PATCH",
      body: { tripId: started.body.id, tripShareWith: [me.id.toString()] },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.tripId, started.body.id);
    assert.equal(patched.body.groupId, started.body.id);
    assert.equal(patched.body.trip.name, "Goa");
    assert.deepEqual(patched.body.tripShareWith, [me.id.toString()]);

    const summary = (await call(`/trips/${started.body.id}/summary`, me.token)).body;
    assert.equal(summary.trip.name, "Goa");
    assert.equal(summary.totalMinor, 100_00);
  });
});
