import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Loan, LoanInstalment, Transaction } from "../../models";
import { splitsOf } from "./loans.allocation";
import { reallocateLoan } from "./loans.splits";

/**
 * Moves every loan repayment onto loanSplits, and every loan onto the
 * running tab.
 *
 * A repayment from before splits named one loan in loanId and repaid it
 * with the whole amount, so that is the one split it becomes. Written out
 * rather than only read that way, because the budget's fixed costs and the
 * tab both sum split amounts in the database, and one shape there is
 * simpler than two forever - though every reader still falls back to
 * loanId (splitsOf), so a row this has not reached yet is never wrong.
 *
 * Then each loan's payments are poured in afresh. Before the tab, a
 * payment ticked one instalment whatever it came to; now it covers what
 * it actually paid, oldest first. An instalment marked paid that no
 * linked payment explains - ticked by hand, or pointed at a payment that
 * does not say it repays this loan - is kept paid, as a tick by hand.
 */
export const LOAN_SPLIT_BACKFILL = "loanSplits";
export const LOAN_SPLIT_BACKFILL_VERSION = 1;

/** One user's pass. Safe to run twice: the second changes nothing. */
export async function backfillLoanSplits(userId: Types.ObjectId): Promise<number> {
  const moved = await Transaction.collection.updateMany(
    {
      userId,
      loanId: { $ne: null },
      $or: [{ loanSplits: { $exists: false } }, { loanSplits: { $size: 0 } }],
    },
    [{ $set: { loanSplits: [{ loanId: "$loanId", amountMinor: "$amountMinor" }] } }]
  );

  const loans = await Loan.find({ userId }).select("_id");
  for (const loan of loans) {
    const paid = await LoanInstalment.find({ loanId: loan._id, status: "PAID", byHand: { $ne: true } });
    const linkedIds = paid.map((row) => row.transactionId).filter((id): id is Types.ObjectId => !!id);
    const linked = await Transaction.find({ _id: { $in: linkedIds } }).select("loanId loanSplits amountMinor");
    const repaysThis = new Set(
      linked
        .filter((row) => splitsOf(row).some((split) => split.loanId === String(loan._id)))
        .map((row) => String(row._id))
    );

    for (const row of paid) {
      if (row.transactionId && repaysThis.has(String(row.transactionId))) continue;
      row.byHand = true;
      row.paidMinor = row.amountMinor;
      await row.save();
    }
    await reallocateLoan(loan._id);
  }

  return moved.modifiedCount + loans.length;
}

/** Every user who has not had this pass yet. Called once at start-up. */
export async function runLoanSplitBackfill(): Promise<void> {
  const { users, changed } = await runOncePerUser(LOAN_SPLIT_BACKFILL, LOAN_SPLIT_BACKFILL_VERSION, backfillLoanSplits);
  if (changed > 0) console.log(`Loan split backfill: brought ${changed} repayments and loans across ${users} users onto the tab.`);
}
