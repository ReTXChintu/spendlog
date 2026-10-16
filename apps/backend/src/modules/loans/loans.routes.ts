import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Loan, LoanDoc, LoanInstalment, Transaction } from "../../models";
import { istDayKey, istDayStart } from "../../time";
import { buildSchedule, monthlyInstalmentMinor } from "../emi/emi.schedule";
import { loanTab, tabTotals } from "./loans.allocation";
import { LoanEditError, rescheduleLoan, setPaidCount, syncLoanStatus } from "./loans.edit";
import { paymentsFor, reallocateLoan } from "./loans.splits";
import { combinationsFor, duesAround } from "./loans.suggest";

export const loansRouter = Router();
loansRouter.use(requireAuth);

/**
 * A loan taken outside a card, tracked the way an EMI is: a schedule of
 * instalments, each a real payment can be matched to. See models/index.ts
 * for why this is a plan of its own rather than the same one EMIs use -
 * there is no purchase here to convert, and so nothing to keep out of the
 * totals once instalments start counting.
 */

// GET /loans — every loan, with its instalments, where it stands against
// its schedule, and each payment towards it with its share. `?totals=1`
// wraps the list as { loans, totals }, for the tab across every running
// loan; without it the list is the bare array it has always been, so an
// app that predates the tab keeps reading it.
loansRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const loans = await Loan.find({ userId }).sort({ status: 1, startDate: -1 }).populate("accountId");
  const instalments = await LoanInstalment.find({
    loanId: { $in: loans.map((loan) => loan._id) },
  })
    .sort({ seq: 1 })
    .populate("transactionId");
  const standing = await loanStanding(loans, instalments);

  const listed = loans.map((loan, index) => {
    const own = instalments.filter((instalment) => instalment.loanId.equals(loan._id));
    return { ...loan.toJSON(), instalments: own.map((instalment) => instalment.toJSON()), ...standing[index] };
  });

  if (req.query.totals === "1") {
    const running = standing.filter((_, index) => loans[index].status === "ACTIVE");
    return res.json({ loans: listed, totals: tabTotals(running) });
  }
  res.json(listed);
});

/**
 * Where each loan stands: its progress through the schedule, its tab
 * (ahead or behind), and every payment towards it with its share. Shared
 * with the dashboard, so the two never disagree about a loan.
 */
export async function loanStanding(
  loans: Pick<LoanDoc, "_id">[],
  instalments: {
    loanId: Types.ObjectId;
    seq: number;
    status: string;
    amountMinor: number;
    paidMinor?: number;
    byHand?: boolean;
    transactionId?: unknown;
    dueDate: Date;
  }[],
  now = new Date()
) {
  const payments = await paymentsFor(loans.map((loan) => loan._id));
  return loans.map((loan) => {
    const own = instalments.filter((instalment) => instalment.loanId.equals(loan._id));
    const paid = payments.get(String(loan._id)) ?? [];
    return {
      ...loanProgress(own),
      ...loanTab(own, paid.reduce((sum, payment) => sum + payment.amountMinor, 0), now),
      // Newest first, the way a payment history reads.
      payments: [...paid].reverse().map((payment) => ({
        transactionId: String(payment.transactionId),
        occurredAt: payment.occurredAt,
        merchant: payment.merchant,
        amountMinor: payment.amountMinor,
        totalMinor: payment.totalMinor,
      })),
    };
  });
}

/**
 * Where a loan stands, from its instalments. Shared with the dashboard, so
 * the two never disagree about how much of a loan is left.
 *
 * A partly covered instalment is still owed, for what it is short by.
 * Also reads a card EMI's instalments, which are only ever due or paid.
 */
export function loanProgress(
  instalments: { seq: number; status: string; amountMinor: number; paidMinor?: number; dueDate: Date }[]
) {
  const paid = instalments.filter((instalment) => instalment.status === "PAID");
  const due = instalments
    .filter((instalment) => instalment.status === "DUE" || instalment.status === "PARTIAL")
    .sort((a, b) => a.seq - b.seq);
  const covered = (instalment: { status: string; amountMinor: number; paidMinor?: number }) =>
    instalment.status === "PAID" ? instalment.amountMinor : (instalment.paidMinor ?? 0);

  return {
    paidCount: paid.length,
    paidMinor: instalments.reduce((sum, instalment) => sum + covered(instalment), 0),
    // What is still to pay, ignoring anything deliberately skipped.
    remainingMinor: due.reduce((sum, instalment) => sum + instalment.amountMinor - covered(instalment), 0),
    nextDue: due[0] ? { dueDate: due[0].dueDate, amountMinor: due[0].amountMinor, seq: due[0].seq } : null,
  };
}

