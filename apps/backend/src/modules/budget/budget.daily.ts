import { Types } from "mongoose";
import { Account, DailyBudgetChange, Loan, Transaction, User } from "../../models";
import { peopleCategoryId } from "../categories/categories.system";
import { IST_OFFSET, IST_OFFSET_MS, istDayKey, istMonthKey, istMonthStart } from "../../time";
import { BudgetPeriod } from "./budget.period";
import { currentBudgetPeriod } from "./budget.pace";

/**
 * A daily allowance, and the pot that fills or drains behind it.
 *
 * Set a day at 1,000. Spend 600 and the 400 left over is put by; spend
 * 1,500 and the 500 over comes back out. Run that across the period and
 * the total is the answer to a question the pace card cannot answer: when
 * the salary lands, how much of it can go straight into savings.
 *
 * Deliberately a different thing from the salary pace next to it. The pace
 * divides what is left by the days remaining, so it moves every time
 * anything is spent and every time a day passes - it says whether you will
 * make it to payday. This says what you decided a day should cost and
 * keeps score against it. One is a forecast, the other is a record.
 *
 * Kept as a running sum rather than a stored balance. Nothing is written
 * down, so correcting a transaction from last Tuesday corrects the bucket
 * too - which a stored balance could only do by being recomputed anyway.
 *
 * Retired: the monthly budget (budget.monthly.ts) replaced it, and nothing
 * shows it any more. What is left is the arithmetic, kept for one job -
 * the month before the first monthly budget keeps the result these rules
 * gave it, and the monthly savings bucket opens with that figure rather
 * than quietly rewriting it (budget.bucket.ts).
 */

export interface DailyBudgetDay {
  /** The IST calendar day, as YYYY-MM-DD. */
  day: string;
  spentMinor: number;
  /** Money in on top of pay that day, which goes straight into the bucket. */
  incomeMinor: number;
  /** Refunds that day for purchases the bucket had paid for. */
  refundedMinor: number;
  /** The daily budget in force that day. */
  allowedMinor: number;
  /** Budget less spending, plus any extra money in: positive put by,
      negative taken back. */
  deltaMinor: number;
}

export type DailyBudget =
  | { configured: false }
  | {
      configured: true;
      dailyBudgetMinor: number;
      periodStart: Date;
      periodEnd: Date;
      /// Whether the period resets on a salary or on the 1st. Said out
      /// loud, because "resets when I am paid" is the whole point of it
      /// and a calendar month is a fallback rather than the intent.
      resetsOnSalary: boolean;
      /// Days counted so far, today included. Today counts because money
      /// can still be spent today and the bucket has to move as it is.
      daysCounted: number;
      daysLeft: number;
      /// The allowance for the days counted: the daily budget times them.
      allowedMinor: number;
      spentMinor: number;
      /// Positive is put by, negative is spent out of what was put by.
      bucketMinor: number;
      /// Money in on top of pay this period - gifts, interest, cashback -
      /// already included in the bucket.
      extraIncomeMinor: number;
      /// Refunds this period for purchases the bucket paid for, given back
      /// to it on the day they arrived. Already included in the bucket.
      refundedBackMinor: number;
      todaySpentMinor: number;
      /// What is left of today's allowance. Negative once today is over it.
      todayLeftMinor: number;
      /// How many of the days counted went over. The bucket is one number
      /// and does not say whether it is one bad day or every day.
      daysOver: number;
      /// Spending kept out of the score: one-offs marked as such, anything on
      /// a trip, and payments towards a fixed commitment. Reported so the
      /// bucket never looks as though it simply lost a purchase.
      keptOutMinor: number;
      keptOutCount: number;
      /// Day by day, oldest first, for a strip showing where it went.
      days: DailyBudgetDay[];
    };

/** Before any change was recorded, the amount set covers every day. */
export const SINCE_ALWAYS = "0000-01-01";

/**
 * What a day was allowed: the budget in force on that IST day. Days before
 * the first recorded change - and accounts that have never changed it -
 * take the amount on the user.
 */
