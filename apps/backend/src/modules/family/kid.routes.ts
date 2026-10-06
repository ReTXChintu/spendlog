import { Request, Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { requireKid, signSessionToken } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Category, MerchantPreset, Transaction, User } from "../../models";
import { IST_OFFSET, istDayEnd, istDayKey, istDayStart } from "../../time";
import { TRANSACTION_TYPES } from "../../types";
import { pocketStatuses } from "../accounts/accounts.pocket";
import { monthLabel, userMonths } from "../budget/budget.months";
import { MIN_PASSWORD_LENGTH, checkPassword, hashPassword } from "./family.password";
import { pingOwnerForSms } from "./family.push";

export const kidRouter = Router();

/**
 * Everything a kid can do, and nothing else.
 *
 * A kid's token is refused by every other route in the app (see
 * requireAuth), so this file is the whole of what a kid can reach. Every
 * query here is pinned to the parent's data AND to the kid's own
 * pocket-money accounts - never to anything the request says about whose
 * data it is.
 */

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const IST_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Wrong passwords in a row before sign-in is paused, and for how long. */
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(100),
});

// POST /kid/login — email and password, from the phone app only. The web
// app has no kid screens yet, so a kid's login is refused there rather
// than landing somewhere that shows nothing.
kidRouter.post("/login", async (req, res) => {
  if (req.get("x-spendlog-client") !== "mobile") {
    return res.status(403).json({ error: "Kids sign in on the SpendLog phone app." });
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your email and password." });

  const kid = await User.findOne({ email: parsed.data.email, role: "KID" });
  const now = new Date();
  if (kid?.loginLockedUntil && kid.loginLockedUntil > now) {
    return res.status(429).json({ error: "Too many wrong passwords. Try again in a few minutes." });
  }

  if (!kid || !checkPassword(parsed.data.password, kid.passwordHash, kid.passwordSalt)) {
    if (kid) {
      const failed = (kid.failedLogins ?? 0) + 1;
      kid.failedLogins = failed >= MAX_FAILED_LOGINS ? 0 : failed;
      kid.loginLockedUntil = failed >= MAX_FAILED_LOGINS ? new Date(now.getTime() + LOCKOUT_MS) : null;
      await kid.save();
    }
    // The same answer whether or not the email exists, so this cannot be
    // used to find out which emails are kids' logins.
    return res.status(401).json({ error: "That email and password don't match." });
  }

  kid.failedLogins = 0;
  kid.loginLockedUntil = null;
  await kid.save();

  res.json({
    token: signSessionToken({ id: kid._id.toString(), email: kid.email, role: "KID", v: kid.tokenVersion ?? 0 }),
    kid: { id: kid._id.toString(), name: kid.name ?? "", email: kid.email },
  });
});

kidRouter.use(requireKid);

/**
 * The kid's accounts that are still pocket money. An account the parent
 * has since stopped being pocket money drops out of view even if it is
 * still on the kid's list.
 */
async function kidAccounts(req: Request) {
  const kid = req.kid!;
  return Account.find({ _id: { $in: kid.accountIds }, userId: kid.parentId, pocketMoney: { $ne: null } });
}

/** One of the kid's accounts by id, or all of them; null for anything else. */
async function accountScope(req: Request, accountId: string | undefined) {
  const accounts = await kidAccounts(req);
  if (!accountId) return accounts.map((account) => account._id);
  const match = accounts.find((account) => account._id.toString() === accountId);
  return match ? [match._id] : null;
}

// GET /kid/me — who is signed in, and their accounts with this month's
// limit, spent and left.
kidRouter.get("/me", async (req, res) => {
  const kid = req.kid!;
  const [accounts, parent] = await Promise.all([
    kidAccounts(req),
    User.findById(kid.parentId).select("name email"),
  ]);
  const statuses = await pocketStatuses(kid.parentId, accounts);
  res.json({
    id: kid.kidId.toString(),
    name: kid.name,
    parentName: parent?.name ?? parent?.email ?? "",
    accounts: accounts.map((account) => ({
      id: account._id.toString(),
      name: account.nickname || account.bankName,
      last4: account.last4 ?? null,
      pocket: statuses.get(account._id.toString()) ?? null,
    })),
  });
});

// GET /kid/months — the parent's months, salary day to salary day, which
// is how the pocket-money ledger is paged.
kidRouter.get("/months", async (req, res) => {
  const months = await userMonths(req.kid!.parentId, new Date(), 24);
  res.json({
    current: months.recent[0].key,
    months: months.recent.map((month) => ({
      month: month.key,
      from: month.from,
      to: month.to,
      label: monthLabel(month, months.bySalary),
    })),
  });
});

// GET /kid/categories — the parent's categories, to choose from. Kids
// cannot add or change them.
kidRouter.get("/categories", async (req, res) => {
  const categories = await Category.find({
    $or: [{ userId: null }, { userId: req.kid!.parentId }],
  }).sort({ isSystem: -1, name: 1 });
  res.json(categories);
});

const listSchema = z.object({
  accountId: z.string().regex(OBJECT_ID).optional(),
  from: z.string().regex(IST_DAY).optional(),
  to: z.string().regex(IST_DAY).optional(),
  days: z.coerce.number().int().min(1).max(60).default(7),
  before: z.coerce.date().optional(),
  q: z.string().max(80).optional(),
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /kid/transactions — the kid's pocket-money transactions grouped by
// day, newest first, a page of days at a time - the same shape as the
// owner's ledger.
kidRouter.get("/transactions", async (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Bad filter" });

  const scope = await accountScope(req, parsed.data.accountId);
  if (!scope) return res.status(404).json({ error: "Not found" });
  if (scope.length === 0) return res.json({ days: [], hasMore: false, nextBefore: null });

  const filter: Record<string, unknown> = { userId: req.kid!.parentId, accountId: { $in: scope } };
  const range: Record<string, Date> = {};
  if (parsed.data.from) range.$gte = istDayStart(parsed.data.from);
  if (parsed.data.to) range.$lte = istDayEnd(parsed.data.to);
  if (parsed.data.before) range.$lt = parsed.data.before;
  if (Object.keys(range).length) filter.occurredAt = range;
  if (parsed.data.q) {
    const term = { $regex: escapeRegex(parsed.data.q), $options: "i" };
    filter.$or = [{ merchant: term }, { note: term }];
  }

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
  const hasMore = dayRows.length > parsed.data.days;
  const page = dayRows.slice(0, parsed.data.days);
  if (page.length === 0) return res.json({ days: [], hasMore: false, nextBefore: null });

  const oldest = page[page.length - 1].earliest;
  const transactions = await Transaction.find({
    ...filter,
    occurredAt: { ...(filter.occurredAt as object), $gte: oldest },
  })
    .populate("category")
    .populate("account")
    .sort({ occurredAt: -1 });

  const grouped = new Map<string, typeof transactions>();
  for (const transaction of transactions) {
    const key = istDayKey(transaction.occurredAt);
    grouped.set(key, [...(grouped.get(key) ?? []), transaction]);
  }

  res.json({
    days: [...grouped.entries()].map(([date, items]) => ({
      date,
      // The whole amount: it is the kid's own money going out, and a split
      // or a refund on the parent's books is not something they track.
      spendMinor: items.filter((t) => t.type === "DEBIT").reduce((sum, t) => sum + t.amountMinor, 0),
      incomeMinor: items.filter((t) => t.type === "CREDIT").reduce((sum, t) => sum + t.amountMinor, 0),
      transactions: items,
    })),
    hasMore,
    nextBefore: hasMore ? oldest.toISOString() : null,
  });
});

const writeSchema = z.object({
  accountId: z.string().regex(OBJECT_ID),
  type: z.enum(TRANSACTION_TYPES).default("DEBIT"),
  amountMinor: z.number().int().positive().max(1_000_000_00),
  merchant: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  categoryId: z.string().regex(OBJECT_ID).nullable().optional(),
  occurredAt: z.coerce.date(),
});

/** A category the kid may use: built in, or one of the parent's. */
async function categoryAllowed(req: Request, categoryId: string | null | undefined) {
  if (!categoryId) return true;
  return Boolean(
    await Category.exists({ _id: categoryId, $or: [{ userId: null }, { userId: req.kid!.parentId }] })
  );
}

// POST /kid/transactions — something the kid spent (or got) that no
// message will ever report, added by hand to one of their accounts.
kidRouter.post("/transactions", async (req, res) => {
  const parsed = writeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter an amount and a date." });

  const kid = req.kid!;
  const scope = await accountScope(req, parsed.data.accountId);
  if (!scope || scope.length !== 1) return res.status(400).json({ error: "That isn't one of your accounts." });
  if (!(await categoryAllowed(req, parsed.data.categoryId))) {
    return res.status(400).json({ error: "Unknown category" });
  }

  const created = await Transaction.create({
    userId: kid.parentId,
    accountId: scope[0],
    type: parsed.data.type,
    amountMinor: parsed.data.amountMinor,
    merchant: parsed.data.merchant || null,
    note: parsed.data.note || null,
    categoryId: parsed.data.categoryId ?? null,
    occurredAt: parsed.data.occurredAt,
    source: "MANUAL",
    byKidId: kid.kidId,
    byKidName: kid.name,
  });
  const saved = await Transaction.findById(created._id).populate("category").populate("account");
  res.status(201).json(saved);
});

// PATCH /kid/transactions/:id — what it was, its category, note, amount
// and date. Not its account (beyond the kid's own), and nothing about how
// the parent counts it; a kid cannot delete.
kidRouter.patch("/transactions/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = writeSchema.partial().omit({ type: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "That change isn't valid." });

  const kid = req.kid!;
  const all = await accountScope(req, undefined);
  const transaction = await Transaction.findOne({
    _id: req.params.id,
    userId: kid.parentId,
    accountId: { $in: all ?? [] },
  });
  if (!transaction) return res.status(404).json({ error: "Not found" });

  if (parsed.data.accountId !== undefined) {
    const scope = await accountScope(req, parsed.data.accountId);
    if (!scope || scope.length !== 1) return res.status(400).json({ error: "That isn't one of your accounts." });
    transaction.accountId = scope[0];
  }
  if (!(await categoryAllowed(req, parsed.data.categoryId))) {
    return res.status(400).json({ error: "Unknown category" });
  }
  if (parsed.data.categoryId !== undefined) transaction.categoryId = parsed.data.categoryId ? new Types.ObjectId(parsed.data.categoryId) : null;
  if (parsed.data.merchant !== undefined) transaction.merchant = parsed.data.merchant || null;
  if (parsed.data.note !== undefined) transaction.note = parsed.data.note || null;
  if (parsed.data.amountMinor !== undefined) transaction.amountMinor = parsed.data.amountMinor;
  if (parsed.data.occurredAt !== undefined) transaction.occurredAt = parsed.data.occurredAt;
  transaction.byKidId = kid.kidId;
  transaction.byKidName = kid.name;
  transaction.editedAt = new Date();
  await transaction.save();

  await transaction.populate(["category", "account"]);
  res.json(transaction);
});

const analyticsSchema = z.object({
  accountId: z.string().regex(OBJECT_ID).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

// GET /kid/analytics — one month of the kid's own money: totals, by
// category, by merchant and day by day.
kidRouter.get("/analytics", async (req, res) => {
  const parsed = analyticsSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "Bad filter" });

  const scope = await accountScope(req, parsed.data.accountId);
  if (!scope) return res.status(404).json({ error: "Not found" });

  const { recent, bySalary } = await userMonths(req.kid!.parentId, new Date(), 24);
  const month = (parsed.data.month && recent.find((candidate) => candidate.key === parsed.data.month)) || recent[0];
  const match = {
    userId: req.kid!.parentId,
    accountId: { $in: scope },
    occurredAt: { $gte: month.start, $lt: month.end },
  };

  const [totals, byCategory, byMerchant, byDay] = await Promise.all([
    Transaction.aggregate<{ _id: string; amountMinor: number; count: number }>([
      { $match: match },
      { $group: { _id: "$type", amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate<{ _id: Types.ObjectId | null; amountMinor: number; name: string }>([
      { $match: { ...match, type: "DEBIT" } },
      { $group: { _id: "$categoryId", amountMinor: { $sum: "$amountMinor" } } },
      { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
      { $addFields: { name: { $ifNull: [{ $first: "$category.name" }, "Uncategorized"] } } },
      { $project: { amountMinor: 1, name: 1 } },
      { $sort: { amountMinor: -1 } },
    ]),
    Transaction.aggregate<{ name: string; amountMinor: number; count: number }>([
      { $match: { ...match, type: "DEBIT", merchant: { $nin: [null, ""] } } },
      {
        $group: {
          _id: { $toLower: "$merchant" },
          name: { $first: "$merchant" },
          amountMinor: { $sum: "$amountMinor" },
          count: { $sum: 1 },
        },
      },
      { $sort: { amountMinor: -1 } },
      { $limit: 10 },
    ]),
    Transaction.aggregate<{ _id: string; amountMinor: number }>([
      { $match: { ...match, type: "DEBIT" } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt", timezone: IST_OFFSET } },
          amountMinor: { $sum: "$amountMinor" },
        },
      },
    ]),
  ]);

  const spent = new Map(byDay.map((row) => [row._id, row.amountMinor]));
  const days: { day: string; spendMinor: number }[] = [];
  for (let at = month.start.getTime(); at < month.end.getTime(); at += 24 * 60 * 60 * 1000) {
    const day = istDayKey(new Date(at));
    days.push({ day, spendMinor: spent.get(day) ?? 0 });
  }

  res.json({
    month: month.key,
    from: month.from,
    to: month.to,
    label: monthLabel(month, bySalary),
    totalSpendMinor: totals.find((row) => row._id === "DEBIT")?.amountMinor ?? 0,
    totalInMinor: totals.find((row) => row._id === "CREDIT")?.amountMinor ?? 0,
    transactionCount: totals.reduce((sum, row) => sum + row.count, 0),
    byCategory: byCategory.map((row) => ({
      categoryId: row._id ? row._id.toString() : null,
      name: row.name,
      amountMinor: row.amountMinor,
    })),
    byMerchant: byMerchant.map((row) => ({ merchant: row.name, amountMinor: row.amountMinor, count: row.count })),
    daily: days,
  });
});

// The kid's own merchant shortcuts - theirs alone, never the parent's.
kidRouter.get("/presets", async (req, res) => {
  const presets = await MerchantPreset.find({ userId: req.kid!.kidId })
    .sort({ useCount: -1, lastUsedAt: -1, merchant: 1 })
    .populate("category");
  res.json(presets);
});

const presetSchema = z.object({
  merchant: z.string().trim().min(1).max(120),
  categoryId: z.string().regex(OBJECT_ID).nullable().optional(),
});

kidRouter.post("/presets", async (req, res) => {
  const parsed = presetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Give the shortcut a name." });
  if (!(await categoryAllowed(req, parsed.data.categoryId))) return res.status(400).json({ error: "Unknown category" });

  const preset = await MerchantPreset.findOneAndUpdate(
    { userId: req.kid!.kidId, merchant: parsed.data.merchant },
    { $set: { categoryId: parsed.data.categoryId ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).populate("category");
  res.status(201).json(preset);
});

kidRouter.post("/presets/:id/used", validObjectIdParam("id"), async (req, res) => {
  await MerchantPreset.updateOne(
    { _id: req.params.id, userId: req.kid!.kidId },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } }
  );
  res.status(204).end();
});

kidRouter.delete("/presets/:id", validObjectIdParam("id"), async (req, res) => {
  const deleted = await MerchantPreset.findOneAndDelete({ _id: req.params.id, userId: req.kid!.kidId });
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(100),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(100),
});

// POST /kid/password — the kid changes their own password. Other phones
// signed in as them are signed out; this one gets a fresh session back.
kidRouter.post("/password", async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `A new password needs at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const kid = await User.findById(req.kid!.kidId).orFail();
  if (!checkPassword(parsed.data.currentPassword, kid.passwordHash, kid.passwordSalt)) {
    return res.status(403).json({ error: "Your current password isn't right." });
  }
  const { hash, salt } = hashPassword(parsed.data.newPassword);
  kid.passwordHash = hash;
  kid.passwordSalt = salt;
  kid.tokenVersion = (kid.tokenVersion ?? 0) + 1;
  await kid.save();

  res.json({
    token: signSessionToken({ id: kid._id.toString(), email: kid.email, role: "KID", v: kid.tokenVersion }),
  });
});

// POST /kid/refresh — ask the parent's phone to read new SMS, at most once
// in ten minutes. The kid's app then reloads whatever the server has.
kidRouter.post("/refresh", async (req, res) => {
  const result = await pingOwnerForSms(req.kid!.parentId);
  res.json(result);
});
