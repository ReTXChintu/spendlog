import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, EmiInstalment, EmiPlan, Transaction } from "../../models";
import { horizonFor } from "../ledger/ledger.horizon";
import { AMOUNT_TOLERANCE_MINOR, matchExistingDebits } from "./emi.matching";
import { addMonths, buildSchedule, monthlyInstalmentMinor, scheduleAround } from "./emi.schedule";

export const emiRouter = Router();
emiRouter.use(requireAuth);

// GET /emi — every plan, with its instalments.
emiRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const [plans, trackingSince] = await Promise.all([
    EmiPlan.find({ userId }).sort({ status: 1, startDate: -1 }).populate("accountId"),
    horizonFor(userId),
  ]);
  const instalments = await EmiInstalment.find({
    planId: { $in: plans.map((p) => p._id) },
  }).sort({ seq: 1 });

  res.json(
    plans.map((plan) => {
      const own = instalments.filter((i) => i.planId.equals(plan._id));
      const paid = own.filter((i) => i.status === "PAID");
      const next = own.find((i) => i.status === "DUE");
      return {
        ...plan.toJSON(),
        instalments: own.map((i) => i.toJSON()),
        paidCount: paid.length,
        paidMinor: paid.reduce((sum, i) => sum + i.amountMinor, 0),
        // Paid with nothing to show for it - before tracking began.
        paidBeforeTrackingCount: own.filter((i) => i.paidBeforeTracking).length,
        // What is still to pay, ignoring anything deliberately skipped.
        remainingMinor: own
          .filter((i) => i.status === "DUE")
          .reduce((sum, i) => sum + i.amountMinor, 0),
        nextDue: next ? { seq: next.seq, dueDate: next.dueDate, amountMinor: next.amountMinor } : null,
        // When SpendLog began importing, so a client can say "paid before
        // SpendLog" of an instalment due before it.
        trackingSince,
      };
    })
  );
});

const existingPlanSchema = z.object({
  accountId: z.string().regex(/^[0-9a-fA-F]{24}$/),
  label: z.string().trim().min(1).max(80),
  /** The whole term, paid months included. */
  months: z.number().int().min(1).max(120),
  monthlyAmountMinor: z.number().int().positive(),
  principalMinor: z.number().int().positive().nullable().optional(),
  interestRatePctAnnual: z.number().min(0).max(100).nullable().optional(),
  processingFeeMinor: z.number().int().nonnegative().nullable().optional(),
  /** Instalments already paid. At least one is always left to pay. */
  paidCount: z.number().int().min(0).max(119),
  /** When the next unpaid instalment falls due. */
  nextDueDate: z.coerce.date(),
  /** Add it although a plan like it already exists on the account. */
  force: z.boolean().optional(),
});

const DAY_MS = 24 * 60 * 60 * 1000;

// POST /emi — an EMI that was already running when SpendLog started, so
// its purchase was never seen. The schedule is laid out from how many are
// paid and when the next is due; the months since tracking began look for
// the debits that already arrived; the months before are marked paid with
// nothing to show for them.
emiRouter.post("/", async (req, res) => {
  const parsed = existingPlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const data = parsed.data;
  if (data.paidCount >= data.months) {
    return res.status(400).json({ error: "At least one instalment has to be left to pay" });
  }
  // A next due date long past is a typo, and one years away is too.
  const now = Date.now();
  if (data.nextDueDate.getTime() < now - 62 * DAY_MS || data.nextDueDate.getTime() > now + 400 * DAY_MS) {
    return res.status(400).json({ error: "The next instalment's date should be within the coming year" });
  }

  const account = await Account.findOne({ _id: data.accountId, userId });
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (account.accountType !== "CARD" && account.accountType !== "BANK") {
    return res.status(400).json({ error: "An EMI is billed to a credit card or taken from a bank account" });
  }

  const schedule = scheduleAround(data.nextDueDate, data.paidCount, data.months, data.monthlyAmountMinor);
  const startDate = schedule[0].dueDate;
  const endDate = schedule[schedule.length - 1].dueDate;

  // The same EMI added twice would count every instalment twice.
  if (!data.force) {
    const twin = await findTwin(userId, account._id, data.monthlyAmountMinor, startDate, endDate);
    if (twin) {
      return res.status(409).json({
        error: `"${twin.label ?? "An EMI"}" on this account already bills about the same each month over the same months. Add this one only if it is a different EMI.`,
        code: "duplicate",
        existing: { id: twin.id as string, label: twin.label ?? null },
      });
    }
  }

  const plan = await EmiPlan.create({
    userId,
    sourceTransactionId: null,
    origin: "EXISTING",
    accountId: account._id,
    label: data.label,
    // The purchase price is rarely to hand for an EMI begun long ago. The
    // monthly figure times the term is what is actually repaid, so it
    // stands in - what any screen shows of "principal" is then the total.
    principalMinor: data.principalMinor ?? data.monthlyAmountMinor * data.months,
    months: data.months,
    monthlyAmountMinor: data.monthlyAmountMinor,
    totalPayableMinor: data.monthlyAmountMinor * data.months,
    interestRatePctAnnual: data.interestRatePctAnnual ?? null,
    processingFeeMinor: data.processingFeeMinor ?? null,
    startDate,
    status: "ACTIVE",
  });

  await EmiInstalment.insertMany(schedule.map((entry) => ({ userId, planId: plan._id, ...entry })));

  // Since tracking began, the debits are real rows: find them.
  const since = (await horizonFor(userId)) ?? new Date(now);
  const matched = await matchExistingDebits(plan, since);

  // The rest of those said to be paid have nothing to show for them.
  const markedPaid = await EmiInstalment.updateMany(
    { planId: plan._id, seq: { $lte: data.paidCount }, status: "DUE" },
    { $set: { status: "PAID", paidBeforeTracking: true, paidAt: null } }
  );

  await closePlanIfFinished(plan._id);

  res.status(201).json({ ...plan.toJSON(), matchedCount: matched, paidBeforeTrackingCount: markedPaid.modifiedCount });
});

