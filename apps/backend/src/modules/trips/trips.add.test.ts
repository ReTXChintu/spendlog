import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { isLikelyTravel } from "./trips.travel";

// env.ts demands these at import time, and the app is imported dynamically
// below so they are in place first. The database url is never dialled.
process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "trips-add-test-secret";

/**
 * Adding payments to a trip by hand: the ones made before it started -
 * tickets, a hotel's advance - that its window will never claim on its own.
 * Over real HTTP, since who may add what to a shared trip is the point.
 */
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_trips_add_test"));

  const [{ app }, auth, loaded] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    models.Trip.deleteMany({}),
    models.User.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.Category.deleteMany({}),
    models.Account.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser() {
  const email = `add${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, name: `User ${userCount}` });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function call(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

/** Goa runs from 1 Oct; anything before that is outside its window. */
const START = new Date("2026-10-01T00:00:00Z");
const daysBefore = (days: number) => new Date(START.getTime() - days * 24 * 60 * 60 * 1000);

async function makeTrip(ownerId: Types.ObjectId, overrides: { endedAt?: Date | null } = {}) {
  return models.Trip.create({
    ownerId,
    name: "Goa",
    startedAt: START,
    endedAt: overrides.endedAt ?? null,
    members: [{ userId: ownerId, joinedAt: START }],
    joinCode: `G${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
  });
}

function spend(
  userId: Types.ObjectId,
  amountMinor: number,
  occurredAt: Date,
  extra: Record<string, unknown> = {}
) {
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

async function join(trip: { joinCode: string }, token: string) {
  await call("/trips/join", token, { method: "POST", body: JSON.stringify({ code: trip.joinCode }) });
}

describe("adding a payment from before the trip, one at a time", () => {
  it("takes a ticket booked weeks earlier, and keeps it through a re-scan", async () => {
    const owner = await makeUser();
    const trip = await makeTrip(owner.id);
    const ticket = await spend(owner.id, 840000, daysBefore(20), { merchant: "IRCTC" });

    const patched = await call(`/transactions/${ticket.id}`, owner.token, {
      method: "PATCH",
      body: JSON.stringify({ tripId: trip.id }),
    });
    assert.equal(patched.status, 200);

    const saved = await models.Transaction.findById(ticket._id).orFail();
    assert.equal(saved.tripId?.toString(), trip.id);
    assert.ok(saved.editedAt, "marked as edited, so automatic passes leave it be");

    // Neither a re-scan nor moving the trip's start takes it back off.
    await call(`/trips/${trip.id}/rescan`, owner.token, { method: "POST" });
    await call(`/trips/${trip.id}`, owner.token, {
      method: "PATCH",
      body: JSON.stringify({ startedAt: new Date("2026-10-02T00:00:00Z").toISOString() }),
    });
    assert.equal((await models.Transaction.findById(ticket._id).orFail()).tripId?.toString(), trip.id);

    const summary = await json<{ totalMinor: number; transactionCount: number }>(
      await call(`/trips/${trip.id}/summary`, owner.token)
    );
    assert.equal(summary.totalMinor, 840000);
    assert.equal(summary.transactionCount, 1);
  });

  it("works on a trip that has already ended", async () => {
    const owner = await makeUser();
    const trip = await makeTrip(owner.id, { endedAt: new Date("2026-10-05T00:00:00Z") });
    const hotel = await spend(owner.id, 500000, daysBefore(3));

    const patched = await call(`/transactions/${hotel.id}`, owner.token, {
      method: "PATCH",
      body: JSON.stringify({ tripId: trip.id }),
    });
    assert.equal(patched.status, 200);
    assert.equal((await models.Transaction.findById(hotel._id).orFail()).tripId?.toString(), trip.id);
  });

  it("refuses a trip the user is not on", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    const theirs = await spend(stranger.id, 300000, daysBefore(5));

    const patched = await call(`/transactions/${theirs.id}`, stranger.token, {
      method: "PATCH",
      body: JSON.stringify({ tripId: trip.id }),
    });
    assert.equal(patched.status, 400);
    assert.equal((await models.Transaction.findById(theirs._id).orFail()).tripId, null);
  });

  it("refuses a trip that has been deleted", async () => {
    const owner = await makeUser();
    const trip = await makeTrip(owner.id);
    const ticket = await spend(owner.id, 300000, daysBefore(5));
    await call(`/trips/${trip.id}`, owner.token, { method: "DELETE" });

    const patched = await call(`/transactions/${ticket.id}`, owner.token, {
      method: "PATCH",
      body: JSON.stringify({ tripId: trip.id }),
    });
    assert.equal(patched.status, 400);
  });

  it("forgets a 'just me' said about the trip it was on before", async () => {
    const owner = await makeUser();
    const [goa, kerala] = [await makeTrip(owner.id, { endedAt: new Date("2026-10-05T00:00:00Z") }), await makeTrip(owner.id)];
    const row = await spend(owner.id, 100000, daysBefore(10), { tripId: goa._id, tripShareWith: [owner.id] });

    await call(`/transactions/${row.id}`, owner.token, {
      method: "PATCH",
      body: JSON.stringify({ tripId: kerala.id }),
    });

    const saved = await models.Transaction.findById(row._id).orFail();
    assert.equal(saved.tripId?.toString(), kerala.id);
    assert.equal(saved.tripShareWith, null);
  });
});

