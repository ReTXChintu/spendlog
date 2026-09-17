import { Router } from "express";
import { Types } from "mongoose";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { CardStatement, EmiInstalment, EmiPlan, Perk, Transaction } from "../../models";
import { istDayEnd, istDayKey, istDayStart, istMonthKey, istMonthStart } from "../../time";
import { cardStatuses, pickCards } from "../cards/cards.status";
import { budgetPace } from "../budget/budget.pace";
import { dailyBudget } from "../budget/budget.daily";
import { perkIsLive } from "../perks/perks.match";
import { upcomingBills } from "../statements/statements.bills";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);

/**
 * Everything the landing screen needs, in one request.
 *
 * Seven round trips to draw one screen is slow on a phone on mobile data,
 * and this is the screen that has to be fastest because it is the one you
 * land on. So it is composed here rather than assembled by each client.
 *
 * What belongs here is decided by one test: could you *act* on it before
 * closing the app? A card near its limit changes which card comes out; a
 * chart of last March does not change anything. The second kind lives on
 * the analytics page.
 */

/** A coupon further off than this is not yet worth a line on the screen. */
const EXPIRING_WITHIN_DAYS = 10;

dashboardRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const now = new Date();

  const today = istDayKey(now);
  const yesterday = istDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const month = istMonthKey(now);

  const [cards, pace, needsCategory, emis, owed, perks, statements, monthSoFar, bills, daily] =
    await Promise.all([
    cardStatuses(userId, now),
    budgetPace(userId, now),
    countNeedingACategory(userId, yesterday, month),
    activeEmis(userId),
    owedBalance(userId),
    Perk.find({ userId, isActive: true, usedAt: null }).populate("accountId"),
    statementsNeedingAttention(userId),
    monthAgainstLast(userId, now, today),
    upcomingBills(userId, now),
    dailyBudget(userId, now),
  ]);

  // Only the ones close enough to act on. Settled: shown here, never as a
  // notification — a coupon is not worth interrupting someone for.
  const expiring = perks
    .filter((perk) => perkIsLive(perk, now) && perk.expiresOn)
    .map((perk) => ({
      ...perk.toJSON(),
      daysLeft: Math.ceil((perk.expiresOn!.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    }))
    .filter((perk) => perk.daysLeft <= EXPIRING_WITHIN_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);

  res.json({
    today,
    pace,
    daily,
    cards,
    picks: pickCards(cards),
    needsCategory,
    emis,
    owed,
    expiringPerks: expiring,
    statements,
    monthSoFar,
    // Only the ones still to pay. A bill already cleared is a fact about
    // last month, not something to do today.
    bills: bills.filter((bill) => !bill.isPaid),
  });
});

/**
 * How much still needs a person: yesterday, and the month as a whole.
 *
 * Yesterday is what the midnight reminder asks about, so the dashboard
 * shows the same figure — two screens disagreeing about how much is left
 * to do would make both of them untrustworthy.
 */
async function countNeedingACategory(userId: Types.ObjectId, yesterday: string, month: string) {
  const unfiled = {
    categoryId: null,
    isTransfer: false,
    countedAmountMinor: { $gt: 0 },
  };

  const [yesterdayCount, monthCount] = await Promise.all([
    Transaction.countDocuments({
      userId,
      ...unfiled,
      occurredAt: { $gte: istDayStart(yesterday), $lte: istDayEnd(yesterday) },
    }),
    Transaction.countDocuments({ userId, ...unfiled, occurredAt: { $gte: istMonthStart(month) } }),
  ]);

  return { yesterday: yesterdayCount, month: monthCount };
}

/**
 * Money already committed, whatever this month's spending looks like.
 *
 * What is left to pay is the sum of the instalments still due, ignoring
 * any deliberately skipped - the same rule the EMI list uses, because two
 * screens disagreeing about a debt is worse than either figure.
 */
