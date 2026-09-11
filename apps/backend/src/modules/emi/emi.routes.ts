import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { EmiInstalment, EmiPlan, Transaction } from "../../models";
import { buildSchedule, monthlyInstalmentMinor } from "./emi.schedule";

export const emiRouter = Router();
emiRouter.use(requireAuth);

// GET /emi — every plan, with its instalments.
emiRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const plans = await EmiPlan.find({ userId }).sort({ status: 1, startDate: -1 }).populate("accountId");
  const instalments = await EmiInstalment.find({
    planId: { $in: plans.map((p) => p._id) },
  }).sort({ seq: 1 });

  res.json(
    plans.map((plan) => {
      const own = instalments.filter((i) => i.planId.equals(plan._id));
      const paid = own.filter((i) => i.status === "PAID");
      return {
        ...plan.toJSON(),
        instalments: own.map((i) => i.toJSON()),
        paidCount: paid.length,
        paidMinor: paid.reduce((sum, i) => sum + i.amountMinor, 0),
        // What is still to pay, ignoring anything deliberately skipped.
        remainingMinor: own
          .filter((i) => i.status === "DUE")
          .reduce((sum, i) => sum + i.amountMinor, 0),
      };
    })
  );
});

// GET /emi/upcoming — what falls due in the next window, for the month's
// committed outflow. Defaults to the next 45 days so a bill that lands
// just after month end is still in view.
emiRouter.get("/upcoming", async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? "45"), 10) || 45, 1), 365);
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const due = await EmiInstalment.find({
    userId: currentUserId(req),
    status: "DUE",
    dueDate: { $lte: until },
  })
    .sort({ dueDate: 1 })
    .populate({ path: "planId", populate: { path: "accountId" } });

  res.json({
    totalMinor: due.reduce((sum, i) => sum + i.amountMinor, 0),
    instalments: due,
  });
});

const createPlanSchema = z
  .object({
    months: z.number().int().min(1).max(120),
    /** From the statement. Wins over anything computed from a rate. */
    monthlyAmountMinor: z.number().int().positive().optional(),
    interestRatePctAnnual: z.number().min(0).max(100).nullable().optional(),
    processingFeeMinor: z.number().int().nonnegative().nullable().optional(),
    startDate: z.coerce.date().optional(),
    label: z.string().max(80).nullable().optional(),
  })
  .refine((data) => data.monthlyAmountMinor !== undefined || data.interestRatePctAnnual != null, {
    message: "Give either the monthly amount or an interest rate to compute it from",
  });

// POST /transactions/:id/emi lives here, mounted under /emi/from/:id, so a
// purchase can be converted into a plan.
emiRouter.post("/from/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = createPlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const purchase = await Transaction.findOne({ _id: req.params.id, userId });
  if (!purchase) return res.status(404).json({ error: "Not found" });
  if (purchase.type !== "DEBIT") {
    return res.status(400).json({ error: "Only a payment can be converted to an EMI" });
  }
  if (purchase.emiPlanId) {
    return res.status(409).json({ error: "That purchase is already on an EMI plan" });
  }

  const { months, interestRatePctAnnual } = parsed.data;
  const principalMinor = purchase.amountMinor;

  // The entered figure is authoritative; the rate is only a way to arrive
  // at one when the statement isn't to hand.
  const monthlyAmountMinor =
    parsed.data.monthlyAmountMinor ??
    monthlyInstalmentMinor(principalMinor, months, interestRatePctAnnual ?? 0);

  const startDate = parsed.data.startDate ?? purchase.occurredAt;

  const plan = await EmiPlan.create({
    userId,
    sourceTransactionId: purchase._id,
    accountId: purchase.accountId ?? null,
    label: parsed.data.label ?? purchase.merchant ?? null,
    principalMinor,
    months,
    monthlyAmountMinor,
    totalPayableMinor: monthlyAmountMinor * months,
    interestRatePctAnnual: interestRatePctAnnual ?? null,
    processingFeeMinor: parsed.data.processingFeeMinor ?? null,
    startDate,
    status: "ACTIVE",
  });

  await EmiInstalment.insertMany(
    buildSchedule(startDate, months, monthlyAmountMinor).map((entry) => ({
      userId,
      planId: plan._id,
      ...entry,
    }))
  );

  // Saved rather than updated so the counted-amount hook runs: the purchase
  // stops counting, because the instalments will count instead.
  purchase.emiPlanId = plan._id;
  purchase.emiRole = "PARENT";
  await purchase.save();

  res.status(201).json(plan);
});

const updatePlanSchema = z.object({
  label: z.string().max(80).nullable().optional(),
  status: z.enum(["ACTIVE", "CLOSED"]).optional(),
});

// PATCH /emi/:id — rename, or close it early. Closing is foreclosure: what
// is left stops being owed, so those instalments are skipped rather than
// left due forever.
emiRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updatePlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const plan = await EmiPlan.findOne({ _id: req.params.id, userId });
  if (!plan) return res.status(404).json({ error: "Not found" });

  if (parsed.data.label !== undefined) plan.label = parsed.data.label;
  if (parsed.data.status) plan.status = parsed.data.status;
  await plan.save();

  if (parsed.data.status === "CLOSED") {
    await EmiInstalment.updateMany(
      { planId: plan._id, status: "DUE" },
      { $set: { status: "SKIPPED" } }
    );
  }

  res.json(plan);
});

// DELETE /emi/:id — the plan was a mistake. The purchase goes back to
// counting in full, and the schedule disappears; any instalment already
// matched to a real debit keeps that transaction, which stays counted.
emiRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const plan = await EmiPlan.findOne({ _id: req.params.id, userId });
  if (!plan) return res.status(404).json({ error: "Not found" });

  const purchase = await Transaction.findOne({ _id: plan.sourceTransactionId, userId });
  if (purchase) {
    purchase.emiPlanId = null;
    purchase.emiRole = null;
    await purchase.save();
  }

  await EmiInstalment.deleteMany({ planId: plan._id });
  await plan.deleteOne();

  res.status(204).end();
});

const payInstalmentSchema = z.object({
  transactionId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
});

// POST /emi/instalments/:id/pay — mark one as paid by hand, for when the
// debit never produced a message to match against.
emiRouter.post("/instalments/:id/pay", validObjectIdParam("id"), async (req, res) => {
  const parsed = payInstalmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const instalment = await EmiInstalment.findOne({ _id: req.params.id, userId });
  if (!instalment) return res.status(404).json({ error: "Not found" });

  instalment.status = "PAID";
  instalment.paidAt = new Date();
  if (parsed.data.transactionId) {
    instalment.transactionId = (await Transaction.findOne({
      _id: parsed.data.transactionId,
      userId,
    }))?._id;
  }
  await instalment.save();

  await closePlanIfFinished(instalment.planId);

  res.json(instalment);
});

/** A plan with nothing left due has run its course. */
export async function closePlanIfFinished(planId: unknown): Promise<void> {
  const stillDue = await EmiInstalment.countDocuments({ planId, status: "DUE" });
  if (stillDue === 0) {
    await EmiPlan.updateOne({ _id: planId, status: "ACTIVE" }, { $set: { status: "CLOSED" } });
  }
}
