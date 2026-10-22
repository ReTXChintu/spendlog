import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { Group, Transaction, User } from "../../models";
import { RECENT_TRIP_DAYS, archivedAtFor, copyTripsToGroups, runGroupsMigration } from "./groups.migration";

/**
 * Trips into groups, against rows written the way the old code wrote them:
 * straight into `trips`, and transactions carrying tripId. Lossless and
 * safe to run again.
 */
let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_groups_migration_test"));
  await Group.init();
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const trips = () => mongoose.connection.collection("trips");
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await Promise.all([Group.deleteMany({}), Transaction.deleteMany({}), User.deleteMany({}), trips().deleteMany({})]);
});

/** A user and their trips and transactions, as the old code left them. */
async function oldData() {
  const [asha, ravi] = await User.create([{ email: "asha@example.com" }, { email: "ravi@example.com" }]);
  const now = Date.now();
  const joined = new Date(now - 100 * DAY_MS);
  const raviJoined = new Date(now - 98 * DAY_MS);

  const longAgo = new Types.ObjectId();
  const recent = new Types.ObjectId();
  const running = new Types.ObjectId();
  const trippin = new Types.ObjectId();
  await trips().insertMany([
    {
      _id: longAgo,
      ownerId: asha._id,
      name: "Goa",
      startedAt: joined,
      endedAt: new Date(now - 90 * DAY_MS),
      members: [
        { userId: asha._id, joinedAt: joined },
        { userId: ravi._id, joinedAt: raviJoined },
      ],
      joinCode: "GOA234",
      source: null,
      createdAt: joined,
      updatedAt: joined,
    },
    {
      _id: recent,
      ownerId: asha._id,
      name: "Pondicherry",
      startedAt: new Date(now - 12 * DAY_MS),
      endedAt: new Date(now - 10 * DAY_MS),
      members: [{ userId: asha._id, joinedAt: new Date(now - 12 * DAY_MS) }],
      joinCode: "PDY234",
      createdAt: new Date(now - 12 * DAY_MS),
      updatedAt: new Date(now - 10 * DAY_MS),
    },
    {
      _id: running,
      ownerId: ravi._id,
      name: "Weekend",
      startedAt: new Date(now - DAY_MS),
      endedAt: null,
      members: [{ userId: ravi._id, joinedAt: new Date(now - DAY_MS) }],
      joinCode: "WKD234",
      createdAt: new Date(now - DAY_MS),
      updatedAt: new Date(now - DAY_MS),
    },
    {
      _id: trippin,
      ownerId: asha._id,
      name: "Planned in Trippin",
      startedAt: new Date(now + 10 * DAY_MS),
      endedAt: new Date(now + 14 * DAY_MS),
      members: [{ userId: asha._id, joinedAt: new Date(now) }],
      joinCode: "TRP234",
      source: { app: "trippin", externalId: "trp_1", url: null, linked: true, linkedAt: new Date(now), memberSubs: ["s1"] },
      createdAt: new Date(now),
      updatedAt: new Date(now),
    },
  ]);

  const base = { currency: "INR", type: "DEBIT", source: "MANUAL", sources: [], countedReason: "FULL" };
  const [shared, justMine, plain, ravis] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
  await Transaction.collection.insertMany([
    { _id: shared, ...base, userId: asha._id, amountMinor: 3000, countedAmountMinor: 3000, occurredAt: new Date(now - 95 * DAY_MS), tripId: longAgo, tripShareWith: null },
    { _id: justMine, ...base, userId: asha._id, amountMinor: 700, countedAmountMinor: 700, occurredAt: new Date(now - 94 * DAY_MS), tripId: longAgo, tripShareWith: [asha._id] },
    { _id: plain, ...base, userId: asha._id, amountMinor: 100, countedAmountMinor: 100, occurredAt: new Date(now - 5 * DAY_MS), tripId: null },
    { _id: ravis, ...base, userId: ravi._id, amountMinor: 900, countedAmountMinor: 900, occurredAt: new Date(now - 93 * DAY_MS), tripId: longAgo },
  ]);

  return { asha, ravi, joined, raviJoined, ids: { longAgo, recent, running, trippin }, rows: { shared, justMine, plain, ravis } };
}

