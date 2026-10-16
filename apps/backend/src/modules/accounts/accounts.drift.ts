import { HydratedDocument, Types } from "mongoose";
import {
  Account,
  AccountDoc,
  BalanceAlert,
  BalanceAlertDoc,
  CardStatement,
  JobRun,
  MissingCredit,
  MissingCreditDoc,
  Transaction,
  User,
} from "../../models";
import { IST_OFFSET_MS, istDayKey, istMonthEnd, istMonthKey, istMonthStart } from "../../time";
import { sendNotification } from "../family/family.push";
import { AccountLedger, accountLedgers } from "./accounts.balance";
import { accountLabel, rupees, shortDay } from "./accounts.label";
import {
  MISSING_CREDIT_LOOKBACK_DAYS,
  MissingCreditSuggestion,
  detectMissingCredits,
  missingCreditTitle,
  settleMissingCredits,
  suggestionsFor,
} from "./accounts.missingCredits";

/**
 * Telling the user when an account has drifted from the bank, rather than
 * waiting for them to notice a figure looks wrong.
 *
 * Once a night, after the day's messages are in, every tracked account's
 * running balance is set against the bank's latest figure for it - the
 * last SMS that said a balance, or a checkpoint. A gap past a few rupees
 * is recorded as an alert and pushed to the phone. The same gap at the
 * same figure is one problem however many nights it lasts, so it is
 * alerted once; a new figure or a different gap is news again.
 *
 * Before that, the same night looks for money that came in without a
 * message (accounts.missingCredits). Those are counted into the balance
 * provisionally, so a gap they explain is not alerted a second time as a
 * drift; they are pushed as what they are - "₹5,000 came in, what was
 * it?" - instead.
 */

/// A rupee or two is rounding; five is a missing row.
export const ALERT_THRESHOLD_MINOR = 500;

/// Checked after half past ten at night, IST - late enough that the day's
/// alerts have landed.
export const DRIFT_CHECK_HOUR_IST = 22;
export const DRIFT_CHECK_MINUTE_IST = 30;

/// A run that died part way is someone else's to retry after this.
const CLAIM_MS = 15 * 60 * 1000;

const JOB_KEY = "balanceDrift";

const day = shortDay;

export { accountLabel };

type Labelled = Pick<AccountDoc, "nickname" | "bankName" | "last4"> & { noCreditAlerts?: boolean };

/**
 * Whether a gap on this account is most likely money that came in without
 * a text: the bank shows more than SpendLog, and the user has said this
 * bank never texts about money coming in.
 */
function likelyUntextedCredit(account: Labelled | null | undefined, driftMinor: number): boolean {
  return Boolean(account?.noCreditAlerts) && driftMinor > 0;
}

/**
 * "HDFC ••8342 is ₹3,000 off since 12 Oct". On an account whose bank does
 * not text about money in, a gap the bank's way says what it probably is:
 * "Federal Bank ••3295 is ₹5,000 short of the bank since 12 Oct - probably
 * money that came in without a text".
 */
export function alertTitle(account: Labelled, alert: Pick<BalanceAlertDoc, "driftMinor" | "since" | "statedAt">): string {
  const since = day(alert.since ?? alert.statedAt);
  if (likelyUntextedCredit(account, alert.driftMinor)) {
    return `${accountLabel(account)} is ${rupees(alert.driftMinor)} short of the bank since ${since} — probably money that came in without a text`;
  }
  return `${accountLabel(account)} is ${rupees(alert.driftMinor)} off since ${since}`;
}

/** Which side is high, in words the body of a notification can use. */
export function alertBody(
  alert: Pick<BalanceAlertDoc, "driftMinor" | "statedMinor" | "expectedMinor">,
  account?: Labelled | null
): string {
  const figures = `The bank shows ${rupees(alert.statedMinor)}; SpendLog expected ${rupees(alert.expectedMinor)}.`;
  if (likelyUntextedCredit(account, alert.driftMinor)) {
    return `${figures} This bank doesn't text about money coming in - add the credit, or let its statement fill it in.`;
  }
  return alert.driftMinor < 0 ? `${figures} A payment may be missing.` : `${figures} Money in may be missing.`;
}