export function budgetOn(
  user: { dailyBudgetMinor?: number | null; dailyBudgetHistory?: DailyBudgetChange[] | null },
  day: string
): number {
  let amount = user.dailyBudgetMinor ?? 0;
  const history = user.dailyBudgetHistory ?? [];
  if (history.length > 0) {
    amount = history[0].amountMinor;
    for (const change of history) {
      if (change.from <= day) amount = change.amountMinor;
      else break;
    }
  }
  return amount;
}

/** The calendar month, shaped like a budget period, for someone with no pay day. */
function calendarMonth(now: Date): BudgetPeriod {
  const start = istMonthStart(istMonthKey(now));
  const shifted = new Date(start.getTime() + IST_OFFSET_MS);
  const end = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - IST_OFFSET_MS
  );

  const day = 24 * 60 * 60 * 1000;
  const todayStart = Date.parse(`${istDayKey(now)}T00:00:00.000${IST_OFFSET}`);

  return {
    start,
    end,
    key: istDayKey(start),
    daysLeft: Math.max(1, Math.ceil((end.getTime() - todayStart) / day)),
    daysElapsed: Math.max(1, Math.round((todayStart - start.getTime()) / day) + 1),
  };
}

/** Every IST day from `start` up to and including today, oldest first. */
function daysUpToToday(start: Date, now: Date): string[] {
  const days: string[] = [];
  const today = istDayKey(now);

  // Walked as day keys rather than counted, so a period that starts on the
  // 31st and a month that does not have one cannot produce a day that is
  // not a date. Capped, because a clock set wrong should not spin here.
  let cursor = Date.parse(`${istDayKey(start)}T00:00:00.000${IST_OFFSET}`);
  for (let guard = 0; guard < 400; guard += 1) {
    const key = istDayKey(new Date(cursor));
    if (key > today) break;

    days.push(key);
    cursor += 24 * 60 * 60 * 1000;
  }

  return days;
}

