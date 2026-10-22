import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istDayEnd, istDayKey, istDayStart } from "../../time";
import { checkSuiteSignature, suiteSignature } from "./suite.signature";

/**
 * Trippin's side of the suite, over real HTTP: the signature that stands in
 * for a user, and each event doing to a SpendLog trip what the contract
 * says it does.
 */
const SECRET = "trippin-suite-test-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let env: typeof import("../../env").env;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_trippin_test"));

  const [{ app }, auth, envModule, modelsModule] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../env"),
    import("../../models"),
  ]);
  signToken = auth.signSessionToken;
  env = envModule.env;
  env.trippinSuiteSecret = SECRET;
  env.frontendUrl = "https://spend-log.example:50002";
  models = modelsModule;
  // The unique and TTL indexes are part of what is under test.
  await Promise.all([models.Trip.init(), models.SuiteEvent.init(), models.User.init()]);

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
  env.trippinSuiteSecret = SECRET;
  await Promise.all([
    models.Trip.deleteMany({}),
    models.User.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.SuiteEvent.deleteMany({}),
    models.Account.deleteMany({}),
  ]);
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** An IST calendar day relative to today, as Trippin sends it. */
const day = (offset: number) => istDayKey(new Date(Date.now() + offset * DAY_MS));
/** Midday IST on that day. */
const middayOf = (offset: number) => new Date(istDayStart(day(offset)).getTime() + 12 * 60 * 60 * 1000);

const now = () => String(Math.floor(Date.now() / 1000));

async function signed(path: string, init: { method?: string; body?: unknown; timestamp?: string } = {}) {
  const raw = init.body === undefined ? "" : JSON.stringify(init.body);
  const timestamp = init.timestamp ?? now();
  return fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: {
      "Content-Type": "application/json",
      "x-suite-timestamp": timestamp,
      "x-suite-signature": suiteSignature(SECRET, timestamp, raw),
    },
    body: raw || undefined,
  });
}

let eventCount = 0;
let userCount = 0;

interface Person {
  sub: string;
  email: string;
  name: string;
  role?: string;
}

function person(name: string): Person {
  userCount += 1;
  return { sub: `sub-${name.toLowerCase()}-${userCount}`, email: `${name.toLowerCase()}${userCount}@example.com`, name };
}

async function existingUser(p: Person) {
  const user = await models.User.create({ email: p.email, name: p.name, oidcSub: p.sub });
  return { id: user._id, token: signToken({ id: user._id.toString(), email: p.email }) };
}

function tripPayload(overrides: Partial<{ id: string; title: string; startDate: string; endDate: string; owner: Person; members: Person[] }> & { owner: Person }) {
  return {
    id: overrides.id ?? "trp_goa",
    title: overrides.title ?? "Goa",
    startDate: overrides.startDate ?? day(-20),
    endDate: overrides.endDate ?? day(-15),
    destination: "Goa, India",
    url: "https://trippin.example/trips/trp_goa",
    owner: overrides.owner,
    members: (overrides.members ?? [overrides.owner]).map((m) => ({ ...m, role: m.role ?? "member" })),
  };
}

async function sendEvent(type: string, trip: unknown, id = `evt_${(eventCount += 1)}`) {
  const response = await signed("/integrations/trippin/events", {
    body: { id, type, occurredAt: new Date().toISOString(), trip },
  });
  return { status: response.status, body: (await response.json()) as Record<string, any>, id };
}

async function spend(userId: Types.ObjectId, occurredAt: Date, amountMinor = 10000, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    amountMinor,
    currency: "INR",
    type: "DEBIT",
    source: "MANUAL",
    occurredAt,
    ...extra,
  });
}

async function tripOf(remoteId: string) {
  const trip = await models.Trip.findById(remoteId);
  assert.ok(trip, "the linked trip exists");
  return trip;
}