describe("trips into groups", () => {
  it("makes every trip a group with the same id, its members and their join dates", async () => {
    const { asha, ravi, joined, raviJoined, ids } = await oldData();
    await runGroupsMigration();

    assert.equal(await Group.countDocuments(), 4);
    const goa = await Group.findById(ids.longAgo).orFail();
    assert.equal(goa.name, "Goa");
    assert.ok(goa.ownerId.equals(asha._id));
    assert.equal(goa.joinCode, "GOA234");
    assert.deepEqual(
      goa.members.map((m) => [m.userId.toString(), m.joinedAt.getTime()]),
      [
        [asha._id.toString(), joined.getTime()],
        [ravi._id.toString(), raviJoined.getTime()],
      ]
    );
    assert.deepEqual(goa.contactMembers, []);

    const trippin = await Group.findById(ids.trippin).orFail();
    assert.equal(trippin.source?.externalId, "trp_1", "Trippin's remoteId still finds it");
    assert.equal(trippin.source?.linked, true);
    assert.deepEqual(trippin.source?.memberSubs, ["s1"]);
  });

  it("archives a trip long over, and keeps recent, running and future ones active", async () => {
    const { ids } = await oldData();
    await runGroupsMigration();

    const goa = await Group.findById(ids.longAgo).orFail();
    assert.ok(goa.archivedAt, "ended ninety days ago");
    assert.equal(goa.archivedAt?.getTime(), goa.endedAt?.getTime(), "archived as of the day it ended");
    assert.equal((await Group.findById(ids.recent).orFail()).archivedAt, null, "ended ten days ago: still settling up");
    assert.equal((await Group.findById(ids.running).orFail()).archivedAt, null);
    assert.equal((await Group.findById(ids.trippin).orFail()).archivedAt, null);
  });

  it("keeps every transaction in its group, shares and all, and counting what it did", async () => {
    const { asha, ids, rows } = await oldData();
    await runGroupsMigration();

    const shared = await Transaction.findById(rows.shared).orFail();
    assert.equal(shared.groupId?.toString(), ids.longAgo.toString());
    assert.equal(shared.groupShareWith, null);
    assert.equal(shared.countedAmountMinor, 3000);

    const justMine = await Transaction.findById(rows.justMine).orFail();
    assert.deepEqual(justMine.groupShareWith?.map(String), [asha._id.toString()]);
    assert.equal((await Transaction.findById(rows.ravis).orFail()).groupId?.toString(), ids.longAgo.toString());
    assert.equal((await Transaction.findById(rows.plain).orFail()).groupId, null);

    // The old fields are gone from the stored rows, not left to disagree.
    assert.equal(await Transaction.collection.countDocuments({ tripId: { $exists: true } }), 0);
    assert.equal(await Transaction.collection.countDocuments({ tripShareWith: { $exists: true } }), 0);
  });

  it("does nothing the second time, and never brings back a group deleted since", async () => {
    const { asha, ids, rows } = await oldData();
    await runGroupsMigration();
    const firstGoa = await Group.findById(ids.longAgo).orFail().lean();

    await Group.deleteOne({ _id: ids.recent });
    await runGroupsMigration();
    await runGroupsMigration();

    assert.equal(await Group.countDocuments(), 3);
    assert.equal(await Group.exists({ _id: ids.recent }), null);
    assert.deepEqual((await Group.findById(ids.longAgo).orFail().lean()).members, firstGoa.members);
    assert.equal((await Transaction.findById(rows.shared).orFail()).groupId?.toString(), ids.longAgo.toString());
    // Every user marked done; the trips themselves kept, as a backup.
    assert.equal((await User.findById(asha._id).orFail().lean()).backfills?.groups, 1);
    assert.equal(await trips().countDocuments(), 4);
    assert.equal(await trips().countDocuments({ migratedToGroupAt: { $exists: true } }), 4);
  });

  it("counts what it copied, and copies a trip only once", async () => {
    await oldData();
    assert.deepEqual(await copyTripsToGroups(), { copied: 4, archived: 1 });
    assert.deepEqual(await copyTripsToGroups(), { copied: 0, archived: 0 });
  });

  it("gives a trip a new join code if a group took its code in the meantime", async () => {
    const { asha, ids } = await oldData();
    await Group.create({ ownerId: asha._id, name: "Made after the deploy", members: [], joinCode: "GOA234" });
    await runGroupsMigration();

    const goa = await Group.findById(ids.longAgo).orFail();
    assert.notEqual(goa.joinCode, "GOA234");
    assert.equal(goa.name, "Goa");
  });

  it("leaves a row the new code already put in a group where it is", async () => {
    const { asha, rows } = await oldData();
    const other = new Types.ObjectId();
    await Transaction.collection.updateOne({ _id: rows.shared }, { $set: { groupId: other } });
    await runGroupsMigration();
    assert.equal((await Transaction.findById(rows.shared).orFail()).groupId?.toString(), other.toString());
    assert.ok(asha);
  });
});

describe("archivedAtFor", () => {
  it("archives only what ended more than the recent window ago", () => {
    const now = new Date("2026-10-22T00:00:00Z");
    assert.equal(archivedAtFor({ endedAt: null }, now), null);
    const justInside = new Date(now.getTime() - (RECENT_TRIP_DAYS - 1) * DAY_MS);
    assert.equal(archivedAtFor({ endedAt: justInside }, now), null);
    const past = new Date(now.getTime() - (RECENT_TRIP_DAYS + 1) * DAY_MS);
    assert.equal(archivedAtFor({ endedAt: past }, now)?.getTime(), past.getTime());
  });
});