export async function dailyBudget(
  userId: Types.ObjectId,
  now = new Date(),
  within?: Pick<BudgetPeriod, "start" | "end">
): Promise<DailyBudget> {
  const user = await User.findById(userId).select("dailyBudgetMinor dailyBudgetHistory salaryDay").orFail();
  if (!user.dailyBudgetMinor || user.dailyBudgetMinor <= 0) return { configured: false };

  // Salary day to salary day where there is one, because that is when the
  // money to fill the bucket actually turns up. The calendar month is the
  // fallback rather than the intent.
  //
  // Or a month that is already over, scored to its last day: how the
  // savings bucket finds what the daily rules made of the month before
  // the monthly budget began. Nothing in it can still change but the
  // transactions, so it is scored exactly as it would have been then.
  const period: Pick<BudgetPeriod, "start" | "end" | "daysLeft"> = within
    ? { start: within.start, end: within.end, daysLeft: 0 }
    : user.salaryDay
      ? await currentBudgetPeriod(userId, user.salaryDay, now)
      : calendarMonth(now);
  if (within) now = new Date(Math.min(now.getTime(), within.end.getTime() - 1));

  // Grouped by IST day in the database rather than in hand, so a hundred
  // transactions come back as thirty rows. Spending is counted the same
  // way the pace counts it: countedAmountMinor, which already knows that a
  // transfer between your own accounts is not spending and that a card
  // bill is the same money as the purchases it is made of.
  // Two piles from one pass: what scores against a day, and what is kept
  // out of the score. A one-off marked as such, anything spent on a trip,
  // or a payment towards a fixed commitment (rent, a subscription, an
  // EMI) is real spending that the month still sees - but a day is not a
  // bad day for having had a laptop, a week away, or the rent land in it,
  // and a daily budget that said otherwise would be one nobody kept to.
  // Rent especially: "what a day should cost" is set with day-to-day
  // spending in mind, and a single rent payment would otherwise wipe out
  // the whole bucket on the day it lands.
  //
  // Expressions rather than query operators, because this sits inside
  // $group. "Has a trip" / "has a commitment" is written as
  // greater-than-null: any set value sorts above null in BSON, and a
  // missing field does not.
  // Pocket money is a fixed allowance someone else spends, topped up once
  // a month - not the user's own day of spending - so it is kept out too.
  const pocketAccounts = (await Account.find({ userId, pocketMoney: { $ne: null } }).select("_id")).map((a) => a._id);
  const special = {
    $or: [
      { $eq: ["$isSpecial", true] },
      { $gt: ["$tripId", null] },
      { $gt: ["$commitmentId", null] },
      { $in: ["$accountId", pocketAccounts] },
    ],
  };
  const rows = await Transaction.aggregate<{ _id: string | null; total: number; count: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lte: now },
        countedAmountMinor: { $gt: 0 },
      },
    },
    {
      $group: {
        // Kept-out spending groups under null; everything else under its
        // IST day.
        _id: {
          $cond: [
            special,
            null,
            { $dateToString: { date: "$occurredAt", format: "%Y-%m-%d", timezone: IST_OFFSET } },
          ],
        },
        total: { $sum: "$countedAmountMinor" },
        count: { $sum: 1 },
      },
    },
  ]);

  const keptOut = rows.find((row) => row._id === null);
  const spentByDay = new Map(
    rows.filter((row) => row._id !== null).map((row) => [row._id as string, row.total])
  );
  // Each day against the budget it had, so a change made today does not
  // rewrite what the days before it were allowed.
  const budget = (day: string) => budgetOn(user, day);

  // Money that came in on top of pay goes straight into the bucket: a
  // friend's gift, interest, cashback, a side job. Not the salary itself -
  // the daily budget is what the salary is for - and not anything that is
  // not really income: refunds, settling up, transfers, money set aside for
  // a purchase and a split's other shares all count as zero already. Nor a
  // loan landing, which is borrowed, nor a credit marked as kept out.
  //
  // Nor money a person pays back. Lending it never came out of the bucket
  // - a loan to a friend is not a day's spending - so its return does not
  // go into it either. That covers anything with people on it and
  // anything filed under Lent & borrowed, whether or not it was marked as
  // settling up.
  const incomeRows = await Transaction.aggregate<{ _id: string; total: number }>([
    {
      $match: {
        ...(await extraIncomeMatch(userId)),
        occurredAt: { $gte: period.start, $lte: now },
      },
    },
    {
      $group: {
        _id: { $dateToString: { date: "$occurredAt", format: "%Y-%m-%d", timezone: IST_OFFSET } },
        total: { $sum: "$countedAmountMinor" },
      },
    },
  ]);
  const incomeByDay = new Map(incomeRows.map((row) => [row._id, row.total]));

  // A refund gives back to the bucket exactly what its purchase took out
  // of it - on the day the money comes back, not by rewriting the day the
  // purchase was made, which keeps the days already counted as they were.
  // A purchase the bucket never paid for (a one-off, a trip, a fixed cost)
  // gets nothing back when it is refunded, and neither does one bought
  // with money set aside for it.
  const { backByPurchaseDay, backByRefundDay } = await refundsForBucket(userId, period.start, now);
  for (const [day, amount] of backByPurchaseDay) spentByDay.set(day, (spentByDay.get(day) ?? 0) + amount);

  // Every day from the start, not only the days something was spent on. A
  // day with no spending on it is the best kind of day for a bucket, and
  // leaving it out would silently drop what it put by.
  const days: DailyBudgetDay[] = daysUpToToday(period.start, now).map((day) => {
    const spentMinor = spentByDay.get(day) ?? 0;
    const incomeMinor = incomeByDay.get(day) ?? 0;
    const refundedMinor = backByRefundDay.get(day) ?? 0;
    const allowedMinor = budget(day);
    return {
      day,
      spentMinor,
      incomeMinor,
      refundedMinor,
      allowedMinor,
      deltaMinor: allowedMinor - spentMinor + incomeMinor + refundedMinor,
    };
  });

  const spentMinor = days.reduce((sum, day) => sum + day.spentMinor, 0);
  const extraIncomeMinor = days.reduce((sum, day) => sum + day.incomeMinor, 0);
  const refundedBackMinor = days.reduce((sum, day) => sum + day.refundedMinor, 0);
  const allowedMinor = days.reduce((sum, day) => sum + day.allowedMinor, 0);
  const today = days[days.length - 1];
  const todayBudget = budget(istDayKey(now));

  return {
    configured: true,
    dailyBudgetMinor: todayBudget,
    periodStart: period.start,
    periodEnd: period.end,
    resetsOnSalary: Boolean(user.salaryDay),
    daysCounted: days.length,
    daysLeft: period.daysLeft,
    allowedMinor,
    spentMinor,
    bucketMinor: allowedMinor - spentMinor + extraIncomeMinor + refundedBackMinor,
    extraIncomeMinor,
    refundedBackMinor,
    todaySpentMinor: today?.spentMinor ?? 0,
    todayLeftMinor: todayBudget - (today?.spentMinor ?? 0),
    daysOver: days.filter((day) => day.spentMinor > day.allowedMinor).length,
    keptOutMinor: keptOut?.total ?? 0,
    keptOutCount: keptOut?.count ?? 0,
    days,
  };
}

