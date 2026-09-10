export type TransactionType = "DEBIT" | "CREDIT";
export type TransactionSource = "SMS" | "EMAIL" | "MANUAL";

export interface Category {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
}

export type AccountType = "BANK" | "CARD" | "UPI";

/** A spelling of an account that a bank uses in one of its message formats. */
export interface AccountAlias {
  bankName: string;
  last4: string | null;
  accountType: AccountType;
}

export interface Account {
  id: string;
  bankName: string;
  last4: string | null;
  accountType: AccountType;
  nickname: string | null;
  aliases: AccountAlias[];
  issuer: string | null;
  cardNetwork: string | null;
  creditLimitMinor: number | null;
  statementDay: number | null;
  dueDay: number | null;
  isActive: boolean;
  color: string | null;
}

/** What to call an account on screen: the name given to it, else the bank's. */
export function accountLabel(account: Pick<Account, "bankName" | "last4" | "nickname">): string {
  const name = account.nickname?.trim() || account.bankName;
  return account.last4 ? `${name} ••${account.last4}` : name;
}

/** One message that reported a transaction. */
export interface TransactionSourceEntry {
  source: TransactionSource;
  sourceRef: string | null;
  rawText: string | null;
  receivedAt: string;
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
  /** Every message that reported this transaction, oldest first. */
  sources: TransactionSourceEntry[];
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
