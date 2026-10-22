import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Group, GroupDoc, Transaction } from "../../models";
import { resolveCountedAmount } from "../../models/counted";
import { groupSplitFor } from "./groups.service";

/**
 * Mends group payments saved while a SpendLog user's share of them still
 * counted as the payer's spending.
 *
 * A dinner for three, paid by the user, used to count in full unless the
 * other two were the user's contacts: a flatmate on SpendLog had their
 * share settle inside the group, but it sat in the payer's monthly budget
 * all the same. The group now writes the payer's own share as the split
 * on every payment it shares (groupSplitFor); this applies that rule to
 * the rows saved before it.
 *
 * Bump the version if the rule changes and the old rows need it again.
 */
export const GROUP_SHARES_BACKFILL = "groupShares";
export const GROUP_SHARES_BACKFILL_VERSION = 1;

/**
 * One user's pass over their own group payments. Returns how many rows it
 * changed; a second run finds nothing, since groupSplitFor says "keep" for
 * a row that is already right.
 *
 * Written with updateOne rather than save(), like the lending backfill, so
 * a row from before some field existed is not held up by validation it was
 * never written against. The counted amount is set alongside, from the
 * same rule the hooks use.
 */
export async function backfillGroupShares(userId: Types.ObjectId): Promise<number> {
  const rows = await Transaction.find({ userId, groupId: { $ne: null }, type: "DEBIT" }).lean();
  if (rows.length === 0) return 0;

  const groupIds = [...new Set(rows.map((row) => row.groupId!.toString()))];
  const groups = new Map<string, GroupDoc>(
    (await Group.find({ _id: { $in: groupIds } }).lean()).map((group) => [group._id.toString(), group as GroupDoc])
  );

  let changed = 0;
  for (const row of rows) {
    const next = groupSplitFor(row, groups.get(row.groupId!.toString()) ?? null);
    if (next === "keep") continue;

    const patch = {
      split: next ? next.split : null,
      people: next ? next.people : [],
      groupSplit: Boolean(next),
    };
    const counted = resolveCountedAmount({ ...row, ...patch });
    await Transaction.updateOne({ _id: row._id }, { $set: { ...patch, ...counted } });
    changed += 1;
  }
  return changed;
}

/** Every user who has not had this pass yet. Called once at start-up. */
export async function runGroupSharesBackfill(): Promise<{ users: number; changed: number }> {
  const result = await runOncePerUser(GROUP_SHARES_BACKFILL, GROUP_SHARES_BACKFILL_VERSION, backfillGroupShares);
  if (result.users > 0) {
    console.log(`Group shares backfill: ${result.changed} transactions across ${result.users} users.`);
  }
  return result;
}
