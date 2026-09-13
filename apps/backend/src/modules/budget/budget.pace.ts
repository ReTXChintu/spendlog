import { Types } from "mongoose";
import { Account, FixedCommitment, Transaction, User } from "../../models";
import { budgetPeriodFor } from "./budget.period";

/**
 * What is left to spend before the next salary, and how fast it is going.
 *
 * Lives here rather than in the route because the dashboard wants the same
 * answer, and a second copy of this arithmetic would eventually disagree
 * with the first about how much money someone has.
 *
 * Worth restating what this is not: SpendLog reads messages about
 * transactions and has never known a balance. So this is a pace built from
 * money that moved, not a solvency figure built from money sitting
 * somewhere. It can say "you are going faster than your salary supports".
 * It cannot say "you cannot afford next week's bill".
 */
export async function budgetPace(userId: Types.ObjectId, now = new Date()) {
  const user = await User.findById(userId).select("salaryAmountMinor salaryDay").orFail();

  if (!user.salaryAmountMinor || !user.salaryDay) {
    return { configured: false as const };
  }

  const period = budgetPeriodFor(user.salaryDay, now);

  // Paying a card bill is not new spending — it is an earlier cycle's
  // spending reaching the bank. Counting both would double every rupee
  // that ever went on a card, so payments into a card account are left
  // out of the period's total.
  const cardIds = (await Account.find({ userId, accountType: "CARD" }).select("_id")).map(
    (card) => card._id
  );

  const [spend] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lt: period.end },
        accountId: { $nin: cardIds },
        countedAmountMinor: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);

  // Card spending still counts — just at the moment it happens, on the
  // card, rather than when the bill lands.
  const [cardSpend] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lt: period.end },
        accountId: { $in: cardIds },
        countedAmountMinor: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);

  const spentMinor = (spend?.total ?? 0) + (cardSpend?.total ?? 0);

  const commitments = await FixedCommitment.find({ userId, isActive: true }).sort({ dayOfMonth: 1 });
  const pending = commitments.filter((commitment) => commitment.paidForPeriod !== period.key);
  const commitmentsRemainingMinor = pending.reduce((sum, c) => sum + c.amountMinor, 0);

  const availableMinor = user.salaryAmountMinor - commitmentsRemainingMinor;
  const remainingMinor = availableMinor - spentMinor;
  const perDayMinor = Math.round(remainingMinor / period.daysLeft);

  // What has actually been going out lately, which is the only thing the
  // sustainable figure means anything against.
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [recent] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: weekAgo, $lte: now },
        countedAmountMinor: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);
  const recentPerDayMinor = Math.round((recent?.total ?? 0) / 7);

  const state =
    remainingMinor < 0
      ? "over"
      : recentPerDayMinor > 0 && recentPerDayMinor * period.daysLeft > remainingMinor
        ? "watch"
        : "ok";

  return {
    periodStart: period.start,
    periodEnd: period.end,
    daysLeft: period.daysLeft,
    daysElapsed: period.daysElapsed,
    salaryMinor: user.salaryAmountMinor,
    commitmentsRemainingMinor,
    spentMinor,
    remainingMinor,
    perDayMinor,
    recentPerDayMinor,
    state,
    commitments: commitments.map((commitment) => ({
      ...commitment.toJSON(),
      isPaid: commitment.paidForPeriod === period.key,
    })),
    configured: true as const,
  };
}
