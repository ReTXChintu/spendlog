import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Loan, LoanInstalment, Transaction } from "../../models";
import { buildSchedule, monthlyInstalmentMinor } from "../emi/emi.schedule";

export const loansRouter = Router();
loansRouter.use(requireAuth);

/**
 * A loan taken outside a card, tracked the way an EMI is: a schedule of
 * instalments, each a real payment can be matched to. See models/index.ts
 * for why this is a plan of its own rather than the same one EMIs use -
 * there is no purchase here to convert, and so nothing to keep out of the
 * totals once instalments start counting.
 */

// GET /loans — every loan, with its instalments and where it stands.
loansRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const loans = await Loan.find({ userId }).sort({ status: 1, startDate: -1 }).populate("accountId");
  const instalments = await LoanInstalment.find({
    loanId: { $in: loans.map((loan) => loan._id) },
  })
    .sort({ seq: 1 })
    .populate("transactionId");

  res.json(
    loans.map((loan) => {
      const own = instalments.filter((instalment) => instalment.loanId.equals(loan._id));
      const paid = own.filter((instalment) => instalment.status === "PAID");
      return {
        ...loan.toJSON(),
        instalments: own.map((instalment) => instalment.toJSON()),
        paidCount: paid.length,
        paidMinor: paid.reduce((sum, instalment) => sum + instalment.amountMinor, 0),
        // What is still to pay, ignoring anything deliberately skipped.
        remainingMinor: own
          .filter((instalment) => instalment.status === "DUE")
          .reduce((sum, instalment) => sum + instalment.amountMinor, 0),
      };
    })
  );
});

// GET /loans/upcoming — what falls due in the next window, for the
// dashboard's committed-outflow figure. Defaults to 45 days, the same as
// the EMI one, so a repayment just after month end is still in view.
loansRouter.get("/upcoming", async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? "45"), 10) || 45, 1), 365);
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const due = await LoanInstalment.find({
    userId: currentUserId(req),
    status: "DUE",
    dueDate: { $lte: until },
  })
    .sort({ dueDate: 1 })
    .populate({ path: "loanId", populate: { path: "accountId" } });

  res.json({
    totalMinor: due.reduce((sum, instalment) => sum + instalment.amountMinor, 0),
    instalments: due,
  });
});

const createLoanSchema = z
  .object({
    label: z.string().min(1).max(80),
    principalMinor: z.number().int().positive(),
    months: z.number().int().min(1).max(480),
    /// From the paperwork. Wins over anything computed from a rate.
    monthlyAmountMinor: z.number().int().positive().optional(),
    interestRatePctAnnual: z.number().min(0).max(100).nullable().optional(),
    processingFeeMinor: z.number().int().nonnegative().nullable().optional(),
    startDate: z.coerce.date().optional(),
    accountId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
    disbursedTransactionId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  })
  .refine((data) => data.monthlyAmountMinor !== undefined || data.interestRatePctAnnual != null, {
    message: "Give either the monthly amount or an interest rate to compute it from",
  });

// POST /loans — added directly, unlike an EMI which only ever comes from
// converting a purchase. A loan's principal is very often money SpendLog
// never saw arrive at all, so there is nothing to convert it from.
loansRouter.post("/", async (req, res) => {
  const parsed = createLoanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const { label, principalMinor, months, interestRatePctAnnual } = parsed.data;

  if (parsed.data.accountId) {
    const owned = await Account.exists({ _id: parsed.data.accountId, userId });
    if (!owned) return res.status(400).json({ error: "Unknown account" });
  }
  if (parsed.data.disbursedTransactionId) {
    const owned = await Transaction.exists({ _id: parsed.data.disbursedTransactionId, userId });
    if (!owned) return res.status(400).json({ error: "Unknown transaction" });
  }

  // The entered figure is authoritative; the rate is only a way to arrive
  // at one when the paperwork isn't to hand.
  const monthlyAmountMinor =
    parsed.data.monthlyAmountMinor ??
    monthlyInstalmentMinor(principalMinor, months, interestRatePctAnnual ?? 0);

  const startDate = parsed.data.startDate ?? new Date();

  const loan = await Loan.create({
    userId,
    label,
    accountId: parsed.data.accountId ?? null,
    disbursedTransactionId: parsed.data.disbursedTransactionId ?? null,
    principalMinor,
    months,
    monthlyAmountMinor,
    totalPayableMinor: monthlyAmountMinor * months,
    interestRatePctAnnual: interestRatePctAnnual ?? null,
    processingFeeMinor: parsed.data.processingFeeMinor ?? null,
    startDate,
    status: "ACTIVE",
  });

  await LoanInstalment.insertMany(
    buildSchedule(startDate, months, monthlyAmountMinor).map((entry) => ({
      userId,
      loanId: loan._id,
      ...entry,
    }))
  );

  res.status(201).json(loan);
});

const updateLoanSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  status: z.enum(["ACTIVE", "CLOSED"]).optional(),
});

// PATCH /loans/:id — rename, or close it early. Closing is settling up
// outside the schedule - paid off in one go, forgiven, whatever the reason
// - so what is left stops being due rather than sitting there forever.
loansRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateLoanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const loan = await Loan.findOne({ _id: req.params.id, userId });
  if (!loan) return res.status(404).json({ error: "Not found" });

  if (parsed.data.label !== undefined) loan.label = parsed.data.label;
  if (parsed.data.status) loan.status = parsed.data.status;
  await loan.save();

  if (parsed.data.status === "CLOSED") {
    await LoanInstalment.updateMany({ loanId: loan._id, status: "DUE" }, { $set: { status: "SKIPPED" } });
  }

  res.json(loan);
});

// DELETE /loans/:id — it was added by mistake. Any transaction already
// linked to one of its instalments is freed rather than left pointing at
// nothing, the same as an EMI's purchase goes back to counting on its own
// when the plan converting it is undone.
loansRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const loan = await Loan.findOne({ _id: req.params.id, userId });
  if (!loan) return res.status(404).json({ error: "Not found" });

  await Transaction.updateMany({ userId, loanId: loan._id }, { $set: { loanId: null } });
  await LoanInstalment.deleteMany({ loanId: loan._id });
  await loan.deleteOne();

  res.status(204).end();
});

const payInstalmentSchema = z.object({
  transactionId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
});

// POST /loans/instalments/:id/pay — mark one as paid by hand, for a
// repayment that never produced a message to match against - cash handed
// over, or a transfer from an account SpendLog does not read.
loansRouter.post("/instalments/:id/pay", validObjectIdParam("id"), async (req, res) => {
  const parsed = payInstalmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const instalment = await LoanInstalment.findOne({ _id: req.params.id, userId });
  if (!instalment) return res.status(404).json({ error: "Not found" });

  instalment.status = "PAID";
  instalment.paidAt = new Date();
  if (parsed.data.transactionId) {
    instalment.transactionId = (
      await Transaction.findOne({ _id: parsed.data.transactionId, userId })
    )?._id;
  }
  await instalment.save();

  await closeLoanIfFinished(instalment.loanId);

  res.json(instalment);
});

/** A loan with nothing left due has run its course. */
export async function closeLoanIfFinished(loanId: unknown): Promise<void> {
  const stillDue = await LoanInstalment.countDocuments({ loanId, status: "DUE" });
  if (stillDue === 0) {
    await Loan.updateOne({ _id: loanId, status: "ACTIVE" }, { $set: { status: "CLOSED" } });
  }
}

/**
 * The reverse of the above: an instalment that was paid, and has just been
 * put back to being due, means a loan closed by finishing its schedule is
 * not actually finished any more.
 *
 * Only ever fires on a loan that closed itself this way - one closed by
 * hand, or cancelled, is left alone. Unpicking a payment is not the same
 * decision as choosing to reopen a loan someone deliberately settled.
 */
export async function reopenLoanIfNeeded(loanId: unknown): Promise<void> {
  await Loan.updateOne({ _id: loanId, status: "CLOSED" }, { $set: { status: "ACTIVE" } });
}
