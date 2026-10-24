import { HydratedDocument, Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Account, Transaction, TransactionDoc, TransactionSourceEntry } from "../../models";
import { parseStatedFigures } from "../../parsing/balance";
import { statedMoment } from "../../parsing/moment";
import { TransactionReference, transactionReference } from "../../parsing/reference";
import { groupForOccurredAt, syncGroupSplit } from "../groups/groups.service";

/**
 * Takes apart rows that two payments were merged into.
 *
 * Before duplicate detection read the bank's reference, two payments of
 * the same amount to the same account minutes apart - two Rs 350 credits
 * from one friend - matched on amount and time and became one row
 * "reported 6 times". Their messages still say which was which: each
 * quotes its own reference. Such a row keeps the messages of its earliest
 * reference, and every other reference's messages become a row of their
 * own, carrying over what the original had been given (category, note,
 * group, who it was shared with) since it was the same kind of payment.
 *
 * Also writes each message's reference onto rows that never had it, so a
 * late email about an old payment finds that payment by its number.
 */

export const REFERENCE_SPLIT_BACKFILL = "referenceSplit";
export const REFERENCE_SPLIT_BACKFILL_VERSION = 1;

type Entry = TransactionSourceEntry;

function referenceOf(entry: Entry): TransactionReference | null {
  if (entry.reference && entry.referenceKind) return { kind: entry.referenceKind, value: entry.reference };
  return transactionReference(entry.rawText);
}

function arrival(entry: Entry): number {
  return new Date(entry.receivedAt).getTime();
}

/**
 * A row's messages sorted into one batch per payment, earliest first - or
 * null when they are all one payment. Payments are told apart by the first
 * numbering scheme in which their messages quote different numbers; a
 * message that quotes none goes with the payment whose messages arrived
 * nearest to it, the way the SMS and email of one payment arrive together.
 */
export function batchesByReference(entries: Entry[]): { reference: TransactionReference; entries: Entry[] }[] | null {
  const refs = entries.map(referenceOf);
  const kinds = new Set(refs.filter(Boolean).map((ref) => ref!.kind));
  for (const kind of kinds) {
    const values = [...new Set(refs.filter((ref) => ref?.kind === kind).map((ref) => ref!.value))];
    if (values.length < 2) continue;

    const batches = values.map((value) => ({
      reference: { kind, value } as TransactionReference,
      entries: entries.filter((entry, index) => refs[index]?.value === value),
    }));
    entries.forEach((entry, index) => {
      if (batches.some((batch) => batch.entries.includes(entry))) return;
      // Same number under another scheme first; otherwise the nearest in time.
      const byValue = refs[index] ? batches.find((batch) => batch.reference.value === refs[index]!.value) : undefined;
      const nearest = (batch: (typeof batches)[number]) =>
        Math.min(...batch.entries.map((other) => Math.abs(arrival(other) - arrival(entry))));
      const home = byValue ?? batches.reduce((best, batch) => (nearest(batch) < nearest(best) ? batch : best));
      home.entries.push(entry);
    });
    for (const batch of batches) batch.entries.sort((a, b) => arrival(a) - arrival(b));
    return batches.sort((a, b) => arrival(a.entries[0]) - arrival(b.entries[0]));
  }
  return null;
}

/** When a batch of messages says its payment happened. */
function momentOf(entries: Entry[]): Date {
  for (const entry of entries) {
    const stated = statedMoment(entry.rawText, new Date(entry.receivedAt));
    if (stated) return stated;
  }
  return new Date(entries[0].receivedAt);
}

/** The bank's figures a batch's messages state, for the kind of account it is on. */
function statedFigures(entries: Entry[], isCard: boolean) {
  let balanceMinor: number | null = null;
  let availableLimitMinor: number | null = null;
  for (const entry of entries) {
    const figures = parseStatedFigures(entry.rawText ?? "");
    if (!isCard) balanceMinor ??= figures.balanceMinor;
    if (isCard) availableLimitMinor ??= figures.availableLimitMinor;
  }
  return { balanceMinor, availableLimitMinor };
}

function withReference(entry: Entry): Entry {
  const ref = referenceOf(entry);
  return { ...entry, reference: ref?.value ?? null, referenceKind: ref?.kind ?? null };
}

/**
 * Rows that are more than a plain payment - one leg of a pair, a mirror of
 * someone else's, an EMI or loan instalment, a card bill - are tied to
 * other rows, and cloning one would leave the tie pointing at only half.
 * Left as they are.
 */
