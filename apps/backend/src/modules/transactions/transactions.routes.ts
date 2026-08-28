import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { requireAuth } from "../../middleware/auth";
import { TRANSACTION_TYPES } from "../../types";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  categoryId: z.string().optional(),
  accountId: z.string().optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function buildWhere(userId: string, filters: z.infer<typeof listQuerySchema>): Prisma.TransactionWhereInput {
  return {
    userId,
    categoryId: filters.categoryId,
    accountId: filters.accountId,
    type: filters.type,
    occurredAt: {
      gte: filters.from ? new Date(filters.from) : undefined,
      lte: filters.to ? new Date(filters.to) : undefined,
    },
    ...(filters.q
      ? {
          OR: [
            { merchant: { contains: filters.q } },
            { note: { contains: filters.q } },
          ],
        }
      : {}),
  };
}

// GET /transactions — filterable, paginated flat list.
transactionsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const where = buildWhere(req.user!.id, parsed.data);
  const [items, total] = await Promise.all([
    prisma.transaction.findMany({
      where,
      include: { category: true, account: true },
      orderBy: { occurredAt: "desc" },
      skip: (parsed.data.page - 1) * parsed.data.pageSize,
      take: parsed.data.pageSize,
    }),
    prisma.transaction.count({ where }),
  ]);

  res.json({ items, total, page: parsed.data.page, pageSize: parsed.data.pageSize });
});

// GET /transactions/by-day — the "Today"/ledger view: transactions grouped
// by calendar day (server-local date), most recent day first.
transactionsRouter.get("/by-day", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const where = buildWhere(req.user!.id, parsed.data);
  const transactions = await prisma.transaction.findMany({
    where,
    include: { category: true, account: true },
    orderBy: { occurredAt: "desc" },
  });

  const days = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    const dayKey = tx.occurredAt.toISOString().slice(0, 10);
    const bucket = days.get(dayKey);
    if (bucket) bucket.push(tx);
    else days.set(dayKey, [tx]);
  }

  const result = Array.from(days.entries()).map(([date, items]) => {
    const spend = items
      .filter((t) => t.type === "DEBIT" && !t.isTransfer)
      .reduce((sum, t) => sum + t.amountMinor, 0);
    const income = items
      .filter((t) => t.type === "CREDIT" && !t.isTransfer)
      .reduce((sum, t) => sum + t.amountMinor, 0);
    return { date, spendMinor: spend, incomeMinor: income, transactions: items };
  });

  res.json(result);
});

transactionsRouter.get("/:id", async (req, res) => {
  const tx = await prisma.transaction.findUnique({
    where: { id: req.params.id },
    include: { category: true, account: true },
  });
  if (!tx || tx.userId !== req.user!.id) return res.status(404).json({ error: "Not found" });
  res.json(tx);
});

const createTransactionSchema = z.object({
  amountMinor: z.number().int().positive(),
  currency: z.string().default("INR"),
  type: z.enum(TRANSACTION_TYPES),
  merchant: z.string().optional(),
  note: z.string().optional(),
  categoryId: z.string().optional(),
  occurredAt: z.string().datetime(),
});

// POST /transactions — manual entry (cash spends, or anything the auto
// ingestion missed).
transactionsRouter.post("/", async (req, res) => {
  const parsed = createTransactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const tx = await prisma.transaction.create({
    data: {
      userId: req.user!.id,
      amountMinor: parsed.data.amountMinor,
      currency: parsed.data.currency,
      type: parsed.data.type,
      merchant: parsed.data.merchant,
      note: parsed.data.note,
      categoryId: parsed.data.categoryId,
      occurredAt: new Date(parsed.data.occurredAt),
      source: "MANUAL",
    },
    include: { category: true, account: true },
  });
  res.status(201).json(tx);
});

const updateTransactionSchema = z.object({
  categoryId: z.string().nullable().optional(),
  merchant: z.string().optional(),
  note: z.string().optional(),
  isTransfer: z.boolean().optional(),
});

transactionsRouter.patch("/:id", async (req, res) => {
  const parsed = updateTransactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.transaction.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.user!.id) return res.status(404).json({ error: "Not found" });

  const updated = await prisma.transaction.update({
    where: { id: existing.id },
    data: parsed.data,
    include: { category: true, account: true },
  });
  res.json(updated);
});

transactionsRouter.delete("/:id", async (req, res) => {
  const existing = await prisma.transaction.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.user!.id) return res.status(404).json({ error: "Not found" });

  await prisma.transaction.delete({ where: { id: existing.id } });
  res.status(204).end();
});
