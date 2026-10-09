import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Account } from "../../models";

/**
 * Clears the personal spend limit off every account that had one.
 *
 * The limit is gone: a card is now read against its credit limit on its
 * own billing cycle, and what a month may cost is the monthly budget's
 * job. The field left the schema with it, but a document read back from
 * the database keeps whatever it was stored with - so without this an old
 * account would still carry the figure out through the API, to a client
 * that no longer has anywhere to show it or any way to change it.
 *
 * Unset rather than left to lie there: nothing reads it, and a value
 * nothing can edit is one nobody can explain later.
 */
export const SPEND_LIMIT_BACKFILL = "dropSpendLimit";
export const SPEND_LIMIT_BACKFILL_VERSION = 1;

/**
 * One user's pass. Through the collection rather than the model, because
 * the model no longer knows the field and would quietly drop an update
 * that names it. Safe to run twice: the second finds nothing to unset.
 */
export async function dropSpendLimits(userId: Types.ObjectId): Promise<number> {
  const result = await Account.collection.updateMany(
    { userId, spendLimitMinor: { $exists: true } },
    { $unset: { spendLimitMinor: "" } }
  );
  return result.modifiedCount;
}

/** Every user who has not had this pass yet. Called once at start-up. */
export async function runSpendLimitBackfill(): Promise<void> {
  const { users, changed } = await runOncePerUser(SPEND_LIMIT_BACKFILL, SPEND_LIMIT_BACKFILL_VERSION, dropSpendLimits);
  if (changed > 0) console.log(`Spend limit backfill: cleared ${changed} accounts across ${users} users.`);
}
