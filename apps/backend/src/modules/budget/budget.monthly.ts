import { Types } from "mongoose";
import {
  Category,
  EmiInstalment,
  FixedCommitment,
  LoanInstalment,
  MonthlyBudgetChange,
  Transaction,
  User,
  commitmentAmountFor,
} from "../../models";
import { istDayKey, istDayStart } from "../../time";
import { UserMonth, monthLabel, userMonth, userMonths } from "./budget.months";
import { BucketSummary, bucketSummary } from "./budget.bucket";
import { isCardBillCommitment } from "../cards/cards.billPayment";

/**
 * One amount for the month, and everything the month costs held against it.
 *
 * Replaces the daily budget. A day turned out to be the wrong unit: rent,
 * an EMI or a SIP lands once and either wiped out the day it landed on or
 * had to be kept out of the score altogether, which left the score saying
 * nothing about whether the month would last. So the month is the unit now,
 * and everything counts against it - fixed costs, one-offs, trips, pocket
 * money and the day to day alike.
 *
 * "Spent" is the month's total the rest of the app already shows: what
 * counts (countedAmountMinor) of every payment out in the user's month.
 * That already leaves out money moved between the user's own accounts, a
 * card bill (its purchases were counted when they were made), an EMI's
 * parent purchase, settling up, and the part of a split or a loan to a
 * friend that was never the user's own - and it already nets a refund off
 * the purchase it gives back. No second idea of spending is kept here,
 * because two screens disagreeing about what a month cost is worse than
 * either figure.
 *
 * Within the amount, some categories can be given a limit of their own.
 * The limits never add up to more than the amount; what they leave over is
 * the "unassigned" pool that every other category spends from.
 */

const DAY = 24 * 60 * 60 * 1000;

export const PACE_STATUSES = ["on_track", "high", "over"] as const;
export type PaceStatus = (typeof PACE_STATUSES)[number];

export interface Pace {
  status: PaceStatus;
  /// Which day of the month today is, from 1, and how many days are left
  /// counting today - money can still be spent today.
  dayOfMonth: number;
  daysInMonth: number;
  daysLeft: number;
  /// The amount less what is spent. Negative once it is over.
  remainingMinor: number;
  /// What can go out each day from here, today included, and still leave
  /// the fixed costs not yet paid covered. Never below zero.
  safeDailyMinor: number;
  /// Where spending would be today if the month were going to plan: fixed
  /// costs already paid, plus the rest of the amount spread evenly over
  /// the days. A rent paid on the 1st is not a fast start.
  expectedSpentMinor: number;
  /// Spent less expected. Positive is ahead of plan.
  aheadByMinor: number;
  /// Average day-to-day spending per day so far - everything but fixed
  /// costs, which do not repeat daily.
  dailyAverageMinor: number;
  /// What the month will come to if the average holds and the fixed costs
  /// still to go out do.
  projectedSpentMinor: number;
  /// The IST day the amount runs out at the current average, when that is
  /// before the month ends. Null when it lasts, or is already gone.
  runOutOn: string | null;
  /// Fixed costs - commitments, loan and EMI instalments - paid this month,
  /// and still to go out.
  fixedPaidMinor: number;
  fixedStillDueMinor: number;
}

export interface PaceInput {
  budgetMinor: number;
  spentMinor: number;
  fixedPaidMinor: number;
  fixedStillDueMinor: number;
  dayOfMonth: number;
  daysInMonth: number;
  /// Today, YYYY-MM-DD in IST, for naming the day it runs out.
  today: string;
}

/**
 * How a month (or a category's share of one) is going, from its figures.
 * Kept free of the database so the arithmetic can be checked directly.
 */
