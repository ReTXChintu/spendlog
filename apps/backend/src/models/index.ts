import { Schema, Types, model } from "mongoose";
import {
  ACCOUNT_TYPES,
  COUNTED_REASONS,
  EMI_INSTALMENT_STATUSES,
  EMI_PLAN_STATUSES,
  EMI_ROLES,
  RULE_MATCH_TYPES,
  TRANSACTION_SOURCES,
  TRANSACTION_TYPES,
  AccountType,
  CountedReason,
  EmiInstalmentStatus,
  EmiPlanStatus,
  EmiRole,
  RuleMatchType,
  TransactionSource,
  TransactionType,
} from "../types";
import { resolveCountedAmount } from "./counted";

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
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDoc>(
  {
    email: { type: String, required: true, unique: true },
    name: { type: String, default: null },
    googleId: { type: String, default: null },
  },
  { timestamps: true, ...serialization }
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
  creditLimitMinor?: number | null;
  /// Day of month the card statement is generated, and the day it is due.
  statementDay?: number | null;
  dueDay?: number | null;
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
    creditLimitMinor: { type: Number, default: null },
    statementDay: { type: Number, default: null, min: 1, max: 31 },
    dueDay: { type: Number, default: null, min: 1, max: 31 },
    isActive: { type: Boolean, default: true },
    color: { type: String, default: null },
  },
  { timestamps: true, ...serialization }
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
    refundOf: { type: [refundAllocationSchema], default: [] },
    refundedMinor: { type: Number, default: 0, min: 0 },
    emiPlanId: { type: Schema.Types.ObjectId, ref: "EmiPlan", default: null },
    emiRole: { type: String, enum: EMI_ROLES, default: null },
    isTransfer: { type: Boolean, default: false },
    split: { type: transactionSplitSchema, default: null },
    isSettlement: { type: Boolean, default: false },
    pending: { type: Boolean, default: false },
    occurredAt: { type: Date, required: true },
    editedAt: { type: Date, default: null },
    sources: { type: [transactionSourceSchema], default: [] },
    mergedFrom: { type: [mergedSnapshotSchema], default: [] },
    countedAmountMinor: { type: Number, default: 0 },
    countedReason: { type: String, enum: COUNTED_REASONS, default: "FULL" },
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
