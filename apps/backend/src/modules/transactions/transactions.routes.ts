import { Router } from "express";
import { FilterQuery, Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Transaction, TransactionDoc, TransactionSourceEntry } from "../../models";
import { ingestRawMessage } from "../../parsing/ingest";
import { IST_OFFSET, istDayEnd, istDayKey, istDayStart } from "../../time";
import { TRANSACTION_TYPES } from "../../types";

export const transactionsRouter = Router();
transactionsRouter.use(requireAuth);

const IST_DAY = /^\d{4}-\d{2}-\d{2}$/;

const listQuerySchema = z.object({
  // Bare calendar days, read as IST: "to=2026-09-11" means up to the end
  // of the 11th as lived in India, not as UTC would have it.
  from: z.string().regex(IST_DAY).optional(),
  to: z.string().regex(IST_DAY).optional(),
  categoryId: z.string().optional(),
  accountId: z.string().optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

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
      ...(filters.from ? { $gte: istDayStart(filters.from) } : {}),
      // A bare date means the whole of that day, not midnight at its start.
      ...(filters.to ? { $lte: istDayEnd(filters.to) } : {}),
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
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt", timezone: IST_OFFSET } },
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
    const dayKey = istDayKey(tx.occurredAt);
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
  // Zero is meaningful: someone else's bill paid from the user's card, all
  // of which is owed back. null clears the split entirely.
  split: z
    .object({
      myShareMinor: z.number().int().nonnegative(),
      groupLabel: z.string().max(60).nullable().optional(),
    })
    .nullable()
    .optional(),
  isSettlement: z.boolean().optional(),
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
    split: parsed.data.split ?? null,
    isSettlement: parsed.data.isSettlement ?? false,
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
  // Zero is meaningful: someone else's bill paid from the user's card, all
  // of which is owed back. null clears the split entirely.
  split: z
    .object({
      myShareMinor: z.number().int().nonnegative(),
      groupLabel: z.string().max(60).nullable().optional(),
    })
    .nullable()
    .optional(),
  isSettlement: z.boolean().optional(),
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
  const userId = currentUserId(req);
  const deleted = await Transaction.findOneAndDelete({ _id: req.params.id, userId });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  // Deleting a refund puts the purchases it covered back to costing what
  // they did; deleting a purchase releases the refunds pointing at it
  // rather than leaving them aimed at nothing.
  for (const allocation of deleted.refundOf) {
    await syncRefundTotal(allocation.transactionId, userId);
  }
  await Transaction.updateMany(
    { userId, "refundOf.transactionId": deleted._id },
    { $pull: { refundOf: { transactionId: deleted._id } } }
  );

  res.status(204).end();
});

/**
 * Recomputes what has come back against a purchase, and saves it so the
 * counted-amount hook runs: the purchase then costs what was paid less
 * what was refunded.
 */
async function syncRefundTotal(purchaseId: unknown, userId: unknown): Promise<void> {
  const purchase = await Transaction.findOne({ _id: purchaseId, userId });
  if (!purchase) return;

  const credits = await Transaction.find({ userId, "refundOf.transactionId": purchase._id });
  purchase.refundedMinor = credits.reduce(
    (sum, credit) =>
      sum +
      credit.refundOf
        .filter((allocation) => allocation.transactionId.equals(purchase._id))
        .reduce((inner, allocation) => inner + allocation.amountMinor, 0),
    0
  );
  await purchase.save();
}

const refundOfSchema = z.object({
  /**
   * How much of this credit belongs to which purchases. An empty list
   * unlinks it entirely — it goes back to being ordinary income.
   */
  allocations: z
    .array(
      z.object({
        transactionId: z.string().regex(OBJECT_ID),
        amountMinor: z.number().int().positive(),
      })
    )
    .max(20),
});