export function paceFor(input: PaceInput): Pace {
  const { budgetMinor, spentMinor, fixedPaidMinor, fixedStillDueMinor, daysInMonth } = input;
  const dayOfMonth = Math.min(Math.max(1, input.dayOfMonth), daysInMonth);
  const daysLeft = daysInMonth - dayOfMonth + 1;
  const daysAfterToday = daysInMonth - dayOfMonth;

  const remainingMinor = budgetMinor - spentMinor;
  const safeDailyMinor = Math.max(0, Math.floor((remainingMinor - fixedStillDueMinor) / daysLeft));

  // The day to day is what is spread evenly. Fixed costs are expected
  // once they have been paid and not before, so a month that starts with
  // the rent is not "ahead of plan" for having paid it.
  const dayToDayBudget = budgetMinor - fixedPaidMinor - fixedStillDueMinor;
  const dayToDaySpent = Math.max(0, spentMinor - fixedPaidMinor);
  const expectedSpentMinor = fixedPaidMinor + Math.max(0, Math.round((dayToDayBudget * dayOfMonth) / daysInMonth));
  const dailyAverageMinor = Math.round(dayToDaySpent / dayOfMonth);
  const projectedSpentMinor = spentMinor + fixedStillDueMinor + dailyAverageMinor * daysAfterToday;

  const status: PaceStatus =
    spentMinor > budgetMinor ? "over" : spentMinor > expectedSpentMinor ? "high" : "on_track";

  // Run out: the day what is left, after the fixed costs still due, is
  // gone at the average so far. Only when that is inside the month - a
  // pace that lasts to payday has nothing to warn about - and not once it
  // is already over, which "over" says better.
  let runOutOn: string | null = null;
  const room = remainingMinor - fixedStillDueMinor;
  if (status !== "over" && dailyAverageMinor > 0 && room < dailyAverageMinor * daysAfterToday) {
    const days = room <= 0 ? 0 : Math.ceil(room / dailyAverageMinor);
    runOutOn = istDayKey(new Date(istDayStart(input.today).getTime() + days * DAY + 12 * 60 * 60 * 1000));
  }

  return {
    status,
    dayOfMonth,
    daysInMonth,
    daysLeft,
    remainingMinor,
    safeDailyMinor,
    expectedSpentMinor,
    aheadByMinor: spentMinor - expectedSpentMinor,
    dailyAverageMinor,
    projectedSpentMinor,
    runOutOn,
    fixedPaidMinor,
    fixedStillDueMinor,
  };
}

/** The monthly budget in force for a month, or null before the first. */
export function monthlyBudgetFor(
  user: { monthlyBudgetHistory?: MonthlyBudgetChange[] | null },
  monthKey: string
): MonthlyBudgetChange | null {
  let found: MonthlyBudgetChange | null = null;
  for (const change of user.monthlyBudgetHistory ?? []) {
    if (change.fromMonthKey <= monthKey) found = change;
    else break;
  }
  return found;
}

export interface MonthlyBudgetInput {
  amountMinor: number;
  categoryLimits: { categoryId: Types.ObjectId; amountMinor: number }[];
}

/**
 * The history after a budget is set in the month with this key.
 *
 * Takes effect from that month on: every month before it keeps the entry
 * it was measured against. Setting it twice in one month keeps the last,
 * and anything recorded for a later month - which only a change of pay
 * day could have produced - gives way to it.
 */
export function withMonthlyBudgetChange(
  user: { monthlyBudgetHistory?: MonthlyBudgetChange[] | null },
  next: MonthlyBudgetInput,
  monthKey: string
): MonthlyBudgetChange[] {
  const kept = (user.monthlyBudgetHistory ?? [])
    .filter((change) => change.fromMonthKey < monthKey)
    .map((change) => ({
      fromMonthKey: change.fromMonthKey,
      amountMinor: change.amountMinor,
      categoryLimits: change.categoryLimits.map((limit) => ({
        categoryId: limit.categoryId,
        amountMinor: limit.amountMinor,
      })),
    }));
  kept.push({ fromMonthKey: monthKey, amountMinor: next.amountMinor, categoryLimits: next.categoryLimits });
  return kept;
}

const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/**
 * Whether a budget can be saved. Returns what is wrong, or null - and the
 * overshoot, when the limits add up to more than the amount, so a screen
 * can point at it.
 */
