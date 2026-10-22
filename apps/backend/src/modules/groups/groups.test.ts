import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Transaction, Trip, User } from "../../models";
import { generateJoinCode, tripForOccurredAt } from "./groups.service";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_trips_test"));

  // The indexes are built in the background after connecting; a test that
  // depends on one must not race it.
  await Trip.init();
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([Transaction.deleteMany({}), Trip.deleteMany({}), User.deleteMany({})]);
});

let userCount = 0;

async function makeUser(): Promise<Types.ObjectId> {
  const user = await User.create({ email: `u${(userCount += 1)}@example.com`, name: "Test" });
  return user._id;
}

const GOA_START = new Date("2026-10-01T04:00:00Z"); // 9:30am IST
const GOA_END = new Date("2026-10-07T18:00:00Z");

/**
 * A dated group. `linked` makes it one Trippin planned, the only kind that
 * still takes payments in by its dates.
 */
async function makeTrip(
  userId: Types.ObjectId,
  overrides: { startedAt?: Date; endedAt?: Date | null; linked?: boolean; archivedAt?: Date | null } = {}
) {
  return Trip.create({
    ownerId: userId,
    name: "Goa",
    startedAt: overrides.startedAt ?? GOA_START,
    endedAt: overrides.endedAt === undefined ? null : overrides.endedAt,
    archivedAt: overrides.archivedAt ?? null,
    members: [{ userId, joinedAt: overrides.startedAt ?? GOA_START }],
    joinCode: generateJoinCode(),
    source: overrides.linked
      ? { app: "trippin", externalId: `trp_${generateJoinCode()}`, linked: true, linkedAt: GOA_START }
      : null,
  });
}

const linked = { linked: true } as const;

describe("generateJoinCode", () => {
  it("leaves out the characters people misread aloud", () => {
    // This gets read across a dinner table as often as it gets scanned.
    for (let i = 0; i < 200; i += 1) {
      assert.ok(!/[O0I1]/.test(generateJoinCode()), "no O, 0, I or 1");
    }
  });

  it("is long enough not to collide across a few hundred trips", () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateJoinCode()));
    assert.ok(codes.size > 495, `got ${codes.size} distinct out of 500`);
  });
});

describe("an ordinary group takes nothing in by itself", () => {
  it("never claims a payment because of its dates", async () => {
    // Picked in the editor, not guessed from a date: "Flatmates" has none,
    // and a trip's dates guessed wrong more often than people liked.
    const userId = await makeUser();
    await makeTrip(userId);

    assert.equal(await tripForOccurredAt(userId, new Date("2026-10-03T12:00:00Z")), null);
  });

  it("nor once Trippin has stopped tracking it", async () => {
    const userId = await makeUser();
    const trip = await makeTrip(userId, linked);
    trip.source!.linked = false;
    await trip.save();

    assert.equal(await tripForOccurredAt(userId, new Date("2026-10-03T12:00:00Z")), null);
  });
});

describe("which Trippin group a payment goes into", () => {
  it("claims a payment made while the trip is running", async () => {
    const userId = await makeUser();
    const trip = await makeTrip(userId, linked);

    const found = await tripForOccurredAt(userId, new Date("2026-10-03T12:00:00Z"));
    assert.equal(found?.toString(), trip._id.toString());
  });

  it("ignores a payment made before it started", async () => {
    const userId = await makeUser();
    await makeTrip(userId, linked);

    assert.equal(await tripForOccurredAt(userId, new Date("2026-09-30T12:00:00Z")), null);
  });

  it("still claims a payment inside the window after the trip has ended", async () => {
    // The last dinner abroad does not stop being part of the trip because
    // its SMS only synced on the flight home.
    const userId = await makeUser();
    const trip = await makeTrip(userId, { ...linked, endedAt: GOA_END });

    const found = await tripForOccurredAt(userId, new Date("2026-10-06T12:00:00Z"));
    assert.equal(found?.toString(), trip._id.toString());
  });

  it("ignores a payment made after the trip ended", async () => {
    const userId = await makeUser();
    await makeTrip(userId, { ...linked, endedAt: GOA_END });

    assert.equal(await tripForOccurredAt(userId, new Date("2026-10-09T12:00:00Z")), null);
  });

  it("leaves an archived group alone", async () => {
    const userId = await makeUser();
    await makeTrip(userId, { ...linked, endedAt: GOA_END, archivedAt: new Date() });

    assert.equal(await tripForOccurredAt(userId, new Date("2026-10-03T12:00:00Z")), null);
  });

  it("does not put one person's payment in another's group", async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await makeTrip(a, linked);

    assert.equal(await tripForOccurredAt(b, new Date("2026-10-03T12:00:00Z")), null);
  });

  it("claims it for a member who did not start the trip", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner, linked);
    trip.members.push({ userId: friend, joinedAt: GOA_START });
    await trip.save();

    const found = await tripForOccurredAt(friend, new Date("2026-10-03T12:00:00Z"));
    assert.equal(found?.toString(), trip._id.toString());
  });

  it("prefers the more recently started of two overlapping trips", async () => {
    const userId = await makeUser();
    await makeTrip(userId, { ...linked, startedAt: new Date("2026-10-01T00:00:00Z"), endedAt: GOA_END });
    const later = await makeTrip(userId, {
      ...linked,
      startedAt: new Date("2026-10-04T00:00:00Z"),
      endedAt: new Date("2026-10-05T00:00:00Z"),
    });

    const found = await tripForOccurredAt(userId, new Date("2026-10-04T12:00:00Z"));
    assert.equal(found?.toString(), later._id.toString());
  });
});

describe("groups are not a mode", () => {
  it("lets one person have several open at once", async () => {
    // Trips had a "one running at a time" index; "Goa" and "Flatmates"
    // are both open, and neither is a switch.
    const userId = await makeUser();
    await makeTrip(userId);
    await makeTrip(userId, { startedAt: new Date() });
    await Trip.create({
      ownerId: userId,
      name: "Flatmates",
      members: [{ userId, joinedAt: new Date() }],
      joinCode: generateJoinCode(),
    });

    assert.equal(await Trip.countDocuments({ ownerId: userId, archivedAt: null }), 3);
  });
});

describe("a trip does not change what a payment counts for", () => {
  it("counts a holiday meal exactly as it would at home", async () => {
    const userId = await makeUser();
    const trip = await makeTrip(userId);

    const meal = await Transaction.create({
      userId,
      tripId: trip._id,
      amountMinor: 120000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: new Date("2026-10-03T12:00:00Z"),
    });

    assert.equal(meal.countedAmountMinor, 120000);
    assert.equal(meal.countedReason, "FULL");
  });

  it("still honours a split on a trip", async () => {
    const userId = await makeUser();
    const trip = await makeTrip(userId);

    const dinner = await Transaction.create({
      userId,
      tripId: trip._id,
      amountMinor: 120000,
      currency: "INR",
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: new Date("2026-10-03T12:00:00Z"),
      split: { myShareMinor: 40000 },
    });

    assert.equal(dinner.countedAmountMinor, 40000);
  });
});
