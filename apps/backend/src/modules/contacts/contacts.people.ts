import { Types } from "mongoose";
import { Contact, ContactClearance, Transaction, TransactionDoc } from "../../models";

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
  people: { contactId: string; amountMinor: number }[]
): Promise<string | null> {
  if (people.length === 0) return null;

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
 * Every person's running balance, from the transactions that name them
 * and whatever was cleared with them since. The opening balance is the
 * contact's own, added by whoever has the contact to hand.
 */
export async function balances(userId: Types.ObjectId, contactIds?: Types.ObjectId[]) {
  const [rows, cleared] = await Promise.all([
    Transaction.aggregate<{
      _id: Types.ObjectId;
      givenMinor: number;
      returnedMinor: number;
      transactionCount: number;
      lastAt: Date;
    }>([
      { $match: { userId, "people.0": { $exists: true } } },
      { $unwind: "$people" },
      ...(contactIds ? [{ $match: { "people.contactId": { $in: contactIds } } }] : []),
      {
        $group: {
          _id: "$people.contactId",
          givenMinor: { $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, "$people.amountMinor", 0] } },
          returnedMinor: { $sum: { $cond: [{ $eq: ["$type", "CREDIT"] }, "$people.amountMinor", 0] } },
          transactionCount: { $sum: 1 },
          lastAt: { $max: "$occurredAt" },
        },
      },
    ]),
    ContactClearance.aggregate<{ _id: Types.ObjectId; clearedMinor: number; lastAt: Date }>([
      { $match: { userId, ...(contactIds ? { contactId: { $in: contactIds } } : {}) } },
      { $group: { _id: "$contactId", clearedMinor: { $sum: SIGNED_CLEARANCE }, lastAt: { $max: "$on" } } },
    ]),
  ]);

  const result = new Map<string, Balance>(
    rows.map((row) => [
      row._id.toString(),
      {
        balanceMinor: row.givenMinor - row.returnedMinor,
        givenMinor: row.givenMinor,
        returnedMinor: row.returnedMinor,
        clearedMinor: 0,
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
  return result;
}

/**
 * What people owe the user, net, beyond what their transactions say:
 * every opening balance, less everything cleared. The pooled figures (the
 * dashboard's, and analytics') start from split bills, which know nothing
 * of either, and add this so that they agree with the People screen.
 */
export async function outsideTransactionsMinor(userId: Types.ObjectId): Promise<number> {
  const [opening, cleared] = await Promise.all([
    Contact.aggregate<{ total: number }>([
      { $match: { userId } },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$openingBalanceMinor", 0] } } } },
    ]),
    ContactClearance.aggregate<{ total: number }>([
      { $match: { userId } },
      { $group: { _id: null, total: { $sum: SIGNED_CLEARANCE } } },
    ]),
  ]);
  return (opening[0]?.total ?? 0) - (cleared[0]?.total ?? 0);
}

export const NO_BALANCE: Balance = {
  balanceMinor: 0,
  givenMinor: 0,
  returnedMinor: 0,
  clearedMinor: 0,
  transactionCount: 0,
  lastAt: null,
};
