import { Schema, Types, model } from "mongoose";
import {
  ACCOUNT_TYPES,
  CATEGORY_DIRECTIONS,
  COMMITMENT_KINDS,
  COUNTED_REASONS,
  EMI_INSTALMENT_STATUSES,
  EMI_PLAN_STATUSES,
  EMI_ROLES,
  PERK_KINDS,
  RULE_MATCH_TYPES,
  STATEMENT_KINDS,
  STATEMENT_LINE_KINDS,
  STATEMENT_LINE_RESOLUTIONS,
  STATEMENT_STATUSES,
  TRANSACTION_SOURCES,
  TRANSACTION_TYPES,
  AccountType,
  CategoryDirection,
  CommitmentKind,
  CountedReason,
  EmiInstalmentStatus,
  EmiPlanStatus,
  EmiRole,
  PerkKind,
  RuleMatchType,
  StatementKind,
  StatementLineKind,
  StatementLineResolution,
  StatementStatus,
  TransactionSource,
  TransactionType,
} from "../types";
import { resolveCountedAmount } from "./counted";
import { istMonthKey } from "../time";

// Responses are serialized with `id` (a string) rather than Mongo's `_id`,
// which is the shape the web and mobile clients already consume. Virtuals
// are included so relation fields populated below come through too.
const serialization = {
  toJSON: {
    virtuals: true,
    versionKey: false,
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
      delete ret._id;
      return ret;
    },
  },
  toObject: { virtuals: true },
};

export interface UserDoc {
  _id: Types.ObjectId;
  email: string;
  name?: string | null;
  googleId?: string | null;
  /// What lands each month, and when. Together these define the period the
  /// spending pace is measured over: salary day to salary day, because the
  /// money arrives and then gets spent.
  salaryAmountMinor?: number | null;
  salaryDay?: number | null;
  /// What you allow yourself to spend in a day.
  ///
  /// Separate from the salary pace, and answering a different question. The
  /// pace says what is left per day to get to payday; this says what you
  /// decided a day should cost. Every day under it puts the difference by,
  /// every day over it takes the difference back, and the running total is
  /// what there is to move into savings when the next salary lands.
  dailyBudgetMinor?: number | null;
  /// The first month SpendLog will import anything for, as YYYY-MM.
  ///
  /// Somebody who joins on the 13th of September does not want August's
  /// mail read: a half-remembered month they never meant to track would
  /// arrive uncategorised and count against every total. So the ledger
  /// starts on the 1st of the month they joined, and moves back only when
  /// they ask for it.
  ///
  /// It governs *importing*, not the ledger itself. A payment entered by
  /// hand with an old date is somebody saying what happened, and is kept.
  /// Null on an account that predates the field, which reads as the month
  /// that account was created.
  ledgerFrom?: string | null;
  /// The PIN that unlocks stored card details, as a scrypt hash and its
  /// salt. One PIN covers every card: it guards a screen, not a card, and
  /// nobody wants four of them.
  ///
  /// A PIN is four to six digits, which is a million guesses at worst - so
  /// what actually protects it is the counter beside it rather than the
  /// hash. Never leaves the server in any form; see the toJSON transform.
  vaultPin?: VaultPin | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VaultPin {
  hash: string;
  salt: string;
  /// Consecutive wrong answers. Reset by a right one.
  failedAttempts: number;
  /// While this is in the future, no PIN is accepted at all.
  lockedUntil?: Date | null;
}

const vaultPinSchema = new Schema<VaultPin>(
  {
    hash: { type: String, required: true },
    salt: { type: String, required: true },
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { _id: false }
);

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, default: null },
    googleId: { type: String, default: null },
    salaryAmountMinor: { type: Number, default: null, min: 0 },
    salaryDay: { type: Number, default: null, min: 1, max: 31 },
    dailyBudgetMinor: { type: Number, default: null, min: 0 },
    ledgerFrom: { type: String, default: null },
    vaultPin: { type: vaultPinSchema, default: null },
  },
  {
    timestamps: true,
    ...serialization,
    toJSON: {
      ...serialization.toJSON,
      // The PIN hash is not a thing any client needs, in any shape. Taken
      // out here rather than remembered at each of the several places a
      // user is serialised, because remembering is what eventually fails.
      transform: (doc: unknown, ret: Record<string, unknown>) => {
        serialization.toJSON.transform(doc, ret);
        ret.hasVaultPin = Boolean(ret.vaultPin);
        delete ret.vaultPin;
        return ret;
      },
    },
  }
);

// Unique only among users that actually have a Google id. A `sparse` index
// would not work here: sparse skips documents where the field is absent,
// but `default: null` means it is present-and-null, so every account
// without a Google id would collide on null.
userSchema.index(
  { googleId: 1 },
  { unique: true, partialFilterExpression: { googleId: { $type: "string" } } }
);

export const User = model<UserDoc>("User", userSchema);

/** How a bank names itself in one message format. */
export interface AccountAlias {
  bankName: string;
  last4?: string | null;
  accountType: AccountType;
}

