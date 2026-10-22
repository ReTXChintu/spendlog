import { Router } from "express";
import { FilterQuery, Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Group, Transaction, TransactionDoc, TransactionSourceEntry } from "../../models";
import { ingestRawMessage } from "../../parsing/ingest";
import { checkPeople, shareablePart } from "../contacts/contacts.people";
import { splitsOf } from "../loans/loans.allocation";
import {
  LoanSplitError,
  checkLoanSplits,
  reallocateLoan,
  setLoanSplits,
  splitsForNewAmount,
} from "../loans/loans.splits";
import {
  GroupPaymentError,
  assertGroupMember,
  checkShareWith,
  createPaidByContact,
  groupForOccurredAt,
  groupMemberIds,
  syncGroupSplit,
} from "../groups/groups.service";
import {
  ensureTransferLegs,
  handOverLegs,
  releaseForRepair,
  releaseLegs,
  syncTransferLegs,
} from "./transactions.transfer";
import { ensureCardBillLeg, syncCardBillLeg } from "../cards/cards.billLeg";
import { cardPaymentProblem } from "../cards/cards.billPayment.service";
import { mergeTransactions } from "./transactions.merge";
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
  categoryId: z.string().regex(/^([0-9a-fA-F]{24}|none)$/).optional(),
  accountId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  q: z.string().optional(),
  // "1": only the payments no account could be placed for - the ones that
  // move no balance until somebody says which account they were on.
  accountUnknown: z.enum(["1", "0"]).optional(),
  // "1": only the unexplained differences still waiting for an answer.
  needsExplanation: z.enum(["1", "0"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** Escapes regex metacharacters so a search term can't alter the pattern. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function buildFilter(
  req: Parameters<typeof currentUserId>[0],
  filters: z.infer<typeof listQuerySchema>
): Promise<FilterQuery<TransactionDoc>> {
  const userId = currentUserId(req);
  const filter: FilterQuery<TransactionDoc> = { userId };

  // Real ObjectIds, not the strings from the query: find() would cast them,
  // but the day-grouped ledger runs this through an aggregation, which
  // compares a string to an ObjectId, finds them unequal, and matched
  // nothing at all for any account or category filter.
  //
  // "none" filters for transactions nothing could categorize — the ones
  // that actually need the user's attention.
  if (filters.categoryId === "none") filter.categoryId = null;
  else if (filters.categoryId) filter.categoryId = new Types.ObjectId(filters.categoryId);
  if (filters.accountId) {
    // A bank account's debit cards spend its money, so its transactions
    // include theirs - the same rule its balance follows.
    const cards = await Account.find({ userId, accountType: "DEBIT", linkedAccountId: filters.accountId }).select("_id");
    filter.accountId = { $in: [new Types.ObjectId(filters.accountId), ...cards.map((card) => card._id)] };
  }
  if (filters.type) filter.type = filters.type;
  if (filters.accountUnknown === "1") filter.accountUnknown = true;
  if (filters.needsExplanation === "1") filter.needsExplanation = true;

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

  const filter = await buildFilter(req, parsed.data);
  const [items, total] = await Promise.all([
    Transaction.find(filter)
      .populate("category")
      .populate("account").populate("group").populate("paidByContact", "name")
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

  const filter = await buildFilter(req, parsed.data);
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
    .populate("account").populate("group").populate("paidByContact", "name")
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

// GET /transactions/review — how much of a day still needs a human.
//
// Small on purpose: a background task on the phone calls this every half
// hour to decide whether a reminder is worth showing, so it has to be
// cheap and to answer in one round trip.
transactionsRouter.get("/review", async (req, res) => {
  const day = typeof req.query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.day)
    ? req.query.day
    : istDayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const userId = currentUserId(req);
  const window = { $gte: istDayStart(day), $lte: istDayEnd(day) };

  const [total, uncategorized] = await Promise.all([
    Transaction.countDocuments({ userId, occurredAt: window }),
    Transaction.countDocuments({
      userId,
      occurredAt: window,
      categoryId: null,
      // A transfer between your own accounts has nothing to categorise,
      // and nagging about one would be nagging about nothing.
      isTransfer: false,
      countedAmountMinor: { $gt: 0 },
    }),
  ]);

  res.json({ day, total, uncategorized });
});

transactionsRouter.get("/:id", validObjectIdParam("id"), async (req, res) => {
  const tx = await Transaction.findOne({ _id: req.params.id, userId: currentUserId(req) })
    .populate("category")
    .populate("account").populate("group").populate("paidByContact", "name");
  if (!tx) return res.status(404).json({ error: "Not found" });

  res.json(tx);
});

// Who else a transaction was for or from, and how much each. See
// contacts.people.ts for which transactions can carry this at all.
const personShareBody = z.object({
  contactId: z.string().regex(OBJECT_ID),
  amountMinor: z.number().int().positive(),
});

// Mirrors the edit form field for field: the same form adds a transaction
// and corrects one, so it has to accept the same shape — including the
// nulls it sends for fields the user left blank.
// One loan's part of a repayment.
const loanSplitBody = z.object({
  loanId: z.string().regex(OBJECT_ID),
  amountMinor: z.number().int().positive(),
});

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
  // A one-off; on a credit, money kept out of the savings bucket.
  isSpecial: z.boolean().optional(),
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
  people: z.array(personShareBody).max(20).optional(),
  // On a transfer between own accounts, the other one.
  transferAccountId: z.string().regex(OBJECT_ID).nullable().optional(),
  // Money in that is set aside for a purchase still to come.
  isEarmarked: z.boolean().optional(),
  // The same markings the edit form offers, so adding a transaction keeps
  // them rather than quietly dropping everything but the basics.
  isSalary: z.boolean().optional(),
  cardPaymentFor: z.string().regex(OBJECT_ID).nullable().optional(),
  commitmentId: z.string().regex(OBJECT_ID).nullable().optional(),
  loanId: z.string().regex(OBJECT_ID).nullable().optional(),
  loanSplits: z.array(loanSplitBody).max(20).optional(),
  // The group it goes in, picked in the editor - nothing is put in one by
  // itself any more, bar a Trippin trip's dates. tripId is the old name.
  groupId: z.string().regex(OBJECT_ID).nullable().optional(),
  tripId: z.string().regex(OBJECT_ID).nullable().optional(),
  // null: everyone in the group, equally. A list narrows it.
  groupShareWith: z.array(z.string().regex(OBJECT_ID)).max(100).nullable().optional(),
  tripShareWith: z.array(z.string().regex(OBJECT_ID)).max(100).nullable().optional(),
  // Paid by one of the user's contacts in the group, not by the user: no
  // account moved. The same as POST /groups/:id/payments.
  paidBy: z
    .object({
      contactId: z.string().regex(OBJECT_ID).nullable().optional(),
      userId: z.string().regex(OBJECT_ID).nullable().optional(),
    })
    .nullable()
    .optional(),
});

/**
 * Who paid, as sent: a contact of the user's, or nobody but the user. A
 * SpendLog user records their own payments from their own ledger, so
 * naming anyone else here would count the same money twice.
 */
function paidByContactOf(
  paidBy: { contactId?: string | null; userId?: string | null } | null | undefined,
  userId: Types.ObjectId
): { contactId: string | null } | { error: string } {
  if (!paidBy) return { contactId: null };
  if (paidBy.userId && !userId.equals(paidBy.userId)) {
    return { error: "Someone with SpendLog records what they paid themselves." };
  }
  return { contactId: paidBy.contactId ?? null };
}

// POST /transactions — manual entry (cash spends, or anything the auto
// ingestion missed).
transactionsRouter.post("/", async (req, res) => {
  const parsed = createTransactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);

  // A group picked for it, which has to be one the user is in.
  const groupIdAsked = parsed.data.groupId !== undefined ? parsed.data.groupId : (parsed.data.tripId ?? null);
  const group = groupIdAsked ? await assertGroupMember(groupIdAsked, userId) : null;
  if (groupIdAsked && !group) return res.status(400).json({ error: "Unknown group" });
  const shareAsked = parsed.data.groupShareWith !== undefined ? parsed.data.groupShareWith : parsed.data.tripShareWith;

  // Paid by somebody else: a different kind of row altogether, made the
  // way the group's own "add a payment" makes it.
  const payer = paidByContactOf(parsed.data.paidBy, userId);
  if ("error" in payer) return res.status(400).json({ error: payer.error });
  if (payer.contactId) {
    if (!group) return res.status(400).json({ error: "A payment someone else made goes in a group." });
    if (parsed.data.type !== "DEBIT") return res.status(400).json({ error: "Only a payment can be made by someone else." });
    try {
      const created = await createPaidByContact(userId, group, {
        contactId: payer.contactId,
        amountMinor: parsed.data.amountMinor,
        occurredAt: parsed.data.occurredAt,
        merchant: parsed.data.merchant ?? null,
        note: parsed.data.note ?? null,
        categoryId: parsed.data.categoryId ?? null,
        currency: parsed.data.currency,
        shareWith: shareAsked,
      });
      const tx = await Transaction.findById(created._id)
        .populate("category")
        .populate("account")
        .populate("group")
        .populate("paidByContact", "name");
      return res.status(201).json({ ...tx!.toJSON(), transferLeg: null });
    } catch (error) {
      if (error instanceof GroupPaymentError) return res.status(400).json({ error: error.message });
      throw error;
    }
  }

  let groupShareWith: Types.ObjectId[] | null = null;
  if (group) {
    try {
      groupShareWith = await checkShareWith(group, shareAsked);
    } catch (error) {
      if (error instanceof GroupPaymentError) return res.status(400).json({ error: error.message });
      throw error;
    }
  }

  // Reject an id that isn't one of this user's own accounts, rather than
  // storing a dangling reference.
  if (parsed.data.accountId) {
    const owned = await Account.exists({ _id: parsed.data.accountId, userId });
    if (!owned) return res.status(400).json({ error: "Unknown account" });
  }

  const people = parsed.data.people ?? [];
  const peopleProblem = await checkPeople(
    currentUserId(req),
    {
      amountMinor: parsed.data.amountMinor,
      isSettlement: parsed.data.isSettlement ?? false,
      split: parsed.data.split ?? null,
    },
    people
  );
  if (peopleProblem) return res.status(400).json({ error: peopleProblem });

  const transferProblem = await checkTransferAccount(
    currentUserId(req),
    parsed.data.isTransfer ? parsed.data.transferAccountId : null,
    parsed.data.accountId
  );
  if (transferProblem) return res.status(400).json({ error: transferProblem });
  // A card's bill, paid from that same card: a purchase, never a payment.
  const billProblem = await cardPaymentProblem(currentUserId(req), parsed.data);
  if (billProblem) return res.status(400).json({ error: billProblem });

  // Which loans it repays, checked before anything is written. A bare
  // loanId is the older way of saying one loan, the whole amount.
  let loanSplits: Awaited<ReturnType<typeof checkLoanSplits>> = [];
  if (parsed.data.type === "DEBIT") {
    const asked =
      parsed.data.loanSplits ??
      (parsed.data.loanId ? [{ loanId: parsed.data.loanId, amountMinor: parsed.data.amountMinor }] : []);
    try {
      loanSplits = await checkLoanSplits(currentUserId(req), parsed.data.amountMinor, asked);
    } catch (error) {
      if (error instanceof LoanSplitError) return res.status(400).json({ error: error.message });
      throw error;
    }
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
    // The group picked; with none, only a Trippin trip whose dates it falls
    // in takes it in by itself.
    groupId: group ? group._id : await groupForOccurredAt(userId, parsed.data.occurredAt),
    groupShareWith,
    isTransfer: parsed.data.isTransfer ?? false,
    split: parsed.data.split ?? null,
    isSettlement: parsed.data.isSettlement ?? false,
    people,
    transferAccountId: parsed.data.isTransfer ? (parsed.data.transferAccountId ?? null) : null,
    isEarmarked: parsed.data.type === "CREDIT" ? (parsed.data.isEarmarked ?? false) : false,
    isSpecial: parsed.data.isSpecial ?? false,
    isSalary: parsed.data.type === "CREDIT" ? (parsed.data.isSalary ?? false) : false,
    cardPaymentFor: parsed.data.type === "DEBIT" ? (parsed.data.cardPaymentFor ?? null) : null,
    commitmentId: parsed.data.type === "DEBIT" ? (parsed.data.commitmentId ?? null) : null,
    source: "MANUAL",
  });

  // A loan's instalments move as it is linked, so it goes through the
  // same step an edit uses rather than being written as a plain field.
  if (loanSplits.length > 0) await setLoanSplits(created, loanSplits);

  // Its contacts' shares, when it went into a group that has contacts.
  if (created.groupId) await syncGroupSplit(created, group);

  // The other account's side, found or written in, so a transfer typed in
  // by hand shows on both accounts - and a card bill on the card. Said in
  // the response, so the app can tell the user what else just appeared.
  const transferLeg = (await ensureCardBillLeg(created)) ?? (await ensureTransferLegs(created));

  const tx = await Transaction.findById(created._id).populate("category").populate("account").populate("group").populate("paidByContact", "name");
  res.status(201).json({ ...tx!.toJSON(), transferLeg });
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
  // A one-off; on a credit, money kept out of the savings bucket.
  isSpecial: z.boolean().optional(),
  // Only a person can say which credit is the month's pay: it lands a day
  // either side of the day it is meant to, and a month with leave in it is
  // smaller than the figure in the profile.
  isSalary: z.boolean().optional(),
  // Which card's bill this settled. null clears it.
  cardPaymentFor: z.string().nullable().optional(),
  // The fixed monthly cost this went towards. Paying early is the point
  // of marking the payment rather than ticking a box on a due date.
  commitmentId: z.string().nullable().optional(),
  // Which loan this repays, all of it. null clears it and gives back
  // whatever it was covering. The older way of saying one loan; loanSplits
  // wins when both are sent.
  loanId: z.string().regex(OBJECT_ID).nullable().optional(),
  // Which loans this repays, and how much went to each. An empty list
  // takes it off every loan. Need not add up to the whole payment - what
  // is left over is saved as not yet put down to any loan.
  loanSplits: z.array(loanSplitBody).max(20).optional(),
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
  // null takes it out of whatever group it was in. tripId is the old name,
  // still sent by apps from before groups.
  groupId: z.string().regex(OBJECT_ID).nullable().optional(),
  tripId: z.string().regex(OBJECT_ID).nullable().optional(),
  // null means everyone in the group, equally; a list narrows it.
  groupShareWith: z.array(z.string().regex(OBJECT_ID)).max(100).nullable().optional(),
  tripShareWith: z.array(z.string().regex(OBJECT_ID)).max(100).nullable().optional(),
  pending: z.boolean().optional(),
  // Who it was for or from. An empty list takes everyone off it.
  people: z.array(personShareBody).max(20).optional(),
  // On a transfer between own accounts, the other one. null clears it.
  transferAccountId: z.string().regex(OBJECT_ID).nullable().optional(),
  // Money in that is set aside for a purchase still to come.
  isEarmarked: z.boolean().optional(),
  // false with no account says "this really was cash". Setting an account
  // clears it on its own.
  accountUnknown: z.boolean().optional(),
  // false says an unexplained difference has been looked at. A category
  // or a merchant given to it says the same.
  needsExplanation: z.boolean().optional(),
});

