import { Types } from "mongoose";
import { Contact, ContactClearance, Group, Transaction, TransactionDoc } from "../../models";
import { paidAhead } from "../budget/budget.commitmentShares";

/**
 * Who owes what, and the rules for saying so on a transaction.
 *
 * A person's part only means something where the transaction already says
 * part of it was not the user's own: a split (the rest is someone else's)
 * or settling up (all of it is between people). On anything else there is
 * nothing for a person to owe - the money was simply spent or earned.
 */

/** Digits only, and the last ten of an Indian number however it was written. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits.length >= 6 ? digits : null;
}

/** How much of a transaction can be put down to other people at all. */
export function shareablePart(
  transaction: Pick<TransactionDoc, "amountMinor" | "isSettlement" | "split">
): number {
  if (transaction.isSettlement) return transaction.amountMinor;
  const share = transaction.split?.myShareMinor;
  if (share === null || share === undefined) return 0;
  return Math.max(0, transaction.amountMinor - share);
}

/**
 * Checks a list of people against what a transaction will be once saved.
 * Returns a sentence saying what is wrong, or null when it is fine.
 */
export async function checkPeople(
  userId: Types.ObjectId,
  transaction: Pick<TransactionDoc, "amountMinor" | "isSettlement" | "split">,
  people: { contactId: string; amountMinor: number; elsewhereMinor?: number }[]
): Promise<string | null> {
  if (people.length === 0) return null;
  if (people.some((person) => (person.elsewhereMinor ?? 0) > person.amountMinor)) {
    return "More of someone's part is put down to Splitwise than their part comes to.";
  }

  const ids = people.map((person) => person.contactId);
  if (new Set(ids).size !== ids.length) return "The same person is on it twice.";

  const owned = await Contact.countDocuments({ userId, _id: { $in: ids } });
  if (owned !== ids.length) return "Unknown contact";

  const room = shareablePart(transaction);
  if (room === 0) {
    return "Mark it as split, or as settling up, to say who it was for.";
  }

  const total = people.reduce((sum, person) => sum + person.amountMinor, 0);
  if (total > room) {
    return `That's ₹${(total / 100).toFixed(2)} across people, but only ₹${(room / 100).toFixed(2)} of it wasn't yours.`;
  }
  return null;
}

export interface Balance {
  /** Positive: they owe the user. Negative: the user owes them. */
  balanceMinor: number;
  /** What they were lent or had paid for them, all told. */
  givenMinor: number;
  /** What has come back from them. */
  returnedMinor: number;
  /**
   * What was settled without money moving - see ContactClearance. Signed
   * like the balance: positive cleared what they owed, negative cleared
   * what the user owed them.
   */
  clearedMinor: number;
  /**
   * What groups say was owed with them when each began here - "Opening
   * balance in Flatmates · Rahul owes you 1,200". Signed like the balance,
   * and part of it. Apart from the contact's own opening balance, so each
   * shows as the row it is.
   */
  groupOpeningMinor: number;
  /// Of givenMinor, what was paid at a counter for them rather than lent.
  paidForMinor?: number;
  /**
   * Money they sent towards their part of a fixed cost the user hasn't
   * paid yet this month (or a later one) - rent sent a few days early.
   * Already back in the balance: it is not owed to them, only early.
   */
  aheadMinor?: number;
  transactionCount: number;
  lastAt: Date | null;
}

/**
 * A clearance as it moves a balance: what they owed goes down, what the
 * user owed goes up towards zero. The aggregation form of the same rule.
 */
const SIGNED_CLEARANCE = {
  $cond: [{ $eq: ["$direction", "OWED_TO_ME"] }, "$amountMinor", { $multiply: ["$amountMinor", -1] }],
};

/**
 * A group opening balance as it moves the setter's balance with a contact
 * (see GroupOpeningBalance): "owes_me" adds to what they owe, "i_owe"
 * takes from it - the same way round as a payment the user made for them
 * and one they made for the user. The aggregation form of signedOpening.
 */
const SIGNED_GROUP_OPENING = {
  $cond: [
    { $eq: ["$openingBalances.direction", "owes_me"] },
    "$openingBalances.amountMinor",
    { $multiply: ["$openingBalances.amountMinor", -1] },
  ],
};

