import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { Transaction } from "../../models";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

function monthRange(month: string): { start: Date; end: Date } {
  const [year, mon] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, mon - 1, 1)),
    end: new Date(Date.UTC(year, mon, 1)),
  };
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
  const match = {
    userId: currentUserId(req),
    occurredAt: { $gte: start, $lt: end },
    isTransfer: false,
  };

  // Totals and the category breakdown are computed in the database rather
  // than by loading every transaction into memory.
  const [totals, byCategory] = await Promise.all([
    Transaction.aggregate<{ _id: string; amountMinor: number; count: number }>([
      { $match: match },
      { $group: { _id: "$type", amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate<CategoryTotal>([
      { $match: { ...match, type: "DEBIT" } },
      { $group: { _id: "$categoryId", amountMinor: { $sum: "$amountMinor" } } },
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
        isTransfer: false,
      },
    },
    {
      $group: {
        _id: {
          month: { $dateToString: { format: "%Y-%m", date: "$occurredAt", timezone: "UTC" } },
          type: "$type",
        },
        amountMinor: { $sum: "$amountMinor" },
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
