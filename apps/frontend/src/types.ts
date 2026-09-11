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

/** The part of a shared bill that was actually the user's own spending. */
export interface TransactionSplit {
  myShareMinor: number;
  groupLabel: string | null;
}

export type EmiRole = "PARENT" | "INSTALMENT";

export interface EmiInstalment {
  id: string;
  planId: string;
  seq: number;
  dueDate: string;
  amountMinor: number;
  status: "DUE" | "PAID" | "SKIPPED";
  transactionId: string | null;
}

export interface EmiPlan {
  id: string;
  label: string | null;
  principalMinor: number;
  months: number;
  monthlyAmountMinor: number;
  totalPayableMinor: number;
  interestRatePctAnnual: number | null;
  processingFeeMinor: number | null;
  startDate: string;
  status: "ACTIVE" | "CLOSED" | "CANCELLED";
  instalments: EmiInstalment[];
  paidCount: number;
  paidMinor: number;
  remainingMinor: number;
}

export interface EmiUpcoming {
  totalMinor: number;
  instalments: (EmiInstalment & { planId: EmiPlan })[];
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
  /** On a credit: how much of it belongs to which earlier purchases. */
  refundOf: { transactionId: string; amountMinor: number }[];
  /** On a purchase: how much of it has since come back. */
  refundedMinor: number;
  emiPlanId: string | null;
  emiRole: EmiRole | null;
  isTransfer: boolean;
  split: TransactionSplit | null;
  isSettlement: boolean;
  pending: boolean;
  occurredAt: string;
  editedAt: string | null;
  /** Every message that reported this transaction, oldest first. */
  sources: TransactionSourceEntry[];
  category: Category | null;
  account: Account | null;
}

/** The running balance with everyone the user splits bills with. */
export interface OwedSummary {
  balanceMinor: number;
  lentMinor: number;
  settledInMinor: number;
  settledOutMinor: number;
  splitCount: number;
  splits: Transaction[];
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
