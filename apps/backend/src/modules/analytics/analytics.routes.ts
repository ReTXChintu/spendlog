import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { Account, Transaction } from "../../models";
import { IST_OFFSET, istDayKey } from "../../time";
import { UserMonth, monthLabel, monthSoFar, userMonth, userMonths } from "../budget/budget.months";
import { outsideTransactionsMinor } from "../contacts/contacts.people";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

// Every figure here is for one of the user's own months: salary day to
// salary day where there is a pay day, the calendar month where there is
// not. See budget.months.ts. `month` names one by its key; left out, it
// is the month today is in.
const summarySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  /// An account id, or "cash" for payments with no account - which is
  /// what paying in cash has always meant here.
  account: z.string().regex(/^([0-9a-fA-F]{24}|cash)$/).optional(),
  category: z.string().regex(/^([0-9a-fA-F]{24}|none)$/).optional(),
});

/**
 * The filters a chart can be narrowed by, as a query fragment. Cash covers
 * both the cash account and payments with no account at all.
 */
async function filters(
  userId: Types.ObjectId,
  query: { account?: string; category?: string }
): Promise<Record<string, unknown>> {
  const match: Record<string, unknown> = {};
  if (query.account === "cash") {
    const cash = await Account.findOne({ userId, accountType: "CASH" }).select("_id");
    match.accountId = { $in: [null, ...(cash ? [cash._id] : [])] };
  } else if (query.account) {
    match.accountId = new Types.ObjectId(query.account);
  }
  if (query.category === "none") match.categoryId = null;
  else if (query.category) match.categoryId = new Types.ObjectId(query.category);
  return match;
}

/** What a response says about the month it covers, so a screen can label it. */
function describe(month: UserMonth, bySalary: boolean) {
  return { month: month.key, from: month.from, to: month.to, label: monthLabel(month, bySalary) };
}

// GET /analytics/months — the user's months, newest first, for a screen
// to step through. The current one is first.
analyticsRouter.get("/months", async (req, res) => {
  const months = await userMonths(currentUserId(req), new Date(), 24);
  res.json({
    bySalary: months.bySalary,
    salaryDay: months.salaryDay,
    current: months.recent[0].key,
    months: months.recent.map((month) => describe(month, months.bySalary)),
  });
});

interface CategoryTotal {
  _id: Types.ObjectId | null;
  amountMinor: number;
  name: string | null;
}