export interface AccountDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  bankName: string;
  last4?: string | null;
  accountType: AccountType;
  nickname?: string | null;
  /// Other {bankName, last4, accountType} tuples that mean this same real
  /// account. One bank writes "HDFC" in an SMS and "HDFC Bank" in an email,
  /// which would otherwise be two accounts; merging moves the loser's
  /// tuple in here so the next message resolves to the survivor instead of
  /// recreating it.
  aliases: AccountAlias[];
  issuer?: string | null;
  cardNetwork?: string | null;
  /// For a debit card, the bank account it draws on.
  ///
  /// A debit card is a way of reaching an account rather than a pot of its
  /// own, so its spending belongs to that account — which is where the
  /// bank's own statement will show it, and where it has to be counted if
  /// it is to be counted once. A debit card may also stand alone, for one
  /// whose account SpendLog has never seen; then it is its own pot, the
  /// way cash is.
  linkedAccountId?: Types.ObjectId | null;
  /// For a credit card whose limit is one pot shared with another card.
  ///
  /// Two cards from the same bank often draw on a single limit: spend on
  /// either and the other has less. Points at the card that holds the
  /// limit; creditLimitMinor on this one is then ignored. Each card keeps
  /// its own cycle, its own statement and its own personal limit - only
  /// the bank's ceiling is shared.
  sharesLimitWith?: Types.ObjectId | null;
  creditLimitMinor?: number | null;
  /// What the user allows themselves on this card in a billing cycle, as
  /// distinct from creditLimitMinor, which is what the bank allows.
  spendLimitMinor?: number | null;
  /// Day of month the card statement is generated, and the day it is due.
  statementDay?: number | null;
  dueDay?: number | null;
  /// The password that opens this card's statement PDFs, encrypted. Stored
  /// rather than asked for each month, so a statement can be read the
  /// moment it arrives. Never leaves the server.
  statementPassword?: string | null;
  isActive: boolean;
  color?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const accountAliasSchema = new Schema<AccountAlias>(
  {
    bankName: { type: String, required: true },
    last4: { type: String, default: null },
    accountType: { type: String, enum: ACCOUNT_TYPES, required: true },
  },
  { _id: false }
);

const accountSchema = new Schema<AccountDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    bankName: { type: String, required: true },
    last4: { type: String, default: null },
    accountType: { type: String, enum: ACCOUNT_TYPES, required: true },
    nickname: { type: String, default: null },
    aliases: { type: [accountAliasSchema], default: [] },
    issuer: { type: String, default: null },
    cardNetwork: { type: String, default: null },
    linkedAccountId: { type: Schema.Types.ObjectId, ref: "Account", default: null },
    sharesLimitWith: { type: Schema.Types.ObjectId, ref: "Account", default: null },
    creditLimitMinor: { type: Number, default: null },
    spendLimitMinor: { type: Number, default: null, min: 0 },
    statementDay: { type: Number, default: null, min: 1, max: 31 },
    dueDay: { type: Number, default: null, min: 1, max: 31 },
    // AES-256-GCM ciphertext, never the password itself, and never
    // returned by the API. See modules/statements/statements.crypto.ts.
    statementPassword: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    color: { type: String, default: null },
  },
  {
    timestamps: true,
    ...serialization,
    toJSON: {
      ...serialization.toJSON,
      transform: (doc: unknown, ret: Record<string, unknown>) => {
        serialization.toJSON.transform(doc, ret);
        // The ciphertext must not leave the server, even encrypted. What a
        // client needs is whether a password is set, never the value.
        ret.hasStatementPassword = Boolean(ret.statementPassword);
        delete ret.statementPassword;
        return ret;
      },
    },
  }
);

// One row per real-world account, so repeated messages resolve to the same
// Account and self-transfer detection can tell two accounts apart.
accountSchema.index({ userId: 1, bankName: 1, last4: 1, accountType: 1 }, { unique: true });

// Resolving an incoming message checks the aliases as well as the primary
// tuple, so that lookup needs an index of its own.
accountSchema.index({ userId: 1, "aliases.bankName": 1, "aliases.last4": 1, "aliases.accountType": 1 });

export const Account = model<AccountDoc>("Account", accountSchema);

export interface CategoryDoc {
  _id: Types.ObjectId;
  // null = system default category, shared by all users
  userId?: Types.ObjectId | null;
  name: string;
  icon?: string | null;
  color?: string | null;
  /// Which way money has to be moving for this to make sense. BOTH is
  /// the default, so a category someone adds themselves is never
  /// quietly hidden from the picker they added it for.
  direction: CategoryDirection;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<CategoryDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    name: { type: String, required: true },
    icon: { type: String, default: null },
    color: { type: String, default: null },
    direction: { type: String, enum: CATEGORY_DIRECTIONS, default: "BOTH" },
    isSystem: { type: Boolean, default: false },
  },
  { timestamps: true, ...serialization }
);

export const Category = model<CategoryDoc>("Category", categorySchema);

export interface CategoryRuleDoc {
  _id: Types.ObjectId;
  // null = system default rule, shared by all users
  userId?: Types.ObjectId | null;
  categoryId: Types.ObjectId;
  matchType: RuleMatchType;
  pattern: string; // stored lowercase
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

const categoryRuleSchema = new Schema<CategoryRuleDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    matchType: { type: String, enum: RULE_MATCH_TYPES, required: true },
    pattern: { type: String, required: true },
    priority: { type: Number, default: 0 },
  },
  { timestamps: true, ...serialization }
);

export const CategoryRule = model<CategoryRuleDoc>("CategoryRule", categoryRuleSchema);

