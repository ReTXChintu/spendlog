import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, AccountDoc, BalanceAlert, BalanceCheckpoint, Transaction } from "../../models";
import { AccountLedger, LedgerEntry, accountLedgers, tracksBalance } from "./accounts.balance";
import { describeAlerts } from "./accounts.drift";
import { suspectsFor } from "./accounts.suspects";

/**
 * The passbook, and setting it against the bank.
 *
 * Mounted on /accounts beside the account routes. Everything here reads
 * one account's ledger the same way: the shared walk in accounts.balance,
 * so the figure on the tile, the running balance down the passbook and
 * the gap the reconciler explains are one number computed once.
 */
export const passbookRouter = Router();

/** What every page about the account says about it. */
function describeAccount(account: AccountDoc) {
  return {
    id: account._id.toString(),
    name: account.nickname || account.bankName,
    bankName: account.bankName,
    last4: account.last4 ?? null,
    accountType: account.accountType,
  };
}

/**
 * The account and its ledger, or why there is not one: only a bank or cash
 * account has a passbook, and only once it has a starting balance.
 */
async function ledgerFor(
  userId: Types.ObjectId,
  accountId: string
): Promise<{ account: AccountDoc; ledger: AccountLedger } | { status: number; error: string; hint?: Record<string, unknown> }> {
  const accounts = await Account.find({ userId });
  const account = accounts.find((candidate) => candidate._id.toString() === accountId);
  if (!account) return { status: 404, error: "Not found" };

  if (account.accountType === "DEBIT" && account.linkedAccountId) {
    return {
      status: 400,
      error: "A debit card spends from its bank account. Open that account's passbook.",
      hint: { accountId: account.linkedAccountId.toString() },
    };
  }
  if (!tracksBalance(account)) {
    return { status: 400, error: "Only a bank or cash account has a passbook." };
  }
  if (account.openingBalanceMinor == null || !account.openingBalanceAt) {
    return { status: 400, error: "Set a starting balance on this account first." };
  }

  const ledger = (await accountLedgers(userId, accounts, [accountId])).get(accountId);
  if (!ledger) return { status: 400, error: "Set a starting balance on this account first." };
  return { account, ledger };
}

/** A ledger entry as the passbook shows it. */
function passbookRow(entry: LedgerEntry) {
  const { at, ...rest } = entry;
  return { ...rest, on: at };
}

const passbookQuerySchema = z.object({
  // The cursor from the previous page: its nextBefore. A position in the
  // account's history, oldest first, so a page is "everything older than
  // what you already have".
  before: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// GET /accounts/alerts - the drift alerts not yet seen.
passbookRouter.get("/alerts", async (req, res) => {
  const userId = currentUserId(req);
  const alerts = await BalanceAlert.find({ userId, seenAt: null }).sort({ createdAt: -1 });
  res.json(await describeAlerts(userId, alerts));
});

// POST /accounts/alerts/:id/seen - the user has looked at it.
passbookRouter.post("/alerts/:id/seen", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const alert = await BalanceAlert.findOneAndUpdate(
    { _id: req.params.id, userId },
    { $set: { seenAt: new Date() } },
    { new: true }
  );
  if (!alert) return res.status(404).json({ error: "Not found" });
  res.json((await describeAlerts(userId, [alert]))[0]);
});

/**
 * GET /accounts/:id/passbook - every row that moved the account, newest
 * first, each with what the app expected the account to hold after it and
 * what the bank said it held.
 *
 * Newest first for the screen's sake: it opens on today and scrolls back
 * into the past, like the ledger. The running balance is still worked out
 * oldest first, over the whole history, so a page part-way down shows the
 * same figures it would at the top. firstDrift is likewise over the whole
 * history, whichever page it falls on.
 */
passbookRouter.get("/:id/passbook", validObjectIdParam("id"), async (req, res) => {
  const query = passbookQuerySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.flatten() });

  const found = await ledgerFor(currentUserId(req), req.params.id);
  if ("error" in found) return res.status(found.status).json({ error: found.error, ...found.hint });
  const { account, ledger } = found;

  const upTo = query.data.before ?? ledger.entries.length;
  const page = ledger.entries.slice(Math.max(0, upTo - query.data.limit), upTo).reverse();
  const oldest = page[page.length - 1]?.seq ?? 0;

  res.json({
    account: describeAccount(account),
    openingMinor: ledger.openingMinor,
    openingAt: ledger.openingAt,
    expectedNowMinor: ledger.expectedNowMinor,
    lastStated: ledger.lastStated,
    firstDrift: firstDriftOf(ledger),
    rows: page.map(passbookRow),
    total: ledger.entries.length,
    nextBefore: oldest > 0 ? oldest : null,
  });
});

function firstDriftOf(ledger: AccountLedger) {
  const drift = ledger.firstDrift;
  if (!drift) return null;
  return {
    transactionId: drift.transactionId,
    checkpointId: drift.checkpointId,
    on: drift.at,
    driftMinor: drift.driftMinor,
    seq: drift.seq,
  };
}