const IST_DAY = /^\d{4}-\d{2}-\d{2}$/;

const splitSuggestionSchema = z.object({
  amountMinor: z.coerce.number().int().nonnegative().default(0),
  /// The payment's date, as an IST day or an instant. Today when left out.
  on: z.string().optional(),
  /// A payment being edited: worked out as if it were not linked yet.
  transactionId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
});

// GET /loans/split-suggestion — how a payment made on `on` would divide
// across the running loans: what each has owing for that cycle, net of
// anything an earlier payment already put towards it, and what is left
// over (or missing) against `amountMinor`. `matches` lists every set of
// loans whose dues add up to the amount within a rupee, smallest first.
loansRouter.get("/split-suggestion", async (req, res) => {
  const parsed = splitSuggestionSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { amountMinor, transactionId } = parsed.data;
  const raw = parsed.data.on;
  const on = raw ? (IST_DAY.test(raw) ? istDayStart(raw) : new Date(raw)) : new Date();
  if (Number.isNaN(on.getTime())) return res.status(400).json({ error: "Unreadable date" });

  const dues = await duesAround(currentUserId(req), on, {
    excludeTransactionId: transactionId ? new Types.ObjectId(transactionId) : null,
  });
  const totalDueMinor = dues.reduce((sum, due) => sum + due.dueMinor, 0);

  res.json({
    amountMinor,
    on: istDayKey(on),
    loans: dues,
    totalDueMinor,
    // Positive is extra beyond what is owing, negative is short of it.
    remainderMinor: amountMinor - totalDueMinor,
    matches: amountMinor > 0 ? combinationsFor(dues, amountMinor).map((loanIds) => ({ loanIds })) : [],
  });
});

// GET /loans/upcoming — what falls due in the next window, for the
// dashboard's committed-outflow figure. Defaults to 45 days, the same as
// the EMI one, so a repayment just after month end is still in view.
loansRouter.get("/upcoming", async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? "45"), 10) || 45, 1), 365);
  const until = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const due = await LoanInstalment.find({
    userId: currentUserId(req),
    status: { $in: ["DUE", "PARTIAL"] },
    dueDate: { $lte: until },
  })
    .sort({ dueDate: 1 })
    .populate({ path: "loanId", populate: { path: "accountId" } });

  res.json({
    // Only what is still short on each: a part already paid is not about
    // to go out.
    totalMinor: due.reduce((sum, instalment) => sum + instalment.amountMinor - (instalment.paidMinor ?? 0), 0),
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
    /// For a loan that was already running before it was added: how many
    /// instalments were paid before SpendLog was keeping track.
    alreadyPaidCount: z.number().int().min(0).max(480).optional(),
  })
  .refine((data) => data.monthlyAmountMinor !== undefined || data.interestRatePctAnnual != null, {
    message: "Give either the monthly amount or an interest rate to compute it from",
  })
  .refine((data) => (data.alreadyPaidCount ?? 0) <= data.months, {
    message: "More instalments paid than the loan has",
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

  if (parsed.data.alreadyPaidCount) {
    await setPaidCount(loan._id, parsed.data.alreadyPaidCount);
    await syncLoanStatus(loan._id);
  }

  res.status(201).json(await Loan.findById(loan._id).orFail());
});

const updateLoanSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  status: z.enum(["ACTIVE", "CLOSED"]).optional(),
  principalMinor: z.number().int().positive().optional(),
  months: z.number().int().min(1).max(480).optional(),
  monthlyAmountMinor: z.number().int().positive().optional(),
  interestRatePctAnnual: z.number().min(0).max(100).nullable().optional(),
  startDate: z.coerce.date().optional(),
  accountId: z.string().regex(/^[0-9a-fA-F]{24}$/).nullable().optional(),
  /// How many instalments have been paid, all told. See setPaidCount.
  paidCount: z.number().int().min(0).max(480).optional(),
});

