import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Transaction } from "../../models";
import { statedMoment } from "../../parsing/moment";
import { groupForOccurredAt, syncGroupSplit } from "../groups/groups.service";
import { horizonFor } from "../ledger/ledger.horizon";

/**
 * Re-dates rows imported before the time written in a message was read.
 *
 * Until then every row took its message's arrival time, so a 1:39 AM
 * payment that texted at 5:15 says 5:15 - and one whose SMS came after
 * midnight sits on the wrong day. Each row's messages are read again for
 * the moment they state, measured against when that message arrived
 * (which every row keeps), and the row moves when the two differ by more
 * than a minute and no more than three days: further than that is more
 * likely a misread than a late text.
 *
 * Rows someone edited by hand keep their time, as do rows SpendLog wrote
 * in itself and other people's payments mirrored here. A row that lands in
 * a trip's dates by its new time joins that trip, as it would have on
 * arrival.
 */

export const STATED_TIME_BACKFILL = "statedTime";
export const STATED_TIME_BACKFILL_VERSION = 1;

const MIN_SHIFT_MS = 60 * 1000;
const MAX_SHIFT_MS = 3 * 24 * 60 * 60 * 1000;

/** One user's rows moved to the time their messages state. Returns how many moved. */
export async function redateFromMessages(userId: Types.ObjectId): Promise<number> {
  const horizon = await horizonFor(userId);
  const rows = await Transaction.find({
    userId,
    editedAt: null,
    autoLeg: { $ne: true },
    mirrorOf: null,
    "sources.source": { $in: ["SMS", "EMAIL"] },
  });

  let moved = 0;
  for (const row of rows) {
    let stated: Date | null = null;
    for (const entry of row.sources) {
      if (entry.source !== "SMS" && entry.source !== "EMAIL") continue;
      stated = statedMoment(entry.rawText, new Date(entry.receivedAt));
      if (stated) break;
    }
    if (!stated) continue;

    const shift = Math.abs(stated.getTime() - row.occurredAt.getTime());
    if (shift <= MIN_SHIFT_MS || shift > MAX_SHIFT_MS) continue;
    // Never back past where this ledger starts: ingest would not have kept it.
    if (horizon && stated < horizon) continue;

    row.occurredAt = stated;
    const joinsGroup = row.groupId ? null : await groupForOccurredAt(userId, stated);
    if (joinsGroup) row.groupId = joinsGroup;
    await row.save();
    if (joinsGroup) await syncGroupSplit(row);
    moved += 1;
  }
  return moved;
}

export async function runStatedTimeBackfill(): Promise<{ users: number; changed: number }> {
  const result = await runOncePerUser(STATED_TIME_BACKFILL, STATED_TIME_BACKFILL_VERSION, redateFromMessages);
  if (result.users > 0) {
    console.log(`Stated-time backfill: ${result.changed} transactions re-dated across ${result.users} users.`);
  }
  return result;
}
