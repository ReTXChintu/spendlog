import { HydratedDocument, Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Contact, Group, GroupDoc, Transaction, TransactionDoc, User } from "../../models";
import { groupMemberIds, rowShares } from "./groups.service";
import { noteShare } from "./groups.notify";

/**
 * My share of a group payment somebody else on SpendLog made.
 *
 * When Asha pays 3,000 for a dinner the three of us share, her row counts
 * her own 1,000 (groups.service: the group writes her share as its split)
 * and the other two thirds come back to her through the group's
 * settlement. Until now nothing at all appeared in my ledger - so my
 * monthly budget missed a 1,000 I had spent, and would miss it again when
 * I paid her back, since settling up counts as nothing.
 *
 * So the group writes a *mirror* into each sharer's ledger: a row the
 * shape of a payment a contact made (offLedger, the whole bill as its
 * amount, my share as its split), pointing back at Asha's row through
 * mirrorOf. It moves no account, counts my share in my budget, feeds no
 * balance - People, the group, the settlement all leave it out - and is
 * kept in step with her row by syncMirrors: her amount, date, group,
 * sharers and merchant are its, and it goes when her row does, leaves the
 * group, or stops being shared with me. Only its category is mine to
 * change, since what a dinner is to me is my business.
 */

/** The group fields the shares are worked out from. */
type GroupShape = Pick<GroupDoc, "_id" | "name" | "members" | "contactMembers">;

type Source = HydratedDocument<TransactionDoc> | (TransactionDoc & { _id: Types.ObjectId });

/** What a client is told when it tries to change a mirror beyond its category. */
export const MIRROR_EDIT_MESSAGE =
  "This is your share of a payment someone else made, so only its category can be changed here. The rest follows their payment.";
export const MIRROR_DELETE_MESSAGE =
  "This is your share of a payment someone else made. It goes when they take you off it, or take the payment out of the group.";

/**
 * Who should hold a mirror of this row, and for what share: every SpendLog
 * user it is shared with other than its owner. Someone who has left the
 * group but is still named on the row keeps theirs, the way the settlement
 * keeps them in its arithmetic. Empty for anything the group does not
 * share (see groupSplitFor): a row outside any group, money in, one the
 * group left alone, or a mirror itself.
 */
async function wantedMirrors(row: Source, group: GroupShape | null): Promise<Map<string, number>> {
  const wanted = new Map<string, number>();
  if (row.mirrorOf || !group || !row.groupId || row.type !== "DEBIT" || !row.groupSplit) return wanted;

  const shares = rowShares(row, row.amountMinor, groupMemberIds(group));
  const owner = row.userId.toString();
  const members = new Set(group.members.map((member) => member.userId.toString()));
  const named = [...shares.entries()].filter(([id, share]) => id !== owner && share > 0);

  // A current member is a user; anyone else named is one only if an
  // account says so - a contact's id never is.
  const strangers = named.map(([id]) => id).filter((id) => !members.has(id));
  const users = new Set(
    strangers.length === 0
      ? []
      : (await User.find({ _id: { $in: strangers } }).select("_id").lean()).map((user) => user._id.toString())
  );
  for (const [id, share] of named) {
    if (members.has(id) || users.has(id)) wanted.set(id, share);
  }
  return wanted;
}

/** Who paid, by name: the owner of the row, or the contact of theirs who did. */
async function payerName(row: Source): Promise<string> {
  if (row.paidBy?.contactId) {
    const contact = await Contact.findById(row.paidBy.contactId).select("name").lean();
    return contact?.name ?? "Someone";
  }
  const user = await User.findById(row.userId).select("name email").lean();
  return user?.name ?? user?.email ?? "Someone";
}

/** The fields a mirror takes from its source, and the share it is for. */
function mirrorFields(row: Source, group: GroupShape, share: number, paidByName: string) {
  return {
    amountMinor: row.amountMinor,
    currency: row.currency,
    merchant: row.merchant ?? null,
    note: row.note ?? null,
    occurredAt: row.occurredAt,
    pending: row.pending,
    groupId: group._id,
    groupShareWith: row.groupShareWith ?? null,
    groupShareAmounts: row.groupShareAmounts ?? null,
    groupSplit: true,
    offLedger: true,
    split: { myShareMinor: share, groupLabel: group.name.slice(0, 60) },
    people: [] as TransactionDoc["people"],
    // The payer, where they are a SpendLog user; nobody when a contact of
    // theirs paid, whose name is all the sharer gets to see.
    paidBy: { userId: row.paidBy?.contactId ? null : row.userId, contactId: null },
    mirrorPayerName: paidByName,
  };
}

const sameIds = (a: unknown[] | null | undefined, b: unknown[] | null | undefined) =>
  (a ?? []).length === (b ?? []).length && (a ?? []).every((id, i) => String(id) === String((b ?? [])[i]));

type Amounts = { memberId: unknown; amountMinor: number }[] | null | undefined;
const sameAmounts = (a: Amounts, b: Amounts) =>
  (a ?? []).length === (b ?? []).length &&
  (a ?? []).every(
    (entry, i) => String(entry.memberId) === String((b ?? [])[i].memberId) && entry.amountMinor === (b ?? [])[i].amountMinor
  );

/**
 * Brings the mirrors of one row up to date: written for whoever should
 * hold one and has none, kept in step for whoever has one, taken away
 * from whoever should not. Returns how many rows it wrote, changed or
 * removed; a second call straight after finds nothing to do.
 *
 * `known` saves a lookup when the caller already holds the group.
 */
