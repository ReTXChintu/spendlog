import { HydratedDocument, Types } from "mongoose";
import { Account, CardStatementDoc, Transaction } from "../../models";
import { StatementLineKind, TransactionType } from "../../types";
import { accountLedgers } from "../accounts/accounts.balance";
import { CARD_POSTS_AFTER_DAYS } from "../cards/cards.billPayment";
import { isLedgerWorthy } from "./statements.classify";
import { closingBalanceOf } from "./statements.reconcile";

/**
 * A statement set beside the ledger, both ways: what the bank lists that
 * the app did not have, and what the app has that the bank does not list.
 *
 * Reconciling writes - it adds what is missing. This only reads, and reads
 * the same for a bank statement as for a card's, so the one screen can
 * show either. For a bank statement it also says whether the app's running
 * balance meets the statement's closing balance, which is the one figure a
 * card statement cannot offer.
 *
 * The matching is the pure function at the bottom, so its rules - amount,
 * direction, two days either way, the same account preferred - can be
 * tested against fixtures without a database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/// A statement dates a row by when it posted, which can be a weekend
/// after it happened.
export const COMPARE_DRIFT_DAYS = 2;

export interface CompareLine {
  lineId: string;
  date: Date;
  description: string;
  amountMinor: number;
  type: TransactionType;
  kind: StatementLineKind;
  /// The row this statement added for it, where reconciling already has.
  addedTransactionId: string | null;
}

export interface CompareRow {
  transactionId: string;
  occurredAt: Date;
  merchant: string | null;
  amountMinor: number;
  type: TransactionType;
  accountId: string | null;
  /// Written in by SpendLog for the far side of a transfer or a card
  /// bill, dated by the side it was written for rather than by when this
  /// account posted it.
  autoLeg?: boolean;
}

export interface Comparison {
  onStatementNotInApp: CompareLine[];
  inAppNotOnStatement: CompareRow[];
  matched: number;
  /// Which line was taken for which row, for a screen that wants to show it.
  pairs: { lineId: string; transactionId: string }[];
}

/**
 * Lines against rows. Each line takes the nearest unclaimed row of the
 * same amount and direction within two days, preferring one on the
 * statement's own account over one filed elsewhere - a row filed on the
 * wrong account is still the same payment, and better found than listed
 * as missing. A row may be taken once.
 *
 * A row SpendLog wrote in carries the other side's moment, and a card
 * posts a bill payment up to four days after the bank let it go - so one
 * of those may sit that much earlier than its line.
 */
export function compareLines(
  lines: Omit<CompareLine, "addedTransactionId">[],
  rows: CompareRow[],
  ownAccountIds: Set<string>
): Comparison {
  const claimed = new Set<string>();
  const pairs: { lineId: string; transactionId: string }[] = [];
  const missing: CompareLine[] = [];

  for (const line of lines) {
    // A card's bill payment is never added from a statement, so it is
    // never missing - but the row standing for it, the card's own message
    // or the side SpendLog wrote in, is not extra either.
    const payment = line.kind === "PAYMENT";
    if (!isLedgerWorthy(line.kind) && !payment) continue;

    const candidates = rows.filter(
      (row) =>
        !claimed.has(row.transactionId) &&
        row.amountMinor === line.amountMinor &&
        row.type === line.type &&
        withinDrift(row, line.date)
    );
    const own = candidates.filter((row) => row.accountId && ownAccountIds.has(row.accountId));
    const pool = own.length > 0 || payment ? own : candidates;
    const best = pool.sort(
      (a, b) =>
        Math.abs(a.occurredAt.getTime() - line.date.getTime()) - Math.abs(b.occurredAt.getTime() - line.date.getTime())
    )[0];

    if (best) {
      claimed.add(best.transactionId);
      pairs.push({ lineId: line.lineId, transactionId: best.transactionId });
    } else if (!payment) {
      missing.push({ ...line, addedTransactionId: null });
    }
  }

  return {
    onStatementNotInApp: missing,
    inAppNotOnStatement: rows.filter((row) => !claimed.has(row.transactionId) && row.accountId && ownAccountIds.has(row.accountId)),
    matched: pairs.length,
    pairs,
  };
}

/** Whether a row is close enough in time to be a line. See compareLines. */
function withinDrift(row: CompareRow, lineDate: Date): boolean {
  const lag = lineDate.getTime() - row.occurredAt.getTime();
  const late = (row.autoLeg ? Math.max(COMPARE_DRIFT_DAYS, CARD_POSTS_AFTER_DAYS) : COMPARE_DRIFT_DAYS) * DAY_MS;
  return lag >= -COMPARE_DRIFT_DAYS * DAY_MS && lag <= late;
}