describe("the suite signature", () => {
  it("accepts its own signature and refuses anything else", () => {
    const ts = "1700000000";
    const body = Buffer.from('{"a":1}');
    const sig = suiteSignature(SECRET, ts, body);
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
    assert.equal(checkSuiteSignature(SECRET, ts, sig, body, 1700000000), null);
    assert.ok(checkSuiteSignature("another-secret", ts, sig, body, 1700000000), "wrong secret");
    assert.ok(checkSuiteSignature(SECRET, ts, sig, Buffer.from('{"a":2}'), 1700000000), "tampered body");
    assert.ok(checkSuiteSignature(SECRET, ts, sig, body, 1700000000 + 301), "stale");
    assert.ok(checkSuiteSignature(SECRET, ts, sig, body, 1700000000 - 301), "from the future");
    assert.equal(checkSuiteSignature(SECRET, ts, sig, body, 1700000000 + 299), null, "inside the window");
    assert.ok(checkSuiteSignature(SECRET, ts, sig.slice(0, -1), body, 1700000000), "truncated");
    assert.ok(checkSuiteSignature(SECRET, ts, sig.replace("sha256=", ""), body, 1700000000), "no prefix");
  });

  it("lets a validly signed GET through", async () => {
    const response = await signed("/integrations/trippin/users/nobody");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { exists: false });
  });

  it("refuses a bad signature", async () => {
    const response = await fetch(`${baseUrl}/integrations/trippin/users/nobody`, {
      headers: { "x-suite-timestamp": now(), "x-suite-signature": `sha256=${"0".repeat(64)}` },
    });
    assert.equal(response.status, 401);
  });

  it("refuses a stale timestamp, even correctly signed", async () => {
    const response = await signed("/integrations/trippin/users/nobody", {
      timestamp: String(Math.floor(Date.now() / 1000) - 6 * 60),
    });
    assert.equal(response.status, 401);
  });

  it("refuses a body changed after signing", async () => {
    const owner = person("Asha");
    const timestamp = now();
    const original = JSON.stringify({ id: "evt_t", type: "trip.linked", trip: tripPayload({ owner }) });
    const tampered = original.replace('"Goa"', '"Gao"');
    const response = await fetch(`${baseUrl}/integrations/trippin/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-suite-timestamp": timestamp,
        "x-suite-signature": suiteSignature(SECRET, timestamp, original),
      },
      body: tampered,
    });
    assert.equal(response.status, 401);
    assert.equal(await models.Trip.countDocuments(), 0);
  });

  it("does not need, or accept in place of a signature, a user's session", async () => {
    const owner = await existingUser(person("Asha"));
    for (const [method, path] of [
      ["POST", "/integrations/trippin/events"],
      ["GET", "/integrations/trippin/trips/trp_goa/summary?sub=x"],
      ["GET", "/integrations/trippin/users/x"],
    ] as const) {
      const unsigned = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
        body: method === "POST" ? JSON.stringify({ id: "e", type: "trip.linked", trip: {} }) : undefined,
      });
      assert.equal(unsigned.status, 401, `${method} ${path} without a signature`);
    }
    assert.equal(await models.Trip.countDocuments(), 0);
    assert.equal(await models.SuiteEvent.countDocuments(), 0);
  });

  it("is switched off, not open, when no secret is configured", async () => {
    env.trippinSuiteSecret = "";
    const response = await signed("/integrations/trippin/users/nobody");
    assert.equal(response.status, 503);
  });
});

describe("trip.linked", () => {
  it("creates the trip for an existing owner, provisions a new member, and claims the window", async () => {
    const asha = person("Asha");
    const ravi = person("Ravi");
    const owner = await existingUser(asha);

    const inside = await spend(owner.id, middayOf(-18));
    const before = await spend(owner.id, middayOf(-25));
    const editedInside = await spend(owner.id, middayOf(-17), 5000, { editedAt: new Date() });

    const { status, body } = await sendEvent("trip.linked", tripPayload({ owner: asha, members: [asha, ravi] }));
    assert.equal(status, 200);
    assert.ok(body.remoteId);
    assert.equal(body.url, `https://spend-log.example:50002/groups?group=${body.remoteId}`);

    const trip = await tripOf(body.remoteId);
    assert.equal(trip.name, "Goa");
    assert.ok(trip.ownerId.equals(owner.id));
    assert.equal(trip.startedAt.getTime(), istDayStart(day(-20)).getTime());
    assert.equal(trip.endedAt?.getTime(), istDayEnd(day(-15)).getTime());
    assert.equal(trip.source?.app, "trippin");
    assert.equal(trip.source?.externalId, "trp_goa");
    assert.equal(trip.source?.url, "https://trippin.example/trips/trp_goa");
    assert.equal(trip.source?.linked, true);
    assert.ok(trip.source?.linkedAt);

    // Ravi had never used SpendLog: an ordinary owner account now, found
    // by his subject when he does sign in.
    const raviUser = await models.User.findOne({ oidcSub: ravi.sub });
    assert.ok(raviUser);
    assert.equal(raviUser.email, ravi.email);
    assert.equal(raviUser.role, "OWNER");
    assert.equal(trip.members.length, 2);
    assert.ok(trip.members.some((m) => m.userId.equals(raviUser._id)));
    // Both planned it, so both share it from its first day.
    for (const member of trip.members) assert.ok(member.joinedAt <= trip.startedAt);

    assert.equal((await models.Transaction.findById(inside._id))?.tripId?.toString(), body.remoteId);
    assert.equal((await models.Transaction.findById(before._id))?.tripId, null);
    assert.equal((await models.Transaction.findById(editedInside._id))?.tripId, null, "hand-edited rows stay put");
  });

  it("never makes a kid a member, nor claims an account by its email alone", async () => {
    const asha = person("Asha");
    await existingUser(asha);
    const kidLike = person("Kid");
    const legacy = person("Legacy");
    await models.User.create({ email: kidLike.email, name: "Kid", role: "KID" });
    await models.User.create({ email: legacy.email, name: "Legacy" });

    const { status, body } = await sendEvent(
      "trip.linked",
      tripPayload({ owner: asha, members: [asha, kidLike, legacy] })
    );
    assert.equal(status, 200);
    const trip = await tripOf(body.remoteId);
    assert.equal(trip.members.length, 1, "only the owner");
    assert.deepEqual(
      body.skippedMembers.map((s: { reason: string }) => s.reason).sort(),
      ["email_in_use", "email_in_use"]
    );
    assert.equal(await models.User.countDocuments({ oidcSub: { $in: [kidLike.sub, legacy.sub] } }), 0);
  });

  it("provisions the owner too when they have never used SpendLog", async () => {
    const asha = person("Asha");
    const { status, body } = await sendEvent("trip.linked", tripPayload({ owner: asha }));
    assert.equal(status, 200);
    const owner = await models.User.findOne({ oidcSub: asha.sub });
    assert.ok(owner);
    assert.ok((await tripOf(body.remoteId)).ownerId.equals(owner._id));
    assert.equal(await models.Account.countDocuments({ userId: owner._id, accountType: "CASH" }), 1);
  });

  it("re-links the same trip after it was switched off, keeping what is on it", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const payment = await spend(owner.id, middayOf(-18));

    const first = await sendEvent("trip.linked", tripPayload({ owner: asha }));
    await sendEvent("trip.unlinked", { id: "trp_goa" });
    const again = await sendEvent("trip.linked", tripPayload({ owner: asha, title: "Goa again" }));

    assert.equal(again.status, 200);
    assert.equal(again.body.remoteId, first.body.remoteId);
    assert.equal(await models.Trip.countDocuments(), 1);
    const trip = await tripOf(first.body.remoteId);
    assert.equal(trip.name, "Goa again");
    assert.equal(trip.source?.linked, true);
    assert.equal(trip.source?.unlinkedAt, null);
    assert.equal((await models.Transaction.findById(payment._id))?.tripId?.toString(), first.body.remoteId);
  });

  it("refuses dates that are not dates", async () => {
    const asha = person("Asha");
    const { status } = await sendEvent("trip.linked", tripPayload({ owner: asha, startDate: day(-1), endDate: day(-3) }));
    assert.equal(status, 400);
    const bad = await sendEvent("trip.linked", tripPayload({ owner: asha, startDate: "2026-02-30" }));
    assert.equal(bad.status, 400);
  });
});

