import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, FixedCommitment, Transaction, User } from "../../models";
import { COMMITMENT_KINDS } from "../../types";
import { budgetPeriodFor } from "./budget.period";

export const budgetRouter = Router();
budgetRouter.use(requireAuth);

const profileSchema = z.object({
  salaryAmountMinor: z.number().int().nonnegative().nullable().optional(),
  salaryDay: z.number().int().min(1).max(31).nullable().optional(),
});

// GET /budget/profile — what is known about money coming in.
budgetRouter.get("/profile", async (req, res) => {
  const user = await User.findById(currentUserId(req)).select("salaryAmountMinor salaryDay").orFail();
  res.json({
    salaryAmountMinor: user.salaryAmountMinor ?? null,
    salaryDay: user.salaryDay ?? null,
  });
});

budgetRouter.patch("/profile", async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await User.findByIdAndUpdate(
    currentUserId(req),
    { $set: parsed.data },
    { new: true }
  ).orFail();

  res.json({
    salaryAmountMinor: user.salaryAmountMinor ?? null,
    salaryDay: user.salaryDay ?? null,
  });
});

const commitmentSchema = z.object({
  name: z.string().min(1).max(80),
  amountMinor: z.number().int().nonnegative(),
  dayOfMonth: z.number().int().min(1).max(31),
  kind: z.enum(COMMITMENT_KINDS).optional(),
  isActive: z.boolean().optional(),
});

budgetRouter.get("/commitments", async (req, res) => {
  const commitments = await FixedCommitment.find({ userId: currentUserId(req) }).sort({
    isActive: -1,
    dayOfMonth: 1,
  });
  res.json(commitments);
});

budgetRouter.post("/commitments", async (req, res) => {
  const parsed = commitmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const created = await FixedCommitment.create({ userId: currentUserId(req), ...parsed.data });
  res.status(201).json(created);
});

budgetRouter.patch("/commitments/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = commitmentSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await FixedCommitment.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $set: parsed.data },
    { new: true }
  );
  if (!updated) return res.status(404).json({ error: "Not found" });

  res.json(updated);
});

budgetRouter.delete("/commitments/:id", validObjectIdParam("id"), async (req, res) => {
  const deleted = await FixedCommitment.findOneAndDelete({
    _id: req.params.id,
    userId: currentUserId(req),
  });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  res.status(204).end();
});

const paidSchema = z.object({ paid: z.boolean() });

// POST /budget/commitments/:id/paid — ticked off by hand for this period.
//
// Recorded against the period rather than as a flag, so next month's rent
// starts unpaid again without anything having to reset it.
budgetRouter.post("/commitments/:id/paid", validObjectIdParam("id"), async (req, res) => {
  const parsed = paidSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const user = await User.findById(userId).select("salaryDay").orFail();
  const period = budgetPeriodFor(user.salaryDay ?? 1, new Date());

  const updated = await FixedCommitment.findOneAndUpdate(
    { _id: req.params.id, userId },
    { $set: { paidForPeriod: parsed.data.paid ? period.key : null } },
    { new: true }
  );
  if (!updated) return res.status(404).json({ error: "Not found" });

  res.json(updated);
});

// GET /budget/pace — how fast money is going out against how fast it can.
//
// This measures a pace, not solvency. SpendLog reads messages about
// transactions and has never known an account balance, so it can say
// spending has outrun the salary and cannot say whether a bill is
// affordable. Everything below is built only from money that moved.
budgetRouter.get("/pace", async (req, res) => {
  const userId = currentUserId(req);
  const user = await User.findById(userId).select("salaryAmountMinor salaryDay").orFail();

  if (!user.salaryAmountMinor || !user.salaryDay) {
    return res.json({ configured: false });
  }

  const now = new Date();
  const period = budgetPeriodFor(user.salaryDay, now);

  // Paying a card bill is not new spending — it is an earlier cycle's
  // spending reaching the bank. Counting both would double every rupee
  // that ever went on a card, so payments into a card account are left
  // out of the period's total.
  const cardIds = (await Account.find({ userId, accountType: "CARD" }).select("_id")).map(
    (card) => card._id
  );

  const [spend] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lt: period.end },
        accountId: { $nin: cardIds },
        countedAmountMinor: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);

  // Card spending still counts — just at the moment it happens, on the
  // card, rather than when the bill lands.
  const [cardSpend] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: period.start, $lt: period.end },
        accountId: { $in: cardIds },
        countedAmountMinor: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);

  const spentMinor = (spend?.total ?? 0) + (cardSpend?.total ?? 0);

  const commitments = await FixedCommitment.find({ userId, isActive: true }).sort({ dayOfMonth: 1 });
  const pending = commitments.filter((commitment) => commitment.paidForPeriod !== period.key);
  const commitmentsRemainingMinor = pending.reduce((sum, c) => sum + c.amountMinor, 0);

  const availableMinor = user.salaryAmountMinor - commitmentsRemainingMinor;
  const remainingMinor = availableMinor - spentMinor;
  const perDayMinor = Math.round(remainingMinor / period.daysLeft);

  // What has actually been going out lately, which is the only thing the
  // sustainable figure means anything against.
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [recent] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        occurredAt: { $gte: weekAgo, $lte: now },
        countedAmountMinor: { $gt: 0 },
      },
    },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);
  const recentPerDayMinor = Math.round((recent?.total ?? 0) / 7);

  const state =
    remainingMinor < 0
      ? "over"
      : recentPerDayMinor > 0 && recentPerDayMinor * period.daysLeft > remainingMinor
        ? "watch"
        : "ok";

  res.json({
    configured: true,
    periodStart: period.start,
    periodEnd: period.end,
    daysLeft: period.daysLeft,
    daysElapsed: period.daysElapsed,
    salaryMinor: user.salaryAmountMinor,
    commitmentsRemainingMinor,
    spentMinor,
    remainingMinor,
    perDayMinor,
    recentPerDayMinor,
    state,
    commitments: commitments.map((commitment) => ({
      ...commitment.toJSON(),
      isPaid: commitment.paidForPeriod === period.key,
    })),
  });
});
