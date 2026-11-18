import { HydratedDocument, Types } from "mongoose";
import {
  Contact,
  FixedCommitment,
  FixedCommitmentDoc,
  Transaction,
  TransactionDoc,
  commitmentFullAmountFor,
} from "../../models";
import { BudgetPeriod, countedIn, monthKeyOf } from "./budget.period";
import { commitmentPeriod } from "./budget.pace";
import { userMonth } from "./budget.months";
import { runOncePerUser } from "../../backfill";

/**
 * Fixed costs other people pay the user back for.
 *
 * Rent of ₹11,500 goes out from the user's account, and three flatmates
 * each send their part back: ₹4,000, ₹4,000 and ₹3,000. Only ₹500 of it is
 * the user's own. Saved once on the fixed cost (its shares), this is what
 * every month's rent payment is split into - the user's part counted, each
 * flatmate's owed on People - and what the money they send back is put
 * towards, month by month, so Home can say who has paid this month's part.
 */

export class CommitmentShareError extends Error {}

const sum = (parts: { amountMinor: number }[]) => parts.reduce((total, part) => total + part.amountMinor, 0);

/** The people on a fixed cost, checked: the user's contacts, once each, no more than it comes to. */
export async function checkCommitmentShares(
  userId: Types.ObjectId,
  amountMinor: number,
  shares: { contactId: string; amountMinor: number }[]
): Promise<{ contactId: Types.ObjectId; amountMinor: number }[]> {
  if (shares.length === 0) return [];
  const ids = shares.map((share) => share.contactId);
  if (new Set(ids).size !== ids.length) throw new CommitmentShareError("The same person is on it twice.");
  if ((await Contact.countDocuments({ userId, _id: { $in: ids } })) !== ids.length) {
    throw new CommitmentShareError("Unknown contact");
  }
  const total = sum(shares);
  if (total > amountMinor) {
    throw new CommitmentShareError(
      `They pay back ₹${(total / 100).toFixed(2)}, more than the ₹${(amountMinor / 100).toFixed(2)} it comes to.`
    );
  }
  return shares.map((share) => ({ contactId: new Types.ObjectId(share.contactId), amountMinor: share.amountMinor }));
}

/**
 * How a payment towards a shared fixed cost splits: each person's part, the
 * user's the rest. A payment of the whole amount splits exactly as saved;
 * one of a different amount (part of the rent, or a month it changed)
 * keeps the same proportions, the user's part taking the leftover paise.
 */
export function commitmentSplit(
  commitment: Pick<FixedCommitmentDoc, "name" | "shares">,
  fullMinor: number,
  paymentMinor: number
): { split: { myShareMinor: number; groupLabel: string }; people: { contactId: Types.ObjectId; amountMinor: number }[] } {
  const exact = paymentMinor === fullMinor || fullMinor <= 0;
  const people = commitment.shares
    .map((share) => ({
      contactId: share.contactId,
      amountMinor: exact ? share.amountMinor : Math.floor((share.amountMinor * paymentMinor) / fullMinor),
    }))
    .filter((person) => person.amountMinor > 0);
  const others = Math.min(paymentMinor, sum(people));
  return { split: { myShareMinor: paymentMinor - others, groupLabel: commitment.name.slice(0, 60) }, people };
}

/** Whether a payment is one the rules elsewhere already split, or say is not spending at all. */
function alreadySaid(row: TransactionDoc): boolean {
  return (
    row.type !== "DEBIT" ||
    Boolean(row.split) ||
    row.people.length > 0 ||
    Boolean(row.groupId) ||
    row.isTransfer ||
    row.isSettlement ||
    Boolean(row.cardPaymentFor) ||
    Boolean(row.loanId) ||
    Boolean(row.emiRole) ||
    Boolean(row.offLedger)
  );
}

/**
 * Splits a payment towards a shared fixed cost by its people - once, and
 * only a payment nobody has split or marked otherwise. Returns whether it
 * changed the row.
 */
export async function applyCommitmentShares(row: HydratedDocument<TransactionDoc>, now = new Date()): Promise<boolean> {
  if (!row.commitmentId || alreadySaid(row)) return false;
  const commitment = await FixedCommitment.findOne({ _id: row.commitmentId, userId: row.userId });
  if (!commitment || commitment.shares.length === 0) return false;
  const period = await commitmentPeriod(row.userId, now);
  const { split, people } = commitmentSplit(commitment, commitmentFullAmountFor(commitment, period.key), row.amountMinor);
  row.split = split;
  row.people = people as TransactionDoc["people"];
  await row.save();
  return true;
}

