import { JobRun } from "../models";
import { IST_OFFSET_MS } from "../time";

/**
 * Something that runs once a day, at a given time in India, however often
 * it is asked and however many times the process restarts: the same guard
 * the nightly balance check keeps in Mongo (accounts.drift.ts), for any
 * job that wants it.
 *
 * `moment` is the most recent time of day at or before now; a job that
 * last ran before that moment is due. A run claims the job first, so two
 * processes asking at once run it once, and a claim older than a quarter
 * of an hour is a run that died and may be taken over.
 */

const CLAIM_MS = 15 * 60 * 1000;

/** The most recent `hour:minute` IST at or before `now`. */
export function lastMomentIST(now: Date, hour: number, minute = 0): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const today = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hour, minute) - IST_OFFSET_MS;
  return today <= now.getTime() ? new Date(today) : new Date(today - 24 * 60 * 60 * 1000);
}

export async function runDailyJob<T>(
  key: string,
  at: { hour: number; minute?: number },
  now: Date,
  work: () => Promise<T>
): Promise<{ ran: false } | { ran: true; result: T }> {
  const moment = lastMomentIST(now, at.hour, at.minute ?? 0);
  await JobRun.updateOne({ key }, { $setOnInsert: { ranAt: null } }, { upsert: true });
  const claim = await JobRun.updateOne(
    {
      key,
      $and: [
        { $or: [{ ranAt: null }, { ranAt: { $lt: moment } }] },
        { $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - CLAIM_MS) } }] },
      ],
    },
    { $set: { claimedAt: now } }
  );
  if (claim.modifiedCount === 0) return { ran: false };

  try {
    const result = await work();
    await JobRun.updateOne({ key }, { $set: { claimedAt: null, ranAt: now, lastError: null } });
    return { ran: true, result };
  } catch (error) {
    console.error(`Daily job ${key} failed:`, error);
    await JobRun.updateOne({ key }, { $set: { claimedAt: null, lastError: "Run failed." } });
    throw error;
  }
}
