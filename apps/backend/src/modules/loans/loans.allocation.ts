import { LoanInstalmentStatus } from "../../types";
import { istDayEnd, istDayKey } from "../../time";

/**
 * Where a loan's payments land, worked out from scratch every time.
 *
 * A loan is a running tab rather than a set of boxes each payment ticks:
 * everything paid towards it is one pool, poured into the instalments
 * oldest first. Paying less leaves the instalment it ran out on partly
 * covered, and the next payment finishes that one before starting on the
 * one after. Paying extra flows on into the instalments still to come -
 * the loan is ahead, not prepaid: the lender's schedule, and the interest
 * on it, are exactly as they were, only the next instalment is already
 * partly or wholly in hand.
 *
 * Pure, so the same arithmetic serves the stored statuses, the tab the
 * apps show, and a what-if that leaves one payment out.
 */

/**
 * Paise of slack on a loan's final instalment. A lender squares off its
 * own rounding on the last one, so a schedule that is a rupee or two out
 * would otherwise leave every loan open forever over the difference. The
 * same allowance the matcher gives a debit (see loans.matching.ts).
 */
export const FINAL_INSTALMENT_TOLERANCE_MINOR = 500;

export interface AllocatableInstalment {
  seq: number;
  dueDate: Date;
  amountMinor: number;
  status: LoanInstalmentStatus | string;
  byHand?: boolean;
  transactionId?: unknown;
}

export interface LoanPayment {
  transactionId: unknown;
  /// This loan's share of the payment, not the whole debit.
  amountMinor: number;
  occurredAt: Date;
}

export interface Coverage {
  paidMinor: number;
  status: LoanInstalmentStatus;
  transactionId: unknown | null;
  paidAt: Date | null;
}

/**
 * Ticked off by a person rather than covered by a payment. Rows from
 * before the flag existed say so the way they always did: PAID with no
 * payment behind them, which no allocation ever produces.
 */
export function isByHand(row: AllocatableInstalment): boolean {
  return row.status === "PAID" && (row.byHand === true || !row.transactionId);
}

/**
 * Pours the payments into the instalments, oldest instalment first.
 * Returns each instalment's coverage in the order given (sorted by seq
 * first), and whatever is left once every instalment is full.
 */
export function allocate(
  rows: AllocatableInstalment[],
  payments: LoanPayment[]
): { coverage: Coverage[]; leftoverMinor: number } {
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  const lastSeq = ordered.length > 0 ? ordered[ordered.length - 1].seq : 0;
  // Which payment a row is put down to is the one whose money got there,
  // so the pool keeps them in the order they were made.
  const queue = [...payments]
    .filter((payment) => payment.amountMinor > 0)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .map((payment) => ({ ...payment, left: payment.amountMinor }));

  const coverage = new Map<AllocatableInstalment, Coverage>();
  for (const row of ordered) {
    if (isByHand(row)) {
      coverage.set(row, {
        paidMinor: row.amountMinor,
        status: "PAID",
        transactionId: row.transactionId ?? null,
        paidAt: null,
      });
      continue;
    }

    let covered = 0;
    let last: (typeof queue)[number] | null = null;
    while (covered < row.amountMinor && queue.length > 0) {
      const take = Math.min(queue[0].left, row.amountMinor - covered);
      covered += take;
      queue[0].left -= take;
      last = queue[0];
      if (queue[0].left === 0) queue.shift();
    }

    const short = row.amountMinor - covered;
    const full = short <= 0 || (row.seq === lastSeq && covered > 0 && short <= FINAL_INSTALMENT_TOLERANCE_MINOR);
    // Closed early is closed: what was never paid stays skipped, but one a
    // payment does fill is paid like any other.
    const status: LoanInstalmentStatus = full
      ? "PAID"
      : row.status === "SKIPPED"
        ? "SKIPPED"
        : covered > 0
          ? "PARTIAL"
          : "DUE";

    coverage.set(row, {
      paidMinor: covered,
      status,
      transactionId: last?.transactionId ?? null,
      paidAt: last?.occurredAt ?? null,
    });
  }

  return {
    coverage: rows.map((row) => coverage.get(row)!),
    leftoverMinor: queue.reduce((sum, payment) => sum + payment.left, 0),
  };
}