// GET /analytics/summary?month=YYYY-MM — total spend/income and a
// per-category breakdown for the given month.
analyticsRouter.get("/summary", async (req, res) => {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const [period, { bySalary }] = await Promise.all([
    userMonth(userId, parsed.data.month),
    userMonths(userId, new Date(), 1),
  ]);
  const { start, end } = period;
  // No isTransfer filter: transfers already count as zero, along with
  // settlements, EMI parents and the unclaimed share of a split.
  const match = {
    userId,
    occurredAt: { $gte: start, $lt: end },
    ...(await filters(userId, parsed.data)),
  };

  // Totals and the category breakdown are computed in the database rather
  // than by loading every transaction into memory.
  const [totals, byCategory] = await Promise.all([
    Transaction.aggregate<{ _id: string; amountMinor: number; count: number }>([
      { $match: match },
      { $group: { _id: "$type", amountMinor: { $sum: "$countedAmountMinor" }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate<CategoryTotal>([
      { $match: { ...match, type: "DEBIT", countedAmountMinor: { $gt: 0 } } },
      { $group: { _id: "$categoryId", amountMinor: { $sum: "$countedAmountMinor" } } },
      { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
      { $addFields: { name: { $ifNull: [{ $first: "$category.name" }, "Uncategorized"] } } },
      { $project: { amountMinor: 1, name: 1 } },
      { $sort: { amountMinor: -1 } },
    ]),
  ]);

  const debit = totals.find((t) => t._id === "DEBIT");
  const credit = totals.find((t) => t._id === "CREDIT");

  res.json({
    ...describe(period, bySalary),
    totalSpendMinor: debit?.amountMinor ?? 0,
    totalIncomeMinor: credit?.amountMinor ?? 0,
    byCategory: byCategory.map((c) => ({
      categoryId: c._id ? c._id.toString() : null,
      name: c.name,
      amountMinor: c.amountMinor,
    })),
    transactionCount: (debit?.count ?? 0) + (credit?.count ?? 0),
  });
});

const trendSchema = z.object({
  months: z.coerce.number().int().min(1).max(24).default(6),
});

// GET /analytics/trend?months=6 — monthly totals for the trend chart.
analyticsRouter.get("/trend", async (req, res) => {
  const parsed = trendSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const { recent, bySalary } = await userMonths(userId, new Date(), parsed.data.months);
  // Oldest first, the way a chart reads.
  const months = [...recent].reverse();

  // One grouped query for the whole window, each transaction put in the
  // user's month it falls in - which a calendar group-by cannot do once
  // months run from the 15th.
  const rows = await Transaction.aggregate<{ _id: { month: string; type: string }; amountMinor: number }>([
    {
      $match: {
        userId,
        occurredAt: { $gte: months[0].start, $lt: months[months.length - 1].end },
      },
    },
    {
      $group: {
        _id: {
          month: {
            $switch: {
              branches: months.map((month) => ({
                case: { $and: [{ $gte: ["$occurredAt", month.start] }, { $lt: ["$occurredAt", month.end] }] },
                then: month.key,
              })),
              default: "other",
            },
          },
          type: "$type",
        },
        amountMinor: { $sum: "$countedAmountMinor" },
      },
    },
  ]);

  const byMonth = new Map(
    months.map((month) => [month.key, { ...describe(month, bySalary), spendMinor: 0, incomeMinor: 0 }])
  );
  for (const row of rows) {
    const entry = byMonth.get(row._id.month);
    if (!entry) continue;
    if (row._id.type === "DEBIT") entry.spendMinor = row.amountMinor;
    else entry.incomeMinor = row.amountMinor;
  }

  res.json(months.map((month) => byMonth.get(month.key)!));
});

// GET /analytics/owed — the running balance with everyone the user splits
// bills with.
//
// Deliberately a pool rather than a ledger of who owes what. Splitwise
// nets across many bills, months and people, so insisting each settlement
// be matched to specific splits would be laborious and still wrong. A
// single figure to eyeball against the Splitwise app is honest about its
// own precision, and any drift is itself worth seeing.
analyticsRouter.get("/owed", async (req, res) => {
  const userId = currentUserId(req);

  const [lent, settled, outsideMinor] = await Promise.all([
    // What was paid on someone else's behalf: the part of a split bill
    // that was never the user's own spending.
    Transaction.aggregate<{ _id: null; amountMinor: number; count: number }>([
      { $match: { userId, "split.myShareMinor": { $ne: null }, type: "DEBIT" } },
      {
        $group: {
          _id: null,
          amountMinor: { $sum: { $subtract: ["$amountMinor", "$split.myShareMinor"] } },
          count: { $sum: 1 },
        },
      },
    ]),
    Transaction.aggregate<{ _id: string; amountMinor: number }>([
      { $match: { userId, isSettlement: true } },
      { $group: { _id: "$type", amountMinor: { $sum: "$amountMinor" } } },
    ]),
    // Per person and outside every transaction: what was owed before
    // SpendLog, less what was cleared without money moving.
    outsideTransactionsMinor(userId),
  ]);

  const lentMinor = lent[0]?.amountMinor ?? 0;
  // Money in settles what was owed to the user; money out settles what the
  // user owed, which moves the balance the other way.
  const receivedMinor = settled.find((s) => s._id === "CREDIT")?.amountMinor ?? 0;
  const paidMinor = settled.find((s) => s._id === "DEBIT")?.amountMinor ?? 0;

  const splits = await Transaction.find({ userId, "split.myShareMinor": { $ne: null }, type: "DEBIT" })
    .sort({ occurredAt: -1 })
    .limit(50)
    .populate("category")
    .populate("account");

  res.json({
    balanceMinor: lentMinor - receivedMinor + paidMinor + outsideMinor,
    lentMinor,
    outsideMinor,
    settledInMinor: receivedMinor,
    settledOutMinor: paidMinor,
    splitCount: lent[0]?.count ?? 0,
    splits,
  });
});

const merchantsSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(15),
  account: z.string().regex(/^([0-9a-fA-F]{24}|cash)$/).optional(),
  category: z.string().regex(/^([0-9a-fA-F]{24}|none)$/).optional(),
});

/**
 * GET /analytics/merchants?month=YYYY-MM — where the money actually went.
 *
 * Categories say what kind of spending it was; this says who got it, which
 * is the question you can act on. "Food" is not a thing to cut back on;
 * ordering from one delivery app eleven times is.
 *
 * Merchants are grouped case-insensitively because the same shop arrives
 * spelled differently from an SMS and from an email.
 */
analyticsRouter.get("/merchants", async (req, res) => {
  const parsed = merchantsSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const { start, end } = await userMonth(userId, parsed.data.month);

  const rows = await Transaction.aggregate<{
    _id: string;
    name: string;
    amountMinor: number;
    count: number;
  }>([
    {
      $match: {
        userId,
        occurredAt: { $gte: start, $lt: end },
        type: "DEBIT",
        countedAmountMinor: { $gt: 0 },
        merchant: { $nin: [null, ""] },
        ...(await filters(userId, parsed.data)),
      },
    },
    {
      $group: {
        _id: { $toLower: "$merchant" },
        // The first spelling seen, rather than the folded key, so the list
        // reads the way the merchant writes its own name.
        name: { $first: "$merchant" },
        amountMinor: { $sum: "$countedAmountMinor" },
        count: { $sum: 1 },
      },
    },
    { $sort: { amountMinor: -1 } },
    { $limit: parsed.data.limit },
  ]);

  res.json(
    rows.map((row) => ({
      merchant: row.name,
      amountMinor: row.amountMinor,
      count: row.count,
    }))
  );
});

interface MonthTotals {
  totalSpendMinor: number;
  byCategory: Map<string, { name: string; amountMinor: number }>;
}

async function totalsFor(userId: Types.ObjectId, month: UserMonth): Promise<MonthTotals> {
  const rows = await Transaction.aggregate<CategoryTotal>([
    {
      $match: {
        userId,
        occurredAt: { $gte: month.start, $lt: month.end },
        type: "DEBIT",
        countedAmountMinor: { $gt: 0 },
      },
    },
    { $group: { _id: "$categoryId", amountMinor: { $sum: "$countedAmountMinor" } } },
    { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
    { $addFields: { name: { $ifNull: [{ $first: "$category.name" }, "Uncategorized"] } } },
    { $project: { amountMinor: 1, name: 1 } },
  ]);

  const byCategory = new Map<string, { name: string; amountMinor: number }>();
  let totalSpendMinor = 0;
  for (const row of rows) {
    byCategory.set(row._id ? row._id.toString() : "none", {
      name: row.name ?? "Uncategorized",
      amountMinor: row.amountMinor,
    });
    totalSpendMinor += row.amountMinor;
  }

  return { totalSpendMinor, byCategory };
}

/** The user's month before `month`. */
async function monthBefore(userId: Types.ObjectId, month: UserMonth): Promise<UserMonth> {
  const { recent } = await userMonths(userId);
  const index = recent.findIndex((candidate) => candidate.key === month.key);
  if (index >= 0 && recent[index + 1]) return recent[index + 1];

  const [year, mon] = month.key.split("-").map(Number);
  const key = `${mon === 1 ? year - 1 : year}-${String(mon === 1 ? 12 : mon - 1).padStart(2, "0")}`;
  return userMonth(userId, key);
}

/**
 * GET /analytics/compare?month=YYYY-MM — this month against the one before.
 *
 * Per category as well as in total, because the total moving is rarely the
 * interesting part. A month that came out the same overall can still have
 * doubled on one thing and halved on another, and that is the version worth
 * reading.
 *
 * A category present in one month and absent from the other is included
 * with a zero on the missing side. Dropping it would hide exactly the
 * changes that matter most — something new, or something that stopped.
 */
analyticsRouter.get("/compare", async (req, res) => {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const [month, { bySalary }] = await Promise.all([
    userMonth(userId, parsed.data.month),
    userMonths(userId, new Date(), 1),
  ]);
  const earlier = await monthBefore(userId, month);

  const [current, previous] = await Promise.all([totalsFor(userId, month), totalsFor(userId, earlier)]);

  const categoryIds = new Set([...current.byCategory.keys(), ...previous.byCategory.keys()]);
  const categories = [...categoryIds].map((id) => {
    const now = current.byCategory.get(id);
    const before = previous.byCategory.get(id);
    const amountMinor = now?.amountMinor ?? 0;
    const previousMinor = before?.amountMinor ?? 0;

    return {
      categoryId: id === "none" ? null : id,
      name: now?.name ?? before?.name ?? "Uncategorized",
      amountMinor,
      previousMinor,
      changeMinor: amountMinor - previousMinor,
    };
  });

  // By how much a category moved, not by how much it is — the biggest
  // change is the thing worth looking at first.
  categories.sort((a, b) => Math.abs(b.changeMinor) - Math.abs(a.changeMinor));

  res.json({
    ...describe(month, bySalary),
    previousMonth: earlier.key,
    previousMonthLabel: monthLabel(earlier, bySalary),
    totalSpendMinor: current.totalSpendMinor,
    previousSpendMinor: previous.totalSpendMinor,
    changeMinor: current.totalSpendMinor - previous.totalSpendMinor,
    categories,
  });
});

// GET /analytics/month-so-far — this month against the same point in the
// last, for the one line the dashboard carries. See monthSoFar.
analyticsRouter.get("/month-so-far", async (req, res) => {
  res.json(await monthSoFar(currentUserId(req)));
});

/**
 * GET /analytics/daily?month=&account=&category= — spending and money in,
 * day by day across one of the user's months, for the line chart. Every
 * day is there, including the empty ones a chart needs to be honest.
 */
analyticsRouter.get("/daily", async (req, res) => {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const month = await userMonth(userId, parsed.data.month);
  const rows = await Transaction.aggregate<{ _id: { day: string; type: string }; amountMinor: number }>([
    {
      $match: {
        userId,
        occurredAt: { $gte: month.start, $lt: month.end },
        countedAmountMinor: { $gt: 0 },
        ...(await filters(userId, parsed.data)),
      },
    },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt", timezone: IST_OFFSET } },
          type: "$type",
        },
        amountMinor: { $sum: "$countedAmountMinor" },
      },
    },
  ]);

  const byDay = new Map<string, { day: string; spendMinor: number; incomeMinor: number }>();
  for (let at = month.start.getTime(); at < month.end.getTime(); at += 24 * 60 * 60 * 1000) {
    const day = istDayKey(new Date(at));
    byDay.set(day, { day, spendMinor: 0, incomeMinor: 0 });
  }
  for (const row of rows) {
    const entry = byDay.get(row._id.day);
    if (!entry) continue;
    if (row._id.type === "DEBIT") entry.spendMinor += row.amountMinor;
    else entry.incomeMinor += row.amountMinor;
  }
  res.json([...byDay.values()]);
});

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * GET /analytics/weekday?month=&account=&category= — which days of the
 * week the money goes on, with how many of each day the month had so far
 * so an average is a fair one.
 */
analyticsRouter.get("/weekday", async (req, res) => {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const month = await userMonth(userId, parsed.data.month);
  const rows = await Transaction.aggregate<{ _id: number; amountMinor: number; count: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: month.start, $lt: month.end },
        countedAmountMinor: { $gt: 0 },
        ...(await filters(userId, parsed.data)),
      },
    },
    {
      $group: {
        _id: { $dayOfWeek: { date: "$occurredAt", timezone: IST_OFFSET } },
        amountMinor: { $sum: "$countedAmountMinor" },
        count: { $sum: 1 },
      },
    },
  ]);

  // How many Mondays (and so on) the month has had, so far.
  const until = Math.min(month.end.getTime(), Date.now());
  const days = new Array(7).fill(0);
  for (let at = month.start.getTime(); at < until; at += 24 * 60 * 60 * 1000) {
    days[new Date(at + 5.5 * 60 * 60 * 1000).getUTCDay()] += 1;
  }

  res.json(
    WEEKDAYS.map((name, index) => {
      const row = rows.find((candidate) => candidate._id === index + 1);
      const amountMinor = row?.amountMinor ?? 0;
      return {
        day: name,
        amountMinor,
        count: row?.count ?? 0,
        averageMinor: days[index] ? Math.round(amountMinor / days[index]) : 0,
      };
    })
  );
});

