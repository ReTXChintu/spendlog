import { Types } from "mongoose";
import { CardStatement, Transaction } from "../../models";
import { deleteStatementFile } from "./statements.files";

/**
 * Starting the statement ledger over.
 *
 * There was a period where every sync read every statement again. The
 * identity was `messageId#attachmentId`, and Gmail's attachment id is an
 * opaque token minted per fetch rather than a stable name - so the guard
 * against reading one twice never matched, and each run added every
 * transaction on every statement afresh. Three runs, three copies.
 *
 * That is fixed at the source. This is for the ledger it left behind,
 * where the damage is not one bad row but a few hundred, spread across
 * months, with no way to tell a duplicate from the real thing by looking
 * at it.
 *
 * So: forget every statement and everything it put in the ledger, then
 * read the mailbox once with the identity that works. Anything SpendLog
 * learned from an SMS or an email is untouched - this only removes rows a
 * statement itself created.
 *
 * Always offered as a count before it is offered as a button. Deleting
 * several hundred transactions on somebody's behalf is not something to
 * find out about afterwards.
 */

export interface StatementResetPlan {
  statements: number;
  /// Rows a statement added that nothing else knows about. These go.
  addedTransactions: number;
  /// Rows a statement matched to something already in the ledger. These
  /// stay - they came from an SMS or an email, and the statement only
  /// recognised them.
  matchedTransactions: number;
  /// Of the rows that go, how many have been categorised by hand. The one
  /// number worth hesitating over.
  categorisedAmongThem: number;
  duplicateGroups: number;
}

/**
 * What a reset would do, without doing any of it.
 */
export async function planStatementReset(userId: Types.ObjectId): Promise<StatementResetPlan> {
  const statements = await CardStatement.find({ userId }).select("_id mailKey sourceRef");
  const ids = statements.map((statement) => statement._id);

  // A row a statement created, against a row it merely recognised. Both
  // carry statementId, so that field cannot tell them apart - the one that
  // can is `source`, which says who made the row in the first place. The
  // distinction is the whole safety of this: a matched row came from an
  // SMS and deleting it would throw away a real record.
  const wasCreatedByAStatement = { userId, source: "STATEMENT", statementId: { $in: ids } };

  const [addedTransactions, categorisedAmongThem, matchedTransactions] = await Promise.all([
    Transaction.countDocuments(wasCreatedByAStatement),
    Transaction.countDocuments({ ...wasCreatedByAStatement, categoryId: { $ne: null } }),
    Transaction.countDocuments({
      userId,
      source: { $ne: "STATEMENT" },
      "sources.source": "STATEMENT",
    }),
  ]);

  // How much of the pile is duplication rather than statements. Counted on
  // the mail a statement arrived in, which is what the old identity failed
  // to be stable about.
  const seen = new Set<string>();
  let duplicateGroups = 0;
  for (const statement of statements) {
    const key = statement.mailKey ?? statement.sourceRef.split("#")[0];
    if (seen.has(key)) duplicateGroups += 1;
    else seen.add(key);
  }

  return {
    statements: statements.length,
    addedTransactions,
    matchedTransactions,
    categorisedAmongThem,
    duplicateGroups,
  };
}

export interface StatementResetResult {
  statementsDeleted: number;
  transactionsDeleted: number;
  sourcesCleared: number;
}

/**
 * Do it.
 *
 * Three things in an order that matters. The rows a statement created go
 * first, because once the statements are gone there is nothing left saying
 * which rows those were. Then the statement's mark is lifted off the rows
 * it only matched, so they stop claiming a provenance that no longer
 * exists. Then the statements themselves, and their stored files.
 */
export async function resetStatements(userId: Types.ObjectId): Promise<StatementResetResult> {
  const statements = await CardStatement.find({ userId }).select("_id");
  const ids = statements.map((statement) => statement._id);

  // Only rows a statement created. Both conditions, the same belt and
  // braces unpickStatement uses, because this one runs over everything at
  // once and there is no undoing it.
  const removed = await Transaction.deleteMany({
    userId,
    source: "STATEMENT",
    statementId: { $in: ids },
  });

  const cleared = await Transaction.updateMany(
    { userId, "sources.source": "STATEMENT" },
    {
      $pull: { sources: { source: "STATEMENT" } },
      $set: { statementId: null, statementLineId: null },
    }
  );

  // One at a time rather than in bulk: each has a file beside it, and a
  // file left behind is a bank statement on the disk that nothing in the
  // app can reach or remove.
  for (const id of ids) await deleteStatementFile(id);
  await CardStatement.deleteMany({ userId });

  return {
    statementsDeleted: ids.length,
    transactionsDeleted: removed.deletedCount ?? 0,
    sourcesCleared: cleared.modifiedCount ?? 0,
  };
}
