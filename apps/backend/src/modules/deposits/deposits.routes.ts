import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { DEPOSIT_KINDS, Deposit, Transaction } from "../../models";
import { depositPayments, depositsOf } from "./deposits.service";

/** RDs and FDs: each one's running total, what goes in a month, and the payments that went in. */
export const depositsRouter = Router();
depositsRouter.use(requireAuth);

const minor = z.number().int().min(0);

// GET /deposits — every deposit with its total, and all of them together.
depositsRouter.get("/", async (req, res) => {
  const deposits = await depositsOf(currentUserId(req));
  res.json({
    deposits,
    totalMinor: deposits.filter((deposit) => deposit.isActive).reduce((sum, deposit) => sum + deposit.totalMinor, 0),
    monthlyMinor: deposits
      .filter((deposit) => deposit.isActive)
      .reduce((sum, deposit) => sum + (deposit.monthlyMinor ?? 0), 0),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(DEPOSIT_KINDS),
  institution: z.string().trim().max(80).nullable().optional(),
  monthlyMinor: minor.nullable().optional(),
  // What it holds today.
  totalMinor: minor,
});

// POST /deposits — a deposit, with what it holds today.
depositsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const deposit = await Deposit.create({
    userId: currentUserId(req),
    name: parsed.data.name,
    kind: parsed.data.kind,
    institution: parsed.data.institution || null,
    monthlyMinor: parsed.data.kind === "RD" ? (parsed.data.monthlyMinor ?? null) : null,
    baselineMinor: parsed.data.totalMinor,
    baselineAt: new Date(),
  });
  const view = (await depositsOf(currentUserId(req))).find((d) => d.id === deposit._id.toString());
  res.status(201).json(view);
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  institution: z.string().trim().max(80).nullable().optional(),
  monthlyMinor: minor.nullable().optional(),
  // The total as it really stands - from the passbook, say. Counted from
  // now: payments already in are part of it.
  totalMinor: minor.optional(),
  isActive: z.boolean().optional(),
});

// PATCH /deposits/:id — rename it, change what goes in a month, correct its
// total, or close it.
depositsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = currentUserId(req);
  const deposit = await Deposit.findOne({ _id: req.params.id, userId });
  if (!deposit) return res.status(404).json({ error: "Not found" });

  const { totalMinor, institution, monthlyMinor, ...rest } = parsed.data;
  deposit.set(rest);
  if (institution !== undefined) deposit.institution = institution || null;
  if (monthlyMinor !== undefined) deposit.monthlyMinor = deposit.kind === "RD" ? monthlyMinor : null;
  if (totalMinor !== undefined) {
    deposit.baselineMinor = totalMinor;
    deposit.baselineAt = new Date();
  }
  await deposit.save();
  res.json((await depositsOf(userId)).find((d) => d.id === deposit._id.toString()));
});

// DELETE /deposits/:id — gone, and taken off every payment that went into
// it. The payments stay, as the spending they were.
depositsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const deposit = await Deposit.findOneAndDelete({ _id: req.params.id, userId });
  if (!deposit) return res.status(404).json({ error: "Not found" });
  await Transaction.updateMany(
    { userId, "depositParts.depositId": deposit._id },
    { $pull: { depositParts: { depositId: deposit._id } } }
  );
  res.status(204).end();
});

// GET /deposits/:id/payments — what went into it.
depositsRouter.get("/:id/payments", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const deposit = await Deposit.findOne({ _id: req.params.id, userId }).select("_id");
  if (!deposit) return res.status(404).json({ error: "Not found" });
  res.json(await depositPayments(userId, deposit._id));
});
