import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { User } from "../../models";
import { metalsView } from "./metals.service";

/** Gold and silver rates by the day, and whether they are pushed to this user. */
export const metalsRouter = Router();
metalsRouter.use(requireAuth);

// GET /metals — the latest day's IBJA rates, how they stand against the
// 30 days before, and about three months of history.
metalsRouter.get("/", async (req, res) => {
  res.json(await metalsView(currentUserId(req)));
});

// PATCH /metals/settings — the daily notification, on or off.
metalsRouter.patch("/settings", async (req, res) => {
  const parsed = z.object({ push: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  await User.updateOne({ _id: currentUserId(req) }, { $set: { metalRatesPush: parsed.data.push } });
  res.json(await metalsView(currentUserId(req)));
});