/** The span a statement's lines cover, widened by the drift the matcher allows. */
function windowOf(statement: Pick<CardStatementDoc, "lines" | "periodStart" | "periodEnd">): { from: Date; to: Date } {
  const dates = statement.lines.map((line) => line.date.getTime());
  const from = Math.min(...dates, statement.periodStart?.getTime() ?? Infinity);
  const to = Math.max(...dates, statement.periodEnd?.getTime() ?? -Infinity);
  return { from: new Date(from - COMPARE_DRIFT_DAYS * DAY_MS), to: new Date(to + (COMPARE_DRIFT_DAYS + 1) * DAY_MS) };
}

export interface StatementComparison extends Comparison {
  statementId: string;
  kind: CardStatementDoc["kind"];
  accountId: string | null;
  /// A bank statement's closing balance; a card statement's total due.
  closingBalanceMinor: number | null;
  closingOn: Date | null;
  /// The app's running balance at the close, for a bank account with a
  /// starting balance. Null for a card, or an account with none.
  expectedAtClosingMinor: number | null;
  /// closing less expected: the bank's less the app's.
  differenceMinor: number | null;
}

/**
 * One statement, compared. Rows this statement itself added are set aside
 * before matching and reported as "on the statement, not in the app",
 * naming the row that now stands for each - otherwise reconciling would
 * make every comparison come out clean by construction.
 */
export async function compareStatement(statement: HydratedDocument<CardStatementDoc>): Promise<StatementComparison> {
  const userId = statement.userId;
  const accountId = statement.accountId ?? null;

  const accounts = await Account.find({ userId });
  const own = new Set<string>();
  if (accountId) {
    own.add(accountId.toString());
    for (const account of accounts) {
      if (account.accountType === "DEBIT" && account.linkedAccountId?.equals(accountId)) own.add(account._id.toString());
    }
  }

  const addedByThis = new Map<string, string>();
  for (const line of statement.lines) {
    if (line.resolution === "ADDED" && line.transactionId) addedByThis.set(line._id.toString(), line.transactionId.toString());
  }
  const addedIds = new Set(addedByThis.values());

  const window = statement.lines.length > 0 ? windowOf(statement) : null;
  // From further back for a row SpendLog wrote in, which may be dated
  // days before the card posted it. Only to be matched: one that old and
  // unmatched belongs to the statement before.
  const writtenInFrom = window ? new Date(window.from.getTime() - CARD_POSTS_AFTER_DAYS * DAY_MS) : null;
  const rows = window
    ? await Transaction.find({
        userId,
        occurredAt: { $lte: window.to },
        $or: [{ occurredAt: { $gte: window.from } }, { autoLeg: true, occurredAt: { $gte: writtenInFrom } }],
      })
        .select("accountId occurredAt merchant amountMinor type autoLeg")
        .lean<{ _id: Types.ObjectId; accountId?: Types.ObjectId | null; occurredAt: Date; merchant?: string | null; amountMinor: number; type: TransactionType; autoLeg?: boolean }[]>()
    : [];

  const comparison = compareLines(
    statement.lines.map((line) => ({
      lineId: line._id.toString(),
      date: line.date,
      description: line.description,
      amountMinor: line.amountMinor,
      type: line.type,
      kind: line.kind,
    })),
    rows
      .filter((row) => !addedIds.has(row._id.toString()))
      .map((row) => ({
        transactionId: row._id.toString(),
        occurredAt: row.occurredAt,
        merchant: row.merchant ?? null,
        amountMinor: row.amountMinor,
        type: row.type,
        accountId: row.accountId?.toString() ?? null,
        autoLeg: Boolean(row.autoLeg),
      })),
    own
  );
  if (window) {
    comparison.inAppNotOnStatement = comparison.inAppNotOnStatement.filter((row) => row.occurredAt >= window.from);
  }
  for (const line of comparison.onStatementNotInApp) {
    line.addedTransactionId = addedByThis.get(line.lineId) ?? null;
  }

  // The close: a bank statement's last balance against the app's running
  // figure at that moment; a card statement's total due, with nothing to
  // set it against here.
  const closing = closingBalanceOf(statement);
  let expectedAtClosingMinor: number | null = null;
  if (closing && accountId) {
    const ledger = (await accountLedgers(userId, accounts, [accountId.toString()])).get(accountId.toString());
    if (ledger) {
      expectedAtClosingMinor = ledger.openingMinor;
      for (const entry of ledger.entries) {
        if (entry.at > closing.on) break;
        expectedAtClosingMinor = entry.runningMinor;
      }
    }
  }
  const closingBalanceMinor = closing?.balanceMinor ?? (statement.kind === "CARD" ? (statement.totalDueMinor ?? null) : null);

  return {
    statementId: statement._id.toString(),
    kind: statement.kind,
    accountId: accountId?.toString() ?? null,
    ...comparison,
    closingBalanceMinor,
    closingOn: closing?.on ?? statement.statementDate ?? null,
    expectedAtClosingMinor,
    differenceMinor:
      closing && expectedAtClosingMinor !== null ? closing.balanceMinor - expectedAtClosingMinor : null,
  };
}
