import { HydratedDocument, Types } from "mongoose";
import { FixedCommitment, FixedCommitmentDoc, Transaction, User, commitmentAmountFor } from "../../models";
import { isCardBillCommitment } from "../cards/cards.billPayment";
import { BudgetPeriod, budgetPeriodFor } from "./budget.period";

/**
 * The period a user's money is measured over, right now.
 *
 * Exported because more than one card is built on it - the pace and the
 * user's months the monthly budget runs on - and two of them working out separately when the
 * month started is two of them eventually disagreeing about it.
 */
export async function currentBudgetPeriod(
  userId: Types.ObjectId,
  salaryDay: number,
  now: Date
): Promise<BudgetPeriod & { salaryPaidOn: Date | null }> {
  // The pay day in Settings alone decides the month, whenever the salary
  // actually lands. Anchoring on the credit moved the month with every
  // early or late payment - and a late one left today in no month at all.
  const period = budgetPeriodFor(salaryDay, now);

  // Still said when pay has landed in this month, so the screen can show
  // "paid on the 16th"; it no longer moves where the month starts.
  const paid = await Transaction.findOne({
    userId,
    isSalary: true,
    type: "CREDIT",
    occurredAt: { $gte: period.start, $lte: now },
  })
    .sort({ occurredAt: 1 })
    .select("occurredAt");

  return { ...period, salaryPaidOn: paid?.occurredAt ?? null };
}

/**
 * The period a fixed commitment is paid in, right now.
 *
 * The same period the pace measures, so a tick, a changed amount and the
 * pace's "still to go out" all agree on which month they mean - including
 * when pay landed a day early and opened the period on the day it did.
 * Without a pay day, the calendar month.
 */
export async function commitmentPeriod(userId: Types.ObjectId, now = new Date()): Promise<BudgetPeriod> {
  const user = await User.findById(userId).select("salaryDay").orFail();
  return user.salaryDay ? currentBudgetPeriod(userId, user.salaryDay, now) : budgetPeriodFor(1, now);
}

/** What has gone out towards one commitment in a period, on what counts. */
export async function paidTowards(
  userId: Types.ObjectId,
  commitmentId: Types.ObjectId,
  period: Pick<BudgetPeriod, "start" | "end">
): Promise<number> {
  const [row] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        commitmentId,
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lt: period.end },
      },
    },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);
  return row?.total ?? 0;
}

/**
 * Records a new amount on a commitment, deciding which payment it starts
 * with. Sets the fields on the document; the caller saves it.
 *
 * Already met this period at what it cost - paid in full, or ticked - and
 * the new amount starts with the next period, this one keeping the figure
 * it was paid at. Not yet met, and the new amount is what it costs now.
 */
export async function changeCommitmentAmount(
  commitment: HydratedDocument<FixedCommitmentDoc>,
  newAmountMinor: number,
  now = new Date()
): Promise<void> {
  if (newAmountMinor === commitment.amountMinor) return;

  const period = await commitmentPeriod(commitment.userId, now);
  const costsNow = commitmentAmountFor(commitment, period.key);
  const met =
    commitment.paidForPeriod === period.key ||
    (costsNow > 0 && (await paidTowards(commitment.userId, commitment._id, period)) >= costsNow);

  if (met && newAmountMinor !== costsNow) {
    commitment.previousAmountMinor = costsNow;
    commitment.previousAmountPeriod = period.key;
  } else {
    commitment.previousAmountMinor = null;
    commitment.previousAmountPeriod = null;
  }
  commitment.amountMinor = newAmountMinor;
}

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

  const period = await currentBudgetPeriod(userId, user.salaryDay, now);

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

  const commitments = await FixedCommitment.find({ userId, isActive: true })
    .sort({ dayOfMonth: 1 })
    .populate("categoryId");

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
  const paidRows = await Transaction.aggregate<{ _id: Types.ObjectId; total: number; moved: number }>([
    {
      $match: {
        userId,
        commitmentId: { $ne: null },
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lt: period.end },
      },
    },
    {
      $group: {
        _id: "$commitmentId",
        total: { $sum: "$countedAmountMinor" },
        moved: { $sum: "$amountMinor" },
      },
    },
  ]);
  const paidByCommitment = new Map(paidRows.map((row) => [row._id.toString(), row]));

  const commitmentState = commitments.map((commitment) => {
    const paid = paidByCommitment.get(commitment._id.toString());
    // A card's bill is the exception to counting what counts. Its payment
    // counts nothing - the purchases on it were counted when they were
    // made - so it is met by the money that went, and never holds any back:
    // that would be the same purchases counted twice against the period.
    const isCardBill = isCardBillCommitment(commitment);
    const paidMinor = (isCardBill ? paid?.moved : paid?.total) ?? 0;
    // A hand-tick still means "consider this settled", for anything paid
    // in a way the app will never see.
    const ticked = commitment.paidForPeriod === period.key;
    // A raise made after this period's payment went out starts next time,
    // so this period is measured against what it was when it was paid.
    const dueMinor = commitmentAmountFor(commitment, period.key);

    return {
      commitment,
      paidMinor,
      ticked,
      dueMinor,
      isCardBill,
      isPaid: ticked || paidMinor >= dueMinor,
      // Only what is still to go out. Holding back the whole amount once
      // part of it has been sent would count that part twice, since it is
      // already in the spending above.
      shortfallMinor: ticked || isCardBill ? 0 : Math.max(0, dueMinor - paidMinor),
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
    salaryPaidOn: period.salaryPaidOn,
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
      // What this period costs, which differs from amountMinor only when
      // the amount changed after this period was paid. amountMinor is then
      // what the next one will be.
      thisPeriodAmountMinor: row.dueMinor,
      // Part of it sent and part not, which is the case worth a sentence
      // rather than a tick box.
      isPartial: row.paidMinor > 0 && row.paidMinor < row.dueMinor && !row.ticked,
      // A card's bill: listed, so it can still be ticked off, but never
      // held back from what is left to spend.
      isCardBill: row.isCardBill,
    })),
    shortfallNote: shortfallNote(commitmentState, remainingMinor),
    configured: true as const,
  };
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
  rows: { commitment: { name: string }; dueMinor: number; paidMinor: number; shortfallMinor: number }[],
  remainingMinor: number
): string | null {
  const short = rows.filter((row) => row.paidMinor > 0 && row.shortfallMinor > 0);
  if (short.length === 0) return null;

  const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
  const total = short.reduce((sum, row) => sum + row.shortfallMinor, 0);

  const what =
    short.length === 1
      ? `${short[0].commitment.name} went out at ${rupees(short[0].paidMinor)} of the usual ` +
        `${rupees(short[0].dueMinor)}`
      : `${short.length} fixed costs went out short, by ${rupees(total)} between them`;

  return remainingMinor < total
    ? `${what}. There was not enough left this period to have sent the rest - something else took it.`
    : `${what}. There is still room to send the rest.`;
}