describe("adding several at once", () => {
  it("adds the caller's own, skips anyone else's, and counts both", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    await join(trip, friend.token);

    const flight = await spend(owner.id, 1200000, daysBefore(30), { merchant: "IndiGo" });
    const hotel = await spend(owner.id, 600000, daysBefore(12), { merchant: "Taj Exotica" });
    const friendsOwn = await spend(friend.id, 900000, daysBefore(8));

    const response = await call(`/trips/${trip.id}/add`, owner.token, {
      method: "POST",
      body: JSON.stringify({
        transactionIds: [flight.id, hotel.id, friendsOwn.id, new Types.ObjectId().toString()],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { added: 2, skipped: 2 });

    assert.equal((await models.Transaction.findById(friendsOwn._id).orFail()).tripId, null, "never another person's");
    for (const id of [flight._id, hotel._id]) {
      const saved = await models.Transaction.findById(id).orFail();
      assert.equal(saved.tripId?.toString(), trip.id);
      assert.ok(saved.editedAt);
    }

    await call(`/trips/${trip.id}/rescan`, owner.token, { method: "POST" });
    assert.equal((await models.Transaction.findById(flight._id).orFail()).tripId?.toString(), trip.id);
  });

  it("puts them in the summary and the settlement", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    await join(trip, friend.token);
    const flights = await spend(owner.id, 2000000, daysBefore(40), { merchant: "IndiGo" });

    await call(`/trips/${trip.id}/add`, owner.token, {
      method: "POST",
      body: JSON.stringify({ transactionIds: [flights.id] }),
    });

    const summary = await json<{ totalMinor: number }>(await call(`/trips/${trip.id}/summary`, friend.token));
    assert.equal(summary.totalMinor, 2000000);

    // Both flew, the owner paid: the friend owes half.
    const settlement = await json<{ transfers: { fromUserId: string; toUserId: string; amountMinor: number }[] }>(
      await call(`/trips/${trip.id}/settlement`, friend.token)
    );
    assert.equal(settlement.transfers.length, 1);
    assert.equal(settlement.transfers[0].fromUserId, friend.id.toString());
    assert.equal(settlement.transfers[0].toUserId, owner.id.toString());
    assert.equal(settlement.transfers[0].amountMinor, 1000000);
  });

  it("is refused to someone not on the trip", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    const theirs = await spend(stranger.id, 300000, daysBefore(5));

    const response = await call(`/trips/${trip.id}/add`, stranger.token, {
      method: "POST",
      body: JSON.stringify({ transactionIds: [theirs.id] }),
    });
    assert.equal(response.status, 404);
    assert.equal((await models.Transaction.findById(theirs._id).orFail()).tripId, null);
  });

  it("will not reach into another member's ledger", async () => {
    // The friend is on the trip; still, only they can put their payments on it.
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    await join(trip, friend.token);
    const friendsOwn = await spend(friend.id, 450000, daysBefore(2));

    const response = await call(`/trips/${trip.id}/add`, owner.token, {
      method: "POST",
      body: JSON.stringify({ transactionIds: [friendsOwn.id] }),
    });
    assert.deepEqual(await response.json(), { added: 0, skipped: 1 });
    assert.equal((await models.Transaction.findById(friendsOwn._id).orFail()).tripId, null);
  });
});