/**
 * One message that reported this transaction. The same payment usually
 * arrives twice — an SMS, then a bank email a few minutes later — and both
 * are kept so the row can say what it was seen by, and so an over-eager
 * merge can be taken apart again.
 */
export interface TransactionSourceEntry {
  source: TransactionSource;
  sourceRef?: string | null;
  rawText?: string | null;
  receivedAt: Date;
}

/**
 * A bill where only part of the money was really the user's.
 *
 * There is no "who owes what" ledger here on purpose: for most rows "my
 * share was 400" is the whole story, and Splitwise already tracks the rest
 * far better than a second half-hearted copy would.
 */
export interface TransactionSplit {
  myShareMinor: number;
  /** Free text, e.g. "Goa trip", for recognising a run of them later. */
  groupLabel?: string | null;
}

export interface TransactionDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  accountId?: Types.ObjectId | null;
  categoryId?: Types.ObjectId | null;
  amountMinor: number; // always positive; sign is derived from `type`
  currency: string;
  type: TransactionType;
  merchant?: string | null;
  note?: string | null;
  rawText?: string | null; // original SMS body / email snippet
  source: TransactionSource;
  sourceRef?: string | null; // provider message id, for dedup + audit trail
  dedupeKey?: string | null;
  /// The trip this was spent on, if any. Purely a label: it never touches
  /// countedAmountMinor, because a meal on holiday is still a meal.
  tripId?: Types.ObjectId | null;
  /// Who a trip expense was for. null means everyone on the trip, which is
  /// the usual answer; a list narrows it, and a list of just the payer is
  /// how a souvenir stays out of everyone else's arithmetic.
  tripShareWith?: Types.ObjectId[] | null;
  /// The plan this belongs to, once a purchase has been converted to an
  /// EMI: the purchase itself as PARENT, each monthly payment as
  /// INSTALMENT. Only the parent is kept out of the totals.
  emiPlanId?: Types.ObjectId | null;
  emiRole?: EmiRole | null;
  /// On a credit that gives money back: how much of it belongs to which
  /// earlier purchases. A single credit often settles several cancelled
  /// orders, and only the allocated part stops counting as income.
  refundOf: RefundAllocation[];
  /// On a purchase: how much of it has since come back. Kept in step by
  /// the refund endpoints rather than set by hand.
  refundedMinor: number;
  isTransfer: boolean;
  /// A one-off that should not be scored against a day. A laptop, a
  /// flight, a wedding gift: real spending, counted everywhere else, but
  /// a day is not a bad day for having had it. Kept out of the daily
  /// budget's bucket alone; the month's total and the pace still see it,
  /// because the money still left.
  isSpecial: boolean;
  /// Whether this credit is the month's pay. Marked by hand and never
  /// guessed: it lands a day either side of the date it is meant to, and a
  /// month with leave taken in it is smaller than the figure in a profile.
  isSalary?: boolean;
  /// The card whose bill this payment settled. Counts as nothing: every
  /// purchase on that card was already counted the day it happened.
  cardPaymentFor?: Types.ObjectId | null;
  /// The fixed monthly cost this payment went towards. Unlike a card
  /// bill this is real spending and counts in full - the link is about
  /// knowing the commitment has been met, and by how much.
  commitmentId?: Types.ObjectId | null;
  /// Set when only part of this bill was the user's own spending. The rest
  /// is money owed back, and countedAmountMinor drops to the share.
  split?: TransactionSplit | null;
  /// Repaying, or being repaid by, someone the user has split bills with.
  /// It moves real money but is not spending or income — the original
  /// split already accounted for it.
  isSettlement: boolean;
  pending: boolean;
  occurredAt: Date;
  /// Every message that reported this transaction, in the order they
  /// arrived. The top-level source/rawText/sourceRef mirror the first.
  sources: TransactionSourceEntry[];
  /// Whole transactions absorbed by a manual merge, kept verbatim so
  /// unmerging restores them exactly rather than reconstructing a guess.
  mergedFrom: Record<string, unknown>[];
  /// How much of amountMinor counts as money actually spent or received,
  /// and why it differs. Maintained by the hooks below, never set by hand.
  countedAmountMinor: number;
  countedReason: CountedReason;
  /// The statement line this row came from, when it came from one. Both
  /// the provenance the UI shows and the guard that keeps a second
  /// reconciliation of the same statement from adding it again.
  statementId?: Types.ObjectId | null;
  statementLineId?: Types.ObjectId | null;
  /// Set when a person edited the transaction by hand, so the UI can say so
  /// and automatic passes can leave their corrections alone.
  editedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RefundAllocation {
  transactionId: Types.ObjectId;
  amountMinor: number;
}

