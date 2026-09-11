import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

// env.ts demands these at import time, and the app is imported dynamically
// below so they are in place first. The database url is never dialled —
// the tests connect mongoose to an in-memory server themselves.
process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "trips-auth-test-secret";

/**
 * A trip is the only thing in SpendLog that one person can read from
 * another's ledger, so this exercises every trip endpoint over real HTTP
 * as somebody who was never invited.
 *
 * Checked one endpoint at a time rather than in aggregate: the failure
 * being guarded against is not a subtle miscalculation but a leak, and a
 * single route that forgot its check would be invisible in a summed
 * assertion.
 */
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let Trip: typeof import("../../models").Trip;
let User: typeof import("../../models").User;
let Transaction: typeof import("../../models").Transaction;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_trips_auth_test"));

  const [{ app }, auth, models] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
  ]);
  signToken = auth.signSessionToken;
  ({ Trip, User, Transaction } = models);

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
  await Promise.all([Trip.deleteMany({}), User.deleteMany({}), Transaction.deleteMany({})]);
});

let userCount = 0;

async function makeUser() {
  const email = `u${(userCount += 1)}@example.com`;
  const user = await User.create({ email, name: `User ${userCount}` });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
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

async function makeTrip(ownerId: Types.ObjectId, joinCode = "GOA123") {
  return Trip.create({
    ownerId,
    name: "Goa",
    startedAt: new Date("2026-10-01T00:00:00Z"),
    endedAt: null,
    members: [{ userId: ownerId, joinedAt: new Date("2026-10-01T00:00:00Z") }],
    joinCode,
  });
}

describe("a trip is unreachable by someone who was never invited", () => {
  it("hides it from their list", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    await makeTrip(owner.id);

    const response = await call("/trips", stranger.token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  });

  it("refuses the trip itself", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    assert.equal((await call(`/trips/${trip.id}`, stranger.token)).status, 404);
  });

  it("refuses its summary", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    assert.equal((await call(`/trips/${trip.id}/summary`, stranger.token)).status, 404);
  });

  it("refuses its transactions", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    assert.equal((await call(`/trips/${trip.id}/transactions`, stranger.token)).status, 404);
  });

  it("refuses to re-scan it", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const response = await call(`/trips/${trip.id}/rescan`, stranger.token, { method: "POST" });
    assert.equal(response.status, 404);
  });

  it("refuses to rename or end it", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const response = await call(`/trips/${trip.id}`, stranger.token, {
      method: "PATCH",
      body: JSON.stringify({ name: "Mine now" }),
    });
    assert.equal(response.status, 404);
    assert.equal((await Trip.findById(trip._id).orFail()).name, "Goa");
  });

  it("refuses to delete it", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const response = await call(`/trips/${trip.id}`, stranger.token, { method: "DELETE" });
    assert.equal(response.status, 404);
    assert.ok(await Trip.findById(trip._id));
  });

  it("refuses to rotate its join code", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const response = await call(`/trips/${trip.id}/rotate-code`, stranger.token, { method: "POST" });
    assert.equal(response.status, 404);
    assert.equal((await Trip.findById(trip._id).orFail()).joinCode, "GOA123");
  });

  it("refuses to remove anyone from it", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const response = await call(`/trips/${trip.id}/members/${owner.id}`, stranger.token, {
      method: "DELETE",
    });
    assert.equal(response.status, 404);
    assert.equal((await Trip.findById(trip._id).orFail()).members.length, 1);
  });

  it("refuses to leave a trip they were never on", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const response = await call(`/trips/${trip.id}/leave`, stranger.token, { method: "POST" });
    assert.equal(response.status, 404);
  });

  it("refuses a wrong join code", async () => {
    const [owner, stranger] = await Promise.all([makeUser(), makeUser()]);
    await makeTrip(owner.id);

    const response = await call("/trips/join", stranger.token, {
      method: "POST",
      body: JSON.stringify({ code: "WRONG1" }),
    });
    assert.equal(response.status, 404);
  });

  it("refuses everything without a token at all", async () => {
    const [owner] = await Promise.all([makeUser()]);
    const trip = await makeTrip(owner.id);

    const response = await fetch(`${baseUrl}/trips/${trip.id}/summary`);
    assert.equal(response.status, 401);
  });
});