/**
 * The most recent half-past-ten at night: tonight's when it has passed,
 * otherwise last night's. A run is due once per such moment.
 */
export function lastDriftMoment(now: Date): Date {
  const today = istDayKey(now);
  const minutes = DRIFT_CHECK_HOUR_IST * 60 + DRIFT_CHECK_MINUTE_IST;
  const atToday = new Date(Date.parse(`${today}T00:00:00Z`) - IST_OFFSET_MS + minutes * 60 * 1000);
  return atToday.getTime() <= now.getTime() ? atToday : new Date(atToday.getTime() - 24 * 60 * 60 * 1000);
}

/** The accounts whose balance the nightly check reads. */
async function trackedAccounts(userId: Types.ObjectId) {
  return Account.find({ userId, isActive: true, accountType: { $in: ["BANK", "CASH", "DEBIT"] } });
}

/**
 * One user's accounts, checked. Returns the alerts this run created - one
 * per account whose latest stated figure the app disagrees with, and that
 * has not been alerted at that figure with that gap before.
 */
export async function checkDriftForUser(userId: Types.ObjectId): Promise<BalanceAlertDoc[]> {
  const accounts = await trackedAccounts(userId);
  const ledgers = await accountLedgers(userId, accounts);
  const created: BalanceAlertDoc[] = [];

  for (const [accountId, ledger] of ledgers) {
    const alert = alertFor(ledger);
    if (!alert) continue;

    const exists = await BalanceAlert.exists({
      userId,
      accountId: new Types.ObjectId(accountId),
      statedAt: alert.statedAt,
      driftMinor: alert.driftMinor,
    });
    if (exists) continue;

    try {
      created.push(await BalanceAlert.create({ userId, accountId: new Types.ObjectId(accountId), ...alert }));
    } catch (error) {
      // Two runs at once: the unique index settles it, and the other run
      // has this one.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
  return created;
}

/** What an account's ledger says should be alerted, or nothing. */
export function alertFor(ledger: AccountLedger): Pick<BalanceAlertDoc, "driftMinor" | "statedMinor" | "expectedMinor" | "statedAt" | "since"> | null {
  const stated = ledger.lastStated;
  if (!stated || Math.abs(stated.driftMinor) <= ALERT_THRESHOLD_MINOR) return null;
  return {
    driftMinor: stated.driftMinor,
    statedMinor: stated.minor,
    expectedMinor: stated.expectedMinor,
    statedAt: stated.at,
    since: ledger.firstDrift?.at ?? null,
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

/** The notification for a night's new alerts: one account named, or a count. */
export async function notifyAlerts(userId: Types.ObjectId, alerts: BalanceAlertDoc[]): Promise<void> {
  if (alerts.length === 0) return;

  const accounts = await Account.find({ _id: { $in: alerts.map((alert) => alert.accountId) } });
  const named = alerts
    .map((alert) => ({ alert, account: accounts.find((account) => account._id.equals(alert.accountId)) }))
    .filter((pair): pair is { alert: BalanceAlertDoc; account: (typeof accounts)[number] } => Boolean(pair.account));
  if (named.length === 0) return;

  const first = named[0];
  const note =
    named.length === 1
      ? { title: alertTitle(first.account, first.alert), body: alertBody(first.alert, first.account) }
      : {
          title: `${named.length} accounts are off from the bank`,
          body: named.map(({ account, alert }) => `${accountLabel(account)} by ${rupees(alert.driftMinor)}`).join(", "),
        };

  await sendNotification(userId, {
    ...note,
    data: { type: "BALANCE_DRIFT", accountId: first.account._id.toString(), alertId: first.alert._id.toString() },
  });
}

/**
 * The notification for a night's newly found missing credits: one named,
 * or a count. Opens the account's passbook, where the amber row is.
 */
export async function notifyMissingCredits(
  userId: Types.ObjectId,
  credits: HydratedDocument<MissingCreditDoc>[]
): Promise<void> {
  if (credits.length === 0) return;
  const first = credits[0];
  const account = await Account.findOne({ _id: first.accountId, userId });
  const note =
    credits.length === 1
      ? {
          title: missingCreditTitle(account, first),
          body: account?.noCreditAlerts
            ? "This bank doesn't text about money coming in. What was it?"
            : "What was it?",
        }
      : {
          title: `${credits.length} payments came in without a message`,
          body: `${rupees(credits.reduce((sum, credit) => sum + credit.amountMinor, 0))} in all. Say what each was.`,
        };
  await sendNotification(userId, {
    ...note,
    data: { type: "BALANCE_DRIFT", accountId: first.accountId.toString(), missingCreditId: first._id.toString() },
  });
}

export interface DriftRun {
  ran: boolean;
  users: number;
  alerts: number;
  missingCredits: number;
}

/**
 * The nightly check, for every owner. Called every half hour by the
 * server and once at start-up; the guard in Mongo makes it once a night
 * however often it is called and however many times PM2 restarts. Push
 * not being configured only means the alert is recorded without a
 * notification; the dashboard shows it either way.
 */
export async function runNightlyDriftCheck(now = new Date()): Promise<DriftRun> {
  const moment = lastDriftMoment(now);
  await JobRun.updateOne({ key: JOB_KEY }, { $setOnInsert: { ranAt: null } }, { upsert: true });
  const claim = await JobRun.updateOne(
    {
      key: JOB_KEY,
      $and: [
        { $or: [{ ranAt: null }, { ranAt: { $lt: moment } }] },
        { $or: [{ claimedAt: null }, { claimedAt: { $lt: new Date(now.getTime() - CLAIM_MS) } }] },
      ],
    },
    { $set: { claimedAt: now } }
  );
  if (claim.modifiedCount === 0) return { ran: false, users: 0, alerts: 0, missingCredits: 0 };

  let users = 0;
  let alerts = 0;
  let missingCredits = 0;
  const since = new Date(now.getTime() - MISSING_CREDIT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  try {
    const owners = await User.find({ role: { $ne: "KID" } }).select("_id");
    for (const owner of owners) {
      users += 1;
      // First, so a gap that is money in is counted in before the drift
      // is measured, and not alerted twice.
      const found = await detectMissingCredits(owner._id, { since });
      missingCredits += found.created.length;
      const created = await checkDriftForUser(owner._id);
      alerts += created.length;
      await notifyAlerts(owner._id, created).catch((error) => console.error("Balance drift push failed:", error));
      await notifyMissingCredits(owner._id, found.created).catch((error) =>
        console.error("Missing credit push failed:", error)
      );
    }
    await JobRun.updateOne({ key: JOB_KEY }, { $set: { claimedAt: null, ranAt: now, lastError: null } });
  } catch (error) {
    console.error("Balance drift check failed:", error);
    await JobRun.updateOne({ key: JOB_KEY }, { $set: { claimedAt: null, lastError: "Check failed." } });
  }
  return { ran: true, users, alerts, missingCredits };
}

/** Which account each alert is about, named the way a screen shows it. */
export async function describeAlerts(userId: Types.ObjectId, alerts: BalanceAlertDoc[]) {
  const accounts = await Account.find({ userId, _id: { $in: alerts.map((alert) => alert.accountId) } });
  const byId = new Map(accounts.map((account) => [account._id.toString(), account]));

  return alerts.map((alert) => {
    const account = byId.get(alert.accountId.toString()) ?? null;
    return {
      id: alert._id.toString(),
      accountId: alert.accountId.toString(),
      account: account
        ? { name: account.nickname || account.bankName, bankName: account.bankName, last4: account.last4 ?? null }
        : null,
      driftMinor: alert.driftMinor,
      statedMinor: alert.statedMinor,
      expectedMinor: alert.expectedMinor,
      statedAt: alert.statedAt,
      since: alert.since ?? alert.statedAt,
      seenAt: alert.seenAt ?? null,
      createdAt: alert.createdAt,
      title: account ? alertTitle(account, alert) : `${rupees(alert.driftMinor)} off since ${day(alert.since ?? alert.statedAt)}`,
      body: alertBody(alert, account),
    };
  });
}

/** Anything about balances the user should do something about. */
export type BalanceTodo =
  | {
      kind: "balance_alert";
      title: string;
      body: string;
      alertId: string;
      accountId: string;
      driftMinor: number;
      since: Date;
    }
  | {
      kind: "unexplained_difference";
      title: string;
      body: string;
      transactionId: string;
      accountId: string | null;
      amountMinor: number;
      on: Date;
    }
  | { kind: "unknown_account"; title: string; body: string; count: number; filter: { accountUnknown: "1" } }
  | {
      kind: "missing_credit";
      title: string;
      body: string;
      missingCreditId: string;
      accountId: string;
      amountMinor: number;
      after: Date;
      before: Date;
      suggestions: MissingCreditSuggestion[];
    }
  | { kind: "statement_due"; title: string; body: string; accountId: string; month: string };

/**
 * The balance to-dos for the dashboard: unseen drift alerts, money that
 * came in without a message, adjustments still waiting for an
 * explanation, the payments no account could be placed for, and the
 * statements to fetch for accounts whose bank never texts money in.
 */
export async function balanceTodos(
  userId: Types.ObjectId,
  now = new Date(),
  options: { settle?: boolean } = {}
): Promise<BalanceTodo[]> {
  // A missing credit the user has since explained by adding the row goes
  // before it is listed, not tomorrow night. The dashboard has done this
  // already, before its balances.
  if (options.settle !== false) await settleMissingCredits(userId);
  const [alerts, credits, unexplained, unknown, due] = await Promise.all([
    BalanceAlert.find({ userId, seenAt: null }).sort({ createdAt: -1 }).limit(10),
    MissingCredit.find({ userId, status: "open" }).sort({ before: -1 }).limit(10),
    Transaction.find({ userId, needsExplanation: true }).sort({ occurredAt: -1 }).limit(10),
    Transaction.countDocuments({ userId, accountUnknown: true }),
    statementDueTodos(userId, now),
  ]);
  const suggestions = await suggestionsFor(userId, credits);

  const accountIds = [
    ...alerts.map((alert) => alert.accountId),
    ...credits.map((credit) => credit.accountId),
    ...unexplained.map((row) => row.accountId).filter((id): id is Types.ObjectId => Boolean(id)),
  ];
  const accounts = await Account.find({ userId, _id: { $in: accountIds } });
  const labelOf = (id: Types.ObjectId | null | undefined) => {
    const account = id ? accounts.find((candidate) => candidate._id.equals(id)) : null;
    return account ? accountLabel(account) : "an account";
  };

  const todos: BalanceTodo[] = [];
  for (const alert of alerts) {
    const account = accounts.find((candidate) => candidate._id.equals(alert.accountId));
    todos.push({
      kind: "balance_alert",
      title: account ? alertTitle(account, alert) : `An account is ${rupees(alert.driftMinor)} off`,
      body: alertBody(alert, account),
      alertId: alert._id.toString(),
      accountId: alert.accountId.toString(),
      driftMinor: alert.driftMinor,
      since: alert.since ?? alert.statedAt,
    });
  }
  for (const credit of credits) {
    const account = accounts.find((candidate) => candidate._id.equals(credit.accountId)) ?? null;
    todos.push({
      kind: "missing_credit",
      title: missingCreditTitle(account, credit),
      body: "What was it?",
      missingCreditId: credit._id.toString(),
      accountId: credit.accountId.toString(),
      amountMinor: credit.amountMinor,
      after: credit.after,
      before: credit.before,
      suggestions: suggestions.get(credit._id.toString()) ?? [],
    });
  }
  for (const row of unexplained) {
    todos.push({
      kind: "unexplained_difference",
      title: `${rupees(row.amountMinor)} unexplained ${row.type === "DEBIT" ? "out of" : "into"} ${labelOf(row.accountId)}`,
      body: `Written in on ${day(row.occurredAt)} to match the bank. Give it a category or a name once you know what it was.`,
      transactionId: row._id.toString(),
      accountId: row.accountId?.toString() ?? null,
      amountMinor: row.amountMinor,
      on: row.occurredAt,
    });
  }
  if (unknown > 0) {
    todos.push({
      kind: "unknown_account",
      title: `${unknown} ${unknown === 1 ? "payment" : "payments"} without an account`,
      body: "Not counted in any balance until you say which account each was on.",
      count: unknown,
      filter: { accountUnknown: "1" },
    });
  }
  todos.push(...due);
  return todos;
}

/// Last month's statement is asked for after this day of the month: banks
/// send it in the first few days, and asking on the 1st would only nag.
export const STATEMENT_DUE_AFTER_DAY = 5;

/**
 * The month whose statement is due, as YYYY-MM: last month, once today
 * (IST) is past the 5th. Null before then.
 */
export function statementDueMonth(now: Date): string | null {
  const today = istDayKey(now);
  if (Number(today.slice(8, 10)) <= STATEMENT_DUE_AFTER_DAY) return null;
  return istMonthKey(new Date(istMonthStart(today.slice(0, 7)).getTime() - 1));
}

/**
 * Whether a statement read for this account covers the whole of a month.
 * By its printed period when it has one; by the month it is filed under
 * otherwise, which is as much as such a statement can say.
 */
export async function statementCoversMonth(
  userId: Types.ObjectId,
  accountId: Types.ObjectId,
  month: string
): Promise<boolean> {
  const first = `${month}-01`;
  const last = istDayKey(new Date(istMonthEnd(month).getTime() - 1));
  const statements = await CardStatement.find({ userId, accountId, status: "PARSED" }).select(
    "periodStart periodEnd monthKey"
  );
  return statements.some((statement) =>
    statement.periodStart && statement.periodEnd
      ? istDayKey(statement.periodStart) <= first && istDayKey(statement.periodEnd) >= last
      : statement.monthKey === month
  );
}

/**
 * Once a month, for each bank account whose bank does not text money in:
 * fetch last month's statement, which lists every credit the texts never
 * did. Gone once a statement covering that month has been read, or once
 * waved away for that month.
 */
export async function statementDueTodos(userId: Types.ObjectId, now = new Date()): Promise<BalanceTodo[]> {
  const month = statementDueMonth(now);
  if (!month) return [];
  const accounts = await Account.find({
    userId,
    isActive: true,
    accountType: "BANK",
    noCreditAlerts: true,
    statementDueDismissed: { $ne: month },
  });
  const monthName = istMonthStart(month).toLocaleDateString("en-IN", { month: "long", timeZone: "Asia/Kolkata" });

  const todos: BalanceTodo[] = [];
  for (const account of accounts) {
    if (await statementCoversMonth(userId, account._id, month)) continue;
    todos.push({
      kind: "statement_due",
      title: `Upload ${accountLabel(account)}'s statement for ${monthName} to catch credits it didn't text you about`,
      body: "SpendLog reads it from your mailbox once it arrives, and adds any money in the texts never mentioned.",
      accountId: account._id.toString(),
      month,
    });
  }
  return todos;
}
