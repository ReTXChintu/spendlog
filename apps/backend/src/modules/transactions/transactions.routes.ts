import { Router } from "express";
import { FilterQuery } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Transaction, TransactionDoc } from "../../models";
import { TRANSACTION_TYPES } from "../../types";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const listQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  categoryId: z.string().optional(),
  accountId: z.string().optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Escapes regex metacharacters so a search term can't alter the pattern. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFilter(
  req: Parameters<typeof currentUserId>[0],
  filters: z.infer<typeof listQuerySchema>
): FilterQuery<TransactionDoc> {
  const filter: FilterQuery<TransactionDoc> = { userId: currentUserId(req) };

  // "none" filters for transactions nothing could categorize — the ones
  // that actually need the user's attention.
  if (filters.categoryId === "none") filter.categoryId = null;
  else if (filters.categoryId) filter.categoryId = filters.categoryId;
  if (filters.accountId) filter.accountId = filters.accountId;
  if (filters.type) filter.type = filters.type;

  if (filters.from || filters.to) {
    filter.occurredAt = {
      ...(filters.from ? { $gte: filters.from } : {}),
      // A bare date means the whole of that day, not midnight at its start.
      ...(filters.to ? { $lte: new Date(filters.to.getTime() + 24 * 60 * 60 * 1000 - 1) } : {}),
    };
  }

  if (filters.q) {
    const term = { $regex: escapeRegex(filters.q), $options: "i" };
    filter.$or = [{ merchant: term }, { note: term }];
  }

  return filter;
}

// GET /transactions — filterable, paginated flat list.
transactionsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const filter = buildFilter(req, parsed.data);
  const [items, total] = await Promise.all([
    Transaction.find(filter)
      .populate("category")
      .populate("account")
      .sort({ occurredAt: -1 })
      .skip((parsed.data.page - 1) * parsed.data.pageSize)
      .limit(parsed.data.pageSize),
    Transaction.countDocuments(filter),
  ]);

  res.json({ items, total, page: parsed.data.page, pageSize: parsed.data.pageSize });
});

// GET /transactions/by-day — the "Today"/ledger view: transactions grouped
// by calendar day, most recent day first.
transactionsRouter.get("/by-day", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const transactions = await Transaction.find(buildFilter(req, parsed.data))
    .populate("category")
    .populate("account")
    .sort({ occurredAt: -1 });

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

transactionsRouter.get("/:id", validObjectIdParam("id"), async (req, res) => {
  const tx = await Transaction.findOne({ _id: req.params.id, userId: currentUserId(req) })
    .populate("category")
    .populate("account");
  if (!tx) return res.status(404).json({ error: "Not found" });

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

  const created = await Transaction.create({
    userId: currentUserId(req),
    amountMinor: parsed.data.amountMinor,
    currency: parsed.data.currency,
    type: parsed.data.type,
    merchant: parsed.data.merchant,
    note: parsed.data.note,
    categoryId: parsed.data.categoryId ?? null,
    occurredAt: new Date(parsed.data.occurredAt),
    source: "MANUAL",
  });

  const tx = await Transaction.findById(created._id).populate("category").populate("account");
  res.status(201).json(tx);
});

const updateTransactionSchema = z.object({
  categoryId: z.string().nullable().optional(),
  merchant: z.string().optional(),
  note: z.string().optional(),
  isTransfer: z.boolean().optional(),
});

transactionsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateTransactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await Transaction.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $set: parsed.data },
    { new: true }
  )
    .populate("category")
    .populate("account");
  if (!updated) return res.status(404).json({ error: "Not found" });

  res.json(updated);
});

transactionsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const deleted = await Transaction.findOneAndDelete({
    _id: req.params.id,
    userId: currentUserId(req),
  });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  res.status(204).end();
});
