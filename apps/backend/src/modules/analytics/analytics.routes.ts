import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { Transaction } from "../../models";
import { IST_OFFSET, istDayKey, istMonthEnd, istMonthKey, istMonthStart } from "../../time";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

// A month runs from midnight IST on the 1st to midnight IST on the 1st of
// the next — so a payment at 00:30 on 1 September belongs to September,
// which by the UTC calendar it would not.
function monthRange(month: string): { start: Date; end: Date } {
  return { start: istMonthStart(month), end: istMonthEnd(month) };
}

const summarySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default(() => new Date().toISOString().slice(0, 7)),
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

  const { start, end } = monthRange(parsed.data.month);
  // No isTransfer filter: transfers already count as zero, along with
  // settlements, EMI parents and the unclaimed share of a split.
  const match = {
    userId: currentUserId(req),
    occurredAt: { $gte: start, $lt: end },
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
    month: parsed.data.month,
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

  const now = new Date();
  const months: string[] = [];
  for (let i = parsed.data.months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }

  const start = monthRange(months[0]).start;
  const end = monthRange(months[months.length - 1]).end;

  // One grouped query for the whole window, rather than one query per month.
  const rows = await Transaction.aggregate<{ _id: { month: string; type: string }; amountMinor: number }>([
    {
      $match: {
        userId: currentUserId(req),
        occurredAt: { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id: {
          month: { $dateToString: { format: "%Y-%m", date: "$occurredAt", timezone: IST_OFFSET } },
          type: "$type",
        },
        amountMinor: { $sum: "$countedAmountMinor" },
      },
    },
  ]);

  const byMonth = new Map(months.map((month) => [month, { month, spendMinor: 0, incomeMinor: 0 }]));
  for (const row of rows) {
    const entry = byMonth.get(row._id.month);
    if (!entry) continue;
    if (row._id.type === "DEBIT") entry.spendMinor = row.amountMinor;
    else entry.incomeMinor = row.amountMinor;
  }

  res.json(months.map((month) => byMonth.get(month)!));
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

  const [lent, settled] = await Promise.all([
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
    balanceMinor: lentMinor - receivedMinor + paidMinor,
    lentMinor,
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
    .default(() => new Date().toISOString().slice(0, 7)),
  limit: z.coerce.number().int().min(1).max(50).default(15),
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

  const { start, end } = monthRange(parsed.data.month);

  const rows = await Transaction.aggregate<{
    _id: string;
    name: string;
    amountMinor: number;
    count: number;
  }>([
    {
      $match: {
        userId: currentUserId(req),
        occurredAt: { $gte: start, $lt: end },
        type: "DEBIT",
        countedAmountMinor: { $gt: 0 },
        merchant: { $nin: [null, ""] },
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

/** The month before a `YYYY-MM`. */
function previousMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  const previousYear = mon === 1 ? year - 1 : year;
  const previous = mon === 1 ? 12 : mon - 1;
  return `${previousYear}-${String(previous).padStart(2, "0")}`;
}

interface MonthTotals {
  month: string;
  totalSpendMinor: number;
  byCategory: Map<string, { name: string; amountMinor: number }>;
}

async function totalsFor(userId: Types.ObjectId, month: string): Promise<MonthTotals> {
  const { start, end } = monthRange(month);

  const rows = await Transaction.aggregate<CategoryTotal>([
    {
      $match: { userId, occurredAt: { $gte: start, $lt: end }, type: "DEBIT", countedAmountMinor: { $gt: 0 } },
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

  return { month, totalSpendMinor, byCategory };
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
  const month = parsed.data.month;
  const earlier = previousMonth(month);

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
    month,
    previousMonthLabel: earlier,
    totalSpendMinor: current.totalSpendMinor,
    previousSpendMinor: previous.totalSpendMinor,
    changeMinor: current.totalSpendMinor - previous.totalSpendMinor,
    categories,
  });
});

/**
 * GET /analytics/month-so-far — this month against the same point in the
 * last, for the one line the dashboard carries.
 *
 * Compared day-for-day rather than month-for-month. On the 8th, a whole
 * previous month is not a comparison — it is a number three times larger,
 * and reading it as overspending would be wrong every time.
 */
analyticsRouter.get("/month-so-far", async (req, res) => {
  const userId = currentUserId(req);
  const now = new Date();

  const month = istMonthKey(now);
  const dayOfMonth = Number(istDayKey(now).slice(8));
  const earlier = previousMonth(month);

  const spendUpTo = async (targetMonth: string, days: number): Promise<number> => {
    const start = istMonthStart(targetMonth);
    // The same number of days in, clamped so the end of a short February
    // cannot run past its own month.
    const monthEnd = istMonthEnd(targetMonth);
    const end = new Date(Math.min(start.getTime() + days * 24 * 60 * 60 * 1000, monthEnd.getTime()));

    const rows = await Transaction.aggregate<{ total: number }>([
      {
        $match: { userId, occurredAt: { $gte: start, $lt: end }, type: "DEBIT", countedAmountMinor: { $gt: 0 } },
      },
      { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
    ]);
    return rows[0]?.total ?? 0;
  };

  const [spentMinor, previousMinor] = await Promise.all([
    spendUpTo(month, dayOfMonth),
    spendUpTo(earlier, dayOfMonth),
  ]);

  res.json({
    month,
    dayOfMonth,
    spentMinor,
    previousMinor,
    changeMinor: spentMinor - previousMinor,
  });
});
