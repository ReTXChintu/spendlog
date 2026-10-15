import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Account, Transaction } from "../../models";
import { statedFiguresFor } from "../../parsing/ingest";
import { parseTransactionText } from "../../parsing/parser";
import { AccountType } from "../../types";

/**
 * Two repairs for rows imported before the ledger read balances.
 *
 * The first reads the bank's balance off every message already stored,
 * so the passbook has something to check against from the start rather
 * than only from today. The second stops guessing cash: a message that
 * named no account was filed as a cash payment, and every one of those
 * guesses is in the cash balance. They come out of it here - which moves
 * money out of that balance, and is meant to.
 */

export const STATED_BALANCE_BACKFILL = "statedBalances";
export const STATED_BALANCE_BACKFILL_VERSION = 1;

export const ACCOUNT_UNKNOWN_BACKFILL = "accountUnknown";
export const ACCOUNT_UNKNOWN_BACKFILL_VERSION = 1;

/**
 * One user's pass over the balances: every SMS or email row with no stated
 * balance yet is parsed again, its own text and every message that
 * reported it, and the first figure found is kept. A row with none in any
 * of its messages is left as it is, and found again by a second run only
 * to be left again - safe to run twice, just not free.
 */
export async function backfillStatedBalances(userId: Types.ObjectId): Promise<number> {
  const accounts = await Account.find({ userId }).select("accountType");
  const typeOf = new Map<string, AccountType>(accounts.map((account) => [account._id.toString(), account.accountType]));

  let filled = 0;
  const cursor = Transaction.find({
    userId,
    statedBalanceMinor: null,
    statedAvailableLimitMinor: null,
    $or: [{ source: { $in: ["SMS", "EMAIL"] } }, { "sources.source": { $in: ["SMS", "EMAIL"] } }],
  })
    .select("accountId rawText sources")
    .cursor();

  for await (const row of cursor) {
    const accountType = row.accountId ? (typeOf.get(row.accountId.toString()) ?? null) : null;
    const texts = [row.rawText, ...row.sources.map((entry) => entry.rawText)].filter((text): text is string => Boolean(text));

    let balanceMinor: number | null = null;
    let availableLimitMinor: number | null = null;
    for (const text of texts) {
      const figures = statedFiguresFor(text, accountType);
      balanceMinor ??= figures.balanceMinor;
      availableLimitMinor ??= figures.availableLimitMinor;
    }
    if (balanceMinor === null && availableLimitMinor === null) continue;

    // Straight to the collection: nothing the counted-amount hooks derive
    // depends on these, and a hook per row is a lot of rows.
    await Transaction.updateOne(
      { _id: row._id },
      { $set: { statedBalanceMinor: balanceMinor, statedAvailableLimitMinor: availableLimitMinor } }
    );
    filled += 1;
  }
  return filled;
}

/**
 * One user's pass over the cash guesses: every SMS or email row with no
 * account, never edited, whose message names no account the parser can
 * read, is marked as of unknown account. It stops counting as cash and
 * goes on counting as spending. A row somebody has edited is left alone -
 * they may have meant cash - and so is one whose message does name an
 * account, since something other than the parser cleared it.
 */
export async function backfillAccountUnknown(userId: Types.ObjectId): Promise<number> {
  let marked = 0;
  const cursor = Transaction.find({
    userId,
    accountId: null,
    accountUnknown: { $ne: true },
    editedAt: null,
    source: { $in: ["SMS", "EMAIL"] },
  })
    .select("rawText sources")
    .cursor();

  for await (const row of cursor) {
    const text = row.rawText ?? row.sources[0]?.rawText;
    if (!text) continue;
    const parsed = parseTransactionText(text);
    if (parsed?.account) continue;

    await Transaction.updateOne({ _id: row._id }, { $set: { accountUnknown: true } });
    marked += 1;
  }
  return marked;
}

/** Both passes, for every user who has not had them (see backfill.ts). */
export async function runStatedBalanceBackfill(): Promise<void> {
  const { users, changed } = await runOncePerUser(
    STATED_BALANCE_BACKFILL,
    STATED_BALANCE_BACKFILL_VERSION,
    backfillStatedBalances
  );
  if (changed > 0) console.log(`Stated balance backfill: read ${changed} balances across ${users} users.`);
}

export async function runAccountUnknownBackfill(): Promise<void> {
  const { users, changed } = await runOncePerUser(
    ACCOUNT_UNKNOWN_BACKFILL,
    ACCOUNT_UNKNOWN_BACKFILL_VERSION,
    backfillAccountUnknown
  );
  if (changed > 0) {
    console.log(`Account unknown backfill: ${changed} payments across ${users} users no longer count as cash.`);
  }
}