/** Words without case, spacing or punctuation, for matching a payee. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * A payment that just arrived, linked to the shared fixed cost it is for -
 * and split. Narrow on purpose, since fixed costs are otherwise ticked off
 * by hand: only a fixed cost that has people paying the user back and a
 * payee saved, a payment that names that payee and comes to its amount to
 * the rupee, and a period with nothing linked to it yet.
 */
export async function linkSharedCommitment(row: HydratedDocument<TransactionDoc>, now = new Date()): Promise<boolean> {
  if (row.commitmentId || alreadySaid(row)) return false;
  const commitments = await FixedCommitment.find({
    userId: row.userId,
    isActive: true,
    "shares.0": { $exists: true },
    merchant: { $nin: [null, ""] },
  });
  if (commitments.length === 0) return false;

  const period = await commitmentPeriod(row.userId, now);
  const words = squash([row.merchant, row.rawText, ...row.sources.map((source) => source.rawText)].filter(Boolean).join(" "));
  for (const commitment of commitments) {
    const payee = squash(commitment.merchant ?? "");
    if (payee.length < 3 || !words.includes(payee)) continue;
    if (Math.abs(commitmentFullAmountFor(commitment, period.key) - row.amountMinor) > 100) continue;
    const taken = await Transaction.exists({
      userId: row.userId,
      commitmentId: commitment._id,
      type: "DEBIT",
      ...countedIn(period, monthKeyOf(period)),
    });
    if (taken) continue;

    row.commitmentId = commitment._id;
    if (!row.categoryId && commitment.categoryId) row.categoryId = commitment.categoryId;
    await row.save();
    await applyCommitmentShares(row, now);
    return true;
  }
  return false;
}

export interface ShareStatus {
  contactId: string;
  name: string;
  /// Their part this period, and what they have sent back towards it.
  amountMinor: number;
  paidMinor: number;
}

/**
 * Each person's part of each shared fixed cost for a period, and how much
 * of the money they sent back was put towards it.
 */
export async function shareStatusFor(
  userId: Types.ObjectId,
  commitments: Pick<FixedCommitmentDoc, "_id" | "shares">[],
  period: Pick<BudgetPeriod, "key">
): Promise<Map<string, ShareStatus[]>> {
  const shared = commitments.filter((commitment) => commitment.shares.length > 0);
  const result = new Map<string, ShareStatus[]>();
  if (shared.length === 0) return result;

  const contactIds = [...new Set(shared.flatMap((commitment) => commitment.shares.map((share) => share.contactId.toString())))];
  const [contacts, credits] = await Promise.all([
    Contact.find({ userId, _id: { $in: contactIds } }).select("name").lean(),
    Transaction.find({
      userId,
      type: "CREDIT",
      towards: { $elemMatch: { periodKey: period.key, commitmentId: { $in: shared.map((c) => c._id) } } },
    })
      .select("towards")
      .lean(),
  ]);
  const names = new Map(contacts.map((contact) => [contact._id.toString(), contact.name]));
  const paid = new Map<string, number>();
  for (const credit of credits) {
    for (const entry of credit.towards ?? []) {
      if (entry.periodKey !== period.key) continue;
      const key = `${entry.commitmentId}:${entry.contactId}`;
      paid.set(key, (paid.get(key) ?? 0) + entry.amountMinor);
    }
  }

  for (const commitment of shared) {
    result.set(
      commitment._id.toString(),
      commitment.shares.map((share) => ({
        contactId: share.contactId.toString(),
        name: names.get(share.contactId.toString()) ?? "Someone",
        amountMinor: share.amountMinor,
        paidMinor: paid.get(`${commitment._id}:${share.contactId}`) ?? 0,
      }))
    );
  }
  return result;
}

export class TowardsError extends Error {}

/**
 * What money in from people was put towards, checked against the row it
 * will be: each entry is for a fixed cost of the user's that the person
 * is on, and no person is put down for more than their part of the row.
 *
 * Money sent on to another month (Transaction.countInMonth) is for that
 * month's period, whatever period it was put down for. Roommates who pay
 * the rent a few days before pay day are paying the coming month's -
 * which is exactly what sending it on says - and the editor only ever
 * offered the period that was current when it was opened.
 */