describe("idempotency", () => {
  it("answers a repeated event with the first answer and does nothing twice", async () => {
    const asha = person("Asha");
    await existingUser(asha);

    const first = await sendEvent("trip.linked", tripPayload({ owner: asha }), "evt_same");
    const repeat = await sendEvent("trip.linked", tripPayload({ owner: asha, title: "Changed" }), "evt_same");

    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.body, first.body);
    assert.equal(await models.Trip.countDocuments(), 1);
    assert.equal((await tripOf(first.body.remoteId)).name, "Goa");
    assert.equal(await models.SuiteEvent.countDocuments({ eventId: "evt_same" }), 1);
  });

  it("does not replay an old event over a newer change", async () => {
    const asha = person("Asha");
    await existingUser(asha);
    const linked = await sendEvent("trip.linked", tripPayload({ owner: asha }), "evt_link");
    await sendEvent("trip.unlinked", { id: "trp_goa" }, "evt_unlink");
    await sendEvent("trip.linked", tripPayload({ owner: asha }), "evt_link");
    assert.equal((await tripOf(linked.body.remoteId)).source?.linked, false);
  });
});

describe("trip.updated", () => {
  it("renames and moves the dates, re-claiming the new window and keeping hand-added payments", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const { body } = await sendEvent("trip.linked", tripPayload({ owner: asha }));

    const oldWindow = await spend(owner.id, middayOf(-19));
    const newWindow = await spend(owner.id, middayOf(-12));
    await sendEvent("trip.updated", tripPayload({ owner: asha, startDate: day(-20), endDate: day(-15) }));
    assert.equal((await models.Transaction.findById(oldWindow._id))?.tripId?.toString(), body.remoteId);

    // Put on the trip by hand, whatever its date.
    const handAdded = await spend(owner.id, middayOf(-60), 7000, {
      tripId: new Types.ObjectId(body.remoteId),
      editedAt: new Date(),
    });

    const { status } = await sendEvent(
      "trip.updated",
      tripPayload({ owner: asha, title: "Goa, longer", startDate: day(-14), endDate: day(-10) })
    );
    assert.equal(status, 200);

    const trip = await tripOf(body.remoteId);
    assert.equal(trip.name, "Goa, longer");
    assert.equal(trip.startedAt.getTime(), istDayStart(day(-14)).getTime());
    assert.equal(trip.endedAt?.getTime(), istDayEnd(day(-10)).getTime());
    assert.equal((await models.Transaction.findById(newWindow._id))?.tripId?.toString(), body.remoteId);
    assert.equal((await models.Transaction.findById(oldWindow._id))?.tripId, null, "no longer in the window");
    assert.equal((await models.Transaction.findById(handAdded._id))?.tripId?.toString(), body.remoteId);
  });

  it("leaves an unlinked trip alone", async () => {
    const asha = person("Asha");
    await existingUser(asha);
    const { body } = await sendEvent("trip.linked", tripPayload({ owner: asha }));
    await sendEvent("trip.unlinked", { id: "trp_goa" });
    const { status } = await sendEvent("trip.updated", tripPayload({ owner: asha, title: "Ignored" }));
    assert.equal(status, 200);
    assert.equal((await tripOf(body.remoteId)).name, "Goa");
  });
});

