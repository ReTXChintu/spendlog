import { FilterQuery, HydratedDocument, Types } from "mongoose";
import {
  Category,
  Contact,
  Group,
  GroupDoc,
  GroupOpeningBalance,
  OpeningDirection,
  Transaction,
  TransactionDoc,
  User,
} from "../../models";
import { istDayKey } from "../../time";
import { syncMirrors } from "./groups.mirrors";
import { TripOpening, computeBalances, settle, shareOut } from "./groups.settlement";

/**
 * The one place in the app where a query is scoped by something other than
 * the signed-in user.
 *
 * Everything else ends in `userId: currentUserId(req)`, which is what keeps
 * one person's ledger out of another's. A group is shared on purpose, so
 * its reads are authorised by membership instead — and that exception
 * lives here, in one function, rather than being spelled out at each
 * endpoint where it could be forgotten.
 */
export async function assertGroupMember(groupId: string, userId: Types.ObjectId) {
  return Group.findOne({ _id: groupId, "members.userId": userId });
}

/** A group linked from Trippin, which still takes in what was spent inside its dates. */
export function autoAdds(group: Pick<GroupDoc, "source">): boolean {
  return group.source?.app === "trippin" && Boolean(group.source.linked);
}

/**
 * Which group, if any, a payment made at this moment goes into by itself.
 *
 * Only a group linked from Trippin: every other group is picked by hand,
 * in the editor, since "Flatmates" and "Office lunch" have no dates for a
 * payment to fall inside, and a trip's dates guessed wrong more often than
 * people liked.
 *
 * Matched on when the money was spent rather than when the message turned
 * up, so an SMS that syncs three days after the holiday still lands on the
 * holiday - and a finished trip still claims payments inside its window.
 */
