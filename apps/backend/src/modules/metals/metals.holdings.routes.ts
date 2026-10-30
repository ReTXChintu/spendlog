import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { METAL_HOLDING_KINDS, METAL_PURITIES, MetalHolding, Transaction } from "../../models";
import { holdingPurchases, holdingsOf } from "./metals.holdings";

/** The gold and silver the user owns, in grams. */
export const metalHoldingsRouter = Router();
metalHoldingsRouter.use(requireAuth);

const grams = z.number().min(0).max(100_000);

// GET /metals/holdings — each holding with its grams, cost and today's value.
metalHoldingsRouter.get("/", async (req, res) => {
  res.json(await holdingsOf(currentUserId(req)));
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  purity: z.enum(METAL_PURITIES),
  kind: z.enum(METAL_HOLDING_KINDS).optional(),
  // What is held today, and what it cost if known.
  grams,
  investedMinor: z.number().int().min(0).nullable().optional(),
  payee: z.string().trim().max(120).nullable().optional(),
});

// POST /metals/holdings — what is held today; purchases add to it from now.
metalHoldingsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = currentUserId(req);
  const created = await MetalHolding.create({
    userId,
    name: parsed.data.name,
    purity: parsed.data.purity,
    kind: parsed.data.kind ?? "OTHER",
    openingGrams: parsed.data.grams,
    openingInvestedMinor: parsed.data.investedMinor ?? null,
    openingAt: new Date(),
    payee: parsed.data.payee || null,
  });
  res.status(201).json((await holdingsOf(userId)).find((h) => h.id === created._id.toString()));
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(METAL_HOLDING_KINDS).optional(),
  // Corrects what was held at the start; purchases since stay on top.
  openingGrams: grams.optional(),
  openingInvestedMinor: z.number().int().min(0).nullable().optional(),
  payee: z.string().trim().max(120).nullable().optional(),
  isActive: z.boolean().optional(),
});

// PATCH /metals/holdings/:id
metalHoldingsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = currentUserId(req);
  const holding = await MetalHolding.findOne({ _id: req.params.id, userId });
  if (!holding) return res.status(404).json({ error: "Not found" });
  const { payee, ...rest } = parsed.data;
  holding.set(rest);
  if (payee !== undefined) holding.payee = payee || null;
  await holding.save();
  res.json((await holdingsOf(userId)).find((h) => h.id === holding._id.toString()));
});

// DELETE /metals/holdings/:id — gone, and its purchases go back to being
// plain payments.
metalHoldingsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const holding = await MetalHolding.findOneAndDelete({ _id: req.params.id, userId });
  if (!holding) return res.status(404).json({ error: "Not found" });
  await Transaction.updateMany({ userId, "metalBuy.holdingId": holding._id }, { $set: { metalBuy: null } });
  res.status(204).end();
});

// GET /metals/holdings/:id/purchases
metalHoldingsRouter.get("/:id/purchases", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const holding = await MetalHolding.findOne({ _id: req.params.id, userId }).select("_id");
  if (!holding) return res.status(404).json({ error: "Not found" });
  res.json(await holdingPurchases(userId, holding._id));
});