export async function syncMirrors(row: Source, known?: GroupShape | null): Promise<number> {
  if (row.mirrorOf) return 0;

  const group: GroupShape | null = row.groupId
    ? known && known._id.equals(row.groupId)
      ? known
      : await Group.findById(row.groupId).select("name members contactMembers").lean()
    : null;

  const wanted = await wantedMirrors(row, group);
  const existing = await Transaction.find({ mirrorOf: row._id });
  let changed = 0;

  for (const mirror of existing) {
    const share = wanted.get(mirror.userId.toString());
    if (share === undefined) {
      await mirror.deleteOne();
      changed += 1;
    }
  }
  if (wanted.size === 0) return changed;

  const name = await payerName(row);
  const fields = (share: number) => mirrorFields(row, group!, share, name);

  for (const mirror of existing) {
    const share = wanted.get(mirror.userId.toString());
    if (share === undefined) continue;
    const next = fields(share);
    const unchanged =
      mirror.amountMinor === next.amountMinor &&
      mirror.currency === next.currency &&
      (mirror.merchant ?? null) === next.merchant &&
      (mirror.note ?? null) === next.note &&
      mirror.occurredAt.getTime() === next.occurredAt.getTime() &&
      mirror.pending === next.pending &&
      mirror.groupId?.equals(next.groupId) &&
      sameIds(mirror.groupShareWith, next.groupShareWith) &&
      sameAmounts(mirror.groupShareAmounts, next.groupShareAmounts) &&
      mirror.split?.myShareMinor === share &&
      mirror.split?.groupLabel === next.split.groupLabel &&
      String(mirror.paidBy?.userId ?? "") === String(next.paidBy.userId ?? "") &&
      mirror.mirrorPayerName === name &&
      // The payer's category is the mirror's until its holder picks their own.
      (mirror.editedAt || String(mirror.categoryId ?? "") === String(row.categoryId ?? ""));
    if (unchanged) continue;

    mirror.set(next);
    if (!mirror.editedAt) mirror.categoryId = row.categoryId ?? null;
    await mirror.save();
    changed += 1;
  }

  const holders = new Set(existing.map((mirror) => mirror.userId.toString()));
  for (const [userId, share] of wanted) {
    if (holders.has(userId)) continue;
    try {
      await Transaction.create({
        userId: new Types.ObjectId(userId),
        type: "DEBIT",
        categoryId: row.categoryId ?? null,
        accountId: null,
        accountUnknown: false,
        source: "MANUAL",
        mirrorOf: row._id,
        ...fields(share),
      });
      changed += 1;
      noteShare(new Types.ObjectId(userId), {
        groupId: group!._id.toString(),
        groupName: group!.name,
        payerName: name,
        what: row.merchant ?? row.note ?? null,
        shareMinor: share,
        occurredAt: row.occurredAt,
      });
    } catch (error) {
      // Two syncs of the same row at once: the other one wrote it.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  return changed;
}

/** Every mirror of these rows, gone with them. */
export async function removeMirrorsOf(sourceIds: Types.ObjectId[]): Promise<number> {
  if (sourceIds.length === 0) return 0;
  const result = await Transaction.deleteMany({ mirrorOf: { $in: sourceIds } });
  return result.deletedCount;
}

/**
 * Whether an edit to a mirror is one it allows: nothing but its category
 * (and a form re-sending what is already there). Returns the fields that
 * actually change, or the one it refuses.
 */
export function mirrorEdit(
  mirror: TransactionDoc,
  body: Record<string, unknown>
): { ok: true; categoryId?: string | null } | { ok: false; field: string } {
  const current = (key: string): unknown => (mirror as unknown as Record<string, unknown>)[key];
  const same = (key: string, value: unknown): boolean => {
    const stored = current(key);
    if (value instanceof Date) return stored instanceof Date && stored.getTime() === value.getTime();
    if (Array.isArray(value)) return sameIds(value, stored as unknown[]);
    if (value !== null && typeof value === "object") return JSON.stringify(value) === JSON.stringify(stored ?? null);
    if (stored instanceof Types.ObjectId) return String(stored) === String(value ?? "");
    return (stored ?? null) === (value ?? null) || (!stored && !value);
  };

  let categoryId: string | null | undefined;
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    if (key === "categoryId") {
      if (!same(key, value)) categoryId = value as string | null;
      continue;
    }
    if (key === "tripId" || key === "tripShareWith") continue;
    if (!same(key, value)) return { ok: false, field: key };
  }
  return { ok: true, categoryId };
}

/**
 * Mirrors for the group payments made before they were written: one pass
 * over every row a user shared through a group. Runs after the shares
 * pass (groups.backfill.ts), which is what marks those rows as shared.
 */
export const GROUP_MIRRORS_BACKFILL = "groupMirrors";
export const GROUP_MIRRORS_BACKFILL_VERSION = 1;

export async function backfillGroupMirrors(userId: Types.ObjectId): Promise<number> {
  const rows = await Transaction.find({ userId, groupId: { $ne: null }, type: "DEBIT", groupSplit: true, mirrorOf: null });
  if (rows.length === 0) return 0;

  const groupIds = [...new Set(rows.map((row) => row.groupId!.toString()))];
  const groups = new Map<string, GroupShape>(
    (await Group.find({ _id: { $in: groupIds } }).select("name members contactMembers").lean()).map((group) => [
      group._id.toString(),
      group as GroupShape,
    ])
  );

  let changed = 0;
  for (const row of rows) changed += await syncMirrors(row, groups.get(row.groupId!.toString()) ?? null);
  return changed;
}

export async function runGroupMirrorsBackfill(): Promise<{ users: number; changed: number }> {
  const result = await runOncePerUser(GROUP_MIRRORS_BACKFILL, GROUP_MIRRORS_BACKFILL_VERSION, backfillGroupMirrors);
  if (result.users > 0) {
    console.log(`Group mirrors backfill: ${result.changed} rows across ${result.users} users.`);
  }
  return result;
}
