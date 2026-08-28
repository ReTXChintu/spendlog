export const TRANSACTION_TYPES = ["DEBIT", "CREDIT"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_SOURCES = ["SMS", "EMAIL", "MANUAL"] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

export const ACCOUNT_TYPES = ["BANK", "CARD", "UPI"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const RULE_MATCH_TYPES = ["MERCHANT_CONTAINS", "KEYWORD", "EXACT"] as const;
export type RuleMatchType = (typeof RULE_MATCH_TYPES)[number];

export interface AuthUser {
  id: string;
  email: string;
}