/**
 * An active plan on the account billing about the same each month over
 * months that overlap - most likely this very EMI, added before.
 */
async function findTwin(
  userId: Types.ObjectId,
  accountId: Types.ObjectId,
  monthlyAmountMinor: number,
  start: Date,
  end: Date
) {
  const plans = await EmiPlan.find({
    userId,
    accountId,
    status: "ACTIVE",
    monthlyAmountMinor: {
      $gte: monthlyAmountMinor - AMOUNT_TOLERANCE_MINOR,
      $lte: monthlyAmountMinor + AMOUNT_TOLERANCE_MINOR,
    },
  });
  return plans.find((plan) => {
    const planEnd = addMonths(plan.startDate, plan.months - 1);
    return plan.startDate.getTime() <= end.getTime() && planEnd.getTime() >= start.getTime();
  });
}

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
    origin: "CONVERTED",
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
  /** Only for an EMI typed in: correcting the figure it was added with. */
  monthlyAmountMinor: z.number().int().positive().optional(),
});

// PATCH /emi/:id — rename, or close it early. Closing is foreclosure: what
// is left stops being owed, so those instalments are skipped rather than
// left due forever. An EMI typed in can also have its monthly figure put
// right: what is still due takes the new figure, what was paid keeps its
// own.
emiRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updatePlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const plan = await EmiPlan.findOne({ _id: req.params.id, userId });
  if (!plan) return res.status(404).json({ error: "Not found" });

  if (parsed.data.monthlyAmountMinor !== undefined) {
    // A converted plan's figure came off the statement with the purchase
    // beside it; changing it is converting again.
    if (plan.origin !== "EXISTING") {
      return res.status(400).json({ error: "Delete this EMI and convert the purchase again to change its amount" });
    }
    await EmiInstalment.updateMany(
      { planId: plan._id, status: "DUE" },
      { $set: { amountMinor: parsed.data.monthlyAmountMinor } }
    );
    const all = await EmiInstalment.find({ planId: plan._id }).select("amountMinor");
    plan.monthlyAmountMinor = parsed.data.monthlyAmountMinor;
    plan.totalPayableMinor = all.reduce((sum, instalment) => sum + instalment.amountMinor, 0);
  }
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

// DELETE /emi/:id — the plan was a mistake. The purchase, if there was
// one, goes back to counting in full, and the schedule disappears. A debit
// already matched to an instalment stays where it is and stays counted -
// it was a real payment - but is no longer marked as this plan's, so it is
// free to be matched again if the EMI is added once more.
emiRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const plan = await EmiPlan.findOne({ _id: req.params.id, userId });
  if (!plan) return res.status(404).json({ error: "Not found" });

  const linked = await Transaction.find({
    userId,
    $or: [
      { emiPlanId: plan._id },
      ...(plan.sourceTransactionId ? [{ _id: plan.sourceTransactionId }] : []),
    ],
  });
  // Saved one by one so the counted-amount hook runs on each.
  for (const transaction of linked) {
    transaction.emiPlanId = null;
    transaction.emiRole = null;
    await transaction.save();
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
