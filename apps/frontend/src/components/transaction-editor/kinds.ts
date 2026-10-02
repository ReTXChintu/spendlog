import { Transaction, TransactionType } from "../../types";

/**
 * What a transaction *is*, beyond its amount and direction.
 *
 * These used to be a stack of checkboxes that could all be ticked at once,
 * most of which contradict each other (a salary that is also a transfer
 * that is also settling up). Only one of these can be true of a
 * transaction, so they are one choice. The things that genuinely sit on
 * top of any of them - a one-off, a fixed monthly cost, keeping money out
 * of the savings bucket - are separate toggles.
 */
export type Kind =
  | "normal"
  | "split"
  | "lent"
  | "transfer"
  | "cardBill"
  | "loan"
  | "settle"
  | "salary"
  | "refund"
  | "earmark";

export interface KindOption {
  kind: Kind;
  label: string;
  icon: string;
  /** Said on hover and to screen readers. */
  hint: string;
}

export const DEBIT_KINDS: KindOption[] = [
  { kind: "normal", label: "Normal", icon: "ic-bag", hint: "Ordinary spending, all of it mine" },
  { kind: "split", label: "Split", icon: "ic-people", hint: "Only part of it was mine; the rest is owed back" },
  { kind: "lent", label: "Lent", icon: "ic-arrow-right", hint: "None of it was mine; all of it is owed back" },
  { kind: "transfer", label: "To my own account", icon: "ic-updown", hint: "Moved between my accounts or to cash" },
  { kind: "cardBill", label: "Card bill", icon: "ic-receipt", hint: "Paid a credit card's bill" },
  { kind: "loan", label: "Loan repayment", icon: "ic-bank", hint: "An instalment on a loan" },
  { kind: "settle", label: "Settling up", icon: "ic-check", hint: "Paying someone back for something already recorded" },
];

export const CREDIT_KINDS: KindOption[] = [
  { kind: "normal", label: "Income", icon: "ic-trend", hint: "Ordinary money in" },
  { kind: "salary", label: "Salary", icon: "ic-wallet", hint: "This month's pay" },
  { kind: "refund", label: "Refund", icon: "ic-sync", hint: "Money back on earlier purchases" },
  { kind: "earmark", label: "For a future purchase", icon: "ic-spark", hint: "Money given for something still to be bought" },
  { kind: "transfer", label: "From my own account", icon: "ic-updown", hint: "Moved in from another of my accounts or cash" },
  { kind: "settle", label: "Paid back", icon: "ic-check", hint: "Someone settling up what they owed me" },
  { kind: "split", label: "Split", icon: "ic-people", hint: "Part of it is really someone else's money coming back" },
];

export function kindsFor(type: TransactionType): KindOption[] {
  return type === "DEBIT" ? DEBIT_KINDS : CREDIT_KINDS;
}

/** Kinds that mean the same thing either way round survive a direction change. */
export function kindAfterTypeChange(kind: Kind, next: TransactionType): Kind {
  return kindsFor(next).some((option) => option.kind === kind) ? kind : "normal";
}

/**
 * Reads the kind back off a saved transaction. Order matters only for
 * rows from before this was one choice, where more than one flag could be
 * set: the one that most changes how the money counts wins.
 */
export function initialKind(transaction: Transaction | null): Kind {
  if (!transaction) return "normal";
  const t = transaction;
  if (t.type === "DEBIT") {
    if (t.cardPaymentFor) return "cardBill";
    if (t.isTransfer) return "transfer";
    if (t.isSettlement) return "settle";
    if (t.split) return t.split.myShareMinor === 0 ? "lent" : "split";
    if (t.loanId) return "loan";
    return "normal";
  }
  if (t.isTransfer) return "transfer";
  if (t.isSettlement) return "settle";
  if (t.isEarmarked) return "earmark";
  if (t.isSalary) return "salary";
  if (t.split) return "split";
  if (t.refundOf.length > 0) return "refund";
  return "normal";
}

/**
 * Whether a merchant is what a bank message calls someone rather than
 * what a person would: a UPI handle, or an all-caps string of letters and
 * digits. Only these are safe to replace with "Transfer to …".
 */
export function looksRaw(merchant: string): boolean {
  const text = merchant.trim();
  if (!text) return true;
  if (text.includes("@")) return true;
  return /^[A-Z0-9\s\-_.:/*#&]+$/.test(text);
}