/** An instalment as the tab reads it: stored, so already allocated. */
export interface TabInstalment {
  seq: number;
  dueDate: Date;
  amountMinor: number;
  status: string;
  paidMinor?: number;
  byHand?: boolean;
  transactionId?: unknown;
}

export interface LoanTab {
  /// Everything paid towards the loan: its share of every payment, plus
  /// any instalment ticked off by hand.
  paidMinor: number;
  /// What had fallen due by the end of today, skipped instalments aside.
  dueToDateMinor: number;
  /// paidMinor less dueToDateMinor. Positive is ahead, negative behind.
  balanceMinor: number;
  aheadMinor: number;
  behindMinor: number;
  /// The oldest instalment not yet fully covered: overdue while behind,
  /// the one the extra is going into while ahead.
  nextDue: {
    seq: number;
    on: string;
    dueDate: Date;
    amountMinor: number;
    alreadyCoveredMinor: number;
  } | null;
  /// The due date of the latest instalment fully covered, so "ahead" can
  /// say which instalment it reaches.
  coveredThrough: string | null;
}

/**
 * Where a loan stands against its schedule: how much has been paid, how
 * much has fallen due, and the difference.
 *
 * Reads the stored coverage, so it agrees with the statuses everything
 * else reads. `paymentsMinor` is the loan's share of every payment,
 * passed in rather than summed from the instalments, because a payment
 * past the end of the schedule covers no instalment and still counts.
 */
export function loanTab(rows: TabInstalment[], paymentsMinor: number, now = new Date()): LoanTab {
  const endOfToday = istDayEnd(istDayKey(now)).getTime();
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);

  const byHandMinor = ordered
    .filter((row) => isByHand(row))
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const paidMinor = paymentsMinor + byHandMinor;
  const dueToDateMinor = ordered
    .filter((row) => row.status !== "SKIPPED" && row.dueDate.getTime() <= endOfToday)
    .reduce((sum, row) => sum + row.amountMinor, 0);
  const balanceMinor = paidMinor - dueToDateMinor;

  const next = ordered.find((row) => row.status === "DUE" || row.status === "PARTIAL");
  const covered = ordered.filter((row) => row.status === "PAID");
  const through = covered[covered.length - 1];

  return {
    paidMinor,
    dueToDateMinor,
    balanceMinor,
    aheadMinor: Math.max(0, balanceMinor),
    behindMinor: Math.max(0, -balanceMinor),
    nextDue: next
      ? {
          seq: next.seq,
          on: istDayKey(next.dueDate),
          dueDate: next.dueDate,
          amountMinor: next.amountMinor,
          alreadyCoveredMinor: next.paidMinor ?? 0,
        }
      : null,
    coveredThrough: through ? istDayKey(through.dueDate) : null,
  };
}

/** The same figures summed across loans. */
export function tabTotals(tabs: Pick<LoanTab, "paidMinor" | "dueToDateMinor">[]) {
  const paidMinor = tabs.reduce((sum, tab) => sum + tab.paidMinor, 0);
  const dueToDateMinor = tabs.reduce((sum, tab) => sum + tab.dueToDateMinor, 0);
  const balanceMinor = paidMinor - dueToDateMinor;
  return {
    paidMinor,
    dueToDateMinor,
    balanceMinor,
    aheadMinor: Math.max(0, balanceMinor),
    behindMinor: Math.max(0, -balanceMinor),
  };
}

/** Each loan's share of a payment, reading a row from before loanSplits. */
export function splitsOf(transaction: {
  loanId?: unknown;
  amountMinor: number;
  loanSplits?: { loanId: unknown; amountMinor: number }[] | null;
}): { loanId: string; amountMinor: number }[] {
  const splits = transaction.loanSplits ?? [];
  if (splits.length > 0) {
    return splits.map((split) => ({ loanId: String(split.loanId), amountMinor: split.amountMinor }));
  }
  return transaction.loanId ? [{ loanId: String(transaction.loanId), amountMinor: transaction.amountMinor }] : [];
}
