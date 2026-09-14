import { HydratedDocument, Types } from "mongoose";
import { Account, CardStatement, CardStatementDoc, Transaction, TransactionDoc } from "../../models";
import { StatementLineResolution } from "../../types";
import { categorizeTransaction } from "../../parsing/categorizer";
import { tripForOccurredAt } from "../trips/trips.service";
import { countsAsStatementSpend, isLedgerWorthy, looksLikeCardBill } from "./statements.classify";

/**
 * Matching a statement against the ledger, and adding what is missing.
 *
 * The statement is the bank's own list, so anything on it happened. The
 * ledger only knows what a bank chose to send a message about. The gap
 * between the two is what this finds: the annual fee, the finance charge,
 * the payment made while the phone was off.
 *
 * The danger is the other direction. Most of a statement is already in the
 * ledger, and adding it again would double every figure in the app. So
 * nothing is written until it has failed to match something already there.
 */

/**
 * How far a statement line may sit from the transaction it matches.
 *
 * A statement records the date a transaction *posted*; the alert fired when
 * it *happened*. A weekend between the two is normal, and a long weekend
 * is not rare, so four days is the smallest window that does not produce
 * false "missing" rows - which are the expensive kind of mistake here,
 * because they end up written into the ledger.
 */
const POSTING_DRIFT_DAYS = 4;

export interface ReconcileSummary {
  matched: number;
  added: number;
  uncertain: number;
  skipped: number;
  /// Rows the ledger holds for this card and period that the statement
  /// does not list. Reported, never acted on - there is no safe automatic
  /// answer to one, and each has a different cause.
  notOnStatement: { id: string; merchant: string | null; amountMinor: number; occurredAt: Date }[];
  statementSpendMinor: number;
  knownSpendMinor: number;
}

/**
 * Reconcile a parsed statement that has already been saved.
 *
 * Idempotent by construction: a line that has already been resolved is left
 * alone, so running this twice on the same statement adds nothing the
 * second time even if every other guard failed.
 */
export async function reconcileStatement(
  statement: HydratedDocument<CardStatementDoc>
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    matched: 0,
    added: 0,
    uncertain: 0,
    skipped: 0,
    notOnStatement: [],
    statementSpendMinor: 0,
    knownSpendMinor: 0,
  };

  if (!statement.accountId || statement.lines.length === 0) return summary;

  const window = statementWindow(statement);

  // Everything the ledger already holds for this card over the period the
  // statement covers, read once. A statement runs to a few hundred lines
  // and querying per line would be a few hundred round trips.
  const existing = await Transaction.find({
    userId: statement.userId,
    accountId: statement.accountId,
    occurredAt: { $gte: window.from, $lte: window.to },
  }).sort({ occurredAt: 1 });

  // A transaction may be claimed by one line only, so a statement listing
  // the same amount twice cannot match both halves to a single row.
  const claimed = new Set<string>();
  for (const transaction of existing) {
    if (transaction.statementLineId) claimed.add(transaction._id.toString());
  }

  for (const line of statement.lines) {
    if (countsAsStatementSpend(line.kind)) summary.statementSpendMinor += line.amountMinor;

    // Already dealt with by an earlier run. The second guard against
    // double-adding, after the unique index on the statement itself.
    if (line.resolution !== "SKIPPED" || line.transactionId) {
      summary[tally(line.resolution)] += 1;
      continue;
    }

    if (!isLedgerWorthy(line.kind)) {
      summary.skipped += 1;
      continue;
    }

    const candidates = existing.filter(
      (transaction) =>
        !claimed.has(transaction._id.toString()) &&
        transaction.amountMinor === line.amountMinor &&
        transaction.type === line.type &&
        withinDrift(transaction.occurredAt, line.date)
    );

    if (candidates.length > 0) {
      // The nearest by date. With more than one there is genuinely nothing
      // to choose between them from the statement's side, so the guess is
      // recorded as a guess rather than presented as a match.
      const best = candidates.reduce((nearest, candidate) =>
        distance(candidate.occurredAt, line.date) < distance(nearest.occurredAt, line.date) ? candidate : nearest
      );

      claimed.add(best._id.toString());
      line.transactionId = best._id;
      line.resolution = candidates.length > 1 ? "UNCERTAIN" : "MATCHED";
      summary[candidates.length > 1 ? "uncertain" : "matched"] += 1;

      // The statement names a merchant better than an SMS does, but only
      // gaps are filled and only while nobody has corrected the row by
      // hand - the same rule the duplicate path in ingest.ts follows.
      if (!best.editedAt && !best.merchant) {
        best.merchant = line.description;
        await best.save();
      }
      continue;
    }

    const created = await addFromLine(statement, line);
    claimed.add(created._id.toString());
    line.transactionId = created._id;
    line.resolution = "ADDED";
    summary.added += 1;
  }

  // Measured against what was there before this ran, so the figure says
  // what was missing rather than what is there now.
  summary.knownSpendMinor = existing
    .filter((transaction) => transaction.type === "DEBIT" && !transaction.isTransfer)
    .reduce((total, transaction) => total + transaction.amountMinor, 0);

  const onStatement = new Set(
    statement.lines.map((line) => line.transactionId?.toString()).filter(Boolean) as string[]
  );
  summary.notOnStatement = existing
    .filter(
      (transaction) =>
        !onStatement.has(transaction._id.toString()) && transaction.type === "DEBIT" && !transaction.isTransfer
    )
    .map((transaction) => ({
      id: transaction._id.toString(),
      merchant: transaction.merchant ?? null,
      amountMinor: transaction.amountMinor,
      occurredAt: transaction.occurredAt,
    }));

  statement.statementSpendMinor = summary.statementSpendMinor;
  statement.knownSpendMinor = summary.knownSpendMinor;
  statement.reconciledAt = new Date();
  await statement.save();

  return summary;
}

