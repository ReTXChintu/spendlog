import { HydratedDocument, Types } from "mongoose";
import { LoanInstalment, TransactionDoc } from "../../models";
import { closeLoanIfFinished } from "./loans.routes";

/** A lender bills on its own schedule, not always on the due date. */
const DUE_WINDOW_DAYS = 12;

/**
 * Paise of slack when comparing a debit to a scheduled instalment.
 *
 * A loan's last instalment often differs by a rupee or two from the rest
 * as the lender squares off its own rounding, so an exact match would miss
 * the very payment that closes it.
 */
const AMOUNT_TOLERANCE_MINOR = 500;

/**
 * Links a newly ingested debit to the instalment it repays, if it is one.
 *
 * The alternative - asking someone to tick off each month by hand - is the
 * kind of upkeep that gets abandoned by March, at which point the schedule
 * says nothing true. The same reasoning as an EMI's own matcher, which
 * this is deliberately built to read like.
 */
export async function matchLoanInstalment(
  transaction: HydratedDocument<TransactionDoc>
): Promise<boolean> {
  if (transaction.type !== "DEBIT") return false;
  // Already spoken for - matched on an earlier pass, or picked by hand.
  if (transaction.loanId) return false;

  const windowMs = DUE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const candidates = await LoanInstalment.find({
    userId: transaction.userId,
    status: "DUE",
    dueDate: {
      $gte: new Date(transaction.occurredAt.getTime() - windowMs),
      $lte: new Date(transaction.occurredAt.getTime() + windowMs),
    },
    amountMinor: {
      $gte: transaction.amountMinor - AMOUNT_TOLERANCE_MINOR,
      $lte: transaction.amountMinor + AMOUNT_TOLERANCE_MINOR,
    },
  })
    .sort({ dueDate: 1 })
    .populate("loanId");

  if (candidates.length === 0) return false;

  // Prefer one whose loan repays from the same account, when both are
  // known. Two loans billing a similar instalment in the same fortnight is
  // otherwise a coin toss.
  const onSameAccount = candidates.find((candidate) => {
    const loan = candidate.loanId as unknown as { accountId?: unknown } | null;
    const loanAccount = loan?.accountId;
    if (!loanAccount || !transaction.accountId) return false;
    return String(loanAccount) === String(transaction.accountId);
  });

  // Falling back to the soonest due is safe: they are the same amount
  // within tolerance, so the worst case is attributing a payment to the
  // right loan a month early.
  const instalment = onSameAccount ?? candidates[0];

  instalment.status = "PAID";
  instalment.paidAt = new Date();
  instalment.transactionId = transaction._id;
  await instalment.save();

  transaction.loanId = instalment.loanId as never;
  await transaction.save();

  await closeLoanIfFinished(instalment.loanId);

  return true;
}

/**
 * Claiming a loan by hand, from the payment's own edit screen.
 *
 * Unlike the matcher above, this carries no doubt about which loan is
 * meant - someone has already said so - so it claims whichever instalment
 * on that loan is soonest due, without checking the amount against it.
 * The oldest still-due instalment is always the right one to close next
 * regardless of what this particular payment came to: an extra or a
 * short repayment still counts against the schedule in order.
 *
 * Leaves the transaction linked to the loan even when nothing is left to
 * claim - a loan already fully scheduled can still take an extra payment,
 * and that payment is still a fact about the loan worth keeping.
 */
export async function attachToLoan(
  transaction: HydratedDocument<TransactionDoc>,
  loanId: Types.ObjectId
): Promise<void> {
  transaction.loanId = loanId as never;

  const instalment = await LoanInstalment.findOne({ loanId, status: "DUE" }).sort({ seq: 1 });
  if (instalment) {
    instalment.status = "PAID";
    instalment.paidAt = new Date();
    instalment.transactionId = transaction._id;
    await instalment.save();
    await closeLoanIfFinished(loanId);
  }

  await transaction.save();
}
