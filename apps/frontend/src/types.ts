export type TransactionType = "DEBIT" | "CREDIT";
export type TransactionSource = "SMS" | "EMAIL" | "MANUAL" | "STATEMENT";

export type CategoryDirection = "IN" | "OUT" | "BOTH";

export interface Category {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  /** Which way money has to be moving for this to make sense. */
  direction?: CategoryDirection;
  isSystem: boolean;
}

/**
 * The categories that make sense for money moving this way.
 *
 * Sending money out is never income, and a refund is never a way of
 * spending, so offering either is offering a mistake. A category with no
 * direction recorded is shown either way: better a stale one in the list
 * than a category someone added quietly missing from the picker they
 * added it for.
 */
export function categoriesFor(categories: Category[], type: TransactionType): Category[] {
  const wanted = type === "CREDIT" ? "IN" : "OUT";
  return categories.filter((category) => (category.direction ?? "BOTH") !== (wanted === "IN" ? "OUT" : "IN"));
}

/**
 * CARD is a credit card and DEBIT a debit card. They differ everywhere it
 * matters: a credit card has a cycle, a limit, a due date and a statement
 * of its own; a debit card has none of those, because it is a way of
 * reaching a bank account rather than a line of credit.
 */
export type AccountType = "BANK" | "CARD" | "DEBIT" | "UPI" | "CASH";

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
  /// For a debit card, the bank account it draws on.
  linkedAccountId: string | null;
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

/**
 * An account with everything its own panel shows, from GET
 * /accounts/overview. Assembled on the server because the same figures
 * already feed the dashboard, and four requests per account would be a
 * waterfall for numbers that exist together.
 */
export interface AccountOverview extends Account {
  /// Null for anything without a billing cycle - a savings account has no
  /// limit and no month, and an empty bar drawn for one means nothing.
  cycle: {
    statementOn: string | null;
    dueOn: string | null;
    floatDays: number | null;
    spentMinor: number;
    limitMinor: number | null;
    remainingMinor: number | null;
    state: "ok" | "close" | "over" | "unset";
  } | null;
  /// What this account has spent since the first of the month, and what
  /// you allowed yourself. Every account has this; only a credit card has
  /// a cycle.
  /// Optional because a page can outlive the server build that added
  /// it: a browser holds a cached bundle, and a deployment restarts the
  /// two halves seconds apart.
  month?: { spentMinor: number; limitMinor: number | null };
  /// The last bill read off a statement - the only figure on the panel
  /// that comes from the bank rather than from adding up messages.
  bill: {
    totalDueMinor: number;
    dueOn: string | null;
    daysUntilDue: number | null;
    isPaid: boolean;
  } | null;
  /// Whether full card details are stored. Like the password, the values
  /// themselves need a PIN and a separate request.
  hasCardDetails: boolean;
  /// What a debit card draws on, named rather than referenced.
  linkedAccount: string | null;
  /// For a bank account, the debit cards that reach it.
  debitCards?: { id: string; name: string; last4: string | null; network: string | null }[];
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
  /// What you allow yourself on this card in a period, and what the bank
  /// allows. Different things: being 90% through your own limit matters
  /// at a till, and being 30% through a credit limit tells you nothing.
  limitMinor: number | null;
  creditLimitMinor?: number | null;
  remainingMinor: number | null;
  /// Last statement's bill, less anything paid against it. Money the bank
  /// is still holding against the credit limit. Undefined from a server
  /// older than this field; null when no statement has been read, which is
  /// not the same as nothing owed.
  outstandingMinor?: number | null;
  /// When that bill has to be paid — not the same as dueOn, which is when
  /// the cycle now running will fall due.
  billDueOn?: string | null;
  /// The credit limit, less the outstanding bill, less this cycle.
  availableMinor?: number | null;
  /// Whether spentMinor covers a billing cycle or a calendar month. A card
  /// with no statement day has no cycle to measure.
  periodIsCycle?: boolean;
  state: CardState;
}

export interface FixedCommitment {
  id: string;
  name: string;
  amountMinor: number;
  dayOfMonth: number;
  kind: "RENT" | "SIP" | "INSURANCE" | "LOAN" | "OTHER";
  /** Who it goes to and what it counts as, prefilled onto a payment. */
  merchant?: string | null;
  categoryId?: string | Category | null;
  isActive: boolean;
  isPaid?: boolean;
  /** What has actually gone out towards it this period. */
  paidMinor?: number;
  shortfallMinor?: number;
  isPartial?: boolean;
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
      /** Whether salaryMinor is what landed, or what was configured. */
      salaryIsActual: boolean;
      salaryPaidOn: string | null;
      commitmentsRemainingMinor: number;
      spentMinor: number;
      remainingMinor: number;
      perDayMinor: number;
      recentPerDayMinor: number;
      state: "ok" | "watch" | "over";
      /** Set when a fixed cost went out for less than its usual amount. */
      shortfallNote: string | null;
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
  /** Marked by hand: the credit that opens a spending period. */
  isSalary?: boolean;
  /** The card whose bill this settled. Counts as nothing when set. */
  cardPaymentFor?: string | null;
  /** The fixed monthly cost this went towards. Still counts as spending. */
  commitmentId?: string | null;
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
  /// True for one a model read off a picture that nobody has confirmed. It
  /// is a real perk either way; the flag only says where the figures came
  /// from.
  needsReview?: boolean;
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

/** A card bill that has been read from a statement and not yet paid. */
export interface UpcomingBill {
  statementId: string;
  accountId: string;
  cardName: string;
  totalDueMinor: number;
  minimumDueMinor: number | null;
  statementDate: string | null;
  dueDate: string | null;
  /** Negative once the due date has gone past. */
  daysUntilDue: number | null;
  paidMinor: number;
  isPaid: boolean;
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
  bills: UpcomingBill[];
}
