export const TRANSACTION_TYPES = ["DEBIT", "CREDIT"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_SOURCES = ["SMS", "EMAIL", "MANUAL"] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

// CASH is never detected from a message — no bank announces it — so it
// exists only to be chosen by hand. Keeping it an account type rather
// than a flag means filters, the ledger and trip totals treat it like
// any other without having to know about it.
export const ACCOUNT_TYPES = ["BANK", "CARD", "UPI", "CASH"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// Why a transaction's counted amount differs from the amount the bank
// moved. See models/counted.ts for the rule that assigns these.
export const COUNTED_REASONS = [
  "FULL",
  "TRANSFER",
  "SETTLEMENT",
  "SPLIT",
  "EMI_PARENT",
  "REFUND",
  "REFUNDED",
  "EXCLUDED",
] as const;
export type CountedReason = (typeof COUNTED_REASONS)[number];

export const EMI_PLAN_STATUSES = ["ACTIVE", "CLOSED", "CANCELLED"] as const;
export type EmiPlanStatus = (typeof EMI_PLAN_STATUSES)[number];

export const EMI_INSTALMENT_STATUSES = ["DUE", "PAID", "SKIPPED"] as const;
export type EmiInstalmentStatus = (typeof EMI_INSTALMENT_STATUSES)[number];

// Whether a transaction is the purchase that was converted into an EMI, or
// one of the monthly payments. Only the parent is kept out of the totals —
// the payments are the spending.
export const EMI_ROLES = ["PARENT", "INSTALMENT"] as const;
export type EmiRole = (typeof EMI_ROLES)[number];

export const RULE_MATCH_TYPES = ["MERCHANT_CONTAINS", "KEYWORD", "EXACT"] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export interface AuthUser {
  id: string;
  email: string;
}
