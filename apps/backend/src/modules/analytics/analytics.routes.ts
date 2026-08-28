import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { requireAuth } from "../../middleware/auth";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

function monthRange(month: string): { start: Date; end: Date } {
  const [year, mon] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, mon - 1, 1));
  const end = new Date(Date.UTC(year, mon, 1));
  return { start, end };
}

const summarySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default(() => new Date().toISOString().slice(0, 7)),
});

// GET /analytics/summary?month=YYYY-MM — total spend/income and a
// per-category breakdown for the given month.
analyticsRouter.get("/summary", async (req, res) => {
  const parsed = summarySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { start, end } = monthRange(parsed.data.month);
  const transactions = await prisma.transaction.findMany({
    where: { userId: req.user!.id, occurredAt: { gte: start, lt: end }, isTransfer: false },
    include: { category: true },
  });

  const totalSpendMinor = transactions.filter((t) => t.type === "DEBIT").reduce((s, t) => s + t.amountMinor, 0);
  const totalIncomeMinor = transactions.filter((t) => t.type === "CREDIT").reduce((s, t) => s + t.amountMinor, 0);

  const byCategoryMap = new Map<string, { categoryId: string | null; name: string; amountMinor: number }>();
  for (const t of transactions.filter((t) => t.type === "DEBIT")) {
    const key = t.categoryId ?? "uncategorized";
    const name = t.category?.name ?? "Uncategorized";
    const existing = byCategoryMap.get(key);
    if (existing) existing.amountMinor += t.amountMinor;
    else byCategoryMap.set(key, { categoryId: t.categoryId, name, amountMinor: t.amountMinor });
  }

  res.json({
    month: parsed.data.month,
    totalSpendMinor,
    totalIncomeMinor,
    byCategory: Array.from(byCategoryMap.values()).sort((a, b) => b.amountMinor - a.amountMinor),
    transactionCount: transactions.length,
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

  const results = await Promise.all(
    months.map(async (month) => {
      const { start, end } = monthRange(month);
      const transactions = await prisma.transaction.findMany({
        where: { userId: req.user!.id, occurredAt: { gte: start, lt: end }, isTransfer: false },
      });
      return {
        month,
        spendMinor: transactions.filter((t) => t.type === "DEBIT").reduce((s, t) => s + t.amountMinor, 0),
        incomeMinor: transactions.filter((t) => t.type === "CREDIT").reduce((s, t) => s + t.amountMinor, 0),
      };
    })
  );

  res.json(results);
});
