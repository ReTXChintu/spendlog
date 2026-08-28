import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db";
import { requireAuth } from "../../middleware/auth";
import { RULE_MATCH_TYPES } from "../../types";

export const categoriesRouter = Router();
categoriesRouter.use(requireAuth);

// GET /categories — system defaults + this user's custom categories.
categoriesRouter.get("/", async (req, res) => {
  const categories = await prisma.category.findMany({
    where: { OR: [{ userId: null }, { userId: req.user!.id }] },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
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

  const category = await prisma.category.create({
    data: { ...parsed.data, userId: req.user!.id, isSystem: false },
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

  const category = await prisma.category.findUnique({ where: { id: req.params.id } });
  if (!category || category.userId !== req.user!.id) {
    return res.status(404).json({ error: "Category not found" });
  }

  const updated = await prisma.category.update({ where: { id: category.id }, data: parsed.data });
  res.json(updated);
});

categoriesRouter.delete("/:id", async (req, res) => {
  const category = await prisma.category.findUnique({ where: { id: req.params.id } });
  if (!category || category.userId !== req.user!.id) {
    return res.status(404).json({ error: "Category not found" });
  }
  await prisma.category.delete({ where: { id: category.id } });
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

  const category = await prisma.category.findFirst({
    where: { id: parsed.data.categoryId, OR: [{ userId: null }, { userId: req.user!.id }] },
  });
  if (!category) return res.status(404).json({ error: "Category not found" });

  const rule = await prisma.categoryRule.create({
    data: {
      userId: req.user!.id,
      categoryId: category.id,
      matchType: parsed.data.matchType,
      pattern: parsed.data.pattern.toLowerCase(),
      priority: parsed.data.priority ?? 0,
    },
  });
  res.status(201).json(rule);
});
