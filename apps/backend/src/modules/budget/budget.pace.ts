import { Types } from "mongoose";
import { FixedCommitment, Transaction, User } from "../../models";

/// How far back to look for the credit that opened this period. Wide
/// enough for pay that came early or late, narrow enough that last
/// month's is not found once this month's is overdue.
const SALARY_LOOKBACK_DAYS = 45;
import { budgetPeriodFor, budgetPeriodFromSalary } from "./budget.period";

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

  // A credit marked as pay outranks the configured day, because the day is
  // a prediction and the credit is what happened. Looked for in a window
  // wide enough to cover a salary that came early or late, but not so wide
  // that last month's would still be found once this month's is overdue.
  const recentSalaries = await Transaction.find({
    userId,
    isSalary: true,
    type: "CREDIT",
    occurredAt: { $gte: new Date(now.getTime() - SALARY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000), $lte: now },
  }).sort({ occurredAt: -1 });

  // Pay that arrives in two parts - the salary, then arrears a few days
  // later - is one payment for the purposes of a period. Anchoring on the
  // most recent alone would start the period at the second part and leave
  // the first outside it, which is how the amount came out short.
  const lastSalary = clusterStart(recentSalaries);

  const period = lastSalary
    ? budgetPeriodFromSalary(lastSalary, user.salaryDay, now)
    : budgetPeriodFor(user.salaryDay, now);

  // What actually landed this period, which is the figure that knows about
  // the leave taken in it. Summed rather than taken from the newest, so
  // pay that arrives in two parts is one salary.
  const [paid] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        isSalary: true,
        type: "CREDIT",
        occurredAt: { $gte: period.start, $lt: period.end },
      },
    },
    { $group: { _id: null, total: { $sum: "$amountMinor" } } },
  ]);

  const salaryMinor = paid?.total ?? user.salaryAmountMinor;

  // One sum over everything, which is right because countedAmountMinor
  // already knows what should not be in it. A card bill marked as such
  // counts zero - every purchase on that card was counted the day it
  // happened, so the bill is that same money reaching the bank a month
  // later. Card spending counts at the moment it happens, not when the
  // bill lands.
  //
  // This used to be two queries, one for card accounts and one for
  // everything else, whose results were then added together - which did
  // nothing at all except imply an exclusion that was never happening.
  const [spend] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lt: period.end },
        countedAmountMinor: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);

  const spentMinor = spend?.total ?? 0;

  const commitments = await FixedCommitment.find({ userId, isActive: true }).sort({ dayOfMonth: 1 });

  // What has actually gone out towards each one this period, from payments
  // marked against it. Marking the payment rather than ticking a box is
  // what lets a bill be paid early: the period it lands in decides which
  // month it settles, not the day of the month it was due.
  //
  // Summed on countedAmountMinor rather than the amount that left the
  // account, because those differ exactly when it matters. Rent of 12,000
  // paid for a flat of three, split down to a share of 4,000, is a 4,000
  // commitment met in full - not a 4,000 commitment overpaid by three times
  // over, which is what the raw amount would have said.
  const paidRows = await Transaction.aggregate<{ _id: Types.ObjectId; total: number }>([
    {
      $match: {
        userId,
        commitmentId: { $ne: null },
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lt: period.end },
      },
    },
    { $group: { _id: "$commitmentId", total: { $sum: "$countedAmountMinor" } } },
  ]);
  const paidByCommitment = new Map(paidRows.map((row) => [row._id.toString(), row.total]));

  const commitmentState = commitments.map((commitment) => {
    const paidMinor = paidByCommitment.get(commitment._id.toString()) ?? 0;
    // A hand-tick still means "consider this settled", for anything paid
    // in a way the app will never see.
    const ticked = commitment.paidForPeriod === period.key;

    return {
      commitment,
      paidMinor,
      ticked,
      isPaid: ticked || paidMinor >= commitment.amountMinor,
      // Only what is still to go out. Holding back the whole amount once
      // part of it has been sent would count that part twice, since it is
      // already in the spending above.
      shortfallMinor: ticked ? 0 : Math.max(0, commitment.amountMinor - paidMinor),
    };
  });

  const commitmentsRemainingMinor = commitmentState.reduce((sum, row) => sum + row.shortfallMinor, 0);

  const availableMinor = salaryMinor - commitmentsRemainingMinor;
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
    salaryMinor,
    // Whether the figure above is what landed or what was configured, so
    // the screen can say which it is showing.
    salaryIsActual: paid != null,
    salaryPaidOn: lastSalary,
    commitmentsRemainingMinor,
    spentMinor,
    remainingMinor,
    perDayMinor,
    recentPerDayMinor,
    state,
    commitments: commitmentState.map((row) => ({
      ...row.commitment.toJSON(),
      isPaid: row.isPaid,
      paidMinor: row.paidMinor,
      shortfallMinor: row.shortfallMinor,
      // Part of it sent and part not, which is the case worth a sentence
      // rather than a tick box.
      isPartial: row.paidMinor > 0 && row.paidMinor < row.commitment.amountMinor && !row.ticked,
    })),
    shortfallNote: shortfallNote(commitmentState, remainingMinor),
    configured: true as const,
  };
}

/**
 * The day the current run of pay began.
 *
 * Salary and any arrears land within a few days of each other and mean one
 * payment; two months apart they mean two. Walking back through the run
 * while each is close to the one after it finds where this month's pay
 * started, which is where the period starts.
 */
function clusterStart(salaries: { occurredAt: Date }[]): Date | null {
  if (salaries.length === 0) return null;

  const CLUSTER_MS = 10 * 24 * 60 * 60 * 1000;
  let earliest = salaries[0].occurredAt;

  for (const salary of salaries.slice(1)) {
    if (earliest.getTime() - salary.occurredAt.getTime() > CLUSTER_MS) break;
    earliest = salary.occurredAt;
  }

  return earliest;
}

/**
 * A sentence about a fixed cost that only went out in part.
 *
 * Careful about the causal claim. Sending less than usual is not proof of
 * overspending - it might simply have been a choice - so the shortfall is
 * stated as the fact it is, and the reason is only offered when the
 * arithmetic actually supports it: there was not enough left to have sent
 * the rest.
 */
function shortfallNote(
  rows: { commitment: { name: string; amountMinor: number }; paidMinor: number; shortfallMinor: number }[],
  remainingMinor: number
): string | null {
  const short = rows.filter((row) => row.paidMinor > 0 && row.shortfallMinor > 0);
  if (short.length === 0) return null;

  const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
  const total = short.reduce((sum, row) => sum + row.shortfallMinor, 0);

  const what =
    short.length === 1
      ? `${short[0].commitment.name} went out at ${rupees(short[0].paidMinor)} of the usual ` +
        `${rupees(short[0].commitment.amountMinor)}`
      : `${short.length} fixed costs went out short, by ${rupees(total)} between them`;

  return remainingMinor < total
    ? `${what}. There was not enough left this period to have sent the rest - something else took it.`
    : `${what}. There is still room to send the rest.`;
}
