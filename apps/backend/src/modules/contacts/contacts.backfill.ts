import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Contact, Transaction, lendingPatch } from "../../models";
import { resolveCountedAmount } from "../../models/counted";
import { peopleCategoryId } from "../categories/categories.system";

/**
 * Mends the money lent before lending stopped counting as spending.
 *
 * A row filed under Lent & borrowed with nothing else said about it used
 * to count in full - a friend's 5,000 sat in the monthly budget. The write
 * hooks now read such a row as lent (or, coming in, as paid back); this
 * applies the same rule, lendingPatch, to the rows saved before them.
 *
 * Bump the version if the rule changes and the old rows need it again.
 */
export const LENDING_BACKFILL = "lending";
export const LENDING_BACKFILL_VERSION = 1;

/**
 * One user's pass. Returns how many rows it changed; a second run finds
 * nothing left to change, because a converted row is no longer plain.
 *
 * Written with updateOne rather than save(), like backfill-counted, so a
 * row from before some field existed is not held up by validation it was
 * never written against. The counted amount is set alongside, from the
 * same rule the hooks use.
 */
export async function backfillLending(userId: Types.ObjectId): Promise<number> {
  const peopleCategory = await peopleCategoryId();
  if (!peopleCategory) return 0;

  const rows = await Transaction.find({ userId, categoryId: peopleCategory }).lean();
  if (rows.length === 0) return 0;

  // Someone with an opening balance may well have had these very rows put
  // into it by hand, since they never showed on the person: naming them on
  // the rows now would count that money twice. Their rows still stop
  // counting as spending; they just stay unnamed, for the user to name.
  const withOpening = new Set(
    (await Contact.find({ userId, openingBalanceMinor: { $nin: [0, null] } }).select("_id").lean()).map((contact) =>
      contact._id.toString()
    )
  );

  let changed = 0;
  for (const row of rows) {
    const patch = await lendingPatch(row);
    if (!patch) continue;

    const matched = row.people.length === 0 ? patch.people[0]?.contactId : undefined;
    if (matched && withOpening.has(matched.toString())) patch.people = [];

    const counted = resolveCountedAmount({ ...row, ...patch });
    await Transaction.updateOne({ _id: row._id }, { $set: { ...patch, ...counted } });
    changed += 1;
  }
  return changed;
}

/** Every user who has not had this pass yet. Called once at start-up. */
export async function runLendingBackfill(): Promise<void> {
  const { users, changed } = await runOncePerUser(LENDING_BACKFILL, LENDING_BACKFILL_VERSION, backfillLending);
  if (users > 0) console.log(`Lent & borrowed backfill: ${changed} transactions across ${users} users.`);
}