const refundAllocationSchema = new Schema<RefundAllocation>(
  {
    transactionId: { type: Schema.Types.ObjectId, ref: "Transaction", required: true },
    amountMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const transactionSplitSchema = new Schema<TransactionSplit>(
  {
    myShareMinor: { type: Number, required: true, min: 0 },
    groupLabel: { type: String, default: null },
  },
  { _id: false }
);

const transactionSourceSchema = new Schema<TransactionSourceEntry>(
  {
    source: { type: String, enum: TRANSACTION_SOURCES, required: true },
    sourceRef: { type: String, default: null },
    rawText: { type: String, default: null },
    receivedAt: { type: Date, required: true },
  },
  { _id: false }
);

// Absorbed transactions are kept verbatim, so the shape is deliberately
// open: strict:false stores whatever fields the row happened to have,
// which is what makes an unmerge exact rather than a reconstruction.
const mergedSnapshotSchema = new Schema({}, { _id: false, strict: false });

const transactionSchema = new Schema<TransactionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    amountMinor: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    type: { type: String, enum: TRANSACTION_TYPES, required: true },
    merchant: { type: String, default: null },
    note: { type: String, default: null },
    rawText: { type: String, default: null },
    source: { type: String, enum: TRANSACTION_SOURCES, required: true },
    sourceRef: { type: String, default: null },
    dedupeKey: { type: String, default: null },
    tripId: { type: Schema.Types.ObjectId, ref: "Trip", default: null },
    tripShareWith: { type: [Schema.Types.ObjectId], default: null },
    refundOf: { type: [refundAllocationSchema], default: [] },
    refundedMinor: { type: Number, default: 0, min: 0 },
    emiPlanId: { type: Schema.Types.ObjectId, ref: "EmiPlan", default: null },
    emiRole: { type: String, enum: EMI_ROLES, default: null },
    isTransfer: { type: Boolean, default: false },
    isSpecial: { type: Boolean, default: false },
    isSalary: { type: Boolean, default: false },
    cardPaymentFor: { type: Schema.Types.ObjectId, ref: "Account", default: null },
    commitmentId: { type: Schema.Types.ObjectId, ref: "FixedCommitment", default: null },
    split: { type: transactionSplitSchema, default: null },
    isSettlement: { type: Boolean, default: false },
    pending: { type: Boolean, default: false },
    occurredAt: { type: Date, required: true },
    editedAt: { type: Date, default: null },
    sources: { type: [transactionSourceSchema], default: [] },
    mergedFrom: { type: [mergedSnapshotSchema], default: [] },
    countedAmountMinor: { type: Number, default: 0 },
    countedReason: { type: String, enum: COUNTED_REASONS, default: "FULL" },
    // Where a row came from when no message ever announced it. Also what
    // stops a second reconciliation of the same statement adding it twice.
    statementId: { type: Schema.Types.ObjectId, ref: "CardStatement", default: null },
    statementLineId: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, ...serialization }
);

// Keeping the counted amount correct is the whole point of storing it, so
// it is derived on every write rather than at any call site. save() covers
// create(); findOneAndUpdate needs its own hook because it never loads a
// document. Any new write path has to go through one of these.
transactionSchema.pre("save", function (next) {
  Object.assign(this, resolveCountedAmount(this));

  // A row written before it had a sources list, or created by hand, still
  // needs one entry so the clients have a single shape to read.
  if (this.sources.length === 0) {
    this.sources.push({
      source: this.source,
      sourceRef: this.sourceRef ?? null,
      rawText: this.rawText ?? null,
      receivedAt: this.createdAt ?? this.occurredAt,
    });
  }

  next();
});

transactionSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate() as Record<string, unknown> | null;
  if (!update) return next();

  // The rule reads fields this update may not mention, so it has to run
  // against the document as it will be once the update lands.
  const current = await this.model.findOne(this.getQuery()).lean();
  if (!current) return next();

  const set = (update.$set as Record<string, unknown>) ?? {};
  const merged = { ...current, ...update, ...set } as Record<string, unknown>;
  const counted = resolveCountedAmount(merged as never);

  this.setUpdate({ ...update, $set: { ...set, ...counted } });
  next();
});

transactionSchema.index({ userId: 1, occurredAt: -1 });
transactionSchema.index({ userId: 1, dedupeKey: 1 });
transactionSchema.index({ sourceRef: 1 });
// Totting up what has come back against a purchase, and finding the
// refunds to unlink when one is deleted.
transactionSchema.index({ "refundOf.transactionId": 1 });
// A trip's totals read every member's transactions, so this is not scoped
// by user the way the other indexes are.
transactionSchema.index({ tripId: 1, occurredAt: -1 });

// Exposed as `category`/`account` (alongside the raw `categoryId`/`accountId`)
// so populated responses keep the shape the clients already expect.
transactionSchema.virtual("category", {
  ref: "Category",
  localField: "categoryId",
  foreignField: "_id",
  justOne: true,
});

transactionSchema.virtual("account", {
  ref: "Account",
  localField: "accountId",
  foreignField: "_id",
  justOne: true,
});

// So a row can say which holiday it belongs to without the client having
// to hold a separate list of trips.
transactionSchema.virtual("trip", {
  ref: "Trip",
  localField: "tripId",
  foreignField: "_id",
  justOne: true,
});

export const Transaction = model<TransactionDoc>("Transaction", transactionSchema);

export interface EmailConnectionDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiryDate?: Date | null;
  historyId?: string | null;
  lastSyncedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const emailConnectionSchema = new Schema<EmailConnectionDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, required: true },
    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    expiryDate: { type: Date, default: null },
    historyId: { type: String, default: null },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true, ...serialization }
);

emailConnectionSchema.index({ userId: 1, email: 1 }, { unique: true });

export const EmailConnection = model<EmailConnectionDoc>("EmailConnection", emailConnectionSchema);