export async function groupForOccurredAt(
  userId: Types.ObjectId,
  occurredAt: Date
): Promise<Types.ObjectId | null> {
  const group = await Group.findOne({
    "source.app": "trippin",
    "source.linked": true,
    archivedAt: null,
    // Only from the point this person joined. Someone who joins on day
    // three is sharing the trip from then on, not handing over the
    // spending they did before it — that stays theirs to add on purpose.
    members: { $elemMatch: { userId, joinedAt: { $lte: occurredAt } } },
    startedAt: { $ne: null, $lte: occurredAt },
    $or: [{ endedAt: null }, { endedAt: { $gte: occurredAt } }],
  })
    // The most recently started wins, on the grounds that two overlapping
    // windows almost certainly means the newer one is the intended answer.
    .sort({ startedAt: -1 });

  return group?._id ?? null;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A short code to read out or show as a QR.
 *
 * The alphabet leaves out the characters people misread to each other —
 * O and 0, I and 1 — because this gets spoken across a dinner table as
 * often as it gets scanned.
 */
export function generateJoinCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Whether a group is "running" in the sense trips had: dated, not
 * archived, and under way. No longer what makes a group active - that is
 * simply not being archived - but still what the Trippin overlap rule and
 * the old /trips routes mean by it.
 *
 * Dated with no end runs until it is given one; with both dates, between
 * them, the way a Trippin trip from the 3rd to the 7th is on while it is
 * the 5th.
 */
export function isGroupRunning(
  group: Pick<GroupDoc, "startedAt" | "endedAt" | "archivedAt">,
  now = new Date()
): boolean {
  if (group.archivedAt || !group.startedAt) return false;
  if (!group.endedAt) return true;
  return group.startedAt <= now && group.endedAt >= now;
}

/** The query form of isGroupRunning, to merge into a group filter. */
export function runningAt(now = new Date()): FilterQuery<GroupDoc> {
  return {
    archivedAt: null,
    startedAt: { $ne: null },
    $or: [{ endedAt: null }, { startedAt: { $lte: now }, endedAt: { $gte: now } }],
  };
}

/**
 * Files everything inside a dated group's window that is in no group yet.
 * Only ever called for a group that takes payments in by itself (see
 * autoAdds) - a Trippin trip.
 *
 * Leaves anything hand-edited alone, which is how a transaction taken out
 * on purpose stays out - the same rule that stops automatic passes
 * overwriting corrections elsewhere.
 *
 * With `respectJoins`, each member's share of the window starts when they
 * joined rather than when the group did: someone added on day three shares
 * the trip from then on, not the days before it.
 */
export async function claimTransactions(
  group: Pick<GroupDoc, "_id" | "members" | "startedAt" | "endedAt">,
  onlyUserId?: Types.ObjectId,
  respectJoins = false
): Promise<number> {
  let claimed = 0;
  for (const filter of claimFilters(group, onlyUserId, respectJoins)) {
    const result = await Transaction.updateMany(filter, { $set: { groupId: group._id } });
    claimed += result.modifiedCount;
  }

  // A contact in the group has a share of what was just taken in.
  if (claimed > 0) await resyncGroup(group._id);
  return claimed;
}

/** How many payments claimTransactions would take in, without taking them. */
export async function countClaimable(
  group: Pick<GroupDoc, "members" | "startedAt" | "endedAt">,
  respectJoins = false
): Promise<number> {
  let count = 0;
  for (const filter of claimFilters(group, undefined, respectJoins)) {
    count += await Transaction.countDocuments(filter);
  }
  return count;
}

/** The queries behind claimTransactions: one, or one per member with respectJoins. */
function claimFilters(
  group: Pick<GroupDoc, "members" | "startedAt" | "endedAt">,
  onlyUserId?: Types.ObjectId,
  respectJoins = false
): FilterQuery<TransactionDoc>[] {
  if (!group.startedAt) return [];
  const startedAt = group.startedAt;
  const until = group.endedAt ? { $lte: group.endedAt } : {};
  // Never a payment somebody else made: it was put in its group on purpose.
  const base = { groupId: null, editedAt: null, offLedger: { $ne: true } };

  if (!respectJoins) {
    const memberIds = onlyUserId ? [onlyUserId] : group.members.map((member) => member.userId);
    return [{ ...base, userId: { $in: memberIds }, occurredAt: { $gte: startedAt, ...until } }];
  }
  const filters: FilterQuery<TransactionDoc>[] = [];
  for (const member of group.members) {
    if (onlyUserId && !member.userId.equals(onlyUserId)) continue;
    const from = member.joinedAt > startedAt ? member.joinedAt : startedAt;
    if (group.endedAt && from > group.endedAt) continue;
    filters.push({ ...base, userId: member.userId, occurredAt: { $gte: from, ...until } });
  }
  return filters;
}

/** Everyone in a group by id: its SpendLog users and its contacts, as strings. */
export function groupMemberIds(group: Pick<GroupDoc, "members" | "contactMembers">): string[] {
  return [
    ...group.members.map((member) => member.userId.toString()),
    ...(group.contactMembers ?? []).map((member) => member.contactId.toString()),
  ];
}

type GroupRow = Pick<
  TransactionDoc,
  "userId" | "amountMinor" | "countedAmountMinor" | "groupShareWith" | "groupSplit" | "paidBy"
>;

/** Who paid for a group row: the contact who did, or the row's owner. */
export function payerOf(row: Pick<TransactionDoc, "userId" | "paidBy">): string {
  return (row.paidBy?.contactId ?? row.userId).toString();
}

/**
 * What a row puts into the group's arithmetic.
 *
 * Its counted amount, so a refunded hotel and a bill split with somebody
 * outside the group both behave without this knowing anything about
 * refunds or splits - except where the group itself wrote the split. Then
 * the counted amount is already the payer's share after the group's
 * contacts, and the whole bill is what the group shares.
 */
export function groupAmountOf(row: GroupRow): number {
  return row.groupSplit ? row.amountMinor : row.countedAmountMinor;
}

/** Who a row was for: the ones named, or everyone in the group. */
export function sharersOf(row: Pick<TransactionDoc, "groupShareWith">, memberIds: string[]): string[] {
  return row.groupShareWith?.length ? row.groupShareWith.map((id) => id.toString()) : memberIds;
}

/** The aggregation form of groupAmountOf. */
export const GROUP_AMOUNT = { $cond: [{ $eq: ["$groupSplit", true] }, "$amountMinor", "$countedAmountMinor"] };

/**
 * Whether a row is the kind a group can split: a plain payment, or one
 * the group split already. Anything marked otherwise - a transfer,
 * settling up, a card bill, a loan, an EMI, a split typed in by hand - was
 * marked by someone who knew better, and the group leaves it be.
 */
function groupCanSplit(
  row: Pick<
    TransactionDoc,
    "type" | "isTransfer" | "isSettlement" | "cardPaymentFor" | "emiRole" | "loanId" | "groupSplit" | "split" | "people"
  >
): boolean {
  if (row.type !== "DEBIT") return false;
  if (row.isTransfer || row.isSettlement || row.cardPaymentFor || row.emiRole || row.loanId) return false;
  if (row.groupSplit) return true;
  return !row.split && row.people.length === 0;
}

const sameShares = (a: { contactId: unknown; amountMinor: number }[], b: { contactId: unknown; amountMinor: number }[]) =>
  a.length === b.length &&
  a.every((entry, i) => String(entry.contactId) === String(b[i].contactId) && entry.amountMinor === b[i].amountMinor);

type SplitRow = Pick<
  TransactionDoc,
  | "userId"
  | "type"
  | "amountMinor"
  | "groupId"
  | "groupShareWith"
  | "groupSplit"
  | "paidBy"
  | "split"
  | "people"
  | "isTransfer"
  | "isSettlement"
  | "cardPaymentFor"
  | "emiRole"
  | "loanId"
  | "mirrorOf"
>;

/** What the group writes on a row: its split and people, or nothing (null). */
export type GroupSplitFields = {
  split: { myShareMinor: number; groupLabel: string };
  people: { contactId: Types.ObjectId; amountMinor: number }[];
} | null;

/**
 * What a group row's split should be, worked out without saving: "keep"
 * when the row is already right, the fields to write otherwise (null takes
 * the group's split off). The one rule, for syncGroupSplit and for the
 * pass that mends rows saved under the old one.
 *
 * On a payment the row's owner made, only their own share of it is their
 * spending, whoever else it was shared with. Everyone else's share comes
 * back to them: each of *their* contacts' through the People page (as
 * people on the row); a SpendLog user's, and a contact of somebody else's,
 * through the group's settlement. So the split is the owner's share, and
 * the people are their contacts - and a payment that was the owner's alone
 * ("just mine") needs no split at all.
 *
 * On a payment one of their contacts made (offLedger), the owner's own
 * share is what they spent, and what they now owe that contact.
 *
 * A row that has left its group gives back what the group wrote - except
 * a payment somebody else made, which only ever made sense with its
 * shares, and keeps them.
 */
export function groupSplitFor(
  row: SplitRow,
  group: Pick<GroupDoc, "_id" | "name" | "members" | "contactMembers"> | null
): GroupSplitFields | "keep" {
  const paidByContact = row.paidBy?.contactId ?? null;
  const clear = () => (row.groupSplit ? null : "keep");

  // A mirror's split is its source's share of it, kept by syncMirrors.
  if (row.mirrorOf) return "keep";
  if (!group) return paidByContact ? "keep" : clear();
  if (!paidByContact && !groupCanSplit(row)) return clear();

  const shares = shareOut(row.amountMinor, sharersOf(row, groupMemberIds(group)));
  const owner = row.userId.toString();
  const myShareMinor = shares.get(owner) ?? 0;

  let people: { contactId: Types.ObjectId; amountMinor: number }[];
  if (paidByContact) {
    people = myShareMinor > 0 ? [{ contactId: paidByContact, amountMinor: myShareMinor }] : [];
  } else {
    const mine = group.contactMembers.filter((member) => member.addedBy.equals(row.userId));
    people = mine
      .map((member) => ({ contactId: member.contactId, amountMinor: shares.get(member.contactId.toString()) ?? 0 }))
      .filter((person) => person.amountMinor > 0);
    // All of it the owner's own: an ordinary payment, nothing to split.
    if (people.length === 0 && myShareMinor >= row.amountMinor) return clear();
  }

  const groupLabel = group.name.slice(0, 60);
  const unchanged =
    row.groupSplit &&
    row.split?.myShareMinor === myShareMinor &&
    row.split?.groupLabel === groupLabel &&
    sameShares(row.people, people);
  if (unchanged) return "keep";

  return { split: { myShareMinor, groupLabel }, people };
}

/**
 * Writes a group row's split onto it - the owner's share, and their
 * contacts' - as the split and people the rest of the app already
 * understands (see groupSplitFor for the rule). Saves when anything
 * changed, so the counted amount follows; returns whether it did.
 */
export async function syncGroupSplit(
  row: HydratedDocument<TransactionDoc>,
  known?: HydratedDocument<GroupDoc> | null
): Promise<boolean> {
  const group = row.groupId ? (known && known._id.equals(row.groupId) ? known : await Group.findById(row.groupId)) : null;
  const next = groupSplitFor(row, group);
  if (next !== "keep") {
    row.split = next ? next.split : null;
    row.people = next ? next.people : [];
    row.groupSplit = Boolean(next);
    await row.save();
  }
  // The other SpendLog users' shares of it, in their own ledgers - written,
  // brought up to date or taken away for what the row is now.
  await syncMirrors(row, group);
  return next !== "keep";
}

/**
 * Every row in a group, its shares brought up to date: after someone
 * joins or leaves, or a contact is added or taken off.
 */
export async function resyncGroup(groupId: Types.ObjectId): Promise<number> {
  const group = await Group.findById(groupId);
  if (!group) return 0;

  let changed = 0;
  const rows = await Transaction.find({ groupId, type: "DEBIT", mirrorOf: null });
  for (const row of rows) {
    if (await syncGroupSplit(row, group)) changed += 1;
  }
  return changed;
}

/**
 * A contact deleted from the People page leaves every group they were in.
 * Their part of each payment has already been taken off the rows; the
 * shares are worked out again among whoever is left.
 */
export async function removeContactFromGroups(contactId: Types.ObjectId): Promise<void> {
  const groups = await Group.find({
    $or: [{ "contactMembers.contactId": contactId }, { "openingBalances.contactId": contactId }],
  });
  for (const group of groups) {
    group.contactMembers = group.contactMembers.filter((member) => !member.contactId.equals(contactId));
    dropContactOpenings(group, contactId);
    await group.save();
    await resyncGroup(group._id);
  }
}

/** A name for every id in a group - users' and contacts' - and which each is. */
export async function groupDirectory(group: Pick<GroupDoc, "contactMembers">, ids: string[]) {
  const unique = [...new Set(ids)].filter((id) => Types.ObjectId.isValid(id));
  const [users, contacts] = await Promise.all([
    User.find({ _id: { $in: unique } }).select("name email").lean(),
    Contact.find({ _id: { $in: unique } }).select("name phone userId").lean(),
  ]);

  const directory = new Map<string, { name: string; kind: "user" | "contact" }>();
  for (const user of users) directory.set(user._id.toString(), { name: user.name ?? user.email ?? "Someone", kind: "user" });
  for (const contact of contacts) directory.set(contact._id.toString(), { name: contact.name, kind: "contact" });
  // A contact deleted since is still a contact, if nameless.
  for (const member of group.contactMembers ?? []) {
    const id = member.contactId.toString();
    if (!directory.has(id)) directory.set(id, { name: "Someone", kind: "contact" });
  }
  return {
    nameOf: (id: string) => directory.get(id)?.name ?? "Someone",
    kindOf: (id: string): "user" | "contact" => directory.get(id)?.kind ?? "user",
  };
}

/** What a group cost, and where it went. */
export async function groupSpendSummary(group: Pick<GroupDoc, "_id" | "contactMembers">) {
  // Never a mirror: it is one member's share of a row already here.
  const rows = await Transaction.find({ groupId: group._id, type: "DEBIT", mirrorOf: null })
    .select("userId paidBy amountMinor countedAmountMinor groupSplit categoryId occurredAt")
    .lean();
  const categoryIds = [...new Set(rows.map((row) => row.categoryId?.toString()).filter(Boolean))];
  const categories = await Category.find({ _id: { $in: categoryIds } }).select("name").lean();
  const categoryName = new Map(categories.map((category) => [category._id.toString(), category.name]));

  const byPayer = new Map<string, { spentMinor: number; count: number }>();
  const byCategory = new Map<string, { categoryId: Types.ObjectId | null; amountMinor: number; name: string }>();
  const days = new Set<string>();
  let totalMinor = 0;

  for (const row of rows) {
    const amount = groupAmountOf(row);
    totalMinor += amount;
    // Days actually spent money on, not days elapsed: a trip with a quiet
    // Sunday should not look cheaper per day because of it.
    days.add(istDayKey(row.occurredAt));

    const payer = payerOf(row);
    const entry = byPayer.get(payer) ?? { spentMinor: 0, count: 0 };
    entry.spentMinor += amount;
    entry.count += 1;
    byPayer.set(payer, entry);

    if (amount > 0) {
      const key = row.categoryId?.toString() ?? "none";
      const name = categoryName.get(key) ?? "Uncategorized";
      const category = byCategory.get(key) ?? { categoryId: row.categoryId ?? null, amountMinor: 0, name };
      category.amountMinor += amount;
      byCategory.set(key, category);
    }
  }

  const directory = await groupDirectory(group, [...byPayer.keys()]);
  const dayCount = days.size;

  return {
    totalMinor,
    transactionCount: rows.length,
    dayCount,
    perDayMinor: dayCount === 0 ? 0 : Math.round(totalMinor / dayCount),
    byMember: [...byPayer.entries()]
      .map(([id, entry]) => ({ userId: id, kind: directory.kindOf(id), name: directory.nameOf(id), ...entry }))
      .sort((a, b) => b.spentMinor - a.spentMinor),
    byCategory: [...byCategory.values()].sort((a, b) => b.amountMinor - a.amountMinor),
  };
}

/**
 * Who owes whom in a group, and the payments that square it off.
 *
 * Every expense is shared by everyone in the group unless it says
 * otherwise, which is the common case and saves marking each one up.
 * Contacts are people here like anyone else: what one paid for the group
 * is on their side, and their share of everything else on the other.
 *
 * It starts from the group's opening balances - what members owed each
 * other before any payment here - which move each person's net without
 * counting as anything they paid or had spent on them (openingMinor).
 *
 * The People page keeps its own, direct balance per contact - what they
 * owe *you* across every group and loan. This is the group's view, with
 * the fewest payments that settle everyone.
 */
export async function groupSettlement(
  group: Pick<GroupDoc, "_id" | "members" | "contactMembers" | "openingBalances">,
  viewerId?: Types.ObjectId | string | null
) {
  const memberIds = groupMemberIds(group);

  const transactions = await Transaction.find({
    groupId: group._id,
    type: "DEBIT",
    mirrorOf: null,
    $or: [{ countedAmountMinor: { $gt: 0 } }, { groupSplit: true }],
  }).select("userId paidBy amountMinor countedAmountMinor groupShareWith groupSplit");

  const expenses = transactions
    .map((transaction) => ({
      payerId: payerOf(transaction),
      amountMinor: groupAmountOf(transaction),
      sharerIds: sharersOf(transaction, memberIds),
    }))
    .filter((expense) => expense.amountMinor > 0);

  const openings = (group.openingBalances ?? []).map(openingParties);
  const balances = computeBalances(expenses, openings);
  const transfers = settle(balances);

  // Anyone who has left still appears in the arithmetic, so their name has
  // to be resolvable too.
  const directory = await groupDirectory(group, [...balances.map((b) => b.userId), ...memberIds]);
  const viewer = viewerId ? viewerId.toString() : null;

  return {
    balances: balances.map((balance) => ({
      ...balance,
      kind: directory.kindOf(balance.userId),
      name: directory.nameOf(balance.userId),
      isMe: balance.userId === viewer,
    })),
    transfers: transfers.map((transfer) => ({
      ...transfer,
      fromKind: directory.kindOf(transfer.fromUserId),
      toKind: directory.kindOf(transfer.toUserId),
      fromName: directory.nameOf(transfer.fromUserId),
      toName: directory.nameOf(transfer.toUserId),
    })),
  };
}

export class GroupPaymentError extends Error {}

/**
 * Records a group payment somebody else made: "Rahul paid 2,000 for
 * dinner". The payer is one of the user's own contacts in the group; no
 * account of the user's moved, so the row is off the ledger, and the
 * user's share - all of it, some of it, or none, by shareWith - is what
 * they spent and what they owe Rahul.
 */
export async function createPaidByContact(
  userId: Types.ObjectId,
  group: HydratedDocument<GroupDoc>,
  body: {
    contactId: string;
    amountMinor: number;
    occurredAt: Date;
    merchant?: string | null;
    note?: string | null;
    categoryId?: string | null;
    currency?: string;
    shareWith?: string[] | null;
  }
) {
  const contact = group.contactMembers.find(
    (member) => member.contactId.toString() === body.contactId && member.addedBy.equals(userId)
  );
  if (!contact) throw new GroupPaymentError("Add them to the group from your contacts first.");

  const shareWith = await checkShareWith(group, body.shareWith);

  const created = await Transaction.create({
    userId,
    amountMinor: body.amountMinor,
    currency: body.currency ?? "INR",
    type: "DEBIT",
    merchant: body.merchant ?? null,
    note: body.note ?? null,
    categoryId: body.categoryId ?? null,
    accountId: null,
    accountUnknown: false,
    offLedger: true,
    paidBy: { contactId: contact.contactId, userId: null },
    groupId: group._id,
    groupShareWith: shareWith,
    occurredAt: body.occurredAt,
    source: "MANUAL",
    editedAt: new Date(),
  });
  await syncGroupSplit(created, group);
  return created;
}

/**
 * A share-with list checked against the group: everyone named is in it.
 * null, or an empty list, means everyone.
 */
export async function checkShareWith(
  group: Pick<GroupDoc, "members" | "contactMembers">,
  shareWith: string[] | null | undefined
): Promise<Types.ObjectId[] | null> {
  if (!shareWith || shareWith.length === 0) return null;
  const members = new Set(groupMemberIds(group));
  const unique = [...new Set(shareWith)];
  if (unique.some((id) => !members.has(id))) {
    throw new GroupPaymentError("Everyone it's shared with has to be in the group.");
  }
  return unique.map((id) => new Types.ObjectId(id));
}

/**
 * Opening balances - what members owed each other when the group began
 * here (see GroupOpeningBalance). The sign rules, in one place:
 *
 * - From the setter's side, "owes_me" is +amount and "i_owe" is -amount:
 *   positive is owed to the setter, the way a People balance is signed.
 * - In the group's settlement the member is on the other side of it: an
 *   opening of +1,200 puts the setter 1,200 ahead and the member 1,200
 *   behind (see openingParties).
 * - With a contact, the same signed amount is added to the setter's
 *   People balance with them, exactly as a payment the setter made for
 *   them (+) or one the contact made for the setter (-) would be.
 */
type OpeningLike = Pick<GroupOpeningBalance, "memberKind" | "contactId" | "userId" | "direction" | "amountMinor" | "setBy">;

/** The member an opening is with, by id. */
export function openingMemberId(entry: Pick<GroupOpeningBalance, "memberKind" | "contactId" | "userId">): string {
  return String((entry.memberKind === "contact" ? entry.contactId : entry.userId) ?? "");
}

/** Signed from the setter's side: positive owed to them, negative owed by them. */
export function signedOpening(entry: Pick<GroupOpeningBalance, "direction" | "amountMinor">): number {
  return entry.direction === "owes_me" ? entry.amountMinor : -entry.amountMinor;
}

/** An opening turned into who owes whom: `fromId` owes `toId`. */
export function openingParties(entry: OpeningLike): TripOpening {
  const setter = entry.setBy.toString();
  const member = openingMemberId(entry);
  return entry.direction === "owes_me"
    ? { fromId: member, toId: setter, amountMinor: entry.amountMinor }
    : { fromId: setter, toId: member, amountMinor: entry.amountMinor };
}

/** A contact gone from the group takes their openings with them, as it does their shares. */
export function dropContactOpenings(group: Pick<GroupDoc, "openingBalances">, contactId: Types.ObjectId) {
  group.openingBalances = (group.openingBalances ?? []).filter(
    (entry) => !(entry.memberKind === "contact" && entry.contactId?.equals(contactId))
  );
}

export class GroupOpeningError extends Error {}

export interface OpeningInput {
  memberKind: "contact" | "user";
  contactId?: string | null;
  userId?: string | null;
  direction: OpeningDirection;
  amountMinor: number;
  note?: string | null;
}

/**
 * Replaces everything one member has set as opening balances in a group
 * with `entries`, after checking each one. An entry of nothing (amount 0)
 * is the same as leaving it out: that opening is taken away.
 *
 * Who an opening can be with:
 * - one of the setter's own contacts in the group. A contact belongs to
 *   whoever added them, and so does their People balance; someone else's
 *   contact is theirs to set.
 * - another SpendLog user in the group - once. If they already set one
 *   with the setter, that is the opening between the two of them, and a
 *   second from the other side would count the same debt twice.
 *
 * An entry the same as one already there keeps its id and when it was set.
 * Does not save.
 */
export function setOpenings(group: HydratedDocument<GroupDoc>, setterId: Types.ObjectId, entries: OpeningInput[]) {
  const setter = setterId.toString();
  const seen = new Set<string>();
  const checked: Omit<GroupOpeningBalance, "_id" | "setAt">[] = [];

  for (const entry of entries) {
    if (entry.amountMinor <= 0) continue;
    const memberId = String((entry.memberKind === "contact" ? entry.contactId : entry.userId) ?? "");
    if (!Types.ObjectId.isValid(memberId)) throw new GroupOpeningError("Say who each starting balance is with.");
    if (seen.has(memberId)) throw new GroupOpeningError("The same person is on it twice.");
    seen.add(memberId);

    if (entry.memberKind === "contact") {
      const member = group.contactMembers.find((m) => m.contactId.toString() === memberId);
      if (!member) throw new GroupOpeningError("Everyone with a starting balance has to be in the group.");
      if (!member.addedBy.equals(setterId)) {
        throw new GroupOpeningError("Only whoever added a contact can set what's owed with them.");
      }
    } else {
      if (memberId === setter) throw new GroupOpeningError("A starting balance is with somebody else.");
      if (!group.members.some((m) => m.userId.toString() === memberId)) {
        throw new GroupOpeningError("Everyone with a starting balance has to be in the group.");
      }
      const theirs = group.openingBalances.find(
        (o) => o.memberKind === "user" && o.setBy.toString() === memberId && o.userId?.toString() === setter
      );
      if (theirs) {
        throw new GroupOpeningError(
          "They've already set what's owed between the two of you. Ask them to change it, so it isn't counted twice."
        );
      }
    }

    checked.push({
      memberKind: entry.memberKind,
      contactId: entry.memberKind === "contact" ? new Types.ObjectId(memberId) : null,
      userId: entry.memberKind === "user" ? new Types.ObjectId(memberId) : null,
      direction: entry.direction,
      amountMinor: entry.amountMinor,
      setBy: setterId,
      note: entry.note?.trim() || null,
    });
  }

  const before = group.openingBalances.filter((o) => o.setBy.equals(setterId));
  const others = group.openingBalances.filter((o) => !o.setBy.equals(setterId));
  const now = new Date();
  const next = checked.map((entry) => {
    const same = before.find(
      (o) =>
        openingMemberId(o) === openingMemberId(entry) &&
        o.memberKind === entry.memberKind &&
        o.direction === entry.direction &&
        o.amountMinor === entry.amountMinor &&
        (o.note ?? null) === entry.note
    );
    return same ? same : { ...entry, setAt: now };
  });
  group.openingBalances = [...others, ...next] as GroupDoc["openingBalances"];
}

/**
 * A group's opening balances as the clients get them, from the viewer's
 * side: every one, with both people named, which way it runs (`fromId`
 * owes `toId`), and - where the viewer is one of the two - which way it
 * runs for them. Someone who did not set an opening sees the mirror of
 * it: "Rahul owes me 1,200", set by Rahul's flatmate, is "you owe" to Rahul.
 */
export async function groupOpeningsJson(
  group: Pick<GroupDoc, "openingBalances" | "contactMembers">,
  viewerId: Types.ObjectId | string
) {
  const entries = group.openingBalances ?? [];
  if (entries.length === 0) return [];
  const viewer = viewerId.toString();
  const directory = await groupDirectory(group, [
    ...entries.map((entry) => entry.setBy.toString()),
    ...entries.map((entry) => openingMemberId(entry)),
  ]);

  return entries.map((entry) => {
    const parties = openingParties(entry);
    const memberId = openingMemberId(entry);
    const setBy = entry.setBy.toString();
    const viewerDirection =
      parties.toId === viewer ? "owes_me" : parties.fromId === viewer ? "i_owe" : null;
    return {
      id: entry._id.toString(),
      memberKind: entry.memberKind,
      memberId,
      memberName: directory.nameOf(memberId),
      contactId: entry.contactId ?? null,
      userId: entry.userId ?? null,
      direction: entry.direction,
      amountMinor: entry.amountMinor,
      note: entry.note ?? null,
      setBy,
      setByName: directory.nameOf(setBy),
      setAt: entry.setAt,
      isMine: setBy === viewer,
      fromId: parties.fromId,
      fromName: directory.nameOf(parties.fromId),
      toId: parties.toId,
      toName: directory.nameOf(parties.toId),
      viewerDirection,
    };
  });
}

// The names these went by while groups were trips.
export const assertTripMember = assertGroupMember;
export const tripForOccurredAt = groupForOccurredAt;
export const tripSpendSummary = groupSpendSummary;
export const tripSettlement = groupSettlement;
export const isTripActive = isGroupRunning;