export async function checkMonthlyBudget(
  userId: Types.ObjectId,
  input: MonthlyBudgetInput
): Promise<{ error: string; overshootMinor?: number } | null> {
  const ids = input.categoryLimits.map((limit) => limit.categoryId.toString());
  if (new Set(ids).size !== ids.length) return { error: "The same category has two limits." };

  if (ids.length > 0) {
    const categories = await Category.find({
      _id: { $in: input.categoryLimits.map((limit) => limit.categoryId) },
      $or: [{ userId: null }, { userId }],
    });
    if (categories.length !== ids.length) return { error: "Unknown category" };
    const incoming = categories.find((category) => category.direction === "IN");
    if (incoming) return { error: `${incoming.name} is for money coming in, so there is nothing to limit.` };
  }

  // Limits are parts of the amount, never extra on top of it.
  const total = input.categoryLimits.reduce((sum, limit) => sum + limit.amountMinor, 0);
  if (total > input.amountMinor) {
    const overshootMinor = total - input.amountMinor;
    return {
      error:
        `Category limits add up to ${rupees(total)}, ${rupees(overshootMinor)} more than the ` +
        `${rupees(input.amountMinor)} monthly budget. Lower a limit or raise the budget.`,
      overshootMinor,
    };
  }
  return null;
}

export interface CategoryBudget {
  categoryId: string;
  name: string;
  icon: string | null;
  color: string | null;
  limitMinor: number;
  spentMinor: number;
  /// Negative once it is over.
  leftMinor: number;
  isOver: boolean;
  /// This month only, and only while it is running.
  pace: Pace | null;
}

export interface UnassignedPool {
  /// The amount less every category limit.
  amountMinor: number;
  /// Spent in categories with no limit, uncategorised spending included.
  spentMinor: number;
  leftMinor: number;
  isOver: boolean;
  pace: Pace | null;
  /// What it went on, largest first. categoryId is null for uncategorised.
  categories: { categoryId: string | null; name: string; spentMinor: number }[];
}

export interface MonthDescription {
  key: string;
  from: string;
  to: string;
  label: string;
  bySalary: boolean;
  isCurrent: boolean;
  /// Over and done with: its result has gone into the savings bucket.
  isClosed: boolean;
  daysInMonth: number;
  /// Today's place in it; null for a month that is not running.
  dayOfMonth: number | null;
  /// Days left counting today. The whole month for one still to come,
  /// none for one that is over.
  daysLeft: number;
}

export interface MonthlyBudgetStatus {
  /// Whether a budget is in force for this month.
  configured: boolean;
  /// Whether one has ever been set, so "not set" can be told apart from
  /// "this month is from before you set one".
  everSet: boolean;
  month: MonthDescription;
  /// The month the amount in force was set from.
  fromMonthKey: string | null;
  budgetMinor: number | null;
  spentMinor: number;
  leftMinor: number | null;
  isOver: boolean;
  pace: Pace | null;
  categories: CategoryBudget[];
  unassigned: UnassignedPool | null;
  bucket: BucketSummary;
  /// The old daily budget times the days in this month, offered as a
  /// starting amount and never applied by itself. Null without one.
  suggestedMonthlyMinor: number | null;
}

/** Spending in a month by category, and how much of it was fixed costs. */
async function spendingIn(userId: Types.ObjectId, month: Pick<UserMonth, "start" | "end">) {
  // One pass. A payment towards a commitment, a loan instalment or a card
  // EMI's instalment is a fixed cost; anything else is the day to day.
  const rows = await Transaction.aggregate<{ _id: { categoryId: Types.ObjectId | null; fixed: boolean }; total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: month.start, $lt: month.end },
        countedAmountMinor: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: {
          categoryId: { $ifNull: ["$categoryId", null] },
          fixed: {
            $or: [
              { $gt: ["$commitmentId", null] },
              { $gt: ["$loanId", null] },
              { $eq: ["$emiRole", "INSTALMENT"] },
            ],
          },
        },
        total: { $sum: "$countedAmountMinor" },
      },
    },
  ]);

  const byCategory = new Map<string, { spent: number; fixed: number }>();
  for (const row of rows) {
    const key = row._id.categoryId?.toString() ?? "none";
    const entry = byCategory.get(key) ?? { spent: 0, fixed: 0 };
    entry.spent += row.total;
    if (row._id.fixed) entry.fixed += row.total;
    byCategory.set(key, entry);
  }
  return byCategory;
}