describe("trip.members_changed", () => {
  it("adds and removes Trippin's members, without reaching back before they joined", async () => {
    const asha = person("Asha");
    const ravi = person("Ravi");
    const meera = person("Meera");
    const owner = await existingUser(asha);
    const raviUser = await existingUser(ravi);
    const meeraUser = await existingUser(meera);

    const { body } = await sendEvent("trip.linked", tripPayload({ owner: asha, members: [asha, ravi] }));

    // Joined here with the code; Trippin never knew about them.
    const viaCode = await existingUser(person("Code"));
    await models.Trip.updateOne(
      { _id: body.remoteId },
      { $push: { members: { userId: viaCode.id, joinedAt: new Date() } } }
    );

    // Meera spent during the (past) trip before she was added to it.
    const meeraEarlier = await spend(meeraUser.id, middayOf(-18));

    const { status } = await sendEvent(
      "trip.members_changed",
      tripPayload({ owner: asha, members: [asha, meera] })
    );
    assert.equal(status, 200);

    const trip = await tripOf(body.remoteId);
    const ids = trip.members.map((m) => m.userId.toString()).sort();
    assert.deepEqual(ids, [owner.id, meeraUser.id, viaCode.id].map(String).sort());
    assert.ok(!trip.members.some((m) => m.userId.equals(raviUser.id)), "Ravi was taken off in Trippin");

    const meeraMember = trip.members.find((m) => m.userId.equals(meeraUser.id));
    assert.ok(meeraMember && meeraMember.joinedAt > trip.startedAt, "joins now, not from the start");
    assert.equal((await models.Transaction.findById(meeraEarlier._id))?.tripId, null);
  });
});

