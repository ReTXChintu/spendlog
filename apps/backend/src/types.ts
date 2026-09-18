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
//
// CARD means a credit card specifically, and DEBIT a debit card. They are
// different things everywhere it matters: a credit card has a billing
// cycle, a limit, a due date and a statement of its own, and a debit card
// has none of those because it is a way of reaching a bank account rather
// than a line of credit. What a debit card does have is a network and a
// number, which is why it is an account and not a field — it gets
// suggested at a till and it holds card details.
export const ACCOUNT_TYPES = ["BANK", "CARD", "DEBIT", "UPI", "CASH"] as const;
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

// A loan has no purchase to convert - the money most often never arrived
// as a transaction SpendLog saw at all, so there is no PARENT/INSTALMENT
// split the way an EMI has one. Every payment linked to a loan is a
// repayment, in full, the same as an EMI instalment is.
export const LOAN_STATUSES = ["ACTIVE", "CLOSED", "CANCELLED"] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export const LOAN_INSTALMENT_STATUSES = ["DUE", "PAID", "SKIPPED"] as const;
export type LoanInstalmentStatus = (typeof LOAN_INSTALMENT_STATUSES)[number];

export const COMMITMENT_KINDS = ["RENT", "SIP", "INSURANCE", "LOAN", "OTHER"] as const;
export type CommitmentKind = (typeof COMMITMENT_KINDS)[number];

// What a row on a credit card statement actually is. Only SPEND and FEE
// may ever become a transaction; the rest exist so that the ones that must
// not be added have somewhere to be put. See modules/statements/classify.ts.
// A card statement and a bank statement are the same job on different
// documents: one lists what a card was used for, the other everything
// that touched an account. What differs is what an unexplained credit
// means - on a card it is almost always the bill being paid, and on a
// bank account it is money arriving.
export const STATEMENT_KINDS = ["CARD", "BANK"] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export const STATEMENT_LINE_KINDS = [
  "SPEND",
  "FEE",
  // Money arriving in an account. Only ever found on a bank statement:
  // a credit on a card is the bill being paid, not income.
  "INCOME",
  "PAYMENT",
  "REVERSAL",
  "NOISE",
] as const;
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

// Which way money has to be moving for a category to make sense. Sending
// money out is never income, and a refund is never a way of spending, so
// offering either is offering a mistake.
export const CATEGORY_DIRECTIONS = ["IN", "OUT", "BOTH"] as const;
export type CategoryDirection = (typeof CATEGORY_DIRECTIONS)[number];

export const RULE_MATCH_TYPES = ["MERCHANT_CONTAINS", "KEYWORD", "EXACT"] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export interface AuthUser {
  id: string;
  email: string;
}