export interface EmiPlanDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /// The purchase that was converted. Kept so cancelling a plan can put it
  /// back to counting in full.
  sourceTransactionId: Types.ObjectId;
  accountId?: Types.ObjectId | null;
  label?: string | null;
  principalMinor: number;
  months: number;
  /// What is actually billed each month. Entered from the statement where
  /// possible, since a computed figure rarely matches to the rupee.
  monthlyAmountMinor: number;
  totalPayableMinor: number;
  interestRatePctAnnual?: number | null;
  /// Charged once, up front. A real transaction of its own, so it is not
  /// part of totalPayable.
  processingFeeMinor?: number | null;
  startDate: Date;
  status: EmiPlanStatus;
  createdAt: Date;
  updatedAt: Date;
}

const emiPlanSchema = new Schema<EmiPlanDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sourceTransactionId: { type: Schema.Types.ObjectId, ref: "Transaction", required: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", default: null },
    label: { type: String, default: null },
    principalMinor: { type: Number, required: true, min: 1 },
    months: { type: Number, required: true, min: 1, max: 120 },
    monthlyAmountMinor: { type: Number, required: true, min: 1 },
    totalPayableMinor: { type: Number, required: true, min: 1 },
    interestRatePctAnnual: { type: Number, default: null, min: 0 },
    processingFeeMinor: { type: Number, default: null, min: 0 },
    startDate: { type: Date, required: true },
    status: { type: String, enum: EMI_PLAN_STATUSES, default: "ACTIVE" },
  },
  { timestamps: true, ...serialization }
);

// One plan per purchase: converting the same transaction twice would
// double-count the whole thing.
emiPlanSchema.index({ sourceTransactionId: 1 }, { unique: true });

export const EmiPlan = model<EmiPlanDoc>("EmiPlan", emiPlanSchema);

export interface EmiInstalmentDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  planId: Types.ObjectId;
  /// 1-based, so "3 of 12" reads straight off it.
  seq: number;
  dueDate: Date;
  amountMinor: number;
  status: EmiInstalmentStatus;
  /// The real debit, once one has arrived and been matched to it.
  transactionId?: Types.ObjectId | null;
  paidAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const emiInstalmentSchema = new Schema<EmiInstalmentDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    planId: { type: Schema.Types.ObjectId, ref: "EmiPlan", required: true, index: true },
    seq: { type: Number, required: true, min: 1 },
    dueDate: { type: Date, required: true },
    amountMinor: { type: Number, required: true, min: 0 },
    status: { type: String, enum: EMI_INSTALMENT_STATUSES, default: "DUE" },
    transactionId: { type: Schema.Types.ObjectId, ref: "Transaction", default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true, ...serialization }
);

emiInstalmentSchema.index({ planId: 1, seq: 1 }, { unique: true });
// Matching an incoming debit looks for what is still owed, soonest first.
emiInstalmentSchema.index({ userId: 1, status: 1, dueDate: 1 });

export const EmiInstalment = model<EmiInstalmentDoc>("EmiInstalment", emiInstalmentSchema);

export interface TripMember {
  userId: Types.ObjectId;
  joinedAt: Date;
}

export interface TripDoc {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  name: string;
  /// Everything spent between these belongs to the trip. endedAt is null
  /// while it is still running.
  startedAt: Date;
  endedAt?: Date | null;
  /// Everyone who can see it and add to it. The owner is always the first.
  members: TripMember[];
  /// Shared out of band — read out, or scanned as a QR code — so that
  /// joining needs no email address and no link handling.
  joinCode: string;
  createdAt: Date;
  updatedAt: Date;
}

const tripMemberSchema = new Schema<TripMember>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    joinedAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

const tripSchema = new Schema<TripDoc>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, default: null },
    members: { type: [tripMemberSchema], default: [] },
    joinCode: { type: String, required: true },
  },
  { timestamps: true, ...serialization }
);

tripSchema.index({ joinCode: 1 }, { unique: true });
// Membership is what authorises reading a trip, so it is looked up by it.
tripSchema.index({ "members.userId": 1 });

// One running trip at a time: "trip mode" is a switch, and two of them on
// at once would leave every payment ambiguous. A partial index rather than
// sparse, because endedAt is present-and-null rather than absent.
tripSchema.index(
  { ownerId: 1, endedAt: 1 },
  { unique: true, partialFilterExpression: { endedAt: null } }
);

export const Trip = model<TripDoc>("Trip", tripSchema);

export interface MerchantPresetDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /// What to put in the merchant field.
  merchant: string;
  /// The category that usually goes with it. Optional: a preset can just
  /// save the typing.
  categoryId?: Types.ObjectId | null;
  /// Used to put the ones reached for most at the front, which is the
  /// difference between a useful row of shortcuts and a wall of them.
  useCount: number;
  lastUsedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const merchantPresetSchema = new Schema<MerchantPresetDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    merchant: { type: String, required: true, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    useCount: { type: Number, default: 0, min: 0 },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true, ...serialization }
);

// One preset per merchant: a second would only be a slower way to pick the
// same thing.
merchantPresetSchema.index({ userId: 1, merchant: 1 }, { unique: true });

merchantPresetSchema.virtual("category", {
  ref: "Category",
  localField: "categoryId",
  foreignField: "_id",
  justOne: true,
});