/**
 * Fixed costs still to go out this month, by the category they will land
 * in ("none" where that is not known): every active commitment's
 * shortfall, the way the pace card works it out, and any loan or card EMI
 * instalment due in the month and not yet paid.
 */
async function fixedStillDue(userId: Types.ObjectId, month: UserMonth): Promise<Map<string, number>> {
  const [commitments, paidRows, loanDue, emiDue] = await Promise.all([
    FixedCommitment.find({ userId, isActive: true }),
    Transaction.aggregate<{ _id: Types.ObjectId; total: number }>([
      {
        $match: {
          userId,
          commitmentId: { $ne: null },
          type: "DEBIT",
          occurredAt: { $gte: month.start, $lt: month.end },
        },
      },
      { $group: { _id: "$commitmentId", total: { $sum: "$countedAmountMinor" } } },
    ]),
    LoanInstalment.find({ userId, status: "DUE", dueDate: { $gte: month.start, $lt: month.end } }).select("amountMinor"),
    EmiInstalment.find({ userId, status: "DUE", dueDate: { $gte: month.start, $lt: month.end } }).select("amountMinor"),
  ]);
  const paid = new Map(paidRows.map((row) => [row._id.toString(), row.total]));

  const due = new Map<string, number>();
  const add = (key: string, amount: number) => due.set(key, (due.get(key) ?? 0) + amount);

  // A commitment is ticked against its period's first day, which for the
  // current month is the month's own first day.
  for (const commitment of commitments) {
    if (commitment.paidForPeriod === month.from) continue;
    // A card's bill is the month's card purchases, each already in spent.
    // Holding it back as still to go out counts them a second time, and
    // the payment itself counts nothing, so it would never even read as
    // paid.
    if (isCardBillCommitment(commitment)) continue;
    const shortfall = commitmentAmountFor(commitment, month.from) - (paid.get(commitment._id.toString()) ?? 0);
    if (shortfall > 0) add(commitment.categoryId?.toString() ?? "none", shortfall);
  }
  for (const instalment of [...loanDue, ...emiDue]) add("none", instalment.amountMinor);
  return due;
}

function describe(month: UserMonth, bySalary: boolean, currentKey: string, now: Date): MonthDescription {
  const daysInMonth = Math.max(1, Math.round((month.end.getTime() - month.start.getTime()) / DAY));
  const isCurrent = month.key === currentKey;
  const isClosed = !isCurrent && month.key < currentKey;
  const todayStart = istDayStart(istDayKey(now)).getTime();
  const dayOfMonth = isCurrent
    ? Math.min(daysInMonth, Math.max(1, Math.round((todayStart - month.start.getTime()) / DAY) + 1))
    : null;

  return {
    key: month.key,
    from: month.from,
    to: month.to,
    label: monthLabel(month, bySalary),
    bySalary,
    isCurrent,
    isClosed,
    daysInMonth,
    dayOfMonth,
    daysLeft: dayOfMonth !== null ? daysInMonth - dayOfMonth + 1 : isClosed ? 0 : daysInMonth,
  };
}

/** The month's spent figure alone: the same total analytics shows. */
export async function spentInMonth(userId: Types.ObjectId, month: Pick<UserMonth, "start" | "end">): Promise<number> {
  const byCategory = await spendingIn(userId, month);
  return [...byCategory.values()].reduce((sum, entry) => sum + entry.spent, 0);
}

/**
 * Where a month stands against its budget: the month today is in, or any
 * other by its key.
 */