describe("trip.unlinked", () => {
  it("keeps the trip and everything on it, as an ordinary trip", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const payment = await spend(owner.id, middayOf(-18));
    const { body } = await sendEvent("trip.linked", tripPayload({ owner: asha }));

    const { status, body: answer } = await sendEvent("trip.unlinked", { id: "trp_goa" });
    assert.equal(status, 200);
    assert.deepEqual(answer, {});

    const trip = await tripOf(body.remoteId);
    assert.equal(trip.source?.linked, false);
    assert.ok(trip.source?.unlinkedAt);
    assert.equal(trip.source?.externalId, "trp_goa");
    assert.equal((await models.Transaction.findById(payment._id))?.tripId?.toString(), body.remoteId);

    const summary = await signed(`/integrations/trippin/trips/trp_goa/summary?sub=${asha.sub}`);
    assert.equal(summary.status, 404);
    assert.deepEqual(await summary.json(), { linked: false });

    // Still the owner's to use as any other trip.
    const own = await fetch(`${baseUrl}/trips/${body.remoteId}`, { headers: { Authorization: `Bearer ${owner.token}` } });
    assert.equal(own.status, 200);
  });
});

describe("summary for Trippin", () => {
  it("matches SpendLog's own trip summary and settlement", async () => {
    const asha = person("Asha");
    const ravi = person("Ravi");
    const owner = await existingUser(asha);
    const friend = await existingUser(ravi);

    await spend(owner.id, middayOf(-18), 90000);
    await spend(friend.id, middayOf(-17), 30000);
    await spend(owner.id, middayOf(-16), 1001);
    const { body } = await sendEvent("trip.linked", tripPayload({ owner: asha, members: [asha, ravi] }));

    const response = await signed(`/integrations/trippin/trips/trp_goa/summary?sub=${ravi.sub}`);
    assert.equal(response.status, 200);
    const summary = (await response.json()) as Record<string, any>;

    const headers = { Authorization: `Bearer ${owner.token}` };
    const own = (await (await fetch(`${baseUrl}/trips/${body.remoteId}/summary`, { headers })).json()) as Record<string, any>;
    const settlement = (await (await fetch(`${baseUrl}/trips/${body.remoteId}/settlement`, { headers })).json()) as Record<string, any>;

    assert.equal(summary.linked, true);
    assert.equal(summary.url, body.url);
    assert.equal(summary.currency, "INR");
    assert.equal(summary.totalSpentMinor, own.totalMinor);
    assert.equal(summary.totalSpentMinor, 121001);
    assert.equal(summary.transactionCount, own.transactionCount);
    assert.equal(summary.transactionCount, 3);
    assert.deepEqual(
      summary.settlement,
      settlement.transfers.map((t: Record<string, any>) => ({ fromName: t.fromName, toName: t.toName, amountMinor: t.amountMinor }))
    );

    const raviBalance = settlement.balances.find((b: Record<string, any>) => b.userId === friend.id.toString());
    assert.equal(summary.myShareMinor, raviBalance.shareMinor);
    assert.equal(summary.myShareMinor, 60500);
    // Ravi paid 300 of his 605 share: he owes Asha the rest.
    assert.equal(summary.iOweMinor, 30500);
    assert.equal(summary.owedToMeMinor, 0);
    assert.ok(summary.updatedAt);

    const ashaView = (await (await signed(`/integrations/trippin/trips/trp_goa/summary?sub=${asha.sub}`)).json()) as Record<string, any>;
    assert.equal(ashaView.owedToMeMinor, 30500);
    assert.equal(ashaView.iOweMinor, 0);
  });

  it("says not linked for a trip it has never heard of", async () => {
    const response = await signed("/integrations/trippin/trips/trp_unknown/summary?sub=x");
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { linked: false });
  });
});

