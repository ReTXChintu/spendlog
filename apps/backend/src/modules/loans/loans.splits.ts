import { HydratedDocument, Types } from "mongoose";
import { Loan, LoanInstalment, Transaction, TransactionDoc } from "../../models";
import { LoanPayment, allocate, splitsOf } from "./loans.allocation";

/** A split the payment cannot take, worded for the person who sent it. */
export class LoanSplitError extends Error {}

/**
 * Every payment towards these loans, as each loan's share of it. Reads
 * rows from before loanSplits existed too - one loan, the whole amount -
 * so nothing depends on the backfill having reached them yet.
 */
export async function paymentsFor(
  loanIds: Types.ObjectId[],
  options: { excludeTransactionId?: Types.ObjectId | null } = {}
): Promise<Map<string, (LoanPayment & { totalMinor: number; merchant: string | null })[]>> {
  const byLoan = new Map<string, (LoanPayment & { totalMinor: number; merchant: string | null })[]>();
  if (loanIds.length === 0) return byLoan;

  const rows = await Transaction.find({
    type: "DEBIT",
    $or: [
      { "loanSplits.loanId": { $in: loanIds } },
      { loanId: { $in: loanIds }, "loanSplits.0": { $exists: false } },
    ],
    ...(options.excludeTransactionId ? { _id: { $ne: options.excludeTransactionId } } : {}),
  })
    .select("loanId loanSplits amountMinor occurredAt merchant")
    .sort({ occurredAt: 1, _id: 1 });

  const wanted = new Set(loanIds.map(String));
  for (const row of rows) {
    for (const split of splitsOf(row)) {
      if (!wanted.has(split.loanId)) continue;
      const list = byLoan.get(split.loanId) ?? [];
      list.push({
        transactionId: row._id,
        amountMinor: split.amountMinor,
        occurredAt: row.occurredAt,
        totalMinor: row.amountMinor,
        merchant: row.merchant ?? null,
      });
      byLoan.set(split.loanId, list);
    }
  }
  return byLoan;
}

/**
 * Re-pours a loan's payments into its instalments and stores the result,
 * then opens or closes the loan to match.
 *
 * Called whenever anything that feeds the pool changes - a payment linked,
 * re-split, unlinked or deleted, an instalment ticked by hand, a schedule
 * re-laid - so the stored statuses, which matching and the budget query
 * directly, are always what the arithmetic says.
 */
export async function reallocateLoan(loanId: Types.ObjectId | string): Promise<void> {
  const id = new Types.ObjectId(String(loanId));
  const loan = await Loan.findById(id);
  if (!loan) return;

  const [rows, payments] = await Promise.all([
    LoanInstalment.find({ loanId: id }).sort({ seq: 1 }),
    paymentsFor([id]),
  ]);
  const { coverage } = allocate(rows, payments.get(String(id)) ?? []);

  for (const [index, row] of rows.entries()) {
    const next = coverage[index];
    const changed =
      row.status !== next.status ||
      (row.paidMinor ?? 0) !== next.paidMinor ||
      String(row.transactionId ?? null) !== String(next.transactionId ?? null);
    if (!changed) continue;

    row.status = next.status;
    row.paidMinor = next.paidMinor;
    // A row ticked by hand keeps what it was ticked with.
    if (!row.byHand && !(next.status === "PAID" && !next.transactionId)) {
      row.transactionId = (next.transactionId as Types.ObjectId | null) ?? null;
      row.paidAt = next.status === "PAID" || next.status === "PARTIAL" ? next.paidAt : null;
    }
    await row.save();
  }

  // Finished when nothing is owed; running again when something is. Only
  // between those two - a cancelled loan stays cancelled whatever its
  // payments say.
  const stillOwed = coverage.some((row) => row.status === "DUE" || row.status === "PARTIAL");
  if (!stillOwed && loan.status === "ACTIVE") {
    await Loan.updateOne({ _id: id }, { $set: { status: "CLOSED" } });
  } else if (stillOwed && loan.status === "CLOSED") {
    await Loan.updateOne({ _id: id }, { $set: { status: "ACTIVE" } });
  }
}

export interface SplitInput {
  loanId: string;
  amountMinor: number;
}

/**
 * Checks a set of splits against the payment they divide. Returns the
 * splits to store, or throws a LoanSplitError saying what is wrong.
 *
 * Every loan has to be the user's own. A loan new to this payment has to
 * be running; one it already repays may have closed since - quite often
 * because this very payment finished it - and saving the payment again
 * must not be refused for that.
 */
export async function checkLoanSplits(
  userId: Types.ObjectId,
  amountMinor: number,
  splits: SplitInput[],
  alreadyOn: string[] = []
): Promise<{ loanId: Types.ObjectId; amountMinor: number }[]> {
  const seen = new Set<string>();
  for (const split of splits) {
    if (seen.has(split.loanId)) throw new LoanSplitError("Each loan can only appear once in a payment.");
    seen.add(split.loanId);
  }

  const total = splits.reduce((sum, split) => sum + split.amountMinor, 0);
  if (total > amountMinor) {
    throw new LoanSplitError(
      `The loans add up to ₹${((total - amountMinor) / 100).toLocaleString("en-IN")} more than the payment.`
    );
  }

  const loans = await Loan.find({ _id: { $in: splits.map((split) => split.loanId) }, userId }).select("status label");
  const byId = new Map(loans.map((loan) => [String(loan._id), loan]));
  for (const split of splits) {
    const loan = byId.get(split.loanId);
    if (!loan) throw new LoanSplitError("Unknown loan");
    if (loan.status !== "ACTIVE" && !alreadyOn.includes(split.loanId)) {
      throw new LoanSplitError(`${loan.label} is closed - reopen it to put a payment towards it.`);
    }
  }

  return splits.map((split) => ({ loanId: new Types.ObjectId(split.loanId), amountMinor: split.amountMinor }));
}

/**
 * Points a payment at a set of loans - none, one, or several - and brings
 * every loan it touched, before or after, up to date.
 *
 * Splits are assumed already checked (checkLoanSplits); the matcher, which
 * builds its own, skips that.
 */
export async function setLoanSplits(
  transaction: HydratedDocument<TransactionDoc>,
  splits: { loanId: Types.ObjectId; amountMinor: number }[]
): Promise<void> {
  const before = splitsOf(transaction).map((split) => split.loanId);

  transaction.loanSplits = splits as never;
  transaction.loanId = splits[0]?.loanId ?? null;
  await transaction.save();

  const touched = new Set([...before, ...splits.map((split) => String(split.loanId))]);
  for (const loanId of touched) await reallocateLoan(loanId);
}

/**
 * A payment's amount changed under its splits. One loan taking the whole
 * of it follows the new amount, since that is what a single-loan
 * repayment means; several have to fit inside it, or the edit has to say
 * how they divide now.
 */
export function splitsForNewAmount(
  transaction: Pick<TransactionDoc, "loanId" | "loanSplits" | "amountMinor">,
  amountMinor: number
): { loanId: Types.ObjectId; amountMinor: number }[] | null {
  const splits = splitsOf(transaction);
  if (splits.length === 0 || amountMinor === transaction.amountMinor) return null;

  if (splits.length === 1 && splits[0].amountMinor === transaction.amountMinor) {
    return [{ loanId: new Types.ObjectId(splits[0].loanId), amountMinor }];
  }
  const total = splits.reduce((sum, split) => sum + split.amountMinor, 0);
  if (total > amountMinor) {
    throw new LoanSplitError("The loans this repays add up to more than the new amount - change how it is split too.");
  }
  return null;
}
