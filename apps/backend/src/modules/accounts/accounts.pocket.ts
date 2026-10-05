import { Types } from "mongoose";
import { AccountDoc, Transaction } from "../../models";
import { istDayKey } from "../../time";
import { cycleFor } from "../cards/cards.cycle";

/**
 * Where a pocket-money account stands this month.
 *
 * Its month runs from the renewal day to the day before the next one -
 * the same shape as a card's billing cycle, so the same arithmetic. On
 * renewal day it is topped back up to the limit, so what has to go in is
 * whatever was spent in the month just ended.
 */
export interface PocketStatus {
  holder: string;
  limitMinor: number;
  renewDay: number;
  /// This month: from the last renewal to the day before the next.
  from: string;
  to: string;
  renewsOn: string;
  spentMinor: number;
  leftMinor: number;
  transactionCount: number;
  /// What the month just ended used, which is what renewal day needs put
  /// back in.
  lastMonthSpentMinor: number;
  /// Whether money already went in this month - a top-up recorded as
  /// money into this account since the renewal day.
  toppedUpMinor: number;
  /// Renewal day is today: time to top up.
  renewsToday: boolean;
}

async function spentOn(accountId: Types.ObjectId, userId: Types.ObjectId, start: Date, end: Date) {
  const [row] = await Transaction.aggregate<{ spent: number; count: number; topped: number }>([
    { $match: { userId, accountId, occurredAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: null,
        // The whole amount, not the counted one: a top-up is a transfer
        // and counts as nothing, but it is still money into the account.
        spent: { $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, "$amountMinor", 0] } },
        topped: { $sum: { $cond: [{ $eq: ["$type", "CREDIT"] }, "$amountMinor", 0] } },
        count: { $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, 1, 0] } },
      },
    },
  ]);
  return { spent: row?.spent ?? 0, topped: row?.topped ?? 0, count: row?.count ?? 0 };
}

export async function pocketStatus(
  userId: Types.ObjectId,
  account: Pick<AccountDoc, "_id" | "pocketMoney">,
  now = new Date()
): Promise<PocketStatus | null> {
  const pocket = account.pocketMoney;
  if (!pocket) return null;

  const cycle = cycleFor({ statementDay: pocket.renewDay }, now)!;
  const previous = cycleFor({ statementDay: pocket.renewDay }, new Date(cycle.start.getTime() - 1))!;
  const [current, last] = await Promise.all([
    spentOn(account._id, userId, cycle.start, now.getTime() < cycle.statementOn.getTime() ? new Date(now.getTime() + 1) : cycle.statementOn),
    spentOn(account._id, userId, previous.start, cycle.start),
  ]);

  return {
    holder: pocket.holder,
    limitMinor: pocket.limitMinor,
    renewDay: pocket.renewDay,
    from: istDayKey(cycle.start),
    to: istDayKey(cycle.endsOn),
    renewsOn: istDayKey(cycle.statementOn),
    spentMinor: current.spent,
    leftMinor: Math.max(0, pocket.limitMinor - current.spent),
    transactionCount: current.count,
    lastMonthSpentMinor: last.spent,
    toppedUpMinor: current.topped,
    renewsToday: istDayKey(cycle.start) === istDayKey(now),
  };
}

/** Every pocket-money account's status, by account id. */
export async function pocketStatuses(
  userId: Types.ObjectId,
  accounts: Pick<AccountDoc, "_id" | "pocketMoney">[],
  now = new Date()
): Promise<Map<string, PocketStatus>> {
  const rows = await Promise.all(
    accounts
      .filter((account) => account.pocketMoney)
      .map(async (account) => [account._id.toString(), await pocketStatus(userId, account, now)] as const)
  );
  return new Map(rows.filter((row): row is readonly [string, PocketStatus] => row[1] !== null));
}