// POST /transactions/:id/refund-of — says which purchases this credit
// gives money back from, and how much of it belongs to each.
//
// One credit routinely settles several cancelled orders at once, and it is
// not always wholly a refund, so the allocated part stops counting as
// income while any remainder still does.
transactionsRouter.post("/:id/refund-of", validObjectIdParam("id"), async (req, res) => {
  const parsed = refundOfSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const refund = await Transaction.findOne({ _id: req.params.id, userId });
  if (!refund) return res.status(404).json({ error: "Not found" });

  const { allocations } = parsed.data;

  if (allocations.length > 0) {
    if (refund.type !== "CREDIT") {
      return res.status(400).json({ error: "Only money coming in can be a refund" });
    }
    if (allocations.some((a) => a.transactionId === req.params.id)) {
      return res.status(400).json({ error: "A transaction cannot be a refund of itself" });
    }

    const ids = allocations.map((a) => a.transactionId);
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ error: "Each purchase can only appear once" });
    }

    // More cannot come back than went out.
    const total = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    if (total > refund.amountMinor) {
      return res.status(400).json({ error: "That allocates more than the credit is worth" });
    }

    const purchases = await Transaction.find({ _id: { $in: ids }, userId, type: "DEBIT" });
    if (purchases.length !== ids.length) {
      return res.status(400).json({ error: "A refund has to come from your own payments" });
    }
  }

  // Purchases this credit used to cover, so any it no longer covers get
  // their cost back.
  const previous = refund.refundOf.map((allocation) => allocation.transactionId);

  refund.refundOf = allocations.map((allocation) => ({
    transactionId: new Types.ObjectId(allocation.transactionId),
    amountMinor: allocation.amountMinor,
  }));
  await refund.save();

  const touched = new Set([...previous, ...refund.refundOf.map((a) => a.transactionId)].map(String));
  for (const purchaseId of touched) {
    await syncRefundTotal(new Types.ObjectId(purchaseId), userId);
  }

  await refund.populate(["category", "account"]);
  res.json(refund);
});

// GET /transactions/:id/refund-candidates — payments this credit could be
// giving money back from: same account where known, no more than six
// months earlier, and at least as large as the credit.
transactionsRouter.get("/:id/refund-candidates", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const refund = await Transaction.findOne({ _id: req.params.id, userId });
  if (!refund) return res.status(404).json({ error: "Not found" });

  const sixMonths = 183 * 24 * 60 * 60 * 1000;
  const candidates = await Transaction.find({
    userId,
    type: "DEBIT",
    // Deliberately no lower bound on the amount: one credit settling three
    // cancelled orders is larger than any of them, which is the whole
    // point. A refund still cannot predate the purchase it came from.
    occurredAt: { $lte: refund.occurredAt, $gte: new Date(refund.occurredAt.getTime() - sixMonths) },
  })
    .sort({ occurredAt: -1 })
    .limit(40)
    .populate("category")
    .populate("account");

  // An exact-amount match on the same card is almost always the one.
  const ranked = [...candidates].sort((a, b) => score(b) - score(a));
  function score(transaction: (typeof candidates)[number]): number {
    let points = 0;
    if (transaction.amountMinor === refund!.amountMinor) points += 2;
    if (refund!.accountId && String(transaction.accountId) === String(refund!.accountId)) points += 1;
    if (refund!.merchant && transaction.merchant === refund!.merchant) points += 2;
    return points;
  }

  res.json(ranked);
});

const mergeSchema = z.object({
  /** The transactions to absorb. They stop existing on their own. */
  sourceIds: z.array(z.string().regex(OBJECT_ID)).min(1).max(10),
});

/** Whether two source entries describe the same message. */
function isSameMessage(a: TransactionSourceEntry, b: TransactionSourceEntry): boolean {
  if (a.sourceRef && b.sourceRef) return a.sourceRef === b.sourceRef;
  return a.source === b.source && new Date(a.receivedAt).getTime() === new Date(b.receivedAt).getTime();
}