/** Every group opening the user set with one of their contacts, unwound. */
function groupOpeningsPipeline(userId: Types.ObjectId, contactIds?: Types.ObjectId[]) {
  const match = {
    "openingBalances.setBy": userId,
    "openingBalances.memberKind": "contact",
    ...(contactIds ? { "openingBalances.contactId": { $in: contactIds } } : {}),
  };
  return [{ $match: match }, { $unwind: "$openingBalances" }, { $match: match }];
}

/**
 * Whether a person's part of a row is something they owe the user (a
 * payment the user made, split or lent) rather than something that
 * squares or reverses it (money in from them).
 *
 * A group payment somebody else made is a debit, but runs the other way:
 * the person on it is whoever paid, and their part is the user's share,
 * now owed to them - just as if they had lent it.
 */
const OWED_TO_ME = { $and: [{ $eq: ["$type", "DEBIT"] }, { $ne: ["$offLedger", true] }] };

/**
 * A person's part of a row as it counts between them and the user: all
 * of it, less whatever settled something kept in Splitwise.
 */
const PART_HERE = { $subtract: ["$people.amountMinor", { $ifNull: ["$people.elsewhereMinor", 0] }] };

/** The same, for a person's entry in hand. */
export function partHere(person: { amountMinor: number; elsewhereMinor?: number | null }): number {
  return person.amountMinor - (person.elsewhereMinor ?? 0);
}

/** The same rule, for a row in hand: +1 adds to what they owe, -1 takes from it. */
export function personSign(transaction: Pick<TransactionDoc, "type" | "offLedger">): 1 | -1 {
  return transaction.type === "DEBIT" && !transaction.offLedger ? 1 : -1;
}

/**
 * Every person's running balance, from the transactions that name them,
 * what groups say was owed with them when each began here, and whatever
 * was cleared with them since. The opening balance is the contact's own,
 * added by whoever has the contact to hand.
 */
export async function balances(userId: Types.ObjectId, contactIds?: Types.ObjectId[]) {
  const [rows, cleared, openings, ahead] = await Promise.all([
    Transaction.aggregate<{
      _id: Types.ObjectId;
      givenMinor: number;
      returnedMinor: number;
      paidForMinor: number;
      transactionCount: number;
      lastAt: Date;
    }>([
      { $match: { userId, "people.0": { $exists: true } } },
      { $unwind: "$people" },
      ...(contactIds ? [{ $match: { "people.contactId": { $in: contactIds } } }] : []),
      {
        $group: {
          _id: "$people.contactId",
          givenMinor: { $sum: { $cond: [OWED_TO_ME, PART_HERE, 0] } },
          returnedMinor: { $sum: { $cond: [OWED_TO_ME, 0, PART_HERE] } },
          paidForMinor: {
            $sum: { $cond: [{ $and: [OWED_TO_ME, { $eq: ["$paidFor", true] }] }, PART_HERE, 0] },
          },
          transactionCount: { $sum: 1 },
          lastAt: { $max: "$occurredAt" },
        },
      },
    ]),
    ContactClearance.aggregate<{ _id: Types.ObjectId; clearedMinor: number; lastAt: Date }>([
      { $match: { userId, ...(contactIds ? { contactId: { $in: contactIds } } : {}) } },
      { $group: { _id: "$contactId", clearedMinor: { $sum: SIGNED_CLEARANCE }, lastAt: { $max: "$on" } } },
    ]),
    Group.aggregate<{ _id: Types.ObjectId; openingMinor: number; lastAt: Date }>([
      ...groupOpeningsPipeline(userId, contactIds),
      {
        $group: {
          _id: "$openingBalances.contactId",
          openingMinor: { $sum: SIGNED_GROUP_OPENING },
          lastAt: { $max: "$openingBalances.setAt" },
        },
      },
    ]),
    paidAhead(userId, contactIds),
  ]);

  const result = new Map<string, Balance>(
    rows.map((row) => [
      row._id.toString(),
      {
        balanceMinor: row.givenMinor - row.returnedMinor,
        givenMinor: row.givenMinor,
        returnedMinor: row.returnedMinor,
        paidForMinor: row.paidForMinor,
        clearedMinor: 0,
        groupOpeningMinor: 0,
        transactionCount: row.transactionCount,
        lastAt: row.lastAt,
      },
    ])
  );
  for (const row of cleared) {
    const key = row._id.toString();
    const balance = result.get(key) ?? { ...NO_BALANCE };
    result.set(key, {
      ...balance,
      balanceMinor: balance.balanceMinor - row.clearedMinor,
      clearedMinor: row.clearedMinor,
      lastAt: balance.lastAt && balance.lastAt > row.lastAt ? balance.lastAt : row.lastAt,
    });
  }
  for (const row of openings) {
    const key = row._id.toString();
    const balance = result.get(key) ?? { ...NO_BALANCE };
    result.set(key, {
      ...balance,
      balanceMinor: balance.balanceMinor + row.openingMinor,
      groupOpeningMinor: row.openingMinor,
      lastAt: balance.lastAt && balance.lastAt > row.lastAt ? balance.lastAt : row.lastAt,
    });
  }
  for (const [key, aheadMinor] of ahead) {
    const balance = result.get(key);
    if (!balance) continue;
    result.set(key, { ...balance, balanceMinor: balance.balanceMinor + aheadMinor, aheadMinor });
  }
  return result;
}