export async function monthlyBudgetStatus(
  userId: Types.ObjectId,
  key?: string,
  now = new Date()
): Promise<MonthlyBudgetStatus> {
  const [user, month, months] = await Promise.all([
    User.findById(userId).select("monthlyBudgetHistory dailyBudgetMinor").orFail(),
    userMonth(userId, key, now),
    userMonths(userId, now, 1),
  ]);
  const described = describe(month, months.bySalary, months.recent[0].key, now);
  const entry = monthlyBudgetFor(user, month.key);

  const [byCategory, bucket] = await Promise.all([spendingIn(userId, month), bucketSummary(userId, now)]);
  const spentMinor = [...byCategory.values()].reduce((sum, row) => sum + row.spent, 0);

  const suggestedMonthlyMinor = user.dailyBudgetMinor ? user.dailyBudgetMinor * described.daysInMonth : null;

  if (!entry) {
    return {
      configured: false,
      everSet: (user.monthlyBudgetHistory ?? []).length > 0,
      month: described,
      fromMonthKey: null,
      budgetMinor: null,
      spentMinor,
      leftMinor: null,
      isOver: false,
      pace: null,
      categories: [],
      unassigned: null,
      bucket,
      suggestedMonthlyMinor,
    };
  }

  // Pace only for the month that is running: one that is over has its
  // answer, and one still to come has nothing to measure.
  const due = described.isCurrent ? await fixedStillDue(userId, month) : null;
  const today = istDayKey(now);
  const paceOf = (budgetMinor: number, spent: number, fixedPaid: number, stillDue: number) =>
    due && described.dayOfMonth !== null
      ? paceFor({
          budgetMinor,
          spentMinor: spent,
          fixedPaidMinor: fixedPaid,
          fixedStillDueMinor: stillDue,
          dayOfMonth: described.dayOfMonth,
          daysInMonth: described.daysInMonth,
          today,
        })
      : null;

  const limited = new Set(entry.categoryLimits.map((limit) => limit.categoryId.toString()));
  const names = await Category.find({
    _id: {
      $in: [
        ...entry.categoryLimits.map((limit) => limit.categoryId),
        ...[...byCategory.keys()].filter((id) => id !== "none").map((id) => new Types.ObjectId(id)),
      ],
    },
  });
  const categoryById = new Map(names.map((category) => [category._id.toString(), category]));

  const categories: CategoryBudget[] = entry.categoryLimits.map((limit) => {
    const id = limit.categoryId.toString();
    const category = categoryById.get(id);
    const spent = byCategory.get(id) ?? { spent: 0, fixed: 0 };
    return {
      categoryId: id,
      name: category?.name ?? "Deleted category",
      icon: category?.icon ?? null,
      color: category?.color ?? null,
      limitMinor: limit.amountMinor,
      spentMinor: spent.spent,
      leftMinor: limit.amountMinor - spent.spent,
      isOver: spent.spent > limit.amountMinor,
      pace: paceOf(limit.amountMinor, spent.spent, spent.fixed, due?.get(id) ?? 0),
    };
  });

  // Everything without a limit spends from what the limits leave over.
  const unlimited = [...byCategory.entries()].filter(([id]) => !limited.has(id));
  const poolMinor = entry.amountMinor - entry.categoryLimits.reduce((sum, limit) => sum + limit.amountMinor, 0);
  const poolSpent = unlimited.reduce((sum, [, row]) => sum + row.spent, 0);
  const poolFixed = unlimited.reduce((sum, [, row]) => sum + row.fixed, 0);
  const poolDue = due ? [...due.entries()].filter(([id]) => !limited.has(id)).reduce((sum, [, amount]) => sum + amount, 0) : 0;
  const totalFixed = [...byCategory.values()].reduce((sum, row) => sum + row.fixed, 0);
  const totalDue = due ? [...due.values()].reduce((sum, amount) => sum + amount, 0) : 0;

  return {
    configured: true,
    everSet: true,
    month: described,
    fromMonthKey: entry.fromMonthKey,
    budgetMinor: entry.amountMinor,
    spentMinor,
    leftMinor: entry.amountMinor - spentMinor,
    isOver: spentMinor > entry.amountMinor,
    pace: paceOf(entry.amountMinor, spentMinor, totalFixed, totalDue),
    categories,
    unassigned: {
      amountMinor: poolMinor,
      spentMinor: poolSpent,
      leftMinor: poolMinor - poolSpent,
      isOver: poolSpent > poolMinor,
      pace: paceOf(poolMinor, poolSpent, poolFixed, poolDue),
      categories: unlimited
        .map(([id, row]) => ({
          categoryId: id === "none" ? null : id,
          name: id === "none" ? "Uncategorized" : (categoryById.get(id)?.name ?? "Deleted category"),
          spentMinor: row.spent,
        }))
        .sort((a, b) => b.spentMinor - a.spentMinor),
    },
    bucket,
    suggestedMonthlyMinor,
  };
}