// POST /transactions/:id/merge — for the same payment recorded twice when
// automatic dedup didn't spot it: the bank's email quoted a different
// amount because it included a fee, or arrived outside the time window.
transactionsRouter.post("/:id/merge", validObjectIdParam("id"), async (req, res) => {
  const parsed = mergeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.sourceIds.includes(req.params.id)) {
    return res.status(400).json({ error: "A transaction cannot be merged into itself" });
  }

  const userId = currentUserId(req);
  const target = await Transaction.findOne({ _id: req.params.id, userId });
  if (!target) return res.status(404).json({ error: "Not found" });

  const sources = await Transaction.find({ _id: { $in: parsed.data.sourceIds }, userId });
  if (sources.length !== parsed.data.sourceIds.length) {
    return res.status(404).json({ error: "Not found" });
  }

  for (const source of sources) {
    for (const entry of source.sources) {
      if (!target.sources.some((existing) => isSameMessage(existing, entry))) {
        target.sources.push(entry);
      }
    }

    // Gaps only. Whatever the surviving row already says is the answer,
    // and it can be corrected by hand afterwards either way.
    if (!target.merchant && source.merchant) target.merchant = source.merchant;
    if (!target.accountId && source.accountId) target.accountId = source.accountId;
    if (!target.categoryId && source.categoryId) target.categoryId = source.categoryId;
    if (!target.note && source.note) target.note = source.note;

    // Verbatim, so unmerging restores the row rather than approximating it.
    target.mergedFrom.push(source.toObject() as unknown as Record<string, unknown>);
    await source.deleteOne();
  }

  await target.save();
  await target.populate(["category", "account"]);

  res.json(target);
});

// POST /transactions/:id/unmerge — splits a row back into the separate
// transactions it was made from.
//
// Two kinds of merge end up here. A manual one left a verbatim snapshot,
// which is restored as it was. Automatic dedup never stored the second
// message as a row at all, so those are rebuilt from the message text —
// which is the case that matters, since dedup pairing two genuinely
// different payments of the same amount is exactly why this exists.
transactionsRouter.post("/:id/unmerge", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const target = await Transaction.findOne({ _id: req.params.id, userId });
  if (!target) return res.status(404).json({ error: "Not found" });

  if (target.sources.length < 2 && target.mergedFrom.length === 0) {
    return res.status(400).json({ error: "This transaction was only ever reported once" });
  }

  const snapshots = target.mergedFrom as Record<string, unknown>[];
  const restored: unknown[] = [];

  // Anything a snapshot accounted for leaves with it.
  const claimed = new Set<string>();
  for (const snapshot of snapshots) {
    const entries = (snapshot.sources as TransactionSourceEntry[] | undefined) ?? [];
    for (const entry of entries) claimed.add(sourceKey(entry));

    const { _id, ...rest } = snapshot;
    const recreated = await Transaction.create({ ...rest, _id, userId });
    restored.push(recreated);
  }

  // The first entry is what the surviving row keeps; every other one that
  // no snapshot claimed becomes a transaction of its own.
  const [primary, ...others] = target.sources;
  for (const entry of others) {
    if (claimed.has(sourceKey(entry))) continue;
    if (!entry.rawText) continue;

    const result = await ingestRawMessage({
      userId,
      rawText: entry.rawText,
      source: entry.source,
      // Deliberately dropped: reusing it would let dedup find the row this
      // message was just split out of and merge it straight back in.
      sourceRef: null,
      receivedAt: new Date(entry.receivedAt),
    });
    if (result.transaction) restored.push(result.transaction);
  }

  target.sources = primary ? [primary] : [];
  target.mergedFrom = [];
  await target.save();
  await target.populate(["category", "account"]);

  res.json({ transaction: target, restoredCount: restored.length });
});

function sourceKey(entry: TransactionSourceEntry): string {
  return entry.sourceRef ?? `${entry.source}:${new Date(entry.receivedAt).getTime()}`;
}
