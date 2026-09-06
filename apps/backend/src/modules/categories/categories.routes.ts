import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { Category, CategoryRule } from "../../models";
import { RULE_MATCH_TYPES } from "../../types";

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

// GET /categories — system defaults + this user's custom categories.
categoriesRouter.get("/", async (req, res) => {
  const categories = await Category.find({
    $or: [{ userId: null }, { userId: currentUserId(req) }],
  }).sort({ isSystem: -1, name: 1 });

  res.json(categories);
});

const createCategorySchema = z.object({
  name: z.string().min(1).max(40),
  icon: z.string().optional(),
  color: z.string().optional(),
});

categoriesRouter.post("/", async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const category = await Category.create({
    ...parsed.data,
    userId: currentUserId(req),
    isSystem: false,
  });
  res.status(201).json(category);
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(40).optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
});

categoriesRouter.patch("/:id", async (req, res) => {
  const parsed = updateCategorySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  // Scoping the query by userId means a user can never edit a system
  // category or another user's, without a separate ownership check.
  const updated = await Category.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $set: parsed.data },
    { new: true }
  );
  if (!updated) return res.status(404).json({ error: "Category not found" });

  res.json(updated);
});

categoriesRouter.delete("/:id", async (req, res) => {
  const deleted = await Category.findOneAndDelete({
    _id: req.params.id,
    userId: currentUserId(req),
  });
  if (!deleted) return res.status(404).json({ error: "Category not found" });

  res.status(204).end();
});

const createRuleSchema = z.object({
  categoryId: z.string().min(1),
  matchType: z.enum(RULE_MATCH_TYPES),
  pattern: z.string().min(1).max(80),
  priority: z.number().int().optional(),
});

// POST /categories/rules — teach the categorizer that merchant text
// containing `pattern` should map to `categoryId` going forward. Existing
// transactions are not retroactively recategorized by this endpoint.
categoriesRouter.post("/rules", async (req, res) => {
  const parsed = createRuleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const category = await Category.findOne({
    _id: parsed.data.categoryId,
    $or: [{ userId: null }, { userId }],
  });
  if (!category) return res.status(404).json({ error: "Category not found" });

  const rule = await CategoryRule.create({
    userId,
    categoryId: category._id,
    matchType: parsed.data.matchType,
    pattern: parsed.data.pattern.toLowerCase(),
    priority: parsed.data.priority ?? 0,
  });
  res.status(201).json(rule);
});