async function activeEmis(userId: Types.ObjectId) {
  const plans = await EmiPlan.find({ userId, status: "ACTIVE" }).sort({ createdAt: 1 });
  const instalments = await EmiInstalment.find({
    planId: { $in: plans.map((plan) => plan._id) },
    status: "DUE",
  });

  const remainingFor = (planId: Types.ObjectId) =>
    instalments
      .filter((instalment) => instalment.planId.equals(planId))
      .reduce((total, instalment) => total + instalment.amountMinor, 0);

  return {
    count: plans.length,
    monthlyMinor: plans.reduce((total, plan) => total + plan.monthlyAmountMinor, 0),
    remainingMinor: instalments.reduce((total, instalment) => total + instalment.amountMinor, 0),
    plans: plans.slice(0, 4).map((plan) => ({
      ...plan.toJSON(),
      remainingMinor: remainingFor(plan._id),
    })),
  };
}

/**
 * What people owe each other. Not month-scoped: a debt does not reset in
 * January.
 */
async function owedBalance(userId: Types.ObjectId) {
  const rows = await Transaction.aggregate<{ _id: null; lent: number; settledIn: number; settledOut: number }>([
    { $match: { userId } },
    {
      $group: {
        _id: null,
        // The part of a split bill that was never the user's own spending,
        // which is the bill less their share. There is no stored field for
        // it - this used to read split.owedToMeMinor, which does not exist
        // on the schema, so every lent rupee summed as nothing and the
        // dashboard reported money owed *by* the user whenever anyone paid
        // them back.
        lent: {
          $sum: {
            $cond: [
              { $ne: [{ $ifNull: ["$split.myShareMinor", null] }, null] },
              { $subtract: ["$amountMinor", "$split.myShareMinor"] },
              0,
            ],
          },
        },
        settledIn: {
          $sum: { $cond: [{ $and: ["$isSettlement", { $eq: ["$type", "CREDIT"] }] }, "$amountMinor", 0] },
        },
        settledOut: {
          $sum: { $cond: [{ $and: ["$isSettlement", { $eq: ["$type", "DEBIT"] }] }, "$amountMinor", 0] },
        },
      },
    },
  ]);

  const row = rows[0];
  if (!row) return { balanceMinor: 0 };

  return { balanceMinor: row.lent - row.settledIn + row.settledOut };
}

/**
 * Statements that cannot be read without someone doing something.
 *
 * UNREADABLE is in the list as well as the two fixable ones. A file nobody
 * can open is still worth naming - left out, it sat in the database with a
 * reason recorded against it and no screen that would ever show it.
 */
async function statementsNeedingAttention(userId: Types.ObjectId) {
  const stuck = await CardStatement.find({
    userId,
    status: { $in: ["LOCKED", "UNIDENTIFIED", "UNREADABLE"] },
  })
    .sort({ statementDate: -1 })
    .limit(5);

  return {
    stuckCount: stuck.length,
    stuck: stuck.map((statement) => ({
      id: statement._id.toString(),
      status: statement.status,
      problem: statement.problem ?? null,
      subject: statement.subject ?? null,
      statementDate: statement.statementDate,
    })),
  };
}

/**
 * This month so far against the same point in the last one.
 *
 * Day-for-day, not month-for-month. On the 8th, a whole previous month is
 * not a comparison — it is a number three times larger, and reading that as
 * overspending would be wrong every time.
 */
async function monthAgainstLast(userId: Types.ObjectId, now: Date, today: string) {
  const month = istMonthKey(now);
  const dayOfMonth = Number(today.slice(8));

  const [year, mon] = month.split("-").map(Number);
  const earlier = `${mon === 1 ? year - 1 : year}-${String(mon === 1 ? 12 : mon - 1).padStart(2, "0")}`;

  const spendUpTo = async (target: string): Promise<number> => {
    const start = istMonthStart(target);
    const rows = await Transaction.aggregate<{ total: number }>([
      {
        $match: {
          userId,
          occurredAt: { $gte: start, $lt: new Date(start.getTime() + dayOfMonth * 24 * 60 * 60 * 1000) },
          type: "DEBIT",
          countedAmountMinor: { $gt: 0 },
        },
      },
      { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
    ]);
    return rows[0]?.total ?? 0;
  };

  const [spentMinor, previousMinor] = await Promise.all([spendUpTo(month), spendUpTo(earlier)]);

  return { month, dayOfMonth, spentMinor, previousMinor, changeMinor: spentMinor - previousMinor };
}