/**
 * Which credits are money in on top of pay, as a query - the rule above,
 * written once so the monthly bucket (budget.bucket.ts) adds up exactly
 * what the daily one did.
 */
export async function extraIncomeMatch(userId: Types.ObjectId): Promise<Record<string, unknown>> {
  const peopleCategory = await peopleCategoryId();
  const loanCredits = (await Loan.find({ userId, disbursedTransactionId: { $ne: null } }).select("disbursedTransactionId"))
    .map((loan) => loan.disbursedTransactionId)
    .filter((id): id is Types.ObjectId => Boolean(id));
  return {
    userId,
    type: "CREDIT",
    countedAmountMinor: { $gt: 0 },
    isSalary: { $ne: true },
    isSpecial: { $ne: true },
    _id: { $nin: loanCredits },
    "people.0": { $exists: false },
    ...(peopleCategory ? { categoryId: { $ne: peopleCategory } } : {}),
  };
}

/**
 * Refunds, as the bucket sees them.
 *
 * The ledger nets a refund off its purchase (countedAmountMinor), which is
 * right for spending totals but wrong for a bucket that keeps score day by
 * day: it would quietly rewrite the day of the purchase. So the purchase's
 * day keeps what it really cost on the day (backByPurchaseDay puts the
 * refunded part back on it) and the refund lands on the day it arrived
 * (backByRefundDay).
 *
 * Only for purchases the bucket paid for - scored against a day, not kept
 * out as a one-off, a trip or a fixed cost - and only refunds proper:
 * money set aside for a purchase is linked the same way, but that purchase
 * never cost the user anything and stays netted off.
 */
async function refundsForBucket(userId: Types.ObjectId, periodStart: Date, now: Date) {
  const backByPurchaseDay = new Map<string, number>();
  const backByRefundDay = new Map<string, number>();

  // Refunds rarely come later than six months after the purchase.
  const lookback = new Date(periodStart.getTime() - 200 * 24 * 60 * 60 * 1000);
  const credits = await Transaction.find({
    userId,
    type: "CREDIT",
    isEarmarked: { $ne: true },
    "refundOf.0": { $exists: true },
    occurredAt: { $gte: lookback, $lte: now },
  }).select("occurredAt refundOf");
  if (credits.length === 0) return { backByPurchaseDay, backByRefundDay };

  const purchaseIds = credits.flatMap((credit) => credit.refundOf.map((allocation) => allocation.transactionId));
  const purchases = await Transaction.find({ _id: { $in: purchaseIds }, userId, type: "DEBIT" }).select(
    "occurredAt isSpecial tripId commitmentId"
  );
  const scored = new Map(
    purchases
      .filter((purchase) => !purchase.isSpecial && !purchase.tripId && !purchase.commitmentId)
      .map((purchase) => [purchase._id.toString(), purchase])
  );

  for (const credit of credits) {
    for (const allocation of credit.refundOf) {
      const purchase = scored.get(allocation.transactionId.toString());
      if (!purchase) continue;

      if (purchase.occurredAt >= periodStart && purchase.occurredAt <= now) {
        const day = istDayKey(purchase.occurredAt);
        backByPurchaseDay.set(day, (backByPurchaseDay.get(day) ?? 0) + allocation.amountMinor);
      }
      if (credit.occurredAt >= periodStart) {
        const day = istDayKey(credit.occurredAt);
        backByRefundDay.set(day, (backByRefundDay.get(day) ?? 0) + allocation.amountMinor);
      }
    }
  }

  return { backByPurchaseDay, backByRefundDay };
}
