import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Transaction, Trip, User } from "../../models";
import { generateJoinCode, tripForOccurredAt } from "./trips.service";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_trips_test"));
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

async function makeTrip(
  userId: Types.ObjectId,
  overrides: { startedAt?: Date; endedAt?: Date | null } = {}
) {
  return Trip.create({
    ownerId: userId,
    name: "Goa",
    startedAt: overrides.startedAt ?? GOA_START,
    endedAt: overrides.endedAt === undefined ? null : overrides.endedAt,
    members: [{ userId, joinedAt: new Date() }],
    joinCode: generateJoinCode(),
  });
}

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

describe("which trip a payment belongs to", () => {
  it("claims a payment made while the trip is running", async () => {
    const userId = await makeUser();
    const trip = await makeTrip(userId);

    const found = await tripForOccurredAt(userId, new Date("2026-10-03T12:00:00Z"));
    assert.equal(found?.toString(), trip._id.toString());
  });

  it("ignores a payment made before it started", async () => {
    const userId = await makeUser();
    await makeTrip(userId);

    assert.equal(await tripForOccurredAt(userId, new Date("2026-09-30T12:00:00Z")), null);
  });

  it("still claims a payment inside the window after the trip has ended", async () => {
    // The last dinner abroad does not stop being part of the trip because
    // its SMS only synced on the flight home.
    const userId = await makeUser();
    const trip = await makeTrip(userId, { endedAt: GOA_END });

    const found = await tripForOccurredAt(userId, new Date("2026-10-06T12:00:00Z"));
    assert.equal(found?.toString(), trip._id.toString());
  });

  it("ignores a payment made after the trip ended", async () => {
    const userId = await makeUser();
    await makeTrip(userId, { endedAt: GOA_END });

    assert.equal(await tripForOccurredAt(userId, new Date("2026-10-09T12:00:00Z")), null);
  });

  it("does not put one person's payment on another's trip", async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await makeTrip(a);

    assert.equal(await tripForOccurredAt(b, new Date("2026-10-03T12:00:00Z")), null);
  });

  it("claims it for a member who did not start the trip", async () => {
    const [owner, friend] = await Promise.all([makeUser(), makeUser()]);
    const trip = await makeTrip(owner);
    trip.members.push({ userId: friend, joinedAt: new Date() });
    await trip.save();

    const found = await tripForOccurredAt(friend, new Date("2026-10-03T12:00:00Z"));
    assert.equal(found?.toString(), trip._id.toString());
  });

  it("prefers the more recently started of two overlapping trips", async () => {
    const userId = await makeUser();
    await makeTrip(userId, { startedAt: new Date("2026-10-01T00:00:00Z"), endedAt: GOA_END });
    const later = await Trip.create({
      ownerId: userId,
      name: "Side trip",
      startedAt: new Date("2026-10-04T00:00:00Z"),
      endedAt: new Date("2026-10-05T00:00:00Z"),
      members: [{ userId, joinedAt: new Date() }],
      joinCode: generateJoinCode(),
    });

    const found = await tripForOccurredAt(userId, new Date("2026-10-04T12:00:00Z"));
    assert.equal(found?.toString(), later._id.toString());
  });
});

describe("trip mode is a switch", () => {
  it("refuses a second running trip for the same person", async () => {
    const userId = await makeUser();
    await makeTrip(userId);

    // Two at once would leave every payment ambiguous.
    await assert.rejects(
      () =>
        Trip.create({
          ownerId: userId,
          name: "Another",
          startedAt: new Date(),
          endedAt: null,
          members: [{ userId, joinedAt: new Date() }],
          joinCode: generateJoinCode(),
        }),
      /duplicate key/i
    );
  });

  it("allows a new one once the last has ended", async () => {
    const userId = await makeUser();
    const first = await makeTrip(userId);
    first.endedAt = GOA_END;
    await first.save();

    const second = await makeTrip(userId, { startedAt: new Date("2026-11-01T00:00:00Z") });
    assert.ok(second._id);
  });

  it("lets two people each run their own", async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await makeTrip(a);
    await makeTrip(b);

    assert.equal(await Trip.countDocuments({ endedAt: null }), 2);
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