describe("users/:sub", () => {
  it("says whether somebody has SpendLog", async () => {
    const asha = person("Asha");
    await existingUser(asha);
    const yes = await signed(`/integrations/trippin/users/${encodeURIComponent(asha.sub)}`);
    assert.deepEqual(await yes.json(), { exists: true });
    const no = await signed("/integrations/trippin/users/sub-nobody");
    assert.deepEqual(await no.json(), { exists: false });
  });
});

describe("the running-trip overlap rule", () => {
  async function runningSpendLogTrip(ownerId: Types.ObjectId) {
    return models.Trip.create({
      ownerId,
      name: "Weekend",
      startedAt: new Date(Date.now() - 2 * DAY_MS),
      endedAt: null,
      members: [{ userId: ownerId, joinedAt: new Date(Date.now() - 2 * DAY_MS) }],
      joinCode: "WKND23",
    });
  }

  it("refuses to link a trip under way while another is running, until that one ends", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const weekend = await runningSpendLogTrip(owner.id);

    const refused = await sendEvent(
      "trip.linked",
      tripPayload({ owner: asha, startDate: day(-1), endDate: day(3) }),
      "evt_overlap"
    );
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "running_trip_overlap");
    assert.match(refused.body.error, /Weekend/);
    assert.equal(await models.Trip.countDocuments({ "source.externalId": "trp_goa" }), 0);

    // Not remembered: the same event goes through once the other has ended.
    weekend.endedAt = new Date();
    await weekend.save();
    const retried = await sendEvent(
      "trip.linked",
      tripPayload({ owner: asha, startDate: day(-1), endDate: day(3) }),
      "evt_overlap"
    );
    assert.equal(retried.status, 200);

    // Running by its dates: it is the trip mode now, and starting another
    // here is refused the way a second running trip always is.
    const active = (await (await fetch(`${baseUrl}/trips/active`, { headers: { Authorization: `Bearer ${owner.token}` } })).json()) as Record<string, any>;
    assert.equal(active.id, retried.body.remoteId);
    assert.equal(active.isActive, true);
    const second = await fetch(`${baseUrl}/trips`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: "Another" }),
    });
    assert.equal(second.status, 409);
  });

  it("links a trip in the future or the past regardless", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    await runningSpendLogTrip(owner.id);

    const future = await sendEvent("trip.linked", tripPayload({ id: "trp_later", owner: asha, startDate: day(10), endDate: day(14) }));
    assert.equal(future.status, 200);
    const past = await sendEvent("trip.linked", tripPayload({ id: "trp_before", owner: asha, startDate: day(-40), endDate: day(-35) }));
    assert.equal(past.status, 200);

    const later = await tripOf(future.body.remoteId);
    assert.equal(later.endedAt?.getTime(), istDayEnd(day(14)).getTime(), "scheduled, with its end date");
  });

  it("refuses moving a linked trip's dates onto a running one", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const { body } = await sendEvent("trip.linked", tripPayload({ owner: asha }));
    await runningSpendLogTrip(owner.id);

    const moved = await sendEvent("trip.updated", tripPayload({ owner: asha, startDate: day(-1), endDate: day(2) }));
    assert.equal(moved.status, 409);
    assert.equal(moved.body.code, "running_trip_overlap");
    assert.equal((await tripOf(body.remoteId)).startedAt.getTime(), istDayStart(day(-20)).getTime(), "unchanged");
  });
});