/**
 * What the pooled "people owe you" figures need on top of settlements'
 * own amounts: the part of them that settled something in Splitwise, and
 * rent people sent ahead of it going out - neither of which is owed.
 * Positive moves the pool towards people owing the user.
 */
export async function poolAdjustmentMinor(userId: Types.ObjectId): Promise<number> {
  const [elsewhere, ahead] = await Promise.all([
    Transaction.aggregate<{ _id: string; total: number }>([
      { $match: { userId, isSettlement: true, "people.elsewhereMinor": { $gt: 0 } } },
      { $group: { _id: "$type", total: { $sum: { $sum: "$people.elsewhereMinor" } } } },
    ]),
    paidAhead(userId),
  ]);
  // Splitwise money in was counted as paying the user back, and money out
  // as the user paying back: both undone.
  const inMinor = elsewhere.find((row) => row._id === "CREDIT")?.total ?? 0;
  const outMinor = elsewhere.find((row) => row._id === "DEBIT")?.total ?? 0;
  const aheadMinor = [...ahead.values()].reduce((sum, value) => sum + value, 0);
  return inMinor - outMinor + aheadMinor;
}

/**
 * What people owe the user, net, beyond what their transactions say:
 * every opening balance - each contact's own, and each one a group says
 * was owed with a contact when it began here - less everything cleared.
 * The pooled figures (the dashboard's, and analytics') start from split
 * bills, which know nothing of any of these, and add this so that they
 * agree with the People screen.
 */
export async function outsideTransactionsMinor(userId: Types.ObjectId): Promise<number> {
  const [opening, cleared, groupOpenings] = await Promise.all([
    Contact.aggregate<{ total: number }>([
      { $match: { userId } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$openingBalanceMinor", 0] } } } },
    ]),
    ContactClearance.aggregate<{ total: number }>([
      { $match: { userId } },
      { $group: { _id: null, total: { $sum: SIGNED_CLEARANCE } } },
    ]),
    Group.aggregate<{ total: number }>([
      ...groupOpeningsPipeline(userId),
      { $group: { _id: null, total: { $sum: SIGNED_GROUP_OPENING } } },
    ]),
  ]);
  return (opening[0]?.total ?? 0) + (groupOpenings[0]?.total ?? 0) - (cleared[0]?.total ?? 0);
}

/**
 * What one split row puts on the pool: the part of the bill that was not
 * the user's own. On a group payment somebody else made it goes the other
 * way - none of it was the user's money, and their share is owed to
 * whoever paid - so the same figure the People page shows comes out here.
 *
 * On a payment the user made in a group, only the part their own contacts
 * owe (its people): the rest of what was not theirs is owed by SpendLog
 * users in the group, and comes back through the group's settlement, not
 * through anyone on the People page.
 */
export const LENT_PART = {
  $cond: [
    { $eq: ["$offLedger", true] },
    { $multiply: [-1, { $ifNull: ["$split.myShareMinor", "$amountMinor"] }] },
    {
      $cond: [
        { $eq: ["$groupSplit", true] },
        { $sum: { $ifNull: ["$people.amountMinor", []] } },
        { $subtract: ["$amountMinor", "$split.myShareMinor"] },
      ],
    },
  ],
};

export const NO_BALANCE: Balance = {
  balanceMinor: 0,
  givenMinor: 0,
  returnedMinor: 0,
  clearedMinor: 0,
  groupOpeningMinor: 0,
  transactionCount: 0,
  lastAt: null,
};
