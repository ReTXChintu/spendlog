import { HydratedDocument, Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Account, AccountDoc, Contact, MissingCredit, MissingCreditDoc, Transaction, User } from "../../models";
import { IST_OFFSET_MS } from "../../time";
import { MissingCreditAnswer } from "../../types";
import { balances } from "../contacts/contacts.people";
import { AccountLedger, DRIFT_TOLERANCE_MINOR, LedgerEntry, accountLedgers, ledgerContext } from "./accounts.balance";
import { accountLabel, rupees, shortDay, windowText } from "./accounts.label";

/**
 * Money that came into an account without a message saying so, found from
 * the bank's own figures.
 *
 * Plenty of banks text every debit and never a credit: of one user's
 * Federal Bank messages over ninety days, 88 were money out and one was
 * money in. Most of those messages state the balance afterwards, though,
 * and two balances a few days apart say exactly how much came in between
 * them. So between each pair of consecutive stated figures on the ledger -
 * an SMS's balance, a checkpoint, the starting balance itself:
 *
 *   unexplained = (B.stated - A.stated) - (what the rows between moved)
 *
 * which is the change in drift from A to B. Past a rupee the bank's way,
 * that much came in somewhere in the window and SpendLog never saw it: a
 * missing credit of exactly that amount. The other way it is a missing
 * debit, which the reconciler's missing_days suspect already covers.
 *
 * A missing credit is not a transaction. It counts as nothing - not
 * income, not in the savings bucket - until the user says what it was, so
 * a guess never lands in a budget. Meanwhile the balance walk counts it
 * provisionally (accountLedgers), so the passbook, the overview, the
 * dashboard and the nightly check all show what the bank shows rather
 * than the same gap again under another name.
 *
 * Found three ways: after a message with a stated balance arrives (only
 * the gaps either side of it), every night for every account, and once
 * per user over the last ninety days when this first shipped. Re-found
 * gaps are the same record (the key); one that closes because the user
 * added or fixed rows is resolved on its own.
 */

/// How far back the nightly pass and the first backfill look for gaps.
export const MISSING_CREDIT_LOOKBACK_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One gap between two stated figures that money in would close. */
export interface CreditGap {
  key: string;
  amountMinor: number;
  after: Date;
  before: Date;
  afterTransactionId: string | null;
  afterCheckpointId: string | null;
  beforeTransactionId: string | null;
  beforeCheckpointId: string | null;
}

/**
 * A stated figure's name in a key: its transaction, its checkpoint, or
 * the starting balance at its moment - a new starting balance is a new
 * point, so gaps measured from an old one are never mistaken for it.
 */
function pointName(entry: LedgerEntry): string {
  if (entry.transactionId) return `t:${entry.transactionId}`;
  if (entry.checkpointId) return `c:${entry.checkpointId}`;
  return `o:${entry.at.getTime()}`;
}

/**
 * Every gap money in would close, oldest first. Pure. The ledger has to
 * be walked without provisional rows: with them in, each gap already
 * found would be closed by its own stand-in.
 */
export function creditGaps(ledger: AccountLedger): CreditGap[] {
  const stated = ledger.entries.filter(
    (entry) => entry.kind !== "missing_credit" && entry.statedMinor !== null && entry.driftMinor !== null
  );
  const gaps: CreditGap[] = [];
  for (let index = 1; index < stated.length; index += 1) {
    const from = stated[index - 1];
    const to = stated[index];
    const unexplained = to.driftMinor! - from.driftMinor!;
    if (unexplained <= DRIFT_TOLERANCE_MINOR) continue;
    gaps.push({
      key: `${pointName(from)}>${pointName(to)}`,
      amountMinor: unexplained,
      after: from.at,
      before: to.at,
      afterTransactionId: from.transactionId,
      afterCheckpointId: from.checkpointId,
      beforeTransactionId: to.transactionId,
      beforeCheckpointId: to.checkpointId,
    });
  }
  return gaps;
}

export interface DetectOptions {
  /// Only these tracked accounts. Every one, when left out.
  accountIds?: string[];
  /// New gaps only where this transaction is one of the two figures - a
  /// message just arrived, and the gaps either side of it are all that
  /// can have changed.
  touching?: Types.ObjectId;
  /// New gaps only where the second figure is on or after this.
  since?: Date;
  /// false: only keep the open ones up to date - amounts, and closing the
  /// ones rows added since explain. Nothing new is recorded.
  createNew?: boolean;
}