/**
 * The other account of a transfer, checked: the user's own, and not the
 * account the money moved on. Returns an error sentence, or null when fine.
 */
async function checkTransferAccount(
  userId: Types.ObjectId,
  transferAccountId: string | null | undefined,
  accountId: string | null | undefined
): Promise<string | null> {
  if (!transferAccountId) return null;
  if (accountId && transferAccountId === String(accountId)) {
    return "A transfer goes between two different accounts.";
  }
  const owned = await Account.exists({ _id: transferAccountId, userId });
  return owned ? null : "Unknown account";
}

/**
 * The loans an edit leaves a payment repaying, checked, or null when the
 * edit does not touch them.
 *
 * loanSplits says it outright. A bare loanId is the older way, and means
 * the whole payment to that loan - except that naming the loan it already
 * leads with changes nothing, so a client that only knows loanId cannot
 * flatten a combined payment just by saving it. An amount changed on its
 * own carries a single-loan repayment along with it.
 */
async function nextLoanSplits(
  existing: TransactionDoc,
  userId: Types.ObjectId,
  body: { loanId?: string | null; loanSplits?: { loanId: string; amountMinor: number }[]; amountMinor?: number; type?: string }
) {
  const amountMinor = body.amountMinor ?? existing.amountMinor;
  const current = splitsOf(existing).map((split) => split.loanId);
  // Money in repays nothing.
  if ((body.type ?? existing.type) !== "DEBIT") return current.length > 0 ? [] : null;

  if (body.loanSplits !== undefined) {
    // The app sends an empty list with every edit of a payment that is
    // not a repayment; on one that never was, there is nothing to do.
    if (body.loanSplits.length === 0 && current.length === 0) return null;
    return checkLoanSplits(userId, amountMinor, body.loanSplits, current);
  }
  if (body.loanId === null) return current.length > 0 ? [] : null;
  if (body.loanId !== undefined && body.loanId !== current[0]) {
    return checkLoanSplits(userId, amountMinor, [{ loanId: body.loanId, amountMinor }], current);
  }
  return splitsForNewAmount(existing, amountMinor);
}