/** Which counter a resolution already reached belongs in. */
function tally(resolution: StatementLineResolution): "matched" | "added" | "uncertain" | "skipped" {
  if (resolution === "MATCHED") return "matched";
  if (resolution === "ADDED") return "added";
  if (resolution === "UNCERTAIN") return "uncertain";
  return "skipped";
}

const DAY_MS = 24 * 60 * 60 * 1000;

function distance(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime());
}

function withinDrift(occurredAt: Date, lineDate: Date): boolean {
  // Asymmetric on purpose: a transaction posts on or after the day it
  // happened, never before. A day of slack the other way covers a line
  // dated by the transaction date instead of the posting date.
  const early = lineDate.getTime() - POSTING_DRIFT_DAYS * DAY_MS;
  const late = lineDate.getTime() + DAY_MS;
  return occurredAt.getTime() >= early && occurredAt.getTime() <= late;
}

/** The span to look in, widened by the drift the matcher tolerates. */
function statementWindow(statement: HydratedDocument<CardStatementDoc>): { from: Date; to: Date } {
  const dates = statement.lines.map((line) => line.date.getTime());
  const earliest = Math.min(...dates);
  const latest = Math.max(...dates);

  return {
    from: new Date(earliest - POSTING_DRIFT_DAYS * DAY_MS),
    to: new Date(latest + DAY_MS),
  };
}

/**
 * A transaction for a line the ledger never had.
 *
 * Added at once and left uncategorised on purpose. A cycle total missing
 * four thousand rupees of fees is wrong now, and stays wrong for as long as
 * a review queue goes unread; adding immediately makes the figure right and
 * puts the question - what was this? - into the "needs a category" filter
 * and the reminders that already exist.
 */
async function addFromLine(
  statement: HydratedDocument<CardStatementDoc>,
  line: CardStatementDoc["lines"][number]
): Promise<HydratedDocument<TransactionDoc>> {
  const categoryId = await categorizeTransaction({
    userId: statement.userId,
    merchant: line.description,
    rawText: line.description,
  });

  const tripId = await tripForOccurredAt(statement.userId, line.date);

  // A bank statement lists the card bill going out, while the card's own
  // statement lists every purchase behind it. Adding both as spending books
  // the same money twice, and it is the largest row on the page - so where
  // the narration names a card of the user's, the payment is linked to it
  // and counts as nothing. "CC PAYMENT ICICI 2009" against a card ending
  // 2009 is not a guess.
  const paidCard =
    statement.kind === "BANK" && line.type === "DEBIT" && looksLikeCardBill(line.description)
      ? await findCardNamedIn(statement.userId, line.description)
      : null;

  return Transaction.create({
    userId: statement.userId,
    accountId: statement.accountId,
    categoryId,
    tripId,
    amountMinor: line.amountMinor,
    currency: "INR",
    type: line.type,
    merchant: line.description,
    rawText: line.description,
    source: "STATEMENT",
    cardPaymentFor: paidCard,
    sourceRef: `${statement.sourceRef}#${line._id.toString()}`,
    occurredAt: line.date,
    statementId: statement._id,
    statementLineId: line._id,
    sources: [
      {
        source: "STATEMENT",
        sourceRef: `${statement.sourceRef}#${line._id.toString()}`,
        rawText: line.description,
        receivedAt: statement.statementDate ?? new Date(),
      },
    ],
  });
}

/**
 * Undo one added row, for when a statement was reconciled against the wrong
 * card. Leaves matched lines alone - those transactions were not created
 * here and deleting one would throw away a real record.
 */
export async function unpickStatement(userId: Types.ObjectId, statementId: Types.ObjectId): Promise<number> {
  const statement = await CardStatement.findOne({ _id: statementId, userId });
  if (!statement) return 0;

  const added = statement.lines.filter((line) => line.resolution === "ADDED" && line.transactionId);
  await Transaction.deleteMany({
    userId,
    _id: { $in: added.map((line) => line.transactionId) },
    // Belt and braces: only ever deletes rows this statement created.
    statementId: statement._id,
  });

  for (const line of statement.lines) {
    if (line.resolution !== "ADDED") continue;
    line.resolution = "SKIPPED";
    line.transactionId = null;
  }

  statement.reconciledAt = null;
  await statement.save();

  return added.length;
}

/**
 * A card of the user's whose last four digits appear in a narration.
 *
 * Deliberately narrow: it wants the digits themselves, not a bank name,
 * because two cards from the same bank would both answer to the name and
 * linking a bill to the wrong one is worse than not linking it at all.
 */
async function findCardNamedIn(userId: Types.ObjectId, description: string): Promise<Types.ObjectId | null> {
  const cards = await Account.find({ userId, accountType: "CARD", last4: { $ne: null } }).select("last4");

  const named = cards.filter((card) => card.last4 && new RegExp(`\\b${card.last4}\\b`).test(description));
  return named.length === 1 ? named[0]._id : null;
}
