import { Router } from "express";
import { HydratedDocument, Types } from "mongoose";
import { z } from "zod";
import { currentUserId } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, AccountDoc, BalanceAlert, MissingCredit, Transaction } from "../../models";
import { istDayKey } from "../../time";
import { expectedBalances, tracksBalance } from "./accounts.balance";
import { accountLabel } from "./accounts.label";

/**
 * Starting the balances again from today.
 *
 * Months of small mismatches pile up - a credit nobody texted, a payment
 * filed twice and since fixed, a checkpoint from before any of that - and
 * past a point the user does not want them explained, only gone: "this is
 * what my bank shows now, follow that". So a fresh start makes the figure
 * typed in the account's new starting balance, as of now, and nothing
 * else changes. Transactions stay exactly as they are; spending, the
 * budget and analytics never read the starting balance, so they do not
 * move. Only the balance walk begins again, and it already ignores
 * everything on or before its starting moment - rows, the balances their
 * messages stated, checkpoints, written-in transfer legs alike (see
 * movementsOf and buildLedger).
 *
 * What the old start left behind is cleared with it: drift alerts measured
 * against it are marked seen, and open missing credits found under it are
 * dismissed (reason fresh_start). Adjustments written in to match the
 * bank are real transactions and are left alone; dated before the new
 * start, they no longer move the balance, and the response says so.
 *
 * The old start is kept (openingHistory) with exactly what this cleared,
 * so undo puts all of it back.
 */
export const freshStartRouter = Router();

/// An undo, not an audit trail.
const HISTORY_KEPT = 10;

/// A phone's clock can run a little ahead of the server's.
const CLOCK_SLACK_MS = 5 * 60 * 1000;

const balanceMinor = z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00);

export interface FreshStartResult {
  accountId: string;
  name: string;
  openingMinor: number;
  openingAt: Date;
  previous: { minor: number | null; at: Date | null };
  alertsCleared: number;
  missingCreditsDismissed: number;
  /// Unexplained differences written in before the new start: still
  /// transactions, no longer in the balance.
  adjustmentsBefore: number;
  note: string | null;
}

type AccountDocument = HydratedDocument<AccountDoc>;

/** Why these accounts cannot start fresh, or null. Checked for all before any is touched. */
function problemWith(entries: { accountId: string }[], found: AccountDocument[], at: Date, now: Date): string | null {
  if (entries.length === 0) return "Give at least one account a figure.";
  const ids = entries.map((entry) => entry.accountId);
  if (new Set(ids).size !== ids.length) return "The same account is in twice.";
  for (const id of ids) {
    const account = found.find((candidate) => candidate._id.toString() === id);
    if (!account) return "One of those accounts isn't yours, or is gone.";
    if (account.accountType === "DEBIT") return "A debit card spends from its bank account. Start that account fresh instead.";
    if (!tracksBalance(account)) return `${accountLabel(account)} has no balance to track: only bank accounts and cash do.`;
  }
  if (at.getTime() > now.getTime() + CLOCK_SLACK_MS) return "A fresh start can't be in the future.";
  return null;
}

/** One account, started again from `minor` at `at`. Assumes it was checked. */
async function applyFreshStart(
  userId: Types.ObjectId,
  account: AccountDocument,
  minor: number,
  at: Date,
  now: Date
): Promise<FreshStartResult> {
  const [alerts, credits, cards] = await Promise.all([
    BalanceAlert.find({ userId, accountId: account._id, seenAt: null, statedAt: { $lte: at } }).select("_id"),
    // Every open one measured from a figure before the new start: their
    // gaps are in history the balance no longer walks.
    MissingCredit.find({ userId, accountId: account._id, status: "open", after: { $lt: at } }).select("_id"),
    Account.find({ userId, accountType: "DEBIT", linkedAccountId: account._id }).select("_id"),
  ]);
  const seenAlertIds = alerts.map((alert) => alert._id);
  const dismissedMissingCreditIds = credits.map((credit) => credit._id);

  await Promise.all([
    BalanceAlert.updateMany({ _id: { $in: seenAlertIds } }, { $set: { seenAt: now } }),
    MissingCredit.updateMany(
      { _id: { $in: dismissedMissingCreditIds } },
      { $set: { status: "dismissed", dismissedReason: "fresh_start", closedAt: now } }
    ),
  ]);
  const adjustmentsBefore = await Transaction.countDocuments({
    userId,
    accountId: { $in: [account._id, ...cards.map((card) => card._id)] },
    isAdjustment: true,
    needsExplanation: true,
    occurredAt: { $lte: at },
  });

  const previous = { minor: account.openingBalanceMinor ?? null, at: account.openingBalanceAt ?? null };
  account.openingHistory.push({
    minor: previous.minor,
    at: previous.at,
    replacedAt: now,
    dismissedMissingCreditIds,
    seenAlertIds,
  });
  if (account.openingHistory.length > HISTORY_KEPT) {
    account.openingHistory.splice(0, account.openingHistory.length - HISTORY_KEPT);
  }
  account.openingBalanceMinor = minor;
  account.openingBalanceAt = at;
  await account.save();

  return {
    accountId: account._id.toString(),
    name: accountLabel(account),
    openingMinor: minor,
    openingAt: at,
    previous,
    alertsCleared: seenAlertIds.length,
    missingCreditsDismissed: dismissedMissingCreditIds.length,
    adjustmentsBefore,
    note:
      adjustmentsBefore > 0
        ? `${adjustmentsBefore} unexplained ${adjustmentsBefore === 1 ? "difference" : "differences"} written in before today ${adjustmentsBefore === 1 ? "stays" : "stay"} as ${adjustmentsBefore === 1 ? "a transaction" : "transactions"}, but no longer ${adjustmentsBefore === 1 ? "moves" : "move"} the balance.`
        : null,
  };
}

