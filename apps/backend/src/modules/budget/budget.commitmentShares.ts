import { HydratedDocument, Types } from "mongoose";
import {
  Contact,
  FixedCommitment,
  FixedCommitmentDoc,
  Transaction,
  TransactionDoc,
  commitmentFullAmountFor,
} from "../../models";
import { BudgetPeriod } from "./budget.period";
import { commitmentPeriod } from "./budget.pace";

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
      occurredAt: { $gte: period.start, $lt: period.end },
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
 */
export async function checkTowards(
  userId: Types.ObjectId,
  people: { contactId: string; amountMinor: number }[],
  towards: { commitmentId: string; contactId: string; periodKey: string; amountMinor: number }[]
): Promise<{ commitmentId: Types.ObjectId; contactId: Types.ObjectId; periodKey: string; amountMinor: number }[]> {
  if (towards.length === 0) return [];
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
    const theirs = people.find((person) => person.contactId === contactId)?.amountMinor ?? 0;
    if (total > theirs) {
      throw new TowardsError(
        `That puts ₹${(total / 100).toFixed(2)} of it towards fixed costs, but only ₹${(theirs / 100).toFixed(2)} came from them.`
      );
    }
  }
  return towards.map((entry) => ({
    commitmentId: new Types.ObjectId(entry.commitmentId),
    contactId: new Types.ObjectId(entry.contactId),
    periodKey: entry.periodKey,
    amountMinor: entry.amountMinor,
  }));
}