export interface DetectResult {
  created: HydratedDocument<MissingCreditDoc>[];
  updated: number;
  reopened: number;
  resolved: number;
}

const oid = (id: string | null) => (id ? new Types.ObjectId(id) : null);

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

/**
 * Finds the gaps on a user's accounts and brings their records in line:
 * a new gap recorded, a known one's amount kept current, one answered or
 * closed that has opened again reopened, an open one that has gone
 * resolved. A dismissed one is left dismissed: the user has said they do
 * not know, and asking again every night would not change that.
 */
export async function detectMissingCredits(userId: Types.ObjectId, options: DetectOptions = {}): Promise<DetectResult> {
  const result: DetectResult = { created: [], updated: 0, reopened: 0, resolved: 0 };
  const accounts = await Account.find({ userId });
  const ledgers = await accountLedgers(userId, accounts, options.accountIds, { provisional: false });

  const inScope = (gap: CreditGap) => {
    if (options.createNew === false) return false;
    if (options.touching) {
      const id = options.touching.toString();
      if (gap.afterTransactionId !== id && gap.beforeTransactionId !== id) return false;
    }
    return !options.since || gap.before >= options.since;
  };

  for (const [accountId, ledger] of ledgers) {
    const gaps = creditGaps(ledger);
    const known = await MissingCredit.find({
      accountId: new Types.ObjectId(accountId),
      $or: [{ status: "open" }, { key: { $in: gaps.map((gap) => gap.key) } }],
    });
    const byKey = new Map(known.map((credit) => [credit.key, credit]));
    const present = new Set(gaps.map((gap) => gap.key));
    const now = new Date();

    // Open, and the gap is gone: rows added or fixed since explain it.
    for (const credit of known) {
      if (credit.status !== "open" || present.has(credit.key)) continue;
      credit.status = "resolved";
      credit.resolvedAs = "gap_closed";
      credit.closedAt = now;
      await credit.save();
      result.resolved += 1;
    }

    for (const gap of gaps) {
      const credit = byKey.get(gap.key);
      if (credit?.status === "dismissed") continue;

      if (credit?.status === "open") {
        if (credit.amountMinor !== gap.amountMinor) {
          credit.amountMinor = gap.amountMinor;
          await credit.save();
          result.updated += 1;
        }
        continue;
      }

      if (!inScope(gap)) continue;

      if (credit) {
        // Answered or closed once, and open again: the row that closed
        // it was deleted, or changed.
        credit.status = "open";
        credit.amountMinor = gap.amountMinor;
        credit.resolvedAs = null;
        credit.resolvedTransactionId = null;
        credit.closedAt = null;
        await credit.save();
        result.reopened += 1;
        continue;
      }

      try {
        result.created.push(
          await MissingCredit.create({
            userId,
            accountId: new Types.ObjectId(accountId),
            amountMinor: gap.amountMinor,
            after: gap.after,
            before: gap.before,
            afterTransactionId: oid(gap.afterTransactionId),
            afterCheckpointId: oid(gap.afterCheckpointId),
            beforeTransactionId: oid(gap.beforeTransactionId),
            beforeCheckpointId: oid(gap.beforeCheckpointId),
            key: gap.key,
          })
        );
      } catch (error) {
        // Found by two passes at once; the other one has it.
        if (!isDuplicateKeyError(error)) throw error;
      }
    }
  }
  return result;
}

/**
 * Brings the open missing credits up to date and nothing more: the ones
 * the user has explained by adding rows close, and none are added. Called
 * before anything shows them, so a to-do goes the moment its row is in -
 * and costs one count when there are none, which is the usual case.
 */
export async function settleMissingCredits(userId: Types.ObjectId, accountIds?: string[]): Promise<void> {
  const open = await MissingCredit.distinct("accountId", {
    userId,
    status: "open",
    ...(accountIds ? { accountId: { $in: accountIds.map((id) => new Types.ObjectId(id)) } } : {}),
  });
  if (open.length === 0) return;
  await detectMissingCredits(userId, {
    accountIds: open.map((id: Types.ObjectId) => id.toString()),
    createNew: false,
  });
}

