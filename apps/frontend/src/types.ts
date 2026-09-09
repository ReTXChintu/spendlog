export type TransactionType = "DEBIT" | "CREDIT";
export type TransactionSource = "SMS" | "EMAIL" | "MANUAL";

export interface Category {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
}

export interface Account {
  id: string;
  bankName: string;
  last4: string | null;
  accountType: "BANK" | "CARD" | "UPI";
  nickname: string | null;
}

export interface Transaction {
  id: string;
  amountMinor: number;
  currency: string;
  type: TransactionType;
  merchant: string | null;
  note: string | null;
  rawText: string | null;
  source: TransactionSource;
  isTransfer: boolean;
  pending: boolean;
  occurredAt: string;
  editedAt: string | null;
  category: Category | null;
  account: Account | null;
}

export interface DayGroup {
  date: string;
  spendMinor: number;
  incomeMinor: number;
  transactions: Transaction[];
}

export interface AnalyticsSummary {
  month: string;
  totalSpendMinor: number;
  totalIncomeMinor: number;
  byCategory: { categoryId: string | null; name: string; amountMinor: number }[];
  transactionCount: number;
}

export interface TrendPoint {
  month: string;
  spendMinor: number;
  incomeMinor: number;
}

export interface EmailConnectionStatus {
  id: string;
  email: string;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
}