/**
 * GET /accounts/:id/reconcile - how far the account is from the bank, and
 * what could explain it, likeliest first.
 */
passbookRouter.get("/:id/reconcile", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const found = await ledgerFor(userId, req.params.id);
  if ("error" in found) return res.status(found.status).json({ error: found.error, ...found.hint });
  const { account, ledger } = found;

  const suspects = await suspectsFor(userId, ledger);
  res.json({
    account: describeAccount(account),
    expectedMinor: ledger.expectedNowMinor,
    lastStated: ledger.lastStated,
    differenceMinor: ledger.lastStated?.driftMinor ?? null,
    firstDrift: firstDriftOf(ledger),
    // The score is for ordering here, not for showing.
    suspects: suspects.map(({ score: _score, ...suspect }) => suspect),
  });
});

const adjustSchema = z.object({
  /// What the bank shows, in paise. Signed: an overdraft is negative.
  balanceMinor: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00),
  /// When it showed that. Now, when left out.
  on: z.coerce.date().optional(),
  note: z.string().max(120).nullable().optional(),
});

/** The app's running balance at an instant: after every row on or before it. */
function expectedAt(ledger: AccountLedger, at: Date): number {
  let running = ledger.openingMinor;
  for (const entry of ledger.entries) {
    if (entry.at > at) break;
    running = entry.runningMinor;
  }
  return running;
}

/**
 * POST /accounts/:id/reconcile/adjust - the last resort: write the gap in.
 *
 * A row for the difference, so the balance is right from here on: a debit
 * when the app showed more than the bank, a credit when less. It counts
 * as spending or income like any other row - the user wants a missing
 * three thousand rupees to stay visible in the month, not hidden to make
 * a number tidy - and it sits in the to-dos until they say what it was.
 * The figure typed in is kept as a checkpoint too, since it is the bank's
 * own word for that moment.
 */
passbookRouter.post("/:id/reconcile/adjust", validObjectIdParam("id"), async (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const found = await ledgerFor(userId, req.params.id);
  if ("error" in found) return res.status(found.status).json({ error: found.error, ...found.hint });
  const { account, ledger } = found;

  const on = parsed.data.on ?? new Date();
  if (on <= ledger.openingAt) {
    return res.status(400).json({ error: "That is before the starting balance. Change the starting balance instead." });
  }

  const gapMinor = parsed.data.balanceMinor - expectedAt(ledger, on);
  if (gapMinor === 0) {
    return res.status(400).json({ error: "Nothing to adjust: SpendLog already shows that balance." });
  }

  const transaction = await Transaction.create({
    userId,
    accountId: account._id,
    type: gapMinor < 0 ? "DEBIT" : "CREDIT",
    amountMinor: Math.abs(gapMinor),
    merchant: "Unexplained difference",
    note: parsed.data.note ?? null,
    source: "MANUAL",
    occurredAt: on,
    isAdjustment: true,
    needsExplanation: true,
  });
  const checkpoint = await BalanceCheckpoint.create({
    userId,
    accountId: account._id,
    on,
    balanceMinor: parsed.data.balanceMinor,
    source: "MANUAL",
    note: "Typed in when adjusting",
  });

  res.status(201).json({ gapMinor, transaction, checkpoint });
});

const checkpointSchema = z.object({
  balanceMinor: z.number().int().min(-1_000_000_000_00).max(1_000_000_000_00),
  on: z.coerce.date(),
  note: z.string().max(120).nullable().optional(),
});

/** A bank or cash account of this user's, or null. */
async function balanceAccount(userId: Types.ObjectId, accountId: string) {
  const account = await Account.findOne({ _id: accountId, userId });
  return account && tracksBalance(account) ? account : null;
}

// GET /accounts/:id/checkpoints - every figure the bank has given for the
// account, newest first.
passbookRouter.get("/:id/checkpoints", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  if (!(await balanceAccount(userId, req.params.id))) return res.status(404).json({ error: "Not found" });
  res.json(await BalanceCheckpoint.find({ userId, accountId: req.params.id }).sort({ on: -1 }));
});

// POST /accounts/:id/checkpoints - "my bank app shows X on this date".
//
// Read by the passbook exactly as a balance in an SMS is: the app's running
// figure at that moment is set against it, and a gap is a drift.
passbookRouter.post("/:id/checkpoints", validObjectIdParam("id"), async (req, res) => {
  const parsed = checkpointSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const account = await balanceAccount(userId, req.params.id);
  if (!account) return res.status(404).json({ error: "Not found" });

  const checkpoint = await BalanceCheckpoint.create({
    userId,
    accountId: account._id,
    on: parsed.data.on,
    balanceMinor: parsed.data.balanceMinor,
    source: "MANUAL",
    note: parsed.data.note ?? null,
  });
  res.status(201).json(checkpoint);
});

passbookRouter.delete("/:id/checkpoints/:checkpointId", validObjectIdParam("id"), validObjectIdParam("checkpointId"), async (req, res) => {
  const deleted = await BalanceCheckpoint.findOneAndDelete({
    _id: req.params.checkpointId,
    userId: currentUserId(req),
    accountId: req.params.id,
  });
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});
