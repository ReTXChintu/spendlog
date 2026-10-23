import { HydratedDocument, Types } from "mongoose";
import { EmiInstalment, EmiInstalmentDoc, Transaction, TransactionDoc } from "../../models";
import { closePlanIfFinished } from "./emi.routes";

/** A bank bills the EMI on its own schedule, not always on the due date. */
const DUE_WINDOW_DAYS = 12;
const DUE_WINDOW_MS = DUE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Paise of slack when comparing a debit to a scheduled instalment.
 *
 * A card's final instalment often differs by a rupee or two from the rest
 * as the issuer squares off its own rounding, so an exact match would miss
 * the very payment that closes the plan.
 */
export const AMOUNT_TOLERANCE_MINOR = 500;

/**
 * Whether a debit could be this instalment's payment: a debit not already
 * spoken for, within the window either side of the due date, and the
 * amount within tolerance. The one rule both directions use - a new debit
 * looking for its instalment, and a new plan looking back for debits that
 * already arrived.
 */
export function couldPay(
  debit: Pick<TransactionDoc, "type" | "amountMinor" | "occurredAt" | "emiPlanId">,
  instalment: Pick<EmiInstalmentDoc, "status" | "dueDate" | "amountMinor">
): boolean {
  if (debit.type !== "DEBIT" || debit.emiPlanId) return false;
  if (instalment.status !== "DUE") return false;
  if (Math.abs(debit.occurredAt.getTime() - instalment.dueDate.getTime()) > DUE_WINDOW_MS) return false;
  return Math.abs(debit.amountMinor - instalment.amountMinor) <= AMOUNT_TOLERANCE_MINOR;
}

/** Records that a debit paid an instalment, on both sides. */
async function link(
  instalment: HydratedDocument<EmiInstalmentDoc>,
  transaction: HydratedDocument<TransactionDoc>
): Promise<void> {
  instalment.status = "PAID";
  instalment.paidAt = new Date();
  instalment.transactionId = transaction._id;
  await instalment.save();

  // Saved rather than updated so the counted-amount hook runs. An
  // instalment counts in full: paying it is the actual spending.
  transaction.emiPlanId = instalment.planId;
  transaction.emiRole = "INSTALMENT";
  await transaction.save();
}

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
  // Already spoken for — as a purchase converted to a plan, or a payment
  // matched on an earlier pass.
  if (transaction.type !== "DEBIT" || transaction.emiPlanId) return false;

  const candidates = (
    await EmiInstalment.find({
      userId: transaction.userId,
      status: "DUE",
      dueDate: {
        $gte: new Date(transaction.occurredAt.getTime() - DUE_WINDOW_MS),
        $lte: new Date(transaction.occurredAt.getTime() + DUE_WINDOW_MS),
      },
      amountMinor: {
        $gte: transaction.amountMinor - AMOUNT_TOLERANCE_MINOR,
        $lte: transaction.amountMinor + AMOUNT_TOLERANCE_MINOR,
      },
    })
      .sort({ dueDate: 1 })
      .populate("planId")
  ).filter((candidate) => couldPay(transaction, candidate));

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
  // The populated plan has to go back to an id before saving.
  instalment.planId = (instalment.planId as unknown as { _id: Types.ObjectId })._id ?? instalment.planId;

  await link(instalment, transaction);
  await closePlanIfFinished(instalment.planId);

  return true;
}

/**
 * The other direction: a plan just added for an EMI that was already
 * running looks back for debits that already arrived and pay it - the
 * months since SpendLog started tracking, which came in before anything
 * knew they were instalments.
 *
 * Only instalments due from `since` on are looked for: before it nothing
 * was imported, so there is nothing to find. The plan's own account is
 * preferred, as when a debit looks for its instalment; each debit pays at
 * most one instalment. Returns how many were linked.
 */
export async function matchExistingDebits(
  plan: { _id: Types.ObjectId; userId: Types.ObjectId; accountId?: Types.ObjectId | null },
  since: Date
): Promise<number> {
  const instalments = await EmiInstalment.find({
    planId: plan._id,
    status: "DUE",
    dueDate: { $gte: new Date(since.getTime() - DUE_WINDOW_MS) },
  }).sort({ seq: 1 });

  const taken = new Set<string>();
  let linked = 0;
  for (const instalment of instalments) {
    const debits = (
      await Transaction.find({
        userId: plan.userId,
        type: "DEBIT",
        emiPlanId: null,
        occurredAt: {
          $gte: new Date(Math.max(since.getTime(), instalment.dueDate.getTime() - DUE_WINDOW_MS)),
          $lte: new Date(instalment.dueDate.getTime() + DUE_WINDOW_MS),
        },
        amountMinor: {
          $gte: instalment.amountMinor - AMOUNT_TOLERANCE_MINOR,
          $lte: instalment.amountMinor + AMOUNT_TOLERANCE_MINOR,
        },
      }).sort({ occurredAt: 1 })
    ).filter((debit) => !taken.has(debit.id) && couldPay(debit, instalment));
    if (debits.length === 0) continue;

    // Nearest the due date wins among the same account's, then anyone's.
    const nearest = (rows: typeof debits) =>
      [...rows].sort(
        (a, b) =>
          Math.abs(a.occurredAt.getTime() - instalment.dueDate.getTime()) -
          Math.abs(b.occurredAt.getTime() - instalment.dueDate.getTime())
      )[0];
    const sameAccount = plan.accountId
      ? debits.filter((debit) => debit.accountId && debit.accountId.equals(plan.accountId!))
      : [];
    const debit = nearest(sameAccount.length > 0 ? sameAccount : debits);

    taken.add(debit.id);
    await link(instalment, debit);
    linked += 1;
  }
  return linked;
}
