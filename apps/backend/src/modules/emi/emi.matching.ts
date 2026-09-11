import { HydratedDocument } from "mongoose";
import { EmiInstalment, TransactionDoc } from "../../models";
import { closePlanIfFinished } from "./emi.routes";

/** A bank bills the EMI on its own schedule, not always on the due date. */
const DUE_WINDOW_DAYS = 12;

/**
 * Paise of slack when comparing a debit to a scheduled instalment.
 *
 * A card's final instalment often differs by a rupee or two from the rest
 * as the issuer squares off its own rounding, so an exact match would miss
 * the very payment that closes the plan.
 */
const AMOUNT_TOLERANCE_MINOR = 500;

/**
 * Links a newly ingested debit to the instalment it pays, if it is one.
 *
 * The alternative — asking the user to tick off each month — is the kind
 * of upkeep that gets abandoned by March, at which point the schedule says
 * nothing true.
 *
 * Nothing about the transaction changes except its role: an instalment
 * counts in full, because paying it is the actual spending.
 */
export async function matchEmiInstalment(
  transaction: HydratedDocument<TransactionDoc>
): Promise<boolean> {
  if (transaction.type !== "DEBIT") return false;
  // Already spoken for — as a purchase converted to a plan, or a payment
  // matched on an earlier pass.
  if (transaction.emiPlanId) return false;

  const windowMs = DUE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  const candidates = await EmiInstalment.find({
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
    .populate("planId");

  if (candidates.length === 0) return false;

  // Prefer one whose plan is on the same card, when both are known. Two
  // cards billing a similar instalment in the same fortnight is otherwise
  // a coin toss.
  const onSameAccount = candidates.find((candidate) => {
    const plan = candidate.planId as unknown as { accountId?: unknown } | null;
    const planAccount = plan?.accountId;
    if (!planAccount || !transaction.accountId) return false;
    return String(planAccount) === String(transaction.accountId);
  });

  // Falling back to the soonest due is safe: they are the same amount
  // within tolerance, so the worst case is attributing a payment to the
  // right plan a month early.
  const instalment = onSameAccount ?? candidates[0];

  instalment.status = "PAID";
  instalment.paidAt = new Date();
  instalment.transactionId = transaction._id;
  await instalment.save();

  transaction.emiPlanId = instalment.planId as never;
  transaction.emiRole = "INSTALMENT";
  await transaction.save();

  await closePlanIfFinished(instalment.planId);

  return true;
}