export const MerchantPreset = model<MerchantPresetDoc>("MerchantPreset", merchantPresetSchema);

export interface FixedCommitmentDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  amountMinor: number;
  dayOfMonth: number;
  kind: CommitmentKind;
  /// Who it goes to, and what it counts as. Carried here so selecting the
  /// commitment on a payment fills both in - a fixed cost is the same
  /// merchant and the same category every month, which is most of the
  /// typing the payment would otherwise need.
  merchant?: string | null;
  categoryId?: Types.ObjectId | null;
  isActive: boolean;
  /// The period this was last ticked off for, as that period's start date
  /// in YYYY-MM-DD. Equal to the current period's start means it is paid.
  ///
  /// Ticked by hand rather than matched to a transaction, which is a
  /// deliberate choice with a cost: a commitment paid but not ticked is
  /// counted twice. Hence the list living where it will be seen.
  paidForPeriod?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const fixedCommitmentSchema = new Schema<FixedCommitmentDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true },
    amountMinor: { type: Number, required: true, min: 0 },
    dayOfMonth: { type: Number, required: true, min: 1, max: 31 },
    kind: { type: String, enum: COMMITMENT_KINDS, default: "OTHER" },
    merchant: { type: String, default: null, trim: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    isActive: { type: Boolean, default: true },
    paidForPeriod: { type: String, default: null },
  },
  { timestamps: true, ...serialization }
);

export const FixedCommitment = model<FixedCommitmentDoc>(
  "FixedCommitment",
  fixedCommitmentSchema
);

/**
 * One row of a credit card statement, with what reconciling made of it.
 *
 * Kept after the fact rather than thrown away once processed: it is the
 * only record of why a transaction nobody remembers is in the ledger, and
 * it is what makes re-reading the same statement a no-op.
 */
export interface StatementLine {
  _id: Types.ObjectId;
  /// The date the statement prints against the line. That is the posting
  /// date, which is not always the day the money was spent - see the
  /// tolerance in statements.reconcile.ts.
  date: Date;
  description: string;
  amountMinor: number;
  type: TransactionType;
  kind: StatementLineKind;
  resolution: StatementLineResolution;
  transactionId?: Types.ObjectId | null;
}

const statementLineSchema = new Schema<StatementLine>({
  date: { type: Date, required: true },
  description: { type: String, required: true },
  amountMinor: { type: Number, required: true, min: 0 },
  type: { type: String, enum: TRANSACTION_TYPES, required: true },
  kind: { type: String, enum: STATEMENT_LINE_KINDS, required: true },
  resolution: { type: String, enum: STATEMENT_LINE_RESOLUTIONS, default: "SKIPPED" },
  transactionId: { type: Schema.Types.ObjectId, ref: "Transaction", default: null },
});

export interface CardStatementDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /// Null while the statement could not be tied to a card - either it is
  /// still locked, or the card it belongs to is not in the app.
  accountId?: Types.ObjectId | null;
  /// Gmail message id and attachment id together. Provenance, and
  /// deliberately no longer an identity - see mailKey.
  sourceRef: string;
  /// What actually identifies a statement: the mail it arrived in, and the
  /// name of the file on it. Unique per user, which is what makes a
  /// repeated sync cost nothing.
  ///
  /// sourceRef was doing this job and could not do it. Gmail's attachmentId
  /// is an opaque token handed out per fetch rather than a stable name for
  /// the attachment, so every sync built a different sourceRef for the same
  /// file, matched nothing, and read the statement again from scratch -
  /// adding every transaction on it a second and a third time.
  mailKey?: string | null;
  /// A SHA-256 of the PDF, and the backstop for what mailKey cannot see:
  /// the same statement re-sent in a genuinely different mail.
  fileHash?: string | null;
  subject?: string | null;
  fileName?: string | null;
  /// Whether this is a card statement or a bank one. The model is still
  /// called CardStatement, and the collection with it, because renaming
  /// would move every document for no gain a reader of this line does
  /// not already get from the field itself.
  kind: StatementKind;
  /// Which reader read it. Worth storing: "generic" against a bank that
  /// has its own reader means the layout changed, and a short list of
  /// lines is the symptom either way.
  issuer?: string | null;
  status: StatementStatus;
  /// Why it could not be read, in words meant for the person who has to
  /// fix it rather than for a log.
  problem?: string | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  statementDate?: Date | null;
  dueDate?: Date | null;
  /// When the mail carrying this statement arrived. The only date a
  /// statement that could not be read has, and so the only thing that can
  /// put it in order next to the ones that could.
  receivedAt?: Date | null;
  /// The month this statement is filed under, as YYYY-MM in IST. Derived
  /// on save from whichever date it has, so that grouping a card's
  /// statements by month is a field lookup rather than a rule that every
  /// caller has to remember and apply the same way.
  monthKey?: string | null;
  /// The text the PDF extracted to, exactly as the readers saw it. Kept so
  /// a statement can be looked at again - and argued with - without
  /// fetching the mail a second time.
  rows?: string[];
  /// The size of the stored PDF, in bytes. Null when there is no file: the
  /// bytes live on disk, and this is how a listing knows one is there
  /// without going to look.
  fileBytes?: number | null;
  totalDueMinor?: number | null;
  minimumDueMinor?: number | null;
  lines: Types.DocumentArray<StatementLine>;
  /// Sum of the lines that are real spending, and what the ledger already
  /// held for the same card and period before this ran. The gap between
  /// the two is the thing the whole feature exists to find.
  statementSpendMinor: number;
  knownSpendMinor: number;
  reconciledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const cardStatementSchema = new Schema<CardStatementDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", default: null },
    sourceRef: { type: String, required: true },
    mailKey: { type: String, default: null },
    fileHash: { type: String, default: null },
    kind: { type: String, enum: STATEMENT_KINDS, default: "CARD" },
    subject: { type: String, default: null },
    fileName: { type: String, default: null },
    issuer: { type: String, default: null },
    status: { type: String, enum: STATEMENT_STATUSES, required: true },
    problem: { type: String, default: null },
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    statementDate: { type: Date, default: null },
    dueDate: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    monthKey: { type: String, default: null },
    rows: { type: [String], default: [] },
    fileBytes: { type: Number, default: null },
    totalDueMinor: { type: Number, default: null },
    minimumDueMinor: { type: Number, default: null },
    lines: { type: [statementLineSchema], default: [] },
    statementSpendMinor: { type: Number, default: 0 },
    knownSpendMinor: { type: Number, default: 0 },
    reconciledAt: { type: Date, default: null },
  },
  { timestamps: true, ...serialization }
);