describe("the payments offered to add", () => {
  type Candidate = {
    id: string;
    merchant: string | null;
    amountMinor: number;
    accountLabel: string | null;
    categoryName: string | null;
    likelyTravel: boolean;
  };

  it("leaves out anything already on a trip, and puts travel first", async () => {
    const owner = await makeUser();
    const trip = await makeTrip(owner.id);
    const other = await makeTrip(owner.id, { endedAt: new Date("2026-10-05T00:00:00Z") });
    const travel = await models.Category.create({ name: "Travel" });
    const account = await models.Account.create({
      userId: owner.id,
      bankName: "HDFC",
      last4: "8342",
      accountType: "CARD",
    });

    const groceries = await spend(owner.id, 150000, daysBefore(2), { merchant: "DMart" });
    const train = await spend(owner.id, 240000, daysBefore(20), { merchant: "IRCTC", accountId: account._id });
    const bus = await spend(owner.id, 90000, daysBefore(15), { categoryId: travel._id, merchant: "Some operator" });
    await spend(owner.id, 500000, daysBefore(25), { merchant: "Flights", tripId: other._id });
    await spend(owner.id, 70000, daysBefore(4), { tripId: trip._id });
    // A transfer and money in are never trip spending.
    await spend(owner.id, 1000000, daysBefore(3), { isTransfer: true });
    await models.Transaction.create({
      userId: owner.id,
      amountMinor: 5000000,
      currency: "INR",
      type: "CREDIT",
      source: "MANUAL",
      occurredAt: daysBefore(3),
    });

    const response = await call(`/trips/${trip.id}/candidates`, owner.token);
    assert.equal(response.status, 200);
    const rows = await json<Candidate[]>(response);

    // Travel first, newest first within it; then the rest.
    assert.deepEqual(
      rows.map((row) => row.id),
      [bus.id, train.id, groceries.id]
    );
    assert.equal(rows[0].categoryName, "Travel");
    assert.equal(rows[1].accountLabel, "HDFC ••8342");
    assert.deepEqual(
      rows.map((row) => row.likelyTravel),
      [true, true, false]
    );
  });

  it("looks back 60 days by default, further when asked, and no further than a year", async () => {
    const owner = await makeUser();
    const trip = await makeTrip(owner.id);
    await spend(owner.id, 100000, daysBefore(30));
    await spend(owner.id, 100000, daysBefore(120));
    await spend(owner.id, 100000, daysBefore(400));

    const count = async (query: string) =>
      (await json<Candidate[]>(await call(`/trips/${trip.id}/candidates${query}`, owner.token))).length;

    assert.equal(await count(""), 1);
    assert.equal(await count("?days=180"), 2);
    assert.equal(await count("?days=5000"), 2, "capped at 365");
  });

  it("searches merchants and notes", async () => {
    const owner = await makeUser();
    const trip = await makeTrip(owner.id);
    await spend(owner.id, 100000, daysBefore(3), { merchant: "Goibibo" });
    await spend(owner.id, 100000, daysBefore(4), { merchant: "Swiggy", note: "bus snacks (goa)" });
    await spend(owner.id, 100000, daysBefore(5), { merchant: "Amazon" });

    const rows = await json<Candidate[]>(await call(`/trips/${trip.id}/candidates?q=GO`, owner.token));
    assert.deepEqual(rows.map((row) => row.merchant).sort(), ["Goibibo", "Swiggy"]);

    // A search is text, never a pattern.
    const odd = await call(`/trips/${trip.id}/candidates?q=${encodeURIComponent("(goa")}`, owner.token);
    assert.equal(odd.status, 200);
    assert.equal((await json<Candidate[]>(odd)).length, 1);
  });

  it("offers only the caller's own payments, and only to a member", async () => {
    const [owner, friend, stranger] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    await join(trip, friend.token);
    await spend(friend.id, 100000, daysBefore(3));

    const forOwner = await json<Candidate[]>(await call(`/trips/${trip.id}/candidates`, owner.token));
    assert.deepEqual(forOwner, []);
    assert.equal((await call(`/trips/${trip.id}/candidates`, stranger.token)).status, 404);
  });
});

describe("the trip's own payments", () => {
  it("says which are the caller's, the only ones they can take off", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    await join(trip, friend.token);
    const mine = await spend(owner.id, 100000, daysBefore(1), { tripId: trip._id });
    await spend(friend.id, 200000, daysBefore(1), { tripId: trip._id });

    const rows = await json<{ id: string; isMine: boolean }[]>(
      await call(`/trips/${trip.id}/transactions`, owner.token)
    );
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.isMine, row.id === mine.id);
  });
});

describe("isLikelyTravel", () => {
  it("knows tickets, stays and rides by merchant", () => {
    for (const merchant of [
      "IRCTC NEW DELHI",
      "MAKEMYTRIP INDIA PVT LTD",
      "makemytrip.cc@icici",
      "Booking.com",
      "OYO Rooms",
      "Uber India",
      "Ola",
      "redBus",
      "IndiGo",
      "Air India Express",
      "Zoomcar",
    ]) {
      assert.ok(isLikelyTravel({ merchant }), merchant);
    }
  });

  it("knows a travel category whatever the merchant", () => {
    assert.ok(isLikelyTravel({ merchant: "RAMESH K", categoryName: "Transport" }));
    assert.ok(isLikelyTravel({ merchant: null, categoryName: "Hotels" }));
  });

  it("does not see travel inside other words", () => {
    for (const merchant of ["Coca-Cola", "Bookingham Stores", "Swiggy", "Tajmahal Sweets"]) {
      assert.ok(!isLikelyTravel({ merchant, categoryName: "Food & Dining" }), merchant);
    }
  });
});
