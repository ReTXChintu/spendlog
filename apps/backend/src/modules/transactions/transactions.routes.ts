import { Router } from "express";
import { FilterQuery } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Transaction, TransactionDoc } from "../../models";
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

const byDaySchema = listQuerySchema.extend({
  // Paginates by *day* rather than by transaction, so a day's totals are
  // always computed from every transaction in it. Paginating by transaction
  // would split a day across pages and show a partial total as if it were
  // the whole day.
  days: z.coerce.number().int().min(1).max(120).default(30),
  before: z.coerce.date().optional(),
});

// GET /transactions/by-day — the ledger: transactions grouped by calendar
// day, most recent first, with each day's spend and income.
transactionsRouter.get("/by-day", async (req, res) => {
  const parsed = byDaySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const filter = buildFilter(req, parsed.data);
  if (parsed.data.before) {
    // Continue below the oldest day already shown.
    filter.occurredAt = { ...(filter.occurredAt as object), $lt: parsed.data.before };
  }

  // Which days to return, newest first — asked separately so each returned
  // day is complete.
  const dayRows = await Transaction.aggregate<{ _id: string; earliest: Date }>([
    { $match: filter },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt" } },
        earliest: { $min: "$occurredAt" },
      },
    },
    { $sort: { _id: -1 } },
    { $limit: parsed.data.days + 1 },
  ]);

  // One extra day was requested purely to detect whether more exist.
  const hasMore = dayRows.length > parsed.data.days;
  const page = dayRows.slice(0, parsed.data.days);

  if (page.length === 0) {
    return res.json({ days: [], hasMore: false, nextBefore: null });
  }

  const oldest = page[page.length - 1].earliest;
  const transactions = await Transaction.find({ ...filter, occurredAt: { ...(filter.occurredAt as object), $gte: oldest } })
    .populate("category")
    .populate("account")
    .sort({ occurredAt: -1 });

  const grouped = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    const dayKey = tx.occurredAt.toISOString().slice(0, 10);
    const bucket = grouped.get(dayKey);
    if (bucket) bucket.push(tx);
    else grouped.set(dayKey, [tx]);
  }

  const days = Array.from(grouped.entries()).map(([date, items]) => {
    // countedAmountMinor, not amountMinor: a transfer, a settlement or the
    // unclaimed half of a split moved money that was never spent. It is
    // already zero for those, so no filtering is needed here.
    const spend = items
      .filter((t) => t.type === "DEBIT")
      .reduce((sum, t) => sum + t.countedAmountMinor, 0);
    const income = items
      .filter((t) => t.type === "CREDIT")
      .reduce((sum, t) => sum + t.countedAmountMinor, 0);
    return { date, spendMinor: spend, incomeMinor: income, transactions: items };
  });

  res.json({ days, hasMore, nextBefore: hasMore ? oldest.toISOString() : null });
});

transactionsRouter.get("/:id", validObjectIdParam("id"), async (req, res) => {
  const tx = await Transaction.findOne({ _id: req.params.id, userId: currentUserId(req) })
    .populate("category")
    .populate("account");
  if (!tx) return res.status(404).json({ error: "Not found" });

  res.json(tx);
});

// Mirrors the edit form field for field: the same form adds a transaction
// and corrects one, so it has to accept the same shape — including the
// nulls it sends for fields the user left blank.
const createTransactionSchema = z.object({
  amountMinor: z.number().int().positive(),
  currency: z.string().min(1).max(8).default("INR"),
  type: z.enum(TRANSACTION_TYPES),
  merchant: z.string().max(120).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  occurredAt: z.coerce.date(),
  isTransfer: z.boolean().optional(),
});

// POST /transactions — manual entry (cash spends, or anything the auto
// ingestion missed).
transactionsRouter.post("/", async (req, res) => {
  const parsed = createTransactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Reject an id that isn't one of this user's own accounts, rather than
  // storing a dangling reference.
  if (parsed.data.accountId) {
    const owned = await Account.exists({ _id: parsed.data.accountId, userId: currentUserId(req) });
    if (!owned) return res.status(400).json({ error: "Unknown account" });
  }

  const created = await Transaction.create({
    userId: currentUserId(req),
    amountMinor: parsed.data.amountMinor,
    currency: parsed.data.currency,
    type: parsed.data.type,
    merchant: parsed.data.merchant ?? null,
    note: parsed.data.note ?? null,
    categoryId: parsed.data.categoryId ?? null,
    accountId: parsed.data.accountId ?? null,
    occurredAt: parsed.data.occurredAt,
    isTransfer: parsed.data.isTransfer ?? false,
    source: "MANUAL",
  });

  const tx = await Transaction.findById(created._id).populate("category").populate("account");
  res.status(201).json(tx);
});

// Every field a person might need to correct. Automatic parsing gets a
// lot right but not everything, so a transaction has to be fully editable
// by hand — including the amount and which way the money went.
const updateTransactionSchema = z.object({
  amountMinor: z.number().int().positive().optional(),
  currency: z.string().min(1).max(8).optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  merchant: z.string().max(120).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  categoryId: z.string().nullable().optional(),
  accountId: z.string().nullable().optional(),
  occurredAt: z.coerce.date().optional(),
  isTransfer: z.boolean().optional(),
  pending: z.boolean().optional(),
});

transactionsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateTransactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Reject an id that isn't one of this user's own accounts, rather than
  // storing a dangling reference.
  if (parsed.data.accountId) {
    const owned = await Account.exists({ _id: parsed.data.accountId, userId: currentUserId(req) });
    if (!owned) return res.status(400).json({ error: "Unknown account" });
  }

  const updated = await Transaction.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $set: { ...parsed.data, editedAt: new Date() } },
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