/**
 * The month a statement is filed under.
 *
 * Its own date where it has one, then the close of its billing period,
 * then the day its mail arrived - the same order the list sorts in, so a
 * statement never appears under one month and sorts as though it were in
 * another. A statement too broken to have any of the three is filed under
 * no month and shows up on its own, which is the honest answer.
 */
function monthKeyFor(fields: {
  statementDate?: Date | null;
  periodEnd?: Date | null;
  receivedAt?: Date | null;
}): string | null {
  const dated = fields.statementDate ?? fields.periodEnd ?? fields.receivedAt;
  return dated ? istMonthKey(new Date(dated)) : null;
}

cardStatementSchema.pre("save", function (next) {
  this.monthKey = monthKeyFor(this);
  next();
});

// Every statement the sync writes arrives through findOneAndUpdate with an
// upsert, so deriving this on save alone would have meant deriving it
// almost never.
cardStatementSchema.pre("findOneAndUpdate", async function (next) {
  const update = (this.getUpdate() as Record<string, unknown> | null) ?? {};
  const set = (update.$set as Record<string, unknown>) ?? {};

  // The dates this reads may be ones the update is setting or ones it is
  // leaving alone, so it has to run against the document as it will be.
  const current = (await this.model.findOne(this.getQuery()).lean()) ?? {};
  const merged = { ...current, ...set } as Parameters<typeof monthKeyFor>[0];

  this.set("monthKey", monthKeyFor(merged));
  next();
});

// One statement per attachment. A sync that runs twice finds this rather
// than creating a second copy, which is the whole defence against a
// statement being reconciled - and its missing lines added - more than once.
//
// Partial rather than sparse, which on a compound index is not the same
// thing at all: sparse skips a document only when *every* indexed field is
// missing, and userId never is - so two statements with no fileHash would
// both index a null and the second would be rejected. The two that have
// none are the attachment too large to be a statement and the one that
// would not download, and neither is rare enough to lose.
cardStatementSchema.index(
  { userId: 1, mailKey: 1 },
  { unique: true, partialFilterExpression: { mailKey: { $type: "string" } } }
);
cardStatementSchema.index(
  { userId: 1, fileHash: 1 },
  { unique: true, partialFilterExpression: { fileHash: { $type: "string" } } }
);
// Kept non-unique. It was the identity and was not stable enough to be one,
// so it is now what it should always have been: a record of where a
// statement came from.
cardStatementSchema.index({ userId: 1, sourceRef: 1 });
cardStatementSchema.index({ userId: 1, statementDate: -1 });
// The shape the statements screen asks for: one card's statements, newest
// month first.
cardStatementSchema.index({ userId: 1, accountId: 1, monthKey: -1 });

export const CardStatement = model<CardStatementDoc>("CardStatement", cardStatementSchema);

/**
 * Something that makes a purchase cheaper, and the answer to "I am at
 * Gucci - do I have anything?"
 *
 * One collection for two kinds, because every lookup wants both and
 * ranking them against each other is the point. A card offer stands until
 * the bank changes it; a coupon is spent once and then gone.
 */
