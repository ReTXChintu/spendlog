import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { FundHolding, Goal, GoalDoc } from "../../models";
import { istDayKey } from "../../time";
import { loadPortfolio } from "./funds.portfolio";
import { ASSUMPTIONS_JSON, goalJson, goalsFor } from "./goals.service";

export const goalsRouter = Router();
goalsRouter.use(requireAuth);

/**
 * Things to save up for - a laptop, a trip, a deposit - each with a target
 * and a date, the funds put towards it, and a monthly SIP plan to get
 * there. See goals.plan.ts for the maths and the returns assumed.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const goalSchema = z.object({
  name: z.string().trim().min(1).max(80),
  targetMinor: z.number().int().min(100),
  targetOn: day,
  holdingIds: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/)).max(30).optional(),
  savedMinor: z.number().int().nonnegative().optional(),
});

/** The ids that are this user's holdings, or null when any isn't. */
async function ownHoldings(userId: Types.ObjectId, ids: string[] | undefined) {
  if (!ids) return undefined;
  const unique = [...new Set(ids)];
  const count = await FundHolding.countDocuments({ userId, _id: { $in: unique } });
  return count === unique.length ? unique.map((id) => new Types.ObjectId(id)) : null;
}

async function oneGoal(userId: Types.ObjectId, goal: GoalDoc) {
  return goalJson(goal, await loadPortfolio(userId, new Date(), true));
}

// GET /goals — every goal with its progress, monthly plan and status, and
// the return assumptions behind the plans.
goalsRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const portfolio = await loadPortfolio(userId, new Date(), true);
  res.json({
    goals: await goalsFor(userId, portfolio),
    assumptions: ASSUMPTIONS_JSON,
    peersAvailable: Boolean(portfolio.peers),
  });
});

goalsRouter.post("/", async (req, res) => {
  const parsed = goalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.targetOn <= istDayKey(new Date())) return res.status(400).json({ error: "Pick a date in the future." });

  const userId = currentUserId(req);
  const holdingIds = await ownHoldings(userId, parsed.data.holdingIds);
  if (holdingIds === null) return res.status(400).json({ error: "One of those funds isn't yours." });

  const created = await Goal.create({ userId, ...parsed.data, holdingIds: holdingIds ?? [] });
  res.status(201).json(await oneGoal(userId, created.toObject()));
});

// PATCH /goals/:id — any of the fields. The date may be today or past
// here, so a goal that slipped can still be edited.
goalsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = goalSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const holdingIds = await ownHoldings(userId, parsed.data.holdingIds);
  if (holdingIds === null) return res.status(400).json({ error: "One of those funds isn't yours." });

  const update: Record<string, unknown> = { ...parsed.data };
  if (holdingIds) update.holdingIds = holdingIds;
  const updated = await Goal.findOneAndUpdate({ _id: req.params.id, userId }, { $set: update }, { new: true }).lean<GoalDoc>();
  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json(await oneGoal(userId, updated));
});

goalsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const deleted = await Goal.findOneAndDelete({ _id: req.params.id, userId: currentUserId(req) });
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});
