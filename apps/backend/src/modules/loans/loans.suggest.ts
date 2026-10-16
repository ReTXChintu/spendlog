import { Types } from "mongoose";
import { Loan, LoanInstalment, Transaction } from "../../models";
import { istDayEnd, istDayKey } from "../../time";
import { addMonths } from "../emi/emi.schedule";
import { allocate, loanTab, splitsOf } from "./loans.allocation";
import { paymentsFor } from "./loans.splits";

/** One rupee either way, for "these loans add up to this payment". */
export const COMBINED_TOLERANCE_MINOR = 100;

/** More than this many loans owing at once, and nobody is guessing. */
const MAX_LOANS_TO_COMBINE = 12;

export interface LoanDue {
  loanId: string;
  label: string;
  /// Still owed on the instalments this payment is for, net of whatever
  /// earlier payments already put towards them.
  dueMinor: number;
  instalments: { seq: number; on: string; amountMinor: number; shortMinor: number }[];
  balanceMinor: number;
  aheadMinor: number;
  behindMinor: number;
}

/**
 * What each running loan has owing for a payment made on `on`: every
 * instalment due by that day and not yet covered - or, with none, the next
 * one, if it falls due within a month.
 *
 * Someone who repays every loan in one go on the 5th is paying for the
 * one due on the 3rd (just past), and the 10th and the 28th (coming up)
 * alike. Overdue ones win when there are any, so a loan due on the 28th
 * whose September instalment is still open is asked for that, not for
 * September's and October's together.
 *
 * An "ahead" loan has had its extra poured into these same instalments
 * already, so it shows only what is left - or nothing at all.
 *
 * With `excludeTransactionId`, works it out as if that payment had never
 * been linked: re-suggesting for a payment being edited must not count
 * its own money twice. A loan that payment repays is included even if it
 * has closed since - very often that payment is what closed it.
 */
export async function duesAround(
  userId: Types.ObjectId,
  on: Date,
  options: { excludeTransactionId?: Types.ObjectId | null; now?: Date } = {}
): Promise<LoanDue[]> {
  let alsoLoans: string[] = [];
  if (options.excludeTransactionId) {
    const own = await Transaction.findOne({ _id: options.excludeTransactionId, userId }).select(
      "loanId loanSplits amountMinor"
    );
    alsoLoans = own ? splitsOf(own).map((split) => split.loanId) : [];
  }

  const loans = await Loan.find({
    userId,
    $or: [{ status: "ACTIVE" }, { _id: { $in: alsoLoans } }],
  }).sort({ createdAt: 1 });
  const ids = loans.map((loan) => loan._id);
  const [instalments, payments] = await Promise.all([
    LoanInstalment.find({ loanId: { $in: ids } }).sort({ seq: 1 }),
    paymentsFor(ids, { excludeTransactionId: options.excludeTransactionId }),
  ]);

  const endOfDay = istDayEnd(istDayKey(on)).getTime();
  const withinAMonth = addMonths(on, 1).getTime();

  return loans.map((loan) => {
    const rows = instalments.filter((row) => row.loanId.equals(loan._id));
    const own = payments.get(String(loan._id)) ?? [];
    const { coverage } = allocate(rows, own);
    const covered = rows.map((row, index) => ({
      seq: row.seq,
      dueDate: row.dueDate,
      amountMinor: row.amountMinor,
      byHand: row.byHand,
      transactionId: coverage[index].transactionId,
      status: coverage[index].status,
      paidMinor: coverage[index].paidMinor,
    }));

    const open = covered.filter((row) => row.status === "DUE" || row.status === "PARTIAL");
    const overdue = open.filter((row) => row.dueDate.getTime() <= endOfDay);
    const upcoming = open.find((row) => row.dueDate.getTime() > endOfDay && row.dueDate.getTime() < withinAMonth);
    const owing = (overdue.length > 0 ? overdue : upcoming ? [upcoming] : []).map((row) => ({
        seq: row.seq,
        on: istDayKey(row.dueDate),
        amountMinor: row.amountMinor,
        shortMinor: row.amountMinor - row.paidMinor,
      }));
    const tab = loanTab(
      covered,
      own.reduce((sum, payment) => sum + payment.amountMinor, 0),
      options.now
    );

    return {
      loanId: String(loan._id),
      label: loan.label,
      dueMinor: owing.reduce((sum, row) => sum + row.shortMinor, 0),
      instalments: owing,
      balanceMinor: tab.balanceMinor,
      aheadMinor: tab.aheadMinor,
      behindMinor: tab.behindMinor,
    };
  });
}

/**
 * Every set of loans whose dues add up to the amount, within a rupee.
 * Smallest sets first. Empty when too many loans are owing to say.
 */
export function combinationsFor(dues: Pick<LoanDue, "loanId" | "dueMinor">[], amountMinor: number): string[][] {
  const owing = dues.filter((due) => due.dueMinor > 0);
  if (owing.length === 0 || owing.length > MAX_LOANS_TO_COMBINE) return [];

  const found: string[][] = [];
  for (let mask = 1; mask < 1 << owing.length; mask += 1) {
    let total = 0;
    const picked: string[] = [];
    owing.forEach((due, index) => {
      if (mask & (1 << index)) {
        total += due.dueMinor;
        picked.push(due.loanId);
      }
    });
    if (Math.abs(total - amountMinor) <= COMBINED_TOLERANCE_MINOR) found.push(picked);
  }
  return found.sort((a, b) => a.length - b.length);
}

/**
 * The loans' dues as splits of a payment, trimmed so they never add up to
 * more than it: the rupee of rounding comes off the last one rather than
 * making the split invalid.
 */
export function splitsFromDues(
  dues: Pick<LoanDue, "loanId" | "dueMinor">[],
  amountMinor: number
): { loanId: string; amountMinor: number }[] {
  const splits = dues.filter((due) => due.dueMinor > 0).map((due) => ({ loanId: due.loanId, amountMinor: due.dueMinor }));
  const over = splits.reduce((sum, split) => sum + split.amountMinor, 0) - amountMinor;
  if (over > 0 && splits.length > 0) splits[splits.length - 1].amountMinor -= over;
  return splits.filter((split) => split.amountMinor > 0);
}
