import { Types } from "mongoose";
import { Loan, LoanInstalment } from "../../models";
import { addMonths } from "../emi/emi.schedule";

/** A change the loan cannot take, worded for the person who asked for it. */
export class LoanEditError extends Error {}

/**
 * Re-lays a loan's schedule after its term, start or monthly figure changed.
 *
 * Instalments are kept by sequence number rather than thrown away and
 * rebuilt, because a paid one carries a fact worth keeping - the payment it
 * was matched to. Paid ones are re-dated but keep the amount they were paid
 * at; due ones take the new monthly figure.
 */
export async function rescheduleLoan(
  loanId: Types.ObjectId,
  schedule: { startDate: Date; months: number; monthlyAmountMinor: number }
): Promise<void> {
  const existing = await LoanInstalment.find({ loanId }).sort({ seq: 1 });

  const paidBeyond = existing.filter((row) => row.seq > schedule.months && row.status === "PAID");
  if (paidBeyond.length > 0) {
    throw new LoanEditError(
      `${paidBeyond.length} ${paidBeyond.length === 1 ? "instalment" : "instalments"} past month ` +
        `${schedule.months} ${paidBeyond.length === 1 ? "is" : "are"} already paid - ` +
        "a shorter term would lose them."
    );
  }

  const bySeq = new Map(existing.map((row) => [row.seq, row]));
  const userId = existing[0]?.userId ?? (await Loan.findById(loanId).orFail()).userId;

  for (let seq = 1; seq <= schedule.months; seq += 1) {
    const dueDate = addMonths(schedule.startDate, seq - 1);
    const row = bySeq.get(seq);

    if (!row) {
      await LoanInstalment.create({
        userId,
        loanId,
        seq,
        dueDate,
        amountMinor: schedule.monthlyAmountMinor,
        status: "DUE",
      });
      continue;
    }

    row.dueDate = dueDate;
    if (row.status !== "PAID") row.amountMinor = schedule.monthlyAmountMinor;
    await row.save();
  }

  await LoanInstalment.deleteMany({ loanId, seq: { $gt: schedule.months } });
}

/**
 * Brings the number of paid instalments to exactly `target`.
 *
 * For a loan that was already running before it was added here: five of
 * twelve paid long before SpendLog ever saw a message about it. Marking
 * goes oldest first; unmarking goes newest first, and only touches ones
 * that were ticked by hand - one matched to a real payment is undone from
 * that payment, not by lowering a number.
 */
export async function setPaidCount(loanId: Types.ObjectId, target: number): Promise<void> {
  const rows = await LoanInstalment.find({ loanId }).sort({ seq: 1 });
  if (target > rows.length) {
    throw new LoanEditError(`This loan only has ${rows.length} instalments.`);
  }

  const paid = rows.filter((row) => row.status === "PAID");
  const now = new Date();

  if (target > paid.length) {
    const toMark = rows.filter((row) => row.status !== "PAID").slice(0, target - paid.length);
    for (const row of toMark) {
      row.status = "PAID";
      // When it would have been paid, rather than today: the point is
      // recording something that already happened.
      row.paidAt = row.dueDate < now ? row.dueDate : now;
      row.transactionId = null;
      await row.save();
    }
  } else if (target < paid.length) {
    const manual = paid.filter((row) => !row.transactionId).reverse();
    const needed = paid.length - target;
    if (manual.length < needed) {
      const linked = paid.length - manual.length;
      throw new LoanEditError(
        `${linked} paid ${linked === 1 ? "instalment is" : "instalments are"} linked to a real payment. ` +
          "Unlink those from the payment itself to go lower."
      );
    }
    for (const row of manual.slice(0, needed)) {
      row.status = "DUE";
      row.paidAt = null;
      await row.save();
    }
  }
}

/**
 * Whether a loan is running, from what is left on its schedule.
 *
 * Finished when nothing is due. Running again when an edit put something
 * back on it - a longer term, or a paid count lowered - since whatever
 * closed it no longer describes it.
 */
export async function syncLoanStatus(loanId: Types.ObjectId): Promise<void> {
  const stillDue = await LoanInstalment.countDocuments({ loanId, status: "DUE" });
  await Loan.updateOne({ _id: loanId }, { $set: { status: stillDue === 0 ? "CLOSED" : "ACTIVE" } });
}