describe("linking an existing group", () => {
  let codeCount = 0;
  async function group(ownerId: Types.ObjectId, name: string, from: number | null, to: number | null, extra: Record<string, unknown> = {}) {
    codeCount += 1;
    const startedAt = from === null ? null : istDayStart(day(from));
    return models.Trip.create({
      ownerId,
      name,
      startedAt,
      endedAt: to === null ? null : istDayEnd(day(to)),
      members: [{ userId: ownerId, joinedAt: startedAt ?? new Date() }],
      joinCode: `JOIN${codeCount}X`,
      ...extra,
    });
  }

  const candidatesFor = async (sub: string, query: Record<string, string> = {}) => {
    const params = new URLSearchParams({ sub, tripId: "trp_goa", title: "Goa", start: day(-20), end: day(-15), ...query });
    const response = await signed(`/integrations/trippin/candidates?${params}`);
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  it("lists the owner's groups, best match first, with what linking each would do", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const other = await existingUser(person("Ravi"));

    // Overlaps the trip's dates; one payment of its own falls outside them, one unfiled payment inside.
    const overlapping = await group(owner.id, "Weekend away", -22, -16);
    await spend(owner.id, middayOf(-22), 5000, { groupId: overlapping._id });
    await spend(owner.id, middayOf(-18), 7000);
    // Same name, other dates.
    const named = await group(owner.id, "Goa 2025", -400, -395);
    // Neither.
    await group(owner.id, "Flatmates", null, null);
    // Someone else's, and one of hers linked to another Trippin trip: never offered.
    await group(other.id, "Goa", -20, -15);
    await group(owner.id, "Goa too", -20, -15, {
      source: { app: "trippin", externalId: "trp_other", linked: true, linkedAt: new Date(), memberSubs: [] },
    });

    const { status, body } = await candidatesFor(asha.sub);
    assert.equal(status, 200);
    const names = body.candidates.map((c: Record<string, any>) => c.name);
    assert.deepEqual(names, ["Weekend away", "Goa 2025", "Flatmates"]);

    const first = body.candidates[0];
    assert.equal(first.id, overlapping.id);
    assert.equal(first.startDate, day(-22));
    assert.equal(first.endDate, day(-16));
    assert.equal(first.archived, false);
    assert.equal(first.linkedHere, false);
    assert.deepEqual(first.counts, { transactions: 1, members: 1 });
    assert.deepEqual(first.impact, { added: 1, leaving: 1 });
    assert.equal(body.candidates[1].id, named.id);
  });

  it("answers an empty list for someone without SpendLog, and refuses a bad query", async () => {
    assert.deepEqual((await candidatesFor("sub-nobody")).body, { candidates: [] });
    const bad = await signed(`/integrations/trippin/candidates?sub=x&tripId=t&start=tomorrow&end=${day(0)}`);
    assert.equal(bad.status, 400);
  });

  it("links the chosen group instead of making one, with the trip's name and dates", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const existing = await group(owner.id, "Weekend away", -22, -16);
    const outside = await spend(owner.id, middayOf(-22), 5000, { groupId: existing._id });
    const kept = await spend(owner.id, middayOf(-22), 6000, { groupId: existing._id, editedAt: new Date() });
    const inside = await spend(owner.id, middayOf(-18), 7000);

    const response = await signed("/integrations/trippin/events", {
      body: { id: "evt_attach", type: "trip.linked", trip: tripPayload({ owner: asha }), attachTo: existing.id },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.remoteId, existing.id, "the same group, not a new one");
    assert.equal(await models.Trip.countDocuments({ ownerId: owner.id }), 1);

    const linked = await tripOf(existing.id);
    assert.equal(linked.name, "Goa");
    assert.equal(linked.source?.externalId, "trp_goa");
    assert.equal(linked.source?.linked, true);
    assert.equal(linked.startedAt.getTime(), istDayStart(day(-20)).getTime());
    assert.equal((await models.Transaction.findById(outside._id))?.groupId, null, "an automatic payment outside the dates leaves");
    assert.equal((await models.Transaction.findById(kept._id))?.groupId?.toString(), existing.id, "one put there by hand stays");
    assert.equal((await models.Transaction.findById(inside._id))?.groupId?.toString(), existing.id, "an unfiled one inside comes in");

    // A retried delivery is answered the same, and does nothing twice.
    const again = await signed("/integrations/trippin/events", {
      body: { id: "evt_attach", type: "trip.linked", trip: tripPayload({ owner: asha }), attachTo: existing.id },
    });
    assert.deepEqual(await again.json(), body);
  });

  it("takes the link over from the group that had it before", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const first = await sendEvent("trip.linked", tripPayload({ owner: asha }));
    await sendEvent("trip.unlinked", { id: "trp_goa" });
    const chosen = await group(owner.id, "Goa (old)", -20, -15);

    const { status, body } = await (async () => {
      const response = await signed("/integrations/trippin/events", {
        body: { id: "evt_move", type: "trip.linked", trip: tripPayload({ owner: asha }), attachTo: chosen.id },
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    })();
    assert.equal(status, 200);
    assert.equal(body.remoteId, chosen.id);
    assert.equal((await tripOf(first.body.remoteId)).source, null, "the old group is an ordinary group again");

    const summary = await signed(`/integrations/trippin/trips/trp_goa/summary?sub=${asha.sub}`);
    assert.equal(((await summary.json()) as Record<string, any>).url.endsWith(chosen.id), true);
  });

  it("refuses someone else's group and one linked to another trip, changing nothing", async () => {
    const asha = person("Asha");
    const owner = await existingUser(asha);
    const ravi = await existingUser(person("Ravi"));
    const notHers = await group(ravi.id, "Goa", -20, -15);
    const elsewhere = await group(owner.id, "Goa too", -20, -15, {
      source: { app: "trippin", externalId: "trp_other", linked: true, linkedAt: new Date(), memberSubs: [] },
    });

    for (const [attachTo, code] of [
      [notHers.id, "attach_not_found"],
      [new Types.ObjectId().toString(), "attach_not_found"],
      ["not-an-id", "attach_not_found"],
      [elsewhere.id, "attach_linked_elsewhere"],
    ] as const) {
      const response = await signed("/integrations/trippin/events", {
        body: { id: `evt_refuse_${code}_${attachTo}`, type: "trip.linked", trip: tripPayload({ owner: asha }), attachTo },
      });
      assert.equal(response.status, 409, attachTo);
      assert.equal(((await response.json()) as Record<string, any>).code, code);
    }
    assert.equal((await tripOf(notHers.id)).source, null);
    assert.equal((await tripOf(elsewhere.id)).source?.externalId, "trp_other");
    assert.equal(await models.Trip.countDocuments({ "source.externalId": "trp_goa" }), 0, "nothing linked");
    assert.equal(await models.SuiteEvent.countDocuments({}), 0, "a refusal isn't remembered");
  });
});

describe("telling people they're in", () => {
  it("whoever Trippin puts in the group hears about it; the owner doesn't", async () => {
    const notify = await import("../groups/groups.notify");
    const sent: { userId: string; title: string; data: Record<string, string> }[] = [];
    notify.setGroupNotifierForTests(async (userId, note) => {
      sent.push({ userId: userId.toString(), title: note.title, data: note.data });
    });
    try {
      const asha = person("Asha");
      const ravi = person("Ravi");
      const meera = person("Meera");
      await existingUser(asha);
      const friend = await existingUser(ravi);
      const { body } = await sendEvent("trip.linked", tripPayload({ owner: asha, members: [asha, ravi] }));
      assert.deepEqual(sent, [
        { userId: friend.id.toString(), title: "You're in Goa", data: { type: "GROUP", groupId: body.remoteId, link: `spendlog://app/groups/${body.remoteId}` } },
      ]);

      // Someone added later hears too; nobody already in it does.
      sent.length = 0;
      const third = await existingUser(meera);
      await sendEvent("trip.members_changed", tripPayload({ owner: asha, members: [asha, ravi, meera] }));
      assert.deepEqual(sent.map((s) => s.userId), [third.id.toString()]);
    } finally {
      notify.setGroupNotifierForTests(null);
    }
  });
});