/**
 * Starts each account fresh, all or none: every account is checked
 * before the first is touched, so one bad id changes nothing.
 */
export async function startFresh(
  userId: Types.ObjectId,
  entries: { accountId: string; balanceMinor: number }[],
  at: Date,
  now = new Date()
): Promise<FreshStartResult[] | { error: string }> {
  const valid = entries.filter((entry) => Types.ObjectId.isValid(entry.accountId));
  const found = await Account.find({ userId, _id: { $in: valid.map((entry) => new Types.ObjectId(entry.accountId)) } });
  const problem = problemWith(entries, found, at, now);
  if (problem) return { error: problem };

  const results: FreshStartResult[] = [];
  for (const entry of entries) {
    const account = found.find((candidate) => candidate._id.toString() === entry.accountId)!;
    results.push(await applyFreshStart(userId, account, entry.balanceMinor, at, now));
  }
  return results;
}

/** Puts back the starting balance the last fresh start replaced, and what it cleared. */
export async function undoFreshStart(
  userId: Types.ObjectId,
  accountId: string
): Promise<{ account: AccountDocument } | { status: number; error: string }> {
  const account = await Account.findOne({ _id: accountId, userId });
  if (!account) return { status: 404, error: "Not found" };
  const last = account.openingHistory.pop();
  if (!last) return { status: 400, error: "There is no fresh start to undo." };

  account.openingBalanceMinor = last.minor;
  account.openingBalanceAt = last.at;
  await Promise.all([
    account.save(),
    MissingCredit.updateMany(
      { _id: { $in: last.dismissedMissingCreditIds }, status: "dismissed", dismissedReason: "fresh_start" },
      { $set: { status: "open", dismissedReason: null, closedAt: null } }
    ),
    BalanceAlert.updateMany({ _id: { $in: last.seenAlertIds } }, { $set: { seenAt: null } }),
  ]);
  return { account };
}

// ---- Routes --------------------------------------------------------------

// GET /accounts/start-fresh - every bank account and cash, with the figure
// SpendLog has now and the bank's latest, for the screen that asks what
// the bank shows today.
freshStartRouter.get("/start-fresh", async (req, res) => {
  const userId = currentUserId(req);
  const now = new Date();
  const accounts = await Account.find({ userId }).sort({ accountType: 1, bankName: 1, last4: 1 });
  const balances = await expectedBalances(userId, accounts);
  const today = istDayKey(now);

  res.json(
    accounts
      .filter((account) => account.isActive && tracksBalance(account))
      .map((account) => {
        const balance = balances.get(account._id.toString()) ?? null;
        const stated = balance?.lastStated ?? null;
        return {
          accountId: account._id.toString(),
          name: account.nickname || account.bankName,
          bankName: account.bankName,
          last4: account.last4 ?? null,
          accountType: account.accountType,
          isSavings: Boolean(account.isSavings),
          /// Null until the account has a starting balance at all.
          expectedMinor: balance?.expectedMinor ?? null,
          provisionalMinor: balance?.provisionalMinor ?? 0,
          lastStated: stated,
          /// The bank's figure is from today, so it is what the bank shows
          /// now - the screen fills it in.
          statedToday: stated ? istDayKey(stated.at) === today : false,
          canUndo: account.openingHistory.length > 0,
        };
      })
  );
});

const batchSchema = z.object({
  accounts: z
    .array(z.object({ accountId: z.string(), balanceMinor }))
    .min(1)
    .max(50),
  at: z.coerce.date().optional(),
});

// POST /accounts/start-fresh - several accounts at once, all or none.
freshStartRouter.post("/start-fresh", async (req, res) => {
  const parsed = batchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await startFresh(currentUserId(req), parsed.data.accounts, parsed.data.at ?? new Date());
  if ("error" in result) return res.status(400).json({ error: result.error });
  res.json({ accounts: result });
});

const oneSchema = z.object({ balanceMinor, at: z.coerce.date().optional() });

// POST /accounts/:id/start-fresh - one account.
freshStartRouter.post("/:id/start-fresh", validObjectIdParam("id"), async (req, res) => {
  const parsed = oneSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const result = await startFresh(
    currentUserId(req),
    [{ accountId: req.params.id, balanceMinor: parsed.data.balanceMinor }],
    parsed.data.at ?? new Date()
  );
  if ("error" in result) return res.status(400).json({ error: result.error });
  res.json(result[0]);
});

// POST /accounts/:id/start-fresh/undo - back to the start before.
freshStartRouter.post("/:id/start-fresh/undo", validObjectIdParam("id"), async (req, res) => {
  const result = await undoFreshStart(currentUserId(req), req.params.id);
  if (!("account" in result)) return res.status(result.status).json({ error: result.error });
  const { account } = result;
  res.json({
    accountId: account._id.toString(),
    openingMinor: account.openingBalanceMinor ?? null,
    openingAt: account.openingBalanceAt ?? null,
    canUndo: account.openingHistory.length > 0,
  });
});