/**
 * GET /analytics/accounts?month=&category= — where the spending was paid
 * from: each card and account, and cash (which includes payments with no
 * account at all).
 */
analyticsRouter.get("/accounts", async (req, res) => {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const month = await userMonth(userId, parsed.data.month);
  const [rows, accounts] = await Promise.all([
    Transaction.aggregate<{ _id: Types.ObjectId | null; amountMinor: number; count: number }>([
      {
        $match: {
          userId,
          type: "DEBIT",
          occurredAt: { $gte: month.start, $lt: month.end },
          countedAmountMinor: { $gt: 0 },
          ...(await filters(userId, { category: parsed.data.category })),
        },
      },
      { $group: { _id: "$accountId", amountMinor: { $sum: "$countedAmountMinor" }, count: { $sum: 1 } } },
    ]),
    Account.find({ userId }),
  ]);

  const cash = accounts.find((account) => account.accountType === "CASH");
  const merged = new Map<
    string,
    { accountId: string; name: string; accountType: string; amountMinor: number; count: number }
  >();
  for (const row of rows) {
    const account = row._id ? accounts.find((candidate) => candidate._id.equals(row._id!)) : cash;
    const key = account ? account._id.toString() : "cash";
    const entry = merged.get(key) ?? {
      accountId: account && account.accountType !== "CASH" ? key : "cash",
      name: account
        ? account.nickname || `${account.bankName}${account.last4 ? ` ••${account.last4}` : ""}`
        : "Cash",
      accountType: account?.accountType ?? "CASH",
      amountMinor: 0,
      count: 0,
    };
    entry.amountMinor += row.amountMinor;
    entry.count += row.count;
    merged.set(key, entry);
  }
  res.json([...merged.values()].sort((a, b) => b.amountMinor - a.amountMinor));
});
