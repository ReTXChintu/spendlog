import { Types } from "mongoose";
import { AccountDoc, Transaction } from "../../models";

/**
 * What an account should hold right now, from a starting balance and
 * everything that has moved through it since.
 *
 * Counted on the amount the bank moved, not on countedAmountMinor. The two
 * questions differ: a transfer to your own savings is not spending, but
 * the money has still left this account; a split bill was only partly
 * yours, but all of it came out. A balance is about money, not spending.
 *
 * A bank account's debit cards spend from it, so their transactions count
 * here too - the card is a way into the account, not an account of its own.
 */

export interface ExpectedBalance {
  openingMinor: number;
  since: Date;
  inMinor: number;
  outMinor: number;
  expectedMinor: number;
  transactionCount: number;
}

/** Only an account holding money has a balance to track. */
export function tracksBalance(account: Pick<AccountDoc, "accountType">): boolean {
  return account.accountType === "BANK" || account.accountType === "CASH";
}

export async function expectedBalances(
  userId: Types.ObjectId,
  accounts: Pick<AccountDoc, "_id" | "accountType" | "linkedAccountId" | "openingBalanceMinor" | "openingBalanceAt">[]
): Promise<Map<string, ExpectedBalance>> {
  const result = new Map<string, ExpectedBalance>();
  const tracked = accounts.filter(
    (account) => tracksBalance(account) && account.openingBalanceMinor != null && account.openingBalanceAt
  );
  if (tracked.length === 0) return result;

  // Which account each debit card's spending belongs to.
  const ownerOf = new Map<string, string>();
  for (const account of tracked) ownerOf.set(account._id.toString(), account._id.toString());
  for (const account of accounts) {
    if (account.accountType === "DEBIT" && account.linkedAccountId) {
      const owner = account.linkedAccountId.toString();
      if (ownerOf.has(owner)) ownerOf.set(account._id.toString(), owner);
    }
  }

  const earliest = new Date(Math.min(...tracked.map((account) => account.openingBalanceAt!.getTime())));
  const rows = await Transaction.find({
    userId,
    accountId: { $in: [...ownerOf.keys()].map((id) => new Types.ObjectId(id)) },
    occurredAt: { $gt: earliest },
  }).select("accountId type amountMinor occurredAt");

  for (const account of tracked) {
    result.set(account._id.toString(), {
      openingMinor: account.openingBalanceMinor!,
      since: account.openingBalanceAt!,
      inMinor: 0,
      outMinor: 0,
      expectedMinor: account.openingBalanceMinor!,
      transactionCount: 0,
    });
  }

  const sinceFor = new Map(tracked.map((account) => [account._id.toString(), account.openingBalanceAt!]));
  for (const row of rows) {
    const owner = ownerOf.get(String(row.accountId));
    if (!owner) continue;
    // After the moment the balance was read, not on it: a payment in the
    // same minute was already in the figure typed in.
    if (row.occurredAt <= sinceFor.get(owner)!) continue;

    const balance = result.get(owner)!;
    if (row.type === "CREDIT") balance.inMinor += row.amountMinor;
    else balance.outMinor += row.amountMinor;
    balance.transactionCount += 1;
  }

  for (const balance of result.values()) {
    balance.expectedMinor = balance.openingMinor + balance.inMinor - balance.outMinor;
  }
  return result;
}
