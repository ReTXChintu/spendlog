import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, FixedCommitment, Transaction, User, commitmentAmountFor } from "../../models";
import { COMMITMENT_KINDS } from "../../types";
import { budgetPace, changeCommitmentAmount, commitmentPeriod } from "./budget.pace";
import { dailyBudget } from "./budget.daily";

export const budgetRouter = Router();
budgetRouter.use(requireAuth);

const profileSchema = z.object({
  salaryAmountMinor: z.number().int().nonnegative().nullable().optional(),
  salaryDay: z.number().int().min(1).max(31).nullable().optional(),
  dailyBudgetMinor: z.number().int().nonnegative().nullable().optional(),
});

// GET /budget/profile — what is known about money coming in.
budgetRouter.get("/profile", async (req, res) => {
  const user = await User.findById(currentUserId(req)).select("salaryAmountMinor salaryDay dailyBudgetMinor").orFail();
  res.json({
    salaryAmountMinor: user.salaryAmountMinor ?? null,
    salaryDay: user.salaryDay ?? null,
    dailyBudgetMinor: user.dailyBudgetMinor ?? null,
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
    dailyBudgetMinor: user.dailyBudgetMinor ?? null,
  });
});

// GET /budget/daily - the daily allowance and the bucket behind it.
//
// Its own route as well as riding on the dashboard, because the settings
// screen shows it while the number is being chosen: typing 1,000 and
// seeing what this period would have come to is the only way to pick one.
budgetRouter.get("/daily", async (req, res) => {
  res.json(await dailyBudget(currentUserId(req)));
});

const commitmentSchema = z.object({
  name: z.string().min(1).max(80),
  amountMinor: z.number().int().nonnegative(),
  dayOfMonth: z.number().int().min(1).max(31),
  kind: z.enum(COMMITMENT_KINDS).optional(),
  // Prefilled onto a payment when the commitment is picked, so a fixed
  // cost does not need its merchant and category typed every month.
  merchant: z.string().max(120).nullable().optional(),
  categoryId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .nullable()
    .optional(),
  isActive: z.boolean().optional(),
});

budgetRouter.get("/commitments", async (req, res) => {
  const userId = currentUserId(req);
  const [commitments, period] = await Promise.all([
    FixedCommitment.find({ userId }).sort({ isActive: -1, dayOfMonth: 1 }).populate("categoryId"),
    commitmentPeriod(userId),
  ]);
  // amountMinor is what it costs from now on; this is what this period
  // costs, which is the old figure when a change came after it was paid.
  res.json(
    commitments.map((commitment) => ({
      ...commitment.toJSON(),
      thisPeriodAmountMinor: commitmentAmountFor(commitment, period.key),
    }))
  );
});

budgetRouter.post("/commitments", async (req, res) => {
  const parsed = commitmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const created = await FixedCommitment.create({ userId: currentUserId(req), ...parsed.data });
  res.status(201).json(created);
});

// PATCH /budget/commitments/:id
//
// A new amount takes effect from the next payment when this period's has
// already gone out at the old one: raising a SIP from 2,000 to 3,000 the
// week after 2,000 was paid does not leave 1,000 "still to go out". When
// this period is not yet paid, the new amount is simply what it costs now.
budgetRouter.patch("/commitments/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = commitmentSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const commitment = await FixedCommitment.findOne({ _id: req.params.id, userId });
  if (!commitment) return res.status(404).json({ error: "Not found" });

  if (parsed.data.amountMinor !== undefined) {
    await changeCommitmentAmount(commitment, parsed.data.amountMinor);
  }

  commitment.set(parsed.data);
  await commitment.save();
  res.json(commitment);
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
  // The pace's own period, so a tick made after pay landed early is still
  // a tick for the period the pace is showing.
  const period = await commitmentPeriod(userId);

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
  res.json(await budgetPace(currentUserId(req)));
});
