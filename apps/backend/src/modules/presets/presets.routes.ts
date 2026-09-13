import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Category, MerchantPreset } from "../../models";

export const presetsRouter = Router();
presetsRouter.use(requireAuth);

/**
 * Shortcuts for entering a payment by hand: a merchant name and the
 * category that usually goes with it, so a regular cash spend is one tap
 * rather than a name typed out and a category hunted for.
 *
 * Distinct from the categorisation rules, which decide what an *incoming*
 * message is. These only exist for things nobody texts you about.
 */

// GET /merchant-presets — most reached-for first, so the row of shortcuts
// stays useful as it grows.
presetsRouter.get("/", async (req, res) => {
  const presets = await MerchantPreset.find({ userId: currentUserId(req) })
    .sort({ useCount: -1, lastUsedAt: -1, merchant: 1 })
    .populate("category");

  res.json(presets);
});

const presetFields = {
  merchant: z.string().min(1).max(120),
  categoryId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
};

presetsRouter.post("/", async (req, res) => {
  const parsed = z.object(presetFields).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const merchant = parsed.data.merchant.trim();

  if (parsed.data.categoryId) {
    const owned = await Category.exists({
      _id: parsed.data.categoryId,
      $or: [{ userId }, { userId: null }],
    });
    if (!owned) return res.status(400).json({ error: "Unknown category" });
  }

  // Saving the same merchant again updates the category rather than
  // failing: from the form it reads as "use this one from now on".
  const preset = await MerchantPreset.findOneAndUpdate(
    { userId, merchant },
    { $set: { categoryId: parsed.data.categoryId ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).populate("category");

  res.status(201).json(preset);
});

presetsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = z.object(presetFields).partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const update: Record<string, unknown> = {};
  if (parsed.data.merchant !== undefined) update.merchant = parsed.data.merchant.trim();
  if (parsed.data.categoryId !== undefined) update.categoryId = parsed.data.categoryId;

  const updated = await MerchantPreset.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $set: update },
    { new: true }
  ).populate("category");
  if (!updated) return res.status(404).json({ error: "Not found" });

  res.json(updated);
});

presetsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const deleted = await MerchantPreset.findOneAndDelete({
    _id: req.params.id,
    userId: currentUserId(req),
  });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  res.status(204).end();
});

// POST /merchant-presets/:id/used — what keeps the order worth having.
// Sent as the preset is applied and its answer ignored: a shortcut must
// not wait on a round trip to fill a form in.
presetsRouter.post("/:id/used", validObjectIdParam("id"), async (req, res) => {
  await MerchantPreset.updateOne(
    { _id: req.params.id, userId: currentUserId(req) },
    { $inc: { useCount: 1 }, $set: { lastUsedAt: new Date() } }
  );

  res.status(204).end();
});