function isTied(row: HydratedDocument<TransactionDoc>): boolean {
  return Boolean(
    row.transferPairId || row.autoLeg || row.autoLegOf || row.mirrorOf || row.emiPlanId || row.loanId ||
      row.cardPaymentFor || row.refundOf?.length || row.loanSplits?.length
  );
}

/** A row's messages as plain objects, safe to copy into another row. */
function entriesOf(row: HydratedDocument<TransactionDoc>): Entry[] {
  return (row.toObject().sources ?? []) as Entry[];
}

/** Splits one row if its messages are about more than one payment. Returns the rows created. */
export async function splitRowByReference(row: HydratedDocument<TransactionDoc>): Promise<number> {
  const batches = batchesByReference(entriesOf(row));
  if (!batches || isTied(row)) return 0;

  const account = row.accountId ? await Account.findById(row.accountId).select("accountType").lean() : null;
  const isCard = account?.accountType === "CARD";
  const [first, ...others] = batches;

  for (const batch of others) {
    const occurredAt = momentOf(batch.entries);
    const figures = statedFigures(batch.entries, isCard);
    const groupId = row.groupId ?? (await groupForOccurredAt(row.userId, occurredAt));
    const created = await Transaction.create({
      userId: row.userId,
      accountId: row.accountId ?? null,
      categoryId: row.categoryId ?? null,
      amountMinor: row.amountMinor,
      currency: row.currency,
      type: row.type,
      merchant: row.merchant ?? null,
      note: row.note ?? null,
      rawText: batch.entries[0].rawText ?? null,
      source: batch.entries[0].source,
      sourceRef: batch.entries[0].sourceRef ?? null,
      reference: batch.reference.value,
      referenceKind: batch.reference.kind,
      groupId,
      groupShareWith: row.groupShareWith ?? null,
      split: row.split ?? null,
      people: row.people ?? [],
      isSettlement: row.isSettlement,
      isSalary: row.isSalary,
      isSpecial: row.isSpecial,
      isEarmarked: row.isEarmarked,
      byKidId: row.byKidId ?? null,
      byKidName: row.byKidName ?? null,
      accountUnknown: row.accountUnknown,
      occurredAt,
      // A row someone corrected by hand stays out of automatic passes,
      // and so does its twin.
      editedAt: row.editedAt ?? null,
      statedBalanceMinor: figures.balanceMinor,
      statedAvailableLimitMinor: figures.availableLimitMinor,
      sources: batch.entries.map(withReference),
    });
    if (created.groupId) await syncGroupSplit(created);
  }

  row.sources = first.entries.map(withReference) as never;
  row.rawText = first.entries[0].rawText ?? null;
  row.source = first.entries[0].source;
  row.sourceRef = first.entries[0].sourceRef ?? null;
  row.reference = first.reference.value;
  row.referenceKind = first.reference.kind;
  const figures = statedFigures(first.entries, isCard);
  row.statedBalanceMinor = figures.balanceMinor;
  row.statedAvailableLimitMinor = figures.availableLimitMinor;
  // Its time came from a message that may now be another row's. A time
  // someone set by hand stays.
  if (!row.editedAt) row.occurredAt = momentOf(first.entries);
  await row.save();
  if (row.groupId) await syncGroupSplit(row);

  return others.length;
}

/** One user's pass: references written in, merged payments split. Returns rows split. */
export async function splitMergedPayments(userId: Types.ObjectId): Promise<number> {
  let split = 0;
  const rows = await Transaction.find({ userId, "sources.source": { $in: ["SMS", "EMAIL"] } });
  for (const row of rows) {
    if (row.sources.length > 1 && (await splitRowByReference(row)) > 0) {
      split += 1;
      continue;
    }

    // Not split: just remember the references its messages quote.
    const entries = entriesOf(row).map(withReference);
    const ref = entries.find((entry) => entry.reference);
    const changed = entries.some((entry, index) => entry.reference !== (row.sources[index].reference ?? null));
    if (!changed && (row.reference || !ref)) continue;
    await Transaction.updateOne(
      { _id: row._id },
      {
        $set: {
          sources: entries,
          ...(row.reference || !ref ? {} : { reference: ref.reference, referenceKind: ref.referenceKind }),
        },
      }
    );
  }
  return split;
}

export async function runReferenceSplitBackfill(): Promise<{ users: number; changed: number }> {
  const result = await runOncePerUser(REFERENCE_SPLIT_BACKFILL, REFERENCE_SPLIT_BACKFILL_VERSION, splitMergedPayments);
  if (result.users > 0) {
    console.log(`Reference split: ${result.changed} transactions split across ${result.users} users.`);
  }
  return result;
}