export interface PerkDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  kind: PerkKind;
  title: string;
  /// The card this is on. An offer without one is not an offer; a coupon
  /// without one works on any card.
  accountId?: Types.ObjectId | null;
  /// Merchant patterns, stored lowercase. Empty means it is not tied to a
  /// merchant - which, with no category either, means it applies anywhere.
  merchants: string[];
  categoryId?: Types.ObjectId | null;
  /// One or the other. A percentage is how card offers are written; a flat
  /// amount is how most coupons are.
  percent?: number | null;
  flatMinor?: number | null;
  /// The cap the small print puts on a percentage, and the floor under it.
  maxDiscountMinor?: number | null;
  minSpendMinor?: number | null;
  startsOn?: Date | null;
  expiresOn?: Date | null;
  code?: string | null;
  /// Coupons only. Set means spent, and it stops appearing.
  usedAt?: Date | null;
  /// True for one a model read off a picture that nobody has confirmed.
  ///
  /// It is a real perk either way - it shows up, it answers a lookup, it
  /// can be used. The flag only says where the figures came from, so a
  /// screen can offer them for a glance rather than presenting a machine's
  /// reading of small print as though somebody had typed it.
  needsReview?: boolean;
  isActive: boolean;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const perkSchema = new Schema<PerkDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    kind: { type: String, enum: PERK_KINDS, required: true },
    title: { type: String, required: true, trim: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", default: null },
    merchants: { type: [String], default: [] },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", default: null },
    percent: { type: Number, default: null, min: 0, max: 100 },
    flatMinor: { type: Number, default: null, min: 0 },
    maxDiscountMinor: { type: Number, default: null, min: 0 },
    minSpendMinor: { type: Number, default: null, min: 0 },
    startsOn: { type: Date, default: null },
    expiresOn: { type: Date, default: null },
    code: { type: String, default: null, trim: true },
    usedAt: { type: Date, default: null },
    needsReview: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: null, trim: true },
  },
  { timestamps: true, ...serialization }
);

// Patterns are matched case-insensitively, so they are stored folded once
// here rather than lowercased at every comparison.
perkSchema.pre("save", function (next) {
  this.merchants = this.merchants.map((merchant) => merchant.trim().toLowerCase()).filter(Boolean);
  next();
});

perkSchema.index({ userId: 1, isActive: 1, expiresOn: 1 });

export const Perk = model<PerkDoc>("Perk", perkSchema);

/**
 * The full details of a card, kept so they can be read back.
 *
 * A deliberate line is drawn here. The number, its expiry, the name
 * embossed on it and a free-text note are stored; the CVV is not, and
 * there is no field for one. A CVV is the single thing that turns a
 * stolen number into a transaction someone else can make, it is the one
 * value every card scheme forbids keeping, and it is three digits its
 * owner already knows. Storing it would buy nothing and risk everything.
 *
 * Every stored field is ciphertext. What sits in the clear is only what
 * the screen shows while locked: the last four digits and the network,
 * both of which SpendLog already knows from the account.
 */
export interface CardVaultDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  accountId: Types.ObjectId;
  /// iv.tag.ciphertext, base64, one field each. Separate rather than one
  /// blob so a note can be changed without rewriting the card number.
  number: string;
  expiry?: string | null;
  nameOnCard?: string | null;
  note?: string | null;
  /// Shown while locked, and the only part that is not encrypted.
  last4: string;
  createdAt: Date;
  updatedAt: Date;
}

const cardVaultSchema = new Schema<CardVaultDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    accountId: { type: Schema.Types.ObjectId, ref: "Account", required: true },
    number: { type: String, required: true },
    expiry: { type: String, default: null },
    nameOnCard: { type: String, default: null },
    note: { type: String, default: null },
    last4: { type: String, required: true },
  },
  {
    timestamps: true,
    ...serialization,
    toJSON: {
      ...serialization.toJSON,
      // Nothing encrypted here is ever serialised by accident. A vault is
      // only read through the route that checks the PIN first, and that
      // route builds its own response out of the decrypted values.
      transform: (doc: unknown, ret: Record<string, unknown>) => {
        serialization.toJSON.transform(doc, ret);
        for (const secret of ["number", "expiry", "nameOnCard", "note"]) delete ret[secret];
        return ret;
      },
    },
  }
);

// One set of details per card.
cardVaultSchema.index({ userId: 1, accountId: 1 }, { unique: true });

export const CardVault = model<CardVaultDoc>("CardVault", cardVaultSchema);

/**
 * A batch of coupon screenshots, being read.
 *
 * One at a time and in the background, because the model takes tens of
 * seconds an image and runs on the same cores as everything else. The job
 * is a document rather than a variable so a client can close the page,
 * come back, and still be told what happened - and so a restart leaves
 * evidence rather than silence.
 */
export type PerkImportStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export interface PerkImportItem {
  /// What the picture was called, so a failure can name it.
  fileName: string;
  /// Where the bytes are while they wait their turn. Deleted once the job
  /// is over, whether it worked or not.
  path: string;
  status: PerkImportStatus;
  /// The perk it became, or why it did not.
  perkId?: Types.ObjectId | null;
  problem?: string | null;
}

export interface PerkImportDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  status: PerkImportStatus;
  items: Types.DocumentArray<PerkImportItem>;
  /// Why the whole job stopped, as opposed to one picture in it.
  problem?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const perkImportItemSchema = new Schema<PerkImportItem>(
  {
    fileName: { type: String, default: "" },
    path: { type: String, required: true },
    status: { type: String, enum: ["QUEUED", "RUNNING", "DONE", "FAILED"], default: "QUEUED" },
    perkId: { type: Schema.Types.ObjectId, ref: "Perk", default: null },
    problem: { type: String, default: null },
  },
  { _id: true }
);

const perkImportSchema = new Schema<PerkImportDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["QUEUED", "RUNNING", "DONE", "FAILED"], default: "QUEUED" },
    items: { type: [perkImportItemSchema], default: [] },
    problem: { type: String, default: null },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, ...serialization }
);

// The one a client asks about is nearly always the newest.
perkImportSchema.index({ userId: 1, createdAt: -1 });

export const PerkImport = model<PerkImportDoc>("PerkImport", perkImportSchema);
