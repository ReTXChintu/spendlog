import { Router } from "express";
import { Types } from "mongoose";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { CardStatement, EmiInstalment, EmiPlan, Loan, LoanInstalment, Perk, Transaction } from "../../models";
import { istDayEnd, istDayKey, istDayStart } from "../../time";
import { monthSoFar as monthAgainstLast, userMonth } from "../budget/budget.months";
import { cardStatuses, pickCards } from "../cards/cards.status";
import { budgetPace } from "../budget/budget.pace";
import { dailyBudget } from "../budget/budget.daily";
import { perkIsLive } from "../perks/perks.match";
import { upcomingBills } from "../statements/statements.bills";
import { loanProgress } from "../loans/loans.routes";

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
  // The user's own month - salary day to salary day - like every other
  // monthly figure in the app.
  const month = await userMonth(userId, undefined, now);

  const [cards, pace, needsCategory, emis, loans, owed, perks, statements, monthSoFar, bills, daily] =
    await Promise.all([
    cardStatuses(userId, now),
    budgetPace(userId, now),
    countNeedingACategory(userId, yesterday, month.start),
    activeEmis(userId),
    activeLoans(userId),
    owedBalance(userId),
    Perk.find({ userId, isActive: true, usedAt: null }).populate("accountId"),
    statementsNeedingAttention(userId),
    monthAgainstLast(userId, now),
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
    loans,
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
async function countNeedingACategory(userId: Types.ObjectId, yesterday: string, monthStart: Date) {
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
    Transaction.countDocuments({ userId, ...unfiled, occurredAt: { $gte: monthStart } }),
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

/** The same figures, for loans taken outside a card. See activeEmis. */
async function activeLoans(userId: Types.ObjectId) {
  const loans = await Loan.find({ userId, status: "ACTIVE" }).sort({ createdAt: 1 });
  const instalments = await LoanInstalment.find({ loanId: { $in: loans.map((loan) => loan._id) } });

  const withProgress = loans.map((loan) => ({
    ...loan.toJSON(),
    ...loanProgress(instalments.filter((instalment) => instalment.loanId.equals(loan._id))),
  }));

  return {
    count: loans.length,
    monthlyMinor: loans.reduce((total, loan) => total + loan.monthlyAmountMinor, 0),
    remainingMinor: withProgress.reduce((total, loan) => total + loan.remainingMinor, 0),
    // Soonest due first: the one to have money ready for.
    loans: withProgress.sort(
      (a, b) => (a.nextDue?.dueDate.getTime() ?? Infinity) - (b.nextDue?.dueDate.getTime() ?? Infinity)
    ),
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