/**
 * After a message that stated a balance has been stored: the gaps either
 * side of it, on the account it moved. Cheap - one account's walk - and
 * never allowed to fail the message's own ingest.
 */
export async function detectAfterStatedBalance(row: {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  accountId?: Types.ObjectId | null;
  statedBalanceMinor?: number | null;
}): Promise<void> {
  if (!row.accountId || row.statedBalanceMinor == null) return;
  try {
    const accounts = await Account.find({ userId: row.userId }).select(
      "accountType linkedAccountId openingBalanceMinor openingBalanceAt"
    );
    const owner = ledgerContext(accounts).ownerOf.get(row.accountId.toString());
    if (!owner) return;
    await detectMissingCredits(row.userId, { accountIds: [owner], touching: row._id });
  } catch (error) {
    console.error("Missing credit check after ingest failed:", error);
  }
}

// ---- Words ---------------------------------------------------------------

type Labelled = Pick<AccountDoc, "nickname" | "bankName" | "last4">;

/** "₹5,000 came into Federal Bank ••5130 between 10 and 12 Oct". */
export function missingCreditTitle(account: Labelled | null, credit: Pick<MissingCreditDoc, "amountMinor" | "after" | "before">): string {
  const where = account ? accountLabel(account) : "an account";
  return `${rupees(credit.amountMinor)} came into ${where} ${windowText(credit.after, credit.before)}`;
}

// ---- Suggestions ---------------------------------------------------------

/** A likely answer, ready to send as the body of resolve. */
export interface MissingCreditSuggestion {
  as: MissingCreditAnswer;
  label: string;
  fromAccountId?: string;
  /// The row on the other account a transfer would pair with.
  transactionId?: string;
  contactId?: string;
}

/// A salary is "near" when it is this close to the figure in the profile:
/// lower is common (leave, a short month), higher less so.
const SALARY_LOW = 0.7;
const SALARY_HIGH = 1.25;

/** The IST day of the month a salary day lands on in a given month. */
function payDayIn(year: number, month: number, salaryDay: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(salaryDay, last);
}

/** Whether an IST pay day falls in the window. */
export function windowHasPayDay(after: Date, before: Date, salaryDay: number): boolean {
  const ist = (at: Date) => new Date(at.getTime() + IST_OFFSET_MS);
  const end = ist(before);
  // Day by day, IST: a window is days long, not months.
  for (let at = ist(after), guard = 0; at <= end && guard < 400; at = new Date(at.getTime() + DAY_MS), guard += 1) {
    if (at.getUTCDate() === payDayIn(at.getUTCFullYear(), at.getUTCMonth(), salaryDay)) return true;
  }
  // The last day itself, when the walk stepped past it.
  return end.getUTCDate() === payDayIn(end.getUTCFullYear(), end.getUTCMonth(), salaryDay);
}

type CreditLike = Pick<MissingCreditDoc, "_id" | "accountId" | "amountMinor" | "after" | "before">;

/**
 * The likely answers for each missing credit, likeliest first:
 *
 *   - the same amount leaving another of the user's own accounts within
 *     the window - a day either side, since the two ends of a transfer
 *     post apart - and not yet anybody's other leg: from that account;
 *   - the month's pay, when the window holds the pay day and the amount
 *     is near the salary;
 *   - someone who owes exactly that much, paying it back.
 */
