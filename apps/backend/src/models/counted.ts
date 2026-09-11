import { CountedReason } from "../types";

/**
 * The fields the counted-amount rule looks at. Deliberately a plain shape
 * rather than a Mongoose document, so the rule can be applied to a document
 * being saved, to the merge of a document and a pending update, and to a
 * plain object in a test.
 *
 * The split, settlement and EMI fields do not exist on the schema yet —
 * they arrive with the features that need them. Until then those branches
 * are simply never taken, which is why the rule can be written once and
 * left alone.
 */
export interface CountedInput {
  amountMinor: number;
  isTransfer?: boolean | null;
  isSettlement?: boolean | null;
  excludeFromTotals?: boolean | null;
  /**
   * "PARENT" on the purchase that was converted to an EMI, "INSTALMENT" on
   * each monthly payment. The distinction is the whole point: zeroing both
   * would lose the spending entirely, and counting both would book it twice.
   */
  emiRole?: string | null;
  split?: { myShareMinor?: number | null } | null;
  /** Set on a credit that gives back money from an earlier purchase. */
  refundOfId?: unknown;
  /** On a purchase: how much of it has since come back as refunds. */
  refundedMinor?: number | null;
}

export interface CountedAmount {
  countedAmountMinor: number;
  countedReason: CountedReason;
}

/**
 * How much of this transaction counts as money the user actually spent or
 * received.
 *
 * `amountMinor` is what the bank moved, which is not always what was spent:
 * a split bill moved the whole table's money, an EMI purchase moves once
 * but is paid over a year, and settling up with a friend moves money that
 * was never income. Totals sum this instead, so the distinction lives in
 * one place rather than as a filter repeated across every aggregation.
 *
 * Order matters. A transfer that is also split is still a transfer.
 */
export function resolveCountedAmount(transaction: CountedInput): CountedAmount {
  if (transaction.isTransfer) {
    return { countedAmountMinor: 0, countedReason: "TRANSFER" };
  }

  // The instalments count as they are paid, so counting the purchase too
  // would book the whole amount twice.
  if (transaction.emiRole === "PARENT") {
    return { countedAmountMinor: 0, countedReason: "EMI_PARENT" };
  }

  // Repaying or being repaid moves money that was already accounted for
  // when the original split was recorded.
  if (transaction.isSettlement) {
    return { countedAmountMinor: 0, countedReason: "SETTLEMENT" };
  }

  // A refund is not income. It reduces what the original purchase cost,
  // which is handled on that purchase rather than by inventing earnings
  // here — see refundedMinor on the transaction it points at.
  if (transaction.refundOfId) {
    return { countedAmountMinor: 0, countedReason: "REFUND" };
  }

  const rawShare = transaction.split?.myShareMinor;
  // Clamped because a share larger than the bill would otherwise inflate
  // the total beyond what actually left the account.
  const share =
    typeof rawShare === "number" ? Math.max(0, Math.min(rawShare, transaction.amountMinor)) : null;

  // What a purchase really cost is what was paid less what came back. A
  // refund is rarely the whole amount — taxes and fees usually stay gone —
  // and the remainder is the true cost, not the sticker price.
  const refunded = transaction.refundedMinor ?? 0;
  if (refunded > 0) {
    const base = share ?? transaction.amountMinor;
    return { countedAmountMinor: Math.max(0, base - refunded), countedReason: "REFUNDED" };
  }

  if (share !== null) {
    return { countedAmountMinor: share, countedReason: "SPLIT" };
  }

  if (transaction.excludeFromTotals) {
    return { countedAmountMinor: 0, countedReason: "EXCLUDED" };
  }

  return { countedAmountMinor: transaction.amountMinor, countedReason: "FULL" };
}