/** Whether two people lists say the same, in the same order. */
function samePeople(
  a: { contactId: unknown; amountMinor: number }[],
  b: { contactId: unknown; amountMinor: number }[]
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, i) => String(entry.contactId) === String(b[i].contactId) && entry.amountMinor === b[i].amountMinor)
  );
}

transactionsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateTransactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);

  const existing = await Transaction.findOne({ _id: req.params.id, userId });
  if (!existing) return res.status(404).json({ error: "Not found" });

  // The group fields arrive under either name; tripId is what an app from
  // before groups sends. Handled apart from the plain fields below.
  const {
    groupId: groupIdField,
    tripId: tripIdField,
    groupShareWith: shareField,
    tripShareWith: tripShareField,
    ...data
  } = parsed.data;
  const groupAsked = groupIdField !== undefined ? groupIdField : tripIdField;
  const shareAsked = shareField !== undefined ? shareField : tripShareField;

  // A payment somebody else made touched none of the user's accounts and
  // lives in the group it was made in. Its split and who it is owed to are
  // the group's to keep, so a form re-sending them changes nothing.
  if (existing.offLedger) {
    if (data.accountId) {
      return res.status(400).json({ error: "Someone else paid for this, so it isn't on any of your accounts." });
    }
    if (
      data.isTransfer ||
      data.isSettlement ||
      data.isEarmarked ||
      data.cardPaymentFor ||
      data.loanId ||
      (data.loanSplits?.length ?? 0) > 0 ||
      (data.type !== undefined && data.type !== "DEBIT")
    ) {
      return res.status(400).json({ error: "Someone else paid for this - it can only be a payment in its group." });
    }
    if (groupAsked === null) {
      return res.status(400).json({ error: "A payment someone else made stays in its group. Delete it instead." });
    }
    delete data.split;
    delete data.people;
    delete data.accountUnknown;
  }

  // On a row whose split the group keeps, an app that knows nothing of
  // groups re-sends the split it loaded; the same values, or none at all,
  // leave the group in charge. A different split, typed in, takes over.
  let groupSplitTakenOver = false;
  if (existing.groupSplit && !existing.offLedger) {
    const noSplit = data.split === undefined || data.split === null;
    const noPeople = data.people === undefined || data.people.length === 0;
    const asStored =
      data.split?.myShareMinor === existing.split?.myShareMinor &&
      (data.people === undefined || samePeople(data.people, existing.people));
    if ((noSplit && noPeople) || asStored) {
      delete data.split;
      delete data.people;
    } else {
      groupSplitTakenOver = true;
    }
  }

  // Reject an id that isn't one of this user's own accounts, rather than
  // storing a dangling reference.
  if (data.accountId) {
    const owned = await Account.exists({ _id: data.accountId, userId });
    if (!owned) return res.status(400).json({ error: "Unknown account" });
  }

  // People are checked against what the transaction will be once this
  // edit lands, since the same edit often turns the split on and names
  // who it was with. An edit that takes the split away takes the people
  // with it; one that only shrinks the room for them has to say who. The
  // group's own shares are its business, and checked by it.
  const groupKept = (existing.groupSplit && !groupSplitTakenOver) || existing.offLedger;
  const next = {
    amountMinor: data.amountMinor ?? existing.amountMinor,
    isSettlement: data.isSettlement ?? existing.isSettlement,
    split: data.split !== undefined ? data.split : existing.split,
  };
  let people: { contactId: string; amountMinor: number }[] | undefined = data.people;
  if (!groupKept && people === undefined && existing.people.length > 0) {
    if (shareablePart(next) === 0) people = [];
    else {
      const kept = existing.people.map((person) => ({
        contactId: person.contactId.toString(),
        amountMinor: person.amountMinor,
      }));
      const problem = await checkPeople(userId, next, kept);
      if (problem) return res.status(400).json({ error: `${problem} Update who it was for too.` });
    }
  }
  if (people !== undefined) {
    const problem = await checkPeople(userId, next, people);
    if (problem) return res.status(400).json({ error: problem });
  }

  const willBeTransfer = data.isTransfer ?? existing.isTransfer;
  const transferProblem = await checkTransferAccount(
    userId,
    willBeTransfer ? data.transferAccountId : null,
    data.accountId !== undefined ? data.accountId : existing.accountId?.toString()
  );
  if (transferProblem) return res.status(400).json({ error: transferProblem });

  // Put in a group by hand - the editor offers every active one, and the
  // payment can be from any date. Only a group the user is in; taking it
  // out needs no check, and nor does a form re-sending the group it is
  // already in.
  const groupChanged =
    groupAsked !== undefined && (groupAsked ?? null) !== (existing.groupId?.toString() ?? null);
  const groupFields: Record<string, unknown> = {};
  if (groupChanged) {
    if (groupAsked && !(await assertGroupMember(groupAsked, userId))) {
      return res.status(400).json({ error: "Unknown group" });
    }
    groupFields.groupId = groupAsked ? new Types.ObjectId(groupAsked) : null;
    // "Just me" was said about the group it is leaving, and may name
    // people who are not in the next one.
    if (shareAsked === undefined) groupFields.groupShareWith = null;
  }
  if (shareAsked !== undefined) {
    const groupId = groupChanged ? (groupAsked ?? null) : (existing.groupId?.toString() ?? null);
    const group = groupId ? await Group.findById(groupId) : null;
    if (!group || !shareAsked || shareAsked.length === 0) {
      groupFields.groupShareWith = null;
    } else {
      // Whoever it was already shared with stays allowed - someone who has
      // since left the group is still in that row's arithmetic.
      const allowed = new Set([
        ...groupMemberIds(group),
        ...(!groupChanged ? (existing.groupShareWith ?? []).map(String) : []),
      ]);
      if (shareAsked.some((id) => !allowed.has(id))) {
        return res.status(400).json({ error: "Everyone it's shared with has to be in the group." });
      }
      groupFields.groupShareWith = [...new Set(shareAsked)].map((id) => new Types.ObjectId(id));
    }
  }
  if (groupSplitTakenOver) groupFields.groupSplit = false;

  // Marking a payment as the bill of the card it is on, or moving a bill
  // payment onto its card: refused, since a card cannot pay its own bill.
  // Only when this edit says so - a form sends every field, and a row left
  // that way by old data is mended by the backfill, not held against an
  // unrelated edit.
  const differs = (sent: string | null | undefined, stored: unknown) =>
    sent !== undefined && (sent ?? null) !== (stored ? String(stored) : null);
  if (
    differs(data.cardPaymentFor, existing.cardPaymentFor) ||
    differs(data.accountId, existing.accountId) ||
    differs(data.type, existing.type)
  ) {
    const billProblem = await cardPaymentProblem(userId, {
      type: data.type ?? existing.type,
      accountId: data.accountId !== undefined ? data.accountId : existing.accountId,
      cardPaymentFor: data.cardPaymentFor !== undefined ? data.cardPaymentFor : existing.cardPaymentFor,
    });
    if (billProblem) return res.status(400).json({ error: billProblem });
  }
  // No longer a transfer: there is no other account to speak of.
  const transferFields: Record<string, unknown> = willBeTransfer ? {} : { transferAccountId: null };
  // Only money in can be set aside; on a payment it would zero real spending.
  if ((data.type ?? existing.type) === "DEBIT") transferFields.isEarmarked = false;
  // An account named is an account known.
  if (data.accountId) transferFields.accountUnknown = false;
  // A leg SpendLog wrote in for a transfer is the user's own row once they
  // have touched it: kept in step with the transfer no longer, and never
  // deleted along with it.
  if (existing.autoLeg) transferFields.autoLeg = false;
  // An unexplained difference is explained once it is filed somewhere or
  // called something.
  if (
    existing.needsExplanation &&
    (data.categoryId || (data.merchant && data.merchant !== existing.merchant))
  ) {
    transferFields.needsExplanation = false;
  }

  // Which loans a payment repays is not a plain field the way cardPaymentFor
  // is: every loan it touches, before and after, has its instalments
  // worked out again. Handled as its own step, rather than folded into the
  // $set below, because of that side effect.
  let loanSplits: Awaited<ReturnType<typeof nextLoanSplits>>;
  try {
    loanSplits = await nextLoanSplits(existing, userId, data);
  } catch (error) {
    if (error instanceof LoanSplitError) return res.status(400).json({ error: error.message });
    throw error;
  }
  if (loanSplits) await setLoanSplits(existing, loanSplits);
  const { loanId: _handledAbove, loanSplits: _alsoAbove, people: _checkedAbove, ...fields } = data;

  // Whether this edit changes what kind of transaction it is, as opposed
  // to filing it. Compared against the row rather than read off the body,
  // because a form sends every field whether it was touched or not - and
  // only a real change should stop the card bill recogniser from deciding.
  const kindChanged =
    (data.type !== undefined && data.type !== existing.type) ||
    (data.isTransfer !== undefined && data.isTransfer !== existing.isTransfer) ||
    (data.isSettlement !== undefined && data.isSettlement !== existing.isSettlement) ||
    (data.cardPaymentFor !== undefined &&
      (data.cardPaymentFor ?? null) !== (existing.cardPaymentFor?.toString() ?? null));

  let updated = await Transaction.findOneAndUpdate(
    { _id: req.params.id, userId },
    {
      $set: {
        ...fields,
        ...transferFields,
        ...groupFields,
        ...(people !== undefined ? { people } : {}),
        editedAt: new Date(),
        ...(kindChanged ? { kindEditedAt: new Date() } : {}),
      },
    },
    { new: true }
  )
    .populate("category")
    .populate("account").populate("group").populate("paidByContact", "name");
  if (!updated) return res.status(404).json({ error: "Not found" });

  // The other leg of the transfer, moved, taken away or given, to match
  // what this edit said - and in the response, so the app can say what
  // else changed. A card bill's card side is kept the same way, by its
  // own rules (cards.billLeg).
  const cardSide = await syncCardBillLeg(updated, existing);
  const transferLeg = cardSide.handled ? cardSide.leg : await syncTransferLegs(updated, existing);

  // The group's contact shares, worked out again for what the row is now:
  // a new amount, a new group, a narrower list, or out of any group.
  if (updated.groupId || existing.groupSplit) {
    const row = await Transaction.findById(updated._id);
    if (row && (await syncGroupSplit(row))) {
      updated = (await Transaction.findById(updated._id)
        .populate("category")
        .populate("account")
        .populate("group")
        .populate("paidByContact", "name"))!;
    }
  }

  res.json({ ...updated.toJSON(), transferLeg });
});

transactionsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const deleted = await Transaction.findOneAndDelete({ _id: req.params.id, userId });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  // The other leg of a transfer: gone with it if SpendLog wrote it in,
  // otherwise unpaired. See releaseLegs.
  await releaseLegs(deleted);

  // A repayment gone is money no longer paid towards its loans.
  for (const split of splitsOf(deleted)) await reallocateLoan(split.loanId);

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
export async function syncRefundTotal(purchaseId: unknown, userId: unknown): Promise<void> {
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
// giving money back from: every payment in the 30 days either side of it,
// and further back (up to six months) only the likely ones - the same
// amount, or the same merchant - so an old order's refund can still be
// found without the list turning into half a year of payments.
//
// Either side, because money does not always come back after it went
// out: someone sends their share first and the thing is bought with it
// afterwards, and that credit still only offsets the purchase.
transactionsRouter.get("/:id/refund-candidates", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const refund = await Transaction.findOne({ _id: req.params.id, userId });
  if (!refund) return res.status(404).json({ error: "Not found" });

  const day = 24 * 60 * 60 * 1000;
  const monthBefore = new Date(refund.occurredAt.getTime() - 30 * day);
  // Money set aside for something can wait a while before it is spent.
  const monthAfter = new Date(refund.occurredAt.getTime() + (refund.isEarmarked ? 120 : 30) * day);
  const sixMonthsBefore = new Date(refund.occurredAt.getTime() - 183 * day);

  const likely: Record<string, unknown>[] = [{ amountMinor: refund.amountMinor }];
  if (refund.merchant) likely.push({ merchant: refund.merchant });

  const candidates = await Transaction.find({
    userId,
    type: "DEBIT",
    // Deliberately no lower bound on the amount: one credit settling three
    // cancelled orders is larger than any of them, which is the whole
    // point.
    $or: [
      { occurredAt: { $lte: monthAfter, $gte: monthBefore } },
      { occurredAt: { $lt: monthBefore, $gte: sixMonthsBefore }, $or: likely },
    ],
  })
    .sort({ occurredAt: -1 })
    .limit(400)
    .populate("category")
    .populate("account").populate("group").populate("paidByContact", "name");

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

const pairSchema = z.object({
  /** The other leg: the same money arriving where this one says it left. */
  withId: z.string().regex(OBJECT_ID),
});

// POST /transactions/:id/pair — say that two rows are the two legs of one
// transfer between the user's own accounts.
//
// Automatic pairing has a ten-minute window, and a transfer typed in by
// hand on one account moves the other account by itself. When the other
// account's own message then arrives as a row, that balance moves twice -
// which is what the reconciler finds as a one-sided transfer, and this is
// its fix. Both rows become a transfer, each naming the other's account,
// and each knowing the other side has its own row.
transactionsRouter.post("/:id/pair", validObjectIdParam("id"), async (req, res) => {
  const parsed = pairSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.withId === req.params.id) {
    return res.status(400).json({ error: "A transaction cannot be paired with itself" });
  }

  const userId = currentUserId(req);
  const [first, second] = await Promise.all([
    Transaction.findOne({ _id: req.params.id, userId }),
    Transaction.findOne({ _id: parsed.data.withId, userId }),
  ]);
  if (!first || !second) return res.status(404).json({ error: "Not found" });

  if (first.type === second.type) {
    return res.status(400).json({ error: "The two legs of a transfer go opposite ways" });
  }
  if (first.amountMinor !== second.amountMinor) {
    return res.status(400).json({ error: "The two legs of a transfer are the same amount" });
  }
  if (first.accountId && second.accountId && first.accountId.equals(second.accountId)) {
    return res.status(400).json({ error: "A transfer goes between two different accounts" });
  }

  // Whatever either was paired with until now: a leg written in for it
  // goes, a real row is let go to find a leg of its own below.
  const leftovers = [await releaseForRepair(first, second), await releaseForRepair(second, first)];

  const now = new Date();
  for (const [leg, other] of [
    [first, second],
    [second, first],
  ] as const) {
    leg.isTransfer = true;
    leg.transferAccountId = other.accountId ?? null;
    leg.transferPairId = other._id;
    leg.kindEditedAt = now;
    leg.editedAt = now;
    // Paired by a person: theirs now, written in or not.
    leg.autoLeg = false;
  }
  // Saved rather than updated so the counted-amount hook zeroes both.
  await Promise.all([first.save(), second.save()]);
  for (const leftover of leftovers) {
    if (leftover) await ensureTransferLegs(leftover);
  }
  await first.populate(["category", "account"]);

  res.json(first);
});

const mergeSchema = z.object({
  /** The transactions to absorb. They stop existing on their own. */
  sourceIds: z.array(z.string().regex(OBJECT_ID)).min(1).max(10),
});

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
  // A payment somebody else made is never the same money as one of the
  // user's own: merging would put it on an account it never touched.
  if (target.offLedger || sources.some((source) => source.offLedger)) {
    return res.status(400).json({ error: "A payment someone else made can't be merged with one of yours." });
  }

  await mergeTransactions(target, sources);
  // A repayment merged away no longer pays anything; one restored by an
  // unmerge pays again (see below).
  for (const source of sources) {
    for (const split of splitsOf(source)) await reallocateLoan(split.loanId);
  }
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
  for (const row of restored as TransactionDoc[]) {
    for (const split of splitsOf(row)) await reallocateLoan(split.loanId);
  }
  await target.populate(["category", "account"]);

  res.json({ transaction: target, restoredCount: restored.length });
});

function sourceKey(entry: TransactionSourceEntry): string {
  return entry.sourceRef ?? `${entry.source}:${new Date(entry.receivedAt).getTime()}`;
}