export async function suggestionsFor(
  userId: Types.ObjectId,
  credits: CreditLike[]
): Promise<Map<string, MissingCreditSuggestion[]>> {
  const result = new Map<string, MissingCreditSuggestion[]>(credits.map((credit) => [credit._id.toString(), []]));
  if (credits.length === 0) return result;

  const [accounts, user, contacts, owed] = await Promise.all([
    Account.find({ userId }).select("bankName nickname last4 accountType linkedAccountId"),
    User.findById(userId).select("salaryDay salaryAmountMinor"),
    Contact.find({ userId }).select("name openingBalanceMinor"),
    balances(userId),
  ]);
  const byId = new Map(accounts.map((account) => [account._id.toString(), account]));
  const ownerOf = (id: Types.ObjectId | null | undefined) => {
    const account = id ? byId.get(id.toString()) : undefined;
    if (account?.accountType === "DEBIT" && account.linkedAccountId) {
      return byId.get(account.linkedAccountId.toString()) ?? account;
    }
    return account ?? null;
  };

  const earliest = new Date(Math.min(...credits.map((credit) => credit.after.getTime())) - DAY_MS);
  const latest = new Date(Math.max(...credits.map((credit) => credit.before.getTime())) + DAY_MS);
  const debits = await Transaction.find({
    userId,
    type: "DEBIT",
    amountMinor: { $in: [...new Set(credits.map((credit) => credit.amountMinor))] },
    occurredAt: { $gte: earliest, $lte: latest },
    accountId: { $ne: null },
    transferPairId: null,
    cardPaymentFor: null,
    emiRole: null,
    loanId: null,
    isSettlement: { $ne: true },
    isAdjustment: { $ne: true },
  })
    .select("accountId amountMinor occurredAt isTransfer transferAccountId")
    .lean();

  for (const credit of credits) {
    const list = result.get(credit._id.toString())!;
    const here = credit.accountId.toString();

    const from = new Date(credit.after.getTime() - DAY_MS);
    const to = new Date(credit.before.getTime() + DAY_MS);
    const middle = (credit.after.getTime() + credit.before.getTime()) / 2;
    const transfers = debits
      .filter((row) => row.amountMinor === credit.amountMinor && row.occurredAt >= from && row.occurredAt <= to)
      .map((row) => ({ row, owner: ownerOf(row.accountId) }))
      .filter(({ row, owner }) => {
        if (!owner || owner._id.toString() === here) return false;
        if (owner.accountType === "CARD" || owner.accountType === "UPI") return false;
        // A transfer of its own to a third account is that one's.
        if (row.isTransfer && row.transferAccountId) {
          const target = ownerOf(row.transferAccountId);
          if (target && target._id.toString() !== here) return false;
        }
        return true;
      })
      .sort((a, b) => Math.abs(a.row.occurredAt.getTime() - middle) - Math.abs(b.row.occurredAt.getTime() - middle));
    for (const { row, owner } of transfers.slice(0, 2)) {
      list.push({
        as: "transfer",
        label: `From ${accountLabel(owner!)} — you sent ${rupees(row.amountMinor)} on ${shortDay(row.occurredAt)}`,
        fromAccountId: owner!._id.toString(),
        transactionId: row._id.toString(),
      });
    }

    const salary = user?.salaryAmountMinor ?? null;
    const salaryDay = user?.salaryDay ?? null;
    if (
      salary &&
      salaryDay &&
      credit.amountMinor >= salary * SALARY_LOW &&
      credit.amountMinor <= salary * SALARY_HIGH &&
      windowHasPayDay(credit.after, credit.before, salaryDay)
    ) {
      list.push({ as: "salary", label: "Your salary — the window includes pay day" });
    }

    for (const contact of contacts) {
      const balance = (contact.openingBalanceMinor ?? 0) + (owed.get(contact._id.toString())?.balanceMinor ?? 0);
      if (balance <= 0 || Math.abs(balance - credit.amountMinor) > DRIFT_TOLERANCE_MINOR) continue;
      list.push({
        as: "paid_back",
        label: `${contact.name} paying you back — owed you ${rupees(balance)}`,
        contactId: contact._id.toString(),
      });
    }
  }
  return result;
}

/** A missing credit as the API sends it. */
export async function describeMissingCredits(userId: Types.ObjectId, credits: HydratedDocument<MissingCreditDoc>[]) {
  const [accounts, suggestions] = await Promise.all([
    Account.find({ userId, _id: { $in: credits.map((credit) => credit.accountId) } }),
    suggestionsFor(
      userId,
      credits.filter((credit) => credit.status === "open")
    ),
  ]);
  return credits.map((credit) => {
    const account = accounts.find((candidate) => candidate._id.equals(credit.accountId)) ?? null;
    return {
      id: credit._id.toString(),
      accountId: credit.accountId.toString(),
      account: account
        ? {
            name: account.nickname || account.bankName,
            bankName: account.bankName,
            last4: account.last4 ?? null,
            noCreditAlerts: Boolean(account.noCreditAlerts),
          }
        : null,
      amountMinor: credit.amountMinor,
      after: credit.after,
      before: credit.before,
      status: credit.status,
      resolvedAs: credit.resolvedAs ?? null,
      resolvedTransactionId: credit.resolvedTransactionId?.toString() ?? null,
      dismissedReason: credit.dismissedReason ?? null,
      title: missingCreditTitle(account, credit),
      body: "What was it?",
      suggestions: suggestions.get(credit._id.toString()) ?? [],
      createdAt: credit.createdAt,
    };
  });
}

