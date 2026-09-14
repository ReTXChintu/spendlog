export const TRANSACTION_TYPES = ["DEBIT", "CREDIT"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

// STATEMENT is its own source rather than a flavour of EMAIL: a row that
// came from a statement was never announced by the bank at the time, which
// is worth showing and worth being able to filter on.
export const TRANSACTION_SOURCES = ["SMS", "EMAIL", "MANUAL", "STATEMENT"] as const;
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
  // Paying a credit card bill. Every purchase on that card was counted
  // the day it happened, so the bill landing is the same money reaching
  // the bank a month later - counting both books it twice.
  "CARD_BILL",
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

export const COMMITMENT_KINDS = ["RENT", "SIP", "INSURANCE", "LOAN", "OTHER"] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

// What a row on a credit card statement actually is. Only SPEND and FEE
// may ever become a transaction; the rest exist so that the ones that must
// not be added have somewhere to be put. See modules/statements/classify.ts.
export const STATEMENT_LINE_KINDS = ["SPEND", "FEE", "PAYMENT", "REVERSAL", "NOISE"] as const;
export type StatementLineKind = (typeof STATEMENT_LINE_KINDS)[number];

// What reconciling did with a line.
//   MATCHED   the ledger already had it
//   ADDED     it did not, so it does now
//   UNCERTAIN matched, but more than one row fitted and the nearest was taken
//   SKIPPED   never eligible - a payment, or page furniture
export const STATEMENT_LINE_RESOLUTIONS = ["MATCHED", "ADDED", "UNCERTAIN", "SKIPPED"] as const;
export type StatementLineResolution = (typeof STATEMENT_LINE_RESOLUTIONS)[number];

//   PARSED       read, and reconciled
//   LOCKED       password missing or wrong
//   UNIDENTIFIED read, but no card in the app matches it
//   UNREADABLE   opened, but no transaction table could be found in it
export const STATEMENT_STATUSES = ["PARSED", "LOCKED", "UNIDENTIFIED", "UNREADABLE"] as const;
export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

// A card offer stands until the bank changes it; a coupon is spent once
// and then gone. Both answer the same question at a till, which is why
// they share a collection.
export const PERK_KINDS = ["CARD_OFFER", "COUPON"] as const;
export type PerkKind = (typeof PERK_KINDS)[number];

// Which rails a card runs on. It matters at a till rather than in the
// ledger: a RuPay credit card pays over UPI and a Visa one does not, so
// "which card" is really "which card that this place takes".
export const CARD_NETWORKS = ["RUPAY", "VISA", "MASTERCARD", "AMEX", "DINERS"] as const;
export type CardNetwork = (typeof CARD_NETWORKS)[number];

export const RULE_MATCH_TYPES = ["MERCHANT_CONTAINS", "KEYWORD", "EXACT"] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export interface AuthUser {
  id: string;
  email: string;
}
