import { HydratedDocument, Types } from "mongoose";
import { LoanInstalment, TransactionDoc } from "../../models";
import { splitsOf } from "./loans.allocation";
import { setLoanSplits } from "./loans.splits";
import { combinationsFor, duesAround, splitsFromDues } from "./loans.suggest";

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
  if (splitsOf(transaction).length > 0) return false;

  const windowMs = DUE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // A partly covered instalment is still the one this month's debit is
  // for: a loan a little ahead from last month still takes the usual
  // amount, and leaving it out would stop the debit matching at all.
  const candidates = await LoanInstalment.find({
    userId: transaction.userId,
    status: { $in: ["DUE", "PARTIAL"] },
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

  if (candidates.length === 0) return matchCombinedLoans(transaction);

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
  const loanId = (instalment.loanId as unknown as { _id: Types.ObjectId })._id ?? instalment.loanId;

  // The whole debit to that loan. Which instalment it then covers is the
  // tab's business - the oldest one still owed, the same as any payment.
  await setLoanSplits(transaction, [{ loanId, amountMinor: transaction.amountMinor }]);

  return true;
}

/**
 * One debit that repays several loans at once: when no single instalment
 * fits, but what a few running loans have owing adds up to the debit
 * within a rupee.
 *
 * Applied only when exactly one set of loans fits. Two sets that both add
 * up - ₹5,000 + ₹5,000 against ₹10,000 owed on a third, say - is a guess,
 * and a wrong guess here is worse than none: it would mark loans paid that
 * were not, and hide the one that was. Left alone, the editor offers the
 * same sets to pick from (GET /loans/split-suggestion).
 *
 * A set of one is left alone too. That is the single-loan matcher's call,
 * and it already declined.
 */
export async function matchCombinedLoans(transaction: HydratedDocument<TransactionDoc>): Promise<boolean> {
  if (transaction.type !== "DEBIT" || transaction.emiRole) return false;
  if (splitsOf(transaction).length > 0) return false;

  const dues = await duesAround(transaction.userId, transaction.occurredAt);
  const sets = combinationsFor(dues, transaction.amountMinor);
  if (sets.length !== 1 || sets[0].length < 2) return false;

  const picked = dues.filter((due) => sets[0].includes(due.loanId));
  const splits = splitsFromDues(picked, transaction.amountMinor);
  await setLoanSplits(
    transaction,
    splits.map((split) => ({ loanId: new Types.ObjectId(split.loanId), amountMinor: split.amountMinor }))
  );
  return true;
}

/**
 * Claiming a loan by hand, from the payment's own edit screen: the whole
 * payment towards that one loan.
 *
 * Unlike the matcher above, this carries no doubt about which loan is
 * meant - someone has already said so - so the amount is not checked
 * against anything. The money goes into the oldest instalment still owed,
 * like any payment: an extra one runs on into the next, a short one leaves
 * the instalment partly covered.
 *
 * Leaves the transaction linked to the loan even when nothing is left to
 * cover - a loan already fully scheduled can still take an extra payment,
 * and that payment is still a fact about the loan worth keeping.
 */
export async function attachToLoan(
  transaction: HydratedDocument<TransactionDoc>,
  loanId: Types.ObjectId
): Promise<void> {
  await setLoanSplits(transaction, [{ loanId, amountMinor: transaction.amountMinor }]);
}