// ---- Banks that never text money in --------------------------------------

/// Enough debits by text to know the bank texts, and almost no credits:
/// it is not texting the money that comes in.
export const SUGGEST_MIN_DEBITS = 15;
export const SUGGEST_MAX_CREDITS = 1;
export const TEXT_COUNT_DAYS = 90;

export interface TextCounts {
  debits: number;
  credits: number;
  days: number;
}

/**
 * How many debits and credits each bank account was texted about in the
 * last ninety days - its debit cards' messages counted as its own - for
 * suggesting noCreditAlerts. Rows, not messages: one payment reported by
 * an SMS and an email is one.
 */
export async function textCountsFor(
  userId: Types.ObjectId,
  accounts: Pick<AccountDoc, "_id" | "accountType" | "linkedAccountId">[],
  now = new Date()
): Promise<Map<string, TextCounts>> {
  const rows = await Transaction.aggregate<{ _id: { accountId: Types.ObjectId; type: string }; count: number }>([
    {
      $match: {
        userId,
        accountId: { $ne: null },
        occurredAt: { $gte: new Date(now.getTime() - TEXT_COUNT_DAYS * DAY_MS) },
        "sources.source": "SMS",
      },
    },
    { $group: { _id: { accountId: "$accountId", type: "$type" }, count: { $sum: 1 } } },
  ]);

  const ownerOf = new Map<string, string>();
  for (const account of accounts) {
    const id = account._id.toString();
    ownerOf.set(id, account.accountType === "DEBIT" && account.linkedAccountId ? account.linkedAccountId.toString() : id);
  }
  const counts = new Map<string, TextCounts>();
  for (const row of rows) {
    const owner = ownerOf.get(row._id.accountId.toString());
    if (!owner) continue;
    const entry = counts.get(owner) ?? { debits: 0, credits: 0, days: TEXT_COUNT_DAYS };
    if (row._id.type === "DEBIT") entry.debits += row.count;
    else entry.credits += row.count;
    counts.set(owner, entry);
  }
  return counts;
}

/** Whether to suggest turning noCreditAlerts on. Suggested, never set. */
export function suggestsNoCreditAlerts(
  account: Pick<AccountDoc, "accountType" | "noCreditAlerts">,
  counts: TextCounts | undefined
): boolean {
  if (account.accountType !== "BANK" || account.noCreditAlerts || !counts) return false;
  return counts.debits >= SUGGEST_MIN_DEBITS && counts.credits <= SUGGEST_MAX_CREDITS;
}

// ---- The first pass ------------------------------------------------------

/// Raised when the rule for what counts as a missing credit changes.
export const MISSING_CREDIT_BACKFILL = "missingCredits";
export const MISSING_CREDIT_BACKFILL_VERSION = 1;

/**
 * The last ninety days' gaps, for every user it has not run for (see
 * backfill.ts): the history a user already has is where most of these
 * are, and the nightly pass would otherwise wait for tonight to find them.
 * Safe to run twice - a gap is one record however often it is found.
 */
export async function runMissingCreditBackfill(now = new Date()): Promise<{ users: number; found: number }> {
  const since = new Date(now.getTime() - MISSING_CREDIT_LOOKBACK_DAYS * DAY_MS);
  const result = await runOncePerUser(MISSING_CREDIT_BACKFILL, MISSING_CREDIT_BACKFILL_VERSION, async (userId) => {
    const found = await detectMissingCredits(userId, { since });
    return found.created.length + found.reopened;
  });
  if (result.users > 0) {
    console.log(`Missing credits: ${result.changed} found in the last ${MISSING_CREDIT_LOOKBACK_DAYS} days, across ${result.users} user(s).`);
  }
  return { users: result.users, found: result.changed };
}
