import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { CardStatement, Transaction, TransactionDoc } from "../../models";
import { statedMoment } from "../../parsing/moment";
import { groupForOccurredAt, syncGroupSplit } from "../groups/groups.service";
import { horizonFor } from "../ledger/ledger.horizon";
import { mergeTransactions } from "./transactions.merge";

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
export const STATED_TIME_BACKFILL_VERSION = 2;

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

/** The moment a row's messages state, or null. */
function statedFor(row: Pick<TransactionDoc, "sources">): Date | null {
  for (const entry of row.sources) {
    if (entry.source !== "SMS" && entry.source !== "EMAIL") continue;
    const stated = statedMoment(entry.rawText, new Date(entry.receivedAt));
    if (stated) return stated;
  }
  return null;
}

const TWIN_WITHIN_MS = 2 * 60 * 1000;

/**
 * One payment reported twice and kept as two rows: an email whose time
 * was not read sat at its arrival, hours from the SMS for the same payment,
 * too far apart for ingest to see them as one. Found by the moment one
 * row's message states landing on the other row - same account, amount
 * and direction, no references that differ - and merged into that row,
 * which keeps the other verbatim so it can be split back out. Left alone
 * when the late row is tied to something (a group, people, a fixed cost)
 * that the row it would join is not. Returns how many were merged.
 */
export async function mergeReportedTwice(userId: Types.ObjectId): Promise<number> {
  const rows = await Transaction.find({ userId, mirrorOf: null, "sources.source": { $in: ["SMS", "EMAIL"] } });
  const gone = new Set<string>();
  let merged = 0;

  for (const late of rows) {
    if (gone.has(late._id.toString())) continue;
    const stated = statedFor(late);
    if (!stated || Math.abs(stated.getTime() - late.occurredAt.getTime()) <= TWIN_WITHIN_MS) continue;

    const twin = rows.find(
      (other) =>
        other !== late &&
        !gone.has(other._id.toString()) &&
        String(other.accountId ?? "") === String(late.accountId ?? "") &&
        other.amountMinor === late.amountMinor &&
        other.type === late.type &&
        Math.abs(other.occurredAt.getTime() - stated.getTime()) <= TWIN_WITHIN_MS &&
        !(other.reference && late.reference && other.reference !== late.reference)
    );
    if (!twin) continue;

    // What the late row is tied to has to be on the row it joins too.
    const tiedApart =
      (late.groupId && !twin.groupId) ||
      (late.split && !twin.split) ||
      (late.people.length > 0 && twin.people.length === 0) ||
      (late.commitmentId && !twin.commitmentId) ||
      (late.loanId && !twin.loanId) ||
      (late.depositParts.length > 0 && twin.depositParts.length === 0) ||
      (late.metalBuy && !twin.metalBuy) ||
      late.isTransfer !== twin.isTransfer;
    if (tiedApart) continue;

    await mergeTransactions(twin, [late]);
    // A statement line that matched the late row matched the payment.
    await CardStatement.updateMany(
      { userId, "lines.transactionId": late._id },
      { $set: { "lines.$[line].transactionId": twin._id } },
      { arrayFilters: [{ "line.transactionId": late._id }] }
    );
    gone.add(late._id.toString());
    merged += 1;
  }
  return merged;
}

export const REPORTED_TWICE_BACKFILL = "reportedTwiceMerge";
export const REPORTED_TWICE_BACKFILL_VERSION = 1;

export async function runReportedTwiceBackfill(): Promise<{ users: number; changed: number }> {
  const result = await runOncePerUser(REPORTED_TWICE_BACKFILL, REPORTED_TWICE_BACKFILL_VERSION, mergeReportedTwice);
  if (result.changed > 0) console.log(`Reported-twice merge: ${result.changed} duplicate rows merged.`);
  return result;
}

export async function runStatedTimeBackfill(): Promise<{ users: number; changed: number }> {
  const result = await runOncePerUser(STATED_TIME_BACKFILL, STATED_TIME_BACKFILL_VERSION, redateFromMessages);
  if (result.users > 0) {
    console.log(`Stated-time backfill: ${result.changed} transactions re-dated across ${result.users} users.`);
  }
  return result;
}
