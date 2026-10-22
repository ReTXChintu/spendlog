import mongoose, { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Group, Transaction } from "../../models";
import { generateJoinCode } from "./groups.service";

/**
 * Trips became groups.
 *
 * Two steps, both safe to run any number of times:
 *
 *   1. every trip is copied into `groups` under the same id, so every link
 *      to it - a transaction's, Trippin's remoteId, a URL someone saved -
 *      still finds it. The trip is marked as copied rather than deleted:
 *      `trips` stays as it was, a backup nothing reads, and a group deleted
 *      later is not brought back by the next start-up;
 *   2. once per user, every transaction's tripId and tripShareWith move to
 *      groupId and groupShareWith, with the same values. Nothing else about
 *      the row changes, so what it counts for stays exactly what it was.
 *
 * Members carry over with the moment each joined; dates carry over as the
 * group's optional dates. What changes is what "active" means: a group is
 * active until it is archived. A trip that ended long ago is archived as
 * it moves - its end date says it is over, and leaving years of holidays
 * in the editor's picker would bury the groups in use. One that ended
 * recently stays active, since the last few weeks are when people are
 * still settling up and adding the late payments; it can be archived by
 * hand. Running trips, and Trippin trips still ahead, stay active.
 */

/// How long after its end a trip still counts as recent.
export const RECENT_TRIP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const GROUPS_BACKFILL = "groups";
export const GROUPS_BACKFILL_VERSION = 1;

/** When a trip's group is archived as it moves, or null to leave it active. */
export function archivedAtFor(trip: { endedAt?: Date | null }, now = new Date()): Date | null {
  if (!trip.endedAt) return null;
  return trip.endedAt.getTime() < now.getTime() - RECENT_TRIP_DAYS * DAY_MS ? trip.endedAt : null;
}

/** Step 1: every trip not yet copied, into `groups`. Returns how many. */
export async function copyTripsToGroups(now = new Date()): Promise<{ copied: number; archived: number }> {
  const db = mongoose.connection.db;
  if (!db) return { copied: 0, archived: 0 };
  const exists = await db.listCollections({ name: "trips" }, { nameOnly: true }).hasNext();
  if (!exists) return { copied: 0, archived: 0 };

  const trips = db.collection("trips");
  let copied = 0;
  let archived = 0;
  for await (const trip of trips.find({ migratedToGroupAt: { $exists: false } })) {
    const { _id, migratedToGroupAt: _never, ...fields } = trip;
    const archivedAt = archivedAtFor(fields as { endedAt?: Date | null }, now);
    const group: Record<string, unknown> = {
      ...fields,
      startedAt: fields.startedAt ?? null,
      endedAt: fields.endedAt ?? null,
      archivedAt,
      members: fields.members ?? [],
      contactMembers: [],
    };

    // The same id; inserted only if it is not there already, so a second
    // run - or a group changed since - is left alone.
    let result: { upsertedCount: number } | null = null;
    for (let attempt = 0; attempt < 5 && !result; attempt += 1) {
      try {
        result = await Group.collection.updateOne({ _id }, { $setOnInsert: group }, { upsert: true });
      } catch (err) {
        // A group made since the deploy took this join code. Codes are
        // only ever read out, so the trip's gets a new one.
        if ((err as { code?: number }).code === 11000 && String(err).includes("joinCode")) {
          group.joinCode = generateJoinCode();
          continue;
        }
        throw err;
      }
    }
    if (result?.upsertedCount) {
      copied += 1;
      if (archivedAt) archived += 1;
    }
    await trips.updateOne({ _id }, { $set: { migratedToGroupAt: now } });
  }
  return { copied, archived };
}

/**
 * Step 2, for one user: tripId and tripShareWith onto groupId and
 * groupShareWith. A row already given a group since (by the new code,
 * before this reached it) keeps it. Returns how many rows moved.
 */
export async function moveTripFields(userId: Types.ObjectId): Promise<number> {
  const result = await Transaction.collection.updateMany(
    { userId, $or: [{ tripId: { $exists: true } }, { tripShareWith: { $exists: true } }] },
    [
      {
        $set: {
          groupId: { $ifNull: ["$groupId", { $ifNull: ["$tripId", null] }] },
          groupShareWith: { $ifNull: ["$groupShareWith", { $ifNull: ["$tripShareWith", null] }] },
        },
      },
      { $unset: ["tripId", "tripShareWith"] },
    ]
  );
  return result.modifiedCount;
}

/** Both steps, at start-up, before the server answers anything. */
export async function runGroupsMigration(): Promise<void> {
  const { copied, archived } = await copyTripsToGroups();
  if (copied > 0) console.log(`Groups migration: ${copied} trips copied to groups (${archived} archived as long over).`);
  const { users, changed } = await runOncePerUser(GROUPS_BACKFILL, GROUPS_BACKFILL_VERSION, moveTripFields);
  if (users > 0) console.log(`Groups migration: ${changed} transactions moved onto their groups across ${users} users.`);
}
