import { Types } from "mongoose";
import { Transaction, User } from "../../models";
import { istMonthKey, istMonthStart } from "../../time";

/**
 * How far back this ledger goes.
 *
 * Somebody who joins on the 13th of September does not want August read.
 * The mailbox holds months of alerts and the phone holds years of them, and
 * importing all of it would fill the app with a half-remembered period
 * nobody meant to track — every total wrong, every screen full of
 * uncategorised rows from before SpendLog existed.
 *
 * So the ledger starts on the 1st of the month the account was made, and
 * moves back a month at a time when it is asked to. The horizon governs
 * *importing* rather than the ledger itself: a payment typed in by hand
 * with an old date is somebody saying what happened, and is kept whatever
 * the horizon says.
 *
 * Read on every sync and every message, so it is kept to one indexed
 * lookup and no aggregation.
 */

/** The month an account with no horizon set reads as: the one it was made in. */
export function defaultHorizon(createdAt: Date): string {
  return istMonthKey(createdAt);
}

/**
 * The first instant this user imports anything for.
 *
 * Returns null when the user is gone, which callers treat as "import
 * nothing" rather than "import everything" — a sync for a deleted account
 * should do less, not more.
 */
export async function horizonFor(userId: Types.ObjectId): Promise<Date | null> {
  const user = await User.findById(userId).select("ledgerFrom createdAt");
  if (!user) return null;

  return istMonthStart(user.ledgerFrom ?? defaultHorizon(user.createdAt));
}

/** The same, as the month key a client shows and edits. */
export async function horizonMonthFor(userId: Types.ObjectId): Promise<string | null> {
  const user = await User.findById(userId).select("ledgerFrom createdAt");
  if (!user) return null;

  return user.ledgerFrom ?? defaultHorizon(user.createdAt);
}

/** YYYY-MM, and a real month. */
export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** The month before this one, as a key. */
export function monthBefore(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return index === 1
    ? `${year - 1}-12`
    : `${year}-${String(index - 1).padStart(2, "0")}`;
}

export interface PurgePlan {
  /// The horizon everything is measured against.
  month: string;
  /// Rows older than it that an import created. These are what a purge
  /// removes.
  imported: number;
  /// Rows older than it that were typed in by hand. Never removed: the
  /// horizon is about what gets fetched, and somebody who entered a
  /// payment meant to.
  manual: number;
  /// Statements whose whole period falls before it.
  statements: number;
}

/**
 * What clearing out everything before the horizon would remove, without
 * removing any of it.
 */
export async function planPurge(userId: Types.ObjectId): Promise<PurgePlan | null> {
  const month = await horizonMonthFor(userId);
  if (!month) return null;

  const before = istMonthStart(month);

  const [imported, manual] = await Promise.all([
    Transaction.countDocuments({ userId, occurredAt: { $lt: before }, source: { $ne: "MANUAL" } }),
    Transaction.countDocuments({ userId, occurredAt: { $lt: before }, source: "MANUAL" }),
  ]);

  const { CardStatement } = await import("../../models");
  const statements = await CardStatement.countDocuments({
    userId,
    periodEnd: { $ne: null, $lt: before },
  });

  return { month, imported, manual, statements };
}

export interface PurgeResult {
  transactionsDeleted: number;
  statementsDeleted: number;
}

/**
 * Remove everything imported from before the horizon.
 *
 * Deliberately narrower than the plan it follows: rows entered by hand are
 * left where they are, whatever their date. The horizon decides what
 * SpendLog goes and fetches, and it was never meant to overrule somebody
 * typing in a payment they remember.
 */
export async function purgeBeforeHorizon(userId: Types.ObjectId): Promise<PurgeResult | null> {
  const month = await horizonMonthFor(userId);
  if (!month) return null;

  const before = istMonthStart(month);
  const { CardStatement } = await import("../../models");

  const [transactions, statements] = await Promise.all([
    Transaction.deleteMany({ userId, occurredAt: { $lt: before }, source: { $ne: "MANUAL" } }),
    CardStatement.find({ userId, periodEnd: { $ne: null, $lt: before } }).select("_id"),
  ]);

  // Through the same door a single delete uses, so the stored PDF goes
  // with the record rather than being left on the disk unreachable.
  const { deleteStatementFile } = await import("../statements/statements.files");
  for (const statement of statements) await deleteStatementFile(statement._id);

  await CardStatement.deleteMany({ _id: { $in: statements.map((one) => one._id) } });

  return {
    transactionsDeleted: transactions.deletedCount ?? 0,
    statementsDeleted: statements.length,
  };
}