// PATCH /loans/:id — change anything about it. A new term, start or
// monthly figure re-lays the schedule, keeping whatever was already paid.
// Closing is settling up outside the schedule - paid off in one go,
// forgiven, whatever the reason - so what is left stops being due rather
// than sitting there forever; reopening puts it back.
loansRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateLoanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const loan = await Loan.findOne({ _id: req.params.id, userId });
  if (!loan) return res.status(404).json({ error: "Not found" });

  const data = parsed.data;
  if (data.accountId) {
    const owned = await Account.exists({ _id: data.accountId, userId });
    if (!owned) return res.status(400).json({ error: "Unknown account" });
  }

  const scheduleChanged =
    (data.months !== undefined && data.months !== loan.months) ||
    (data.monthlyAmountMinor !== undefined && data.monthlyAmountMinor !== loan.monthlyAmountMinor) ||
    (data.startDate !== undefined && data.startDate.getTime() !== loan.startDate.getTime());

  try {
    if (scheduleChanged) {
      await rescheduleLoan(loan._id, {
        startDate: data.startDate ?? loan.startDate,
        months: data.months ?? loan.months,
        monthlyAmountMinor: data.monthlyAmountMinor ?? loan.monthlyAmountMinor,
      });
    }
    if (data.paidCount !== undefined) await setPaidCount(loan._id, data.paidCount);
  } catch (error) {
    if (error instanceof LoanEditError) return res.status(400).json({ error: error.message });
    throw error;
  }

  if (data.label !== undefined) loan.label = data.label;
  if (data.principalMinor !== undefined) loan.principalMinor = data.principalMinor;
  if (data.interestRatePctAnnual !== undefined) loan.interestRatePctAnnual = data.interestRatePctAnnual;
  if (data.accountId !== undefined) loan.accountId = data.accountId ? new Types.ObjectId(data.accountId) : null;
  if (data.months !== undefined) loan.months = data.months;
  if (data.monthlyAmountMinor !== undefined) loan.monthlyAmountMinor = data.monthlyAmountMinor;
  if (data.startDate !== undefined) loan.startDate = data.startDate;
  loan.totalPayableMinor = loan.monthlyAmountMinor * loan.months;
  await loan.save();

  if (data.status === "CLOSED") {
    // A part already paid on one stays recorded against it; the rest of it
    // is settled along with everything after.
    await LoanInstalment.updateMany(
      { loanId: loan._id, status: { $in: ["DUE", "PARTIAL"] } },
      { $set: { status: "SKIPPED" } }
    );
    await Loan.updateOne({ _id: loan._id }, { $set: { status: "CLOSED" } });
  } else if (data.status === "ACTIVE") {
    await LoanInstalment.updateMany({ loanId: loan._id, status: "SKIPPED" }, { $set: { status: "DUE" } });
    await reallocateLoan(loan._id);
    await syncLoanStatus(loan._id);
  } else if (scheduleChanged || data.paidCount !== undefined) {
    await syncLoanStatus(loan._id);
  }

  res.json(await Loan.findById(loan._id).orFail());
});

// DELETE /loans/:id — it was added by mistake. Any transaction already
// linked to one of its instalments is freed rather than left pointing at
// nothing, the same as an EMI's purchase goes back to counting on its own
// when the plan converting it is undone. A payment split across loans
// keeps its other loans; this one's share becomes unassigned.
loansRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const loan = await Loan.findOne({ _id: req.params.id, userId });
  if (!loan) return res.status(404).json({ error: "Not found" });

  const linked = await Transaction.find({ userId, $or: [{ loanId: loan._id }, { "loanSplits.loanId": loan._id }] });
  for (const transaction of linked) {
    const kept = transaction.loanSplits.filter((split) => !split.loanId.equals(loan._id));
    transaction.loanSplits = kept as never;
    transaction.loanId = kept[0]?.loanId ?? null;
    await transaction.save();
  }
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
  instalment.byHand = true;
  instalment.paidMinor = instalment.amountMinor;
  instalment.paidAt = new Date();
  if (parsed.data.transactionId) {
    instalment.transactionId = (
      await Transaction.findOne({ _id: parsed.data.transactionId, userId })
    )?._id;
  }
  await instalment.save();

  // Payments it was partly covered by move on to the next one.
  await reallocateLoan(instalment.loanId);

  res.json(await LoanInstalment.findById(instalment._id).orFail());
});
