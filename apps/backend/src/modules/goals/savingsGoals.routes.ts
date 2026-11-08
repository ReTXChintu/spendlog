import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, SavingsGoal, Transaction } from "../../models";
import { goalEntries, goalsOf } from "./savingsGoals.service";

/** Savings goals: what each has, what it needs a month, and what went into it. */
export const savingsGoalsRouter = Router();
savingsGoalsRouter.use(requireAuth);

const minor = z.number().int().min(0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

async function viewOf(userId: ReturnType<typeof currentUserId>, id: string) {
  return (await goalsOf(userId)).find((goal) => goal.id === id);
}

async function ownAccount(userId: ReturnType<typeof currentUserId>, accountId: string | null | undefined) {
  if (!accountId) return true;
  return Boolean(await Account.exists({ _id: accountId, userId }));
}

// GET /savings-goals — every goal, and what the open ones have and need together.
savingsGoalsRouter.get("/", async (req, res) => {
  const goals = await goalsOf(currentUserId(req));
  const open = goals.filter((goal) => goal.isActive);
  res.json({
    goals,
    savedMinor: open.reduce((sum, goal) => sum + goal.savedMinor, 0),
    perMonthMinor: open.filter((goal) => !goal.isDone).reduce((sum, goal) => sum + goal.perMonthMinor, 0),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  targetMinor: z.number().int().positive(),
  targetOn: day,
  accountId: z.string().regex(OBJECT_ID).nullable().optional(),
  // Already put aside for it.
  openingMinor: minor.optional(),
});

// POST /savings-goals — a goal, with what is already put aside for it.
savingsGoalsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = currentUserId(req);
  if (!(await ownAccount(userId, parsed.data.accountId))) return res.status(400).json({ error: "Unknown account" });
  const goal = await SavingsGoal.create({
    userId,
    name: parsed.data.name,
    targetMinor: parsed.data.targetMinor,
    targetOn: parsed.data.targetOn,
    accountId: parsed.data.accountId ?? null,
    openingMinor: parsed.data.openingMinor ?? 0,
  });
  res.status(201).json(await viewOf(userId, goal._id.toString()));
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  targetMinor: z.number().int().positive().optional(),
  targetOn: day.optional(),
  accountId: z.string().regex(OBJECT_ID).nullable().optional(),
  openingMinor: minor.optional(),
  // Bought, or given up: no longer spoken for.
  isActive: z.boolean().optional(),
});

// PATCH /savings-goals/:id — rename it, move the target or the date, close it.
savingsGoalsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = currentUserId(req);
  const goal = await SavingsGoal.findOne({ _id: req.params.id, userId });
  if (!goal) return res.status(404).json({ error: "Not found" });
  if (!(await ownAccount(userId, parsed.data.accountId))) return res.status(400).json({ error: "Unknown account" });
  goal.set(parsed.data);
  await goal.save();
  res.json(await viewOf(userId, goal._id.toString()));
});

const adjustSchema = z.object({
  // Positive adds to it, negative takes out of it.
  amountMinor: z.number().int().refine((value) => value !== 0, "Say an amount"),
  note: z.string().trim().max(120).nullable().optional(),
  on: z.coerce.date().optional(),
});

// POST /savings-goals/:id/adjustments — put money aside for it by hand, or take some out.
savingsGoalsRouter.post("/:id/adjustments", validObjectIdParam("id"), async (req, res) => {
  const parsed = adjustSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = currentUserId(req);
  const goal = await SavingsGoal.findOne({ _id: req.params.id, userId });
  if (!goal) return res.status(404).json({ error: "Not found" });
  const view = await viewOf(userId, goal._id.toString());
  if (parsed.data.amountMinor < 0 && view && view.savedMinor + parsed.data.amountMinor < 0) {
    return res.status(400).json({ error: `It only has ₹${(view.savedMinor / 100).toFixed(2)}.` });
  }
  goal.adjustments.push({ amountMinor: parsed.data.amountMinor, note: parsed.data.note || null, on: parsed.data.on ?? new Date() });
  await goal.save();
  res.status(201).json(await viewOf(userId, goal._id.toString()));
});

// DELETE /savings-goals/:id — gone, and taken off every transfer marked for it.
savingsGoalsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const goal = await SavingsGoal.findOneAndDelete({ _id: req.params.id, userId });
  if (!goal) return res.status(404).json({ error: "Not found" });
  await Transaction.updateMany({ userId, "goalParts.goalId": goal._id }, { $pull: { goalParts: { goalId: goal._id } } });
  res.status(204).end();
});

// GET /savings-goals/:id/entries — what went into it and came out of it.
savingsGoalsRouter.get("/:id/entries", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const goal = await SavingsGoal.findOne({ _id: req.params.id, userId }).lean();
  if (!goal) return res.status(404).json({ error: "Not found" });
  const entries = await goalEntries(userId, goal);
  res.json({ entries, openingMinor: goal.openingMinor });
});
