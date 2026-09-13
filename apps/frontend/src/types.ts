export type TransactionType = "DEBIT" | "CREDIT";
export type TransactionSource = "SMS" | "EMAIL" | "MANUAL" | "STATEMENT";

export interface Category {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  isSystem: boolean;
}

export type AccountType = "BANK" | "CARD" | "UPI" | "CASH";

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
  spendLimitMinor: number | null;
  statementDay: number | null;
  dueDay: number | null;
  isActive: boolean;
  color: string | null;
  /// Whether a statement password is stored. The value itself never leaves
  /// the server, so this is all a client can know about it.
  hasStatementPassword?: boolean;
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

export interface TripMember {
  userId: string;
  joinedAt: string;
  /** Present on the trip detail, where members are resolved to people. */
  name?: string;
  isOwner?: boolean;
}

export interface Trip {
  id: string;
  name: string;
  ownerId: string;
  startedAt: string;
  endedAt: string | null;
  members: TripMember[];
  joinCode: string;
  isActive: boolean;
  totalMinor: number;
  transactionCount: number;
}

export interface TripSummary {
  trip: Trip;
  totalMinor: number;
  transactionCount: number;
  dayCount: number;
  perDayMinor: number;
  byMember: { userId: string; name: string | null; spentMinor: number; count: number }[];
  byCategory: { categoryId: string | null; name: string; amountMinor: number }[];
}

export interface TripSettlement {
  balances: {
    userId: string;
    name: string;
    paidMinor: number;
    shareMinor: number;
    netMinor: number;
  }[];
  transfers: {
    fromUserId: string;
    toUserId: string;
    fromName: string;
    toName: string;
    amountMinor: number;
  }[];
}

/** A shortcut for entering a payment by hand: a name and its usual category. */
export interface MerchantPreset {
  id: string;
  merchant: string;
  categoryId: string | null;
  category: Category | null;
  useCount: number;
}

export type CardNetwork = "RUPAY" | "VISA" | "MASTERCARD" | "AMEX" | "DINERS";

/** What each network is called on screen. */
export const NETWORK_LABELS: Record<CardNetwork, string> = {
  RUPAY: "RuPay",
  VISA: "Visa",
  MASTERCARD: "Mastercard",
  AMEX: "Amex",
  DINERS: "Diners",
};

export type CardState = "ok" | "close" | "over" | "unset";

/** A card, with where it is in its cycle and what is left of its limit. */
export interface CardStatus {
  accountId: string;
  name: string;
  last4: string | null;
  network: CardNetwork | null;
  statementOn: string | null;
  dueOn: string | null;
  floatDays: number | null;
  spentMinor: number;
  limitMinor: number | null;
  remainingMinor: number | null;
  state: CardState;
}

export interface FixedCommitment {
  id: string;
  name: string;
  amountMinor: number;
  dayOfMonth: number;
  kind: "RENT" | "SIP" | "INSURANCE" | "LOAN" | "OTHER";
  isActive: boolean;
  isPaid?: boolean;
}

export interface BudgetProfile {
  salaryAmountMinor: number | null;
  salaryDay: number | null;
}

export type BudgetPace =
  | { configured: false }
  | {
      configured: true;
      periodStart: string;
      periodEnd: string;
      daysLeft: number;
      daysElapsed: number;
      salaryMinor: number;
      commitmentsRemainingMinor: number;
      spentMinor: number;
      remainingMinor: number;
      perDayMinor: number;
      recentPerDayMinor: number;
      state: "ok" | "watch" | "over";
      commitments: FixedCommitment[];
    };

export interface Transaction {
  id: string;
  /** Who this belongs to — the payer, on a shared trip. */
  userId: string;
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
  /** The trip this was spent on, if any. */
  tripId: string | null;
  trip: { id: string; name: string } | null;
  /** Who a trip expense was for. null means everyone on the trip. */
  tripShareWith: string[] | null;
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

/**
 * Which card to reach for, one answer per network.
 *
 * Networks matter at a till rather than in the ledger: a RuPay credit card
 * pays over UPI and a Visa one does not.
 */
export interface CardPicks {
  best: CardStatus | null;
  byNetwork: { network: CardNetwork; card: CardStatus }[];
  unknownNetwork: CardStatus[];
}

export type PerkKind = "CARD_OFFER" | "COUPON";

export interface Perk {
  id: string;
  kind: PerkKind;
  title: string;
  accountId: string | Account | null;
  merchants: string[];
  categoryId: string | Category | null;
  percent: number | null;
  flatMinor: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number | null;
  startsOn: string | null;
  expiresOn: string | null;
  code: string | null;
  usedAt: string | null;
  isActive: boolean;
  notes: string | null;
  /** Added by the list and the dashboard, not stored. */
  isLive?: boolean;
  daysLeft?: number | null;
}

export type PerkReach = "MERCHANT" | "CATEGORY" | "ANYWHERE";

export interface PerkMatch extends Perk {
  reach: PerkReach;
  /** Null until there is an amount to apply a percentage to. */
  valueMinor: number | null;
  card: CardStatus | null;
}

export interface PerkLookup {
  query: string;
  matches: PerkMatch[];
  bestForFloat: CardStatus | null;
  /** Only set when it is a different card from the one the offer names. */
  floatAlternative: CardStatus | null;
  verdict: string;
}

export interface MerchantSpend {
  merchant: string;
  amountMinor: number;
  count: number;
}

export interface MonthComparison {
  month: string;
  previousMonthLabel: string;
  totalSpendMinor: number;
  previousSpendMinor: number;
  changeMinor: number;
  categories: {
    categoryId: string | null;
    name: string;
    amountMinor: number;
    previousMinor: number;
    changeMinor: number;
  }[];
}

export interface MonthSoFar {
  month: string;
  dayOfMonth: number;
  spentMinor: number;
  previousMinor: number;
  changeMinor: number;
}

/** Everything the landing screen needs, in one request. */
export interface DashboardData {
  today: string;
  pace: BudgetPace;
  cards: CardStatus[];
  picks: CardPicks;
  needsCategory: { yesterday: number; month: number };
  emis: { count: number; monthlyMinor: number; remainingMinor: number; plans: EmiPlan[] };
  owed: { balanceMinor: number };
  expiringPerks: Perk[];
  statements: {
    stuckCount: number;
    stuck: { id: string; status: string; problem: string | null; subject: string | null }[];
  };
  monthSoFar: MonthSoFar;
}