describe("joining with a code", () => {
  it("lets someone in and shows them the trip", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const joined = await call("/trips/join", friend.token, {
      method: "POST",
      body: JSON.stringify({ code: "GOA123" }),
    });
    assert.equal(joined.status, 200);

    assert.equal((await call(`/trips/${trip.id}/summary`, friend.token)).status, 200);
  });

  it("accepts a code typed in lower case", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    await makeTrip(owner.id);

    const response = await call("/trips/join", friend.token, {
      method: "POST",
      body: JSON.stringify({ code: "goa123" }),
    });
    assert.equal(response.status, 200);
  });

  it("is harmless to join twice", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const body = JSON.stringify({ code: "GOA123" });
    await call("/trips/join", friend.token, { method: "POST", body });
    const second = await call("/trips/join", friend.token, { method: "POST", body });

    assert.equal(second.status, 200);
    assert.equal((await Trip.findById(trip._id).orFail()).members.length, 2);
  });

  it("does not hand over what they spent before joining", async () => {
    // Agreeing to share a holiday is not agreeing to publish the week
    // before it.
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const earlier = await Transaction.create({
      userId: friend.id,
      amountMinor: 50000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: new Date("2026-10-02T12:00:00Z"),
    });

    await call("/trips/join", friend.token, {
      method: "POST",
      body: JSON.stringify({ code: "GOA123" }),
    });

    assert.equal((await Transaction.findById(earlier._id).orFail()).tripId, null);

    const summary = await (await call(`/trips/${trip.id}/summary`, owner.token)).json();
    assert.equal(summary.totalMinor, 0);
  });

  it("lets them add those payments on purpose afterwards", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    await Transaction.create({
      userId: friend.id,
      amountMinor: 50000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: new Date("2026-10-02T12:00:00Z"),
    });

    await call("/trips/join", friend.token, {
      method: "POST",
      body: JSON.stringify({ code: "GOA123" }),
    });
    await call(`/trips/${trip.id}/rescan`, friend.token, { method: "POST" });

    const summary = await (await call(`/trips/${trip.id}/summary`, owner.token)).json();
    assert.equal(summary.totalMinor, 50000);
  });

  it("only ever claims the caller's own payments on a re-scan", async () => {
    // The owner sweeping the window must not reach into a member's ledger.
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);

    const theirs = await Transaction.create({
      userId: friend.id,
      amountMinor: 50000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: new Date("2026-10-02T12:00:00Z"),
    });

    await call("/trips/join", friend.token, {
      method: "POST",
      body: JSON.stringify({ code: "GOA123" }),
    });
    await call(`/trips/${trip.id}/rescan`, owner.token, { method: "POST" });

    assert.equal((await Transaction.findById(theirs._id).orFail()).tripId, null);
  });
});

describe("leaving and being removed", () => {
  async function tripWithFriend() {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    await call("/trips/join", friend.token, {
      method: "POST",
      body: JSON.stringify({ code: "GOA123" }),
    });
    return { owner, friend, trip };
  }

  it("stops a member seeing the trip once they leave", async () => {
    const { friend, trip } = await tripWithFriend();

    assert.equal((await call(`/trips/${trip.id}/leave`, friend.token, { method: "POST" })).status, 204);
    assert.equal((await call(`/trips/${trip.id}/summary`, friend.token)).status, 404);
  });

  it("keeps what they spent on the trip's total", async () => {
    // The total should not quietly drop because somebody walked away.
    const { owner, friend, trip } = await tripWithFriend();

    await Transaction.create({
      userId: friend.id,
      tripId: trip._id,
      amountMinor: 50000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: new Date("2026-10-03T12:00:00Z"),
    });

    await call(`/trips/${trip.id}/leave`, friend.token, { method: "POST" });

    const summary = await (await call(`/trips/${trip.id}/summary`, owner.token)).json();
    assert.equal(summary.totalMinor, 50000);
  });

  it("lets the owner remove someone", async () => {
    const { owner, friend, trip } = await tripWithFriend();

    const response = await call(`/trips/${trip.id}/members/${friend.id}`, owner.token, {
      method: "DELETE",
    });
    assert.equal(response.status, 204);
    assert.equal((await call(`/trips/${trip.id}/summary`, friend.token)).status, 404);
  });

  it("stops a member removing anyone else", async () => {
    const { owner, friend, trip } = await tripWithFriend();

    const response = await call(`/trips/${trip.id}/members/${owner.id}`, friend.token, {
      method: "DELETE",
    });
    assert.equal(response.status, 404);
  });

  it("refuses to let the owner walk away from their own trip", async () => {
    const { owner, trip } = await tripWithFriend();

    const response = await call(`/trips/${trip.id}/leave`, owner.token, { method: "POST" });
    assert.equal(response.status, 400);
  });
});

describe("rotating the join code", () => {
  it("stops the old one working and leaves members in place", async () => {
    const [owner, friend, stranger] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const trip = await makeTrip(owner.id);
    await call("/trips/join", friend.token, {
      method: "POST",
      body: JSON.stringify({ code: "GOA123" }),
    });

    const rotated = await call(`/trips/${trip.id}/rotate-code`, owner.token, { method: "POST" });
    const { joinCode } = await rotated.json();
    assert.notEqual(joinCode, "GOA123");

    const withOldCode = await call("/trips/join", stranger.token, {
      method: "POST",
      body: JSON.stringify({ code: "GOA123" }),
    });
    assert.equal(withOldCode.status, 404);

    assert.equal((await call(`/trips/${trip.id}/summary`, friend.token)).status, 200);
  });
});