export async function checkTowards(
  userId: Types.ObjectId,
  people: { contactId: string; amountMinor: number; elsewhereMinor?: number }[],
  towards: { commitmentId: string; contactId: string; periodKey: string; amountMinor: number }[],
  countInMonth: string | null = null
): Promise<{ commitmentId: Types.ObjectId; contactId: Types.ObjectId; periodKey: string; amountMinor: number }[]> {
  if (towards.length === 0) return [];
  const forPeriod = countInMonth ? (await userMonth(userId, countInMonth)).from : null;
  const commitments = await FixedCommitment.find({ userId, _id: { $in: towards.map((entry) => entry.commitmentId) } })
    .select("shares name")
    .lean();
  const byId = new Map(commitments.map((commitment) => [commitment._id.toString(), commitment]));
  const byPerson = new Map<string, number>();
  for (const entry of towards) {
    const commitment = byId.get(entry.commitmentId);
    if (!commitment) throw new TowardsError("Unknown fixed cost");
    if (!commitment.shares.some((share) => share.contactId.toString() === entry.contactId)) {
      throw new TowardsError(`They aren't one of the people paying for ${commitment.name}.`);
    }
    byPerson.set(entry.contactId, (byPerson.get(entry.contactId) ?? 0) + entry.amountMinor);
  }
  for (const [contactId, total] of byPerson) {
    const person = people.find((entry) => entry.contactId === contactId);
    const elsewhere = person?.elsewhereMinor ?? 0;
    // What settled something in Splitwise can't also be their rent.
    const theirs = (person?.amountMinor ?? 0) - elsewhere;
    if (total > theirs) {
      throw new TowardsError(
        elsewhere > 0
          ? `That puts ₹${(total / 100).toFixed(2)} of it towards fixed costs, but only ₹${(theirs / 100).toFixed(2)} is left once Splitwise's part is taken out.`
          : `That puts ₹${(total / 100).toFixed(2)} of it towards fixed costs, but only ₹${(theirs / 100).toFixed(2)} came from them.`
      );
    }
  }
  return towards.map((entry) => ({
    commitmentId: new Types.ObjectId(entry.commitmentId),
    contactId: new Types.ObjectId(entry.contactId),
    periodKey: forPeriod ?? entry.periodKey,
    amountMinor: entry.amountMinor,
  }));
}

/**
 * Money in towards fixed costs that was sent on to another month before
 * checkTowards knew to move it: put on that month's period. Safe to run
 * twice - a row already right is left alone.
 */
export async function runTowardsFollowMonthBackfill(): Promise<void> {
  await runOncePerUser("towardsFollowMonth", 1, async (userId) => {
    const rows = await Transaction.find({ userId, type: "CREDIT", countInMonth: { $ne: null }, "towards.0": { $exists: true } });
    let changed = 0;
    for (const row of rows) {
      const from = (await userMonth(userId, row.countInMonth!)).from;
      if (row.towards.every((entry) => entry.periodKey === from)) continue;
      for (const entry of row.towards) entry.periodKey = from;
      row.markModified("towards");
      await row.save();
      changed += 1;
    }
    return changed;
  });
}

/**
 * Money people sent towards their part of a fixed cost for a month the
 * user has not paid that cost in yet, by person.
 *
 * Roommates usually send their rent a few days before the rent goes out.
 * Until the rent's own payment is recorded, that money has nothing to
 * square on the People page and reads as the user owing it back - but it
 * isn't owed, it's paid ahead. Once the payment lands it is split with
 * them like any other month's, and the two cancel as they always have.
 *
 * Only the current month and the ones after it: a month that is over with
 * no payment recorded against the cost is a gap in the record, not money
 * paid ahead, and is left to show as it always has.
 */
export async function paidAhead(
  userId: Types.ObjectId,
  contactIds?: Types.ObjectId[],
  now = new Date()
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const current = await userMonth(userId, undefined, now);
  const credits = await Transaction.find({
    userId,
    type: "CREDIT",
    towards: {
      $elemMatch: { periodKey: { $gte: current.from }, ...(contactIds ? { contactId: { $in: contactIds } } : {}) },
    },
  })
    .select("towards")
    .lean();
  if (credits.length === 0) return result;

  // Whether the cost has been paid in a month, asked once per month.
  const paidIn = new Map<string, boolean>();
  for (const credit of credits) {
    for (const entry of credit.towards ?? []) {
      if (entry.periodKey < current.from) continue;
      if (contactIds && !contactIds.some((id) => id.equals(entry.contactId))) continue;
      const pair = `${entry.commitmentId}:${entry.periodKey}`;
      if (!paidIn.has(pair)) {
        const month = await userMonth(userId, entry.periodKey.slice(0, 7), now);
        const paid = await Transaction.exists({
          userId,
          commitmentId: entry.commitmentId,
          type: "DEBIT",
          ...countedIn(month, month.key),
        });
        paidIn.set(pair, !!paid);
      }
      if (paidIn.get(pair)) continue;
      const key = entry.contactId.toString();
      result.set(key, (result.get(key) ?? 0) + entry.amountMinor);
    }
  }
  return result;
}
