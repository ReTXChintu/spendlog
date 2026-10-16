import { HydratedDocument, Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Account, AccountDoc, Transaction, TransactionDoc } from "../../models";
import { TransactionType } from "../../types";
import { accountLabel } from "../accounts/accounts.drift";
import { transferCategoryId } from "../categories/categories.system";
import { CARD_POSTS_AFTER_DAYS, CARD_POSTS_BEFORE_DAYS, mayBeCardPayment } from "../cards/cards.billPayment";

/**
 * Every transfer between the user's own accounts, as two real rows.
 *
 * A transfer used to be allowed one row: marked on the account the money
 * left, it moved the other account's balance by itself (see movementsOf).
 * That kept the balance right and nothing else. The receiving account's
 * own list and passbook never showed the money arriving, and when its bank
 * did send a message after all, that row and the transfer's far side were
 * the same money counted twice - which is most of what the reconciler
 * finds.
 *
 * So a transfer that names its other account and has no other leg is
 * given one (ensureTransferLegs):
 *
 *   - the other leg, already here: a row on the other account or one of
 *     its debit cards, the other way, the same amount, within three days,
 *     nobody's leg yet, and not something else entirely - a card bill, an
 *     EMI, a refund, the month's pay. A row nobody could place
 *     (accountUnknown) qualifies too, and is placed on the way. The
 *     closest in time is taken, and the two are paired;
 *   - otherwise, written in: the same amount the other way, at the same
 *     moment, on the other account, marked autoLeg - so the bank's own
 *     message can adopt it if it turns up after all (findAutoLeg), rather
 *     than arriving as a second row.
 *
 * Neither changes a balance that was right. A written-in leg moves the
 * other account exactly as the far side did; pairing with a row already
 * there stops that row being counted a second time, which is the point.
 *
 * A written-in leg nobody has confirmed follows its transfer: a new amount
 * or day moves it, a new account replaces it, and un-marking or deleting
 * the transfer takes it away (syncTransferLegs, releaseLegs). Once a
 * message has adopted it, or a person has edited it, it is a row like any
 * other and is only ever unpaired.
 *
 * Credit cards are left out on both sides: paying a card's bill is
 * cardPaymentFor, with a pairing of its own in cards.billPayment.service,
 * and its card side found or written in by cards.billLeg - on the same
 * pattern, with these helpers.
 */

/// The two sides of one transfer can post days apart - a NEFT on a
/// Friday evening lands on Monday.
const LEG_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What happened to the other side of a transfer, for the client to say so. */
export interface TransferLegResult {
  action: "paired" | "created";
  transactionId: string;
  accountId: string;
  /// "Federal Bank ••3295", or the nickname.
  accountName: string;
  /// Which way the money moved that account.
  type: TransactionType;
  amountMinor: number;
  /// Set on the card's side of a bill payment, so the client can word it
  /// as one ("paid into HDFC ••1377"). Absent for a transfer.
  kind?: "CARD_BILL";
}

export type AccountRow = Pick<AccountDoc, "_id" | "accountType" | "linkedAccountId" | "bankName" | "nickname" | "last4">;
export type Accounts = Map<string, AccountRow>;

export async function accountsOf(userId: Types.ObjectId): Promise<Accounts> {
  const accounts = await Account.find({ userId }).select("accountType linkedAccountId bankName nickname last4").lean<AccountRow[]>();
  return new Map(accounts.map((account) => [account._id.toString(), account]));
}

/**
 * The account whose money this is: a debit card's bank, otherwise the
 * account itself. The ledger's rule (ledgerContext), without its need for
 * a starting balance - a leg belongs on the bank whether or not anyone has
 * told SpendLog what is in it.
 */
export function ownerOf(id: Types.ObjectId | null | undefined, accounts: Accounts): AccountRow | null {
  const account = id ? accounts.get(id.toString()) : undefined;
  if (!account) return null;
  if (account.accountType === "DEBIT" && account.linkedAccountId) {
    return accounts.get(account.linkedAccountId.toString()) ?? account;
  }
  return account;
}

/** The owner and every debit card that spends from it. */
function familyOf(owner: AccountRow, accounts: Accounts): Types.ObjectId[] {
  return [
    owner._id,
    ...[...accounts.values()]
      .filter((account) => account.accountType === "DEBIT" && account.linkedAccountId?.equals(owner._id))
      .map((account) => account._id),
  ];
}

const opposite = (type: TransactionType): TransactionType => (type === "DEBIT" ? "CREDIT" : "DEBIT");

/** "Transfer from HDFC Bank ••8342" on money in, "Transfer to …" on money out - the edit form's wording. */
export function legMerchant(legType: TransactionType, otherAccount: AccountRow): string {
  return `${legType === "CREDIT" ? "Transfer from" : "Transfer to"} ${accountLabel(otherAccount)}`;
}

/**
 * Which account a transfer row moved money on. A row with no account was
 * paid in cash - what "no account" means everywhere else - unless nobody
 * knows which it was on.
 */
function hereOf(transaction: Pick<TransactionDoc, "accountId" | "accountUnknown">, accounts: Accounts): AccountRow | null {
  if (transaction.accountId) return ownerOf(transaction.accountId, accounts);
  if (transaction.accountUnknown) return null;
  return [...accounts.values()].find((account) => account.accountType === "CASH") ?? null;
}

/** Whether a row is the unconfirmed leg written in for this transfer. */
export function isUnconfirmedLegOf(leg: Pick<TransactionDoc, "autoLeg" | "autoLegOf">, transfer: { _id: Types.ObjectId }): boolean {
  return Boolean(leg.autoLeg) && Boolean(leg.autoLegOf?.equals(transfer._id));
}

export function resultOf(action: TransferLegResult["action"], leg: HydratedDocument<TransactionDoc>, account: AccountRow): TransferLegResult {
  return {
    action,
    transactionId: leg._id.toString(),
    accountId: account._id.toString(),
    accountName: accountLabel(account),
    type: leg.type,
    amountMinor: leg.amountMinor,
  };
}

/**
 * Gives a transfer its other leg, by pairing it with the row already
 * there or by writing one in. Does nothing - and returns null - for a row
 * that is not a transfer, names no other account, already has its leg, or
 * is a card bill; and for one whose written-in leg was deleted by hand
 * (legDeclined), since the person has said that leg was wrong.
 *
 * Writes both rows with save(), so the counted-amount hook zeroes them.
 */
export async function ensureTransferLegs(
  transaction: HydratedDocument<TransactionDoc>,
  known?: Accounts
): Promise<TransferLegResult | null> {
  if (!transaction.isTransfer || !transaction.transferAccountId || transaction.transferPairId) return null;
  if (transaction.cardPaymentFor || transaction.legDeclined) return null;

  const accounts = known ?? (await accountsOf(transaction.userId));
  const there = ownerOf(transaction.transferAccountId, accounts);
  const here = hereOf(transaction, accounts);
  if (!there || !here || there._id.equals(here._id)) return null;
  if (there.accountType === "CARD" || here.accountType === "CARD") return null;

  // What the other leg names as this side: the row's own account, which
  // may be a debit card, or the cash account it was paid from.
  const ownAccountId = transaction.accountId ?? here._id;
  const existing = await findOtherLeg(transaction, there, here, accounts);
  const transfers = await transferCategoryId();

  if (existing) {
    // A row nobody could place is on the other account: this says so.
    if (!existing.accountId) {
      existing.accountId = there._id;
      existing.accountUnknown = false;
    }
    existing.isTransfer = true;
    existing.transferAccountId = ownAccountId;
    existing.transferPairId = transaction._id;
    if (transfers) existing.categoryId ??= transfers;
    transaction.transferAccountId = existing.accountId;
    transaction.transferPairId = existing._id;
    await Promise.all([existing.save(), transaction.save()]);
    return resultOf("paired", existing, ownerOf(existing.accountId, accounts) ?? there);
  }

  const leg = await Transaction.create({
    userId: transaction.userId,
    accountId: there._id,
    type: opposite(transaction.type),
    amountMinor: transaction.amountMinor,
    currency: transaction.currency,
    occurredAt: transaction.occurredAt,
    merchant: legMerchant(opposite(transaction.type), accounts.get(ownAccountId.toString()) ?? here),
    categoryId: transfers,
    isTransfer: true,
    transferAccountId: ownAccountId,
    transferPairId: transaction._id,
    source: "MANUAL",
    autoLeg: true,
    autoLegOf: transaction._id,
  });
  // Named as the account the leg is on: the bank, where a debit card was
  // picked.
  transaction.transferAccountId = there._id;
  transaction.transferPairId = leg._id;
  await transaction.save();
  return resultOf("created", leg, there);
}

/**
 * The row already on the other account that is this transfer's other leg,
 * if there is one. See ensureTransferLegs for what qualifies.
 */
async function findOtherLeg(
  transaction: HydratedDocument<TransactionDoc>,
  there: AccountRow,
  here: AccountRow,
  accounts: Accounts
): Promise<HydratedDocument<TransactionDoc> | null> {
  const at = transaction.occurredAt.getTime();
  const candidates = await Transaction.find({
    userId: transaction.userId,
    _id: { $ne: transaction._id },
    type: opposite(transaction.type),
    amountMinor: transaction.amountMinor,
    occurredAt: { $gte: new Date(at - LEG_WINDOW_MS), $lte: new Date(at + LEG_WINDOW_MS) },
    transferPairId: null,
    // Something else entirely, whatever its amount.
    cardPaymentFor: null,
    emiRole: null,
    loanId: null,
    isSalary: { $ne: true },
    isSettlement: { $ne: true },
    isEarmarked: { $ne: true },
    isAdjustment: { $ne: true },
    "refundOf.0": { $exists: false },
    "people.0": { $exists: false },
    $or: [{ accountId: { $in: familyOf(there, accounts) } }, { accountId: null, accountUnknown: true }],
  });

  const fitting = candidates.filter((candidate) => {
    // A person said what this is, and it is not a transfer.
    if (candidate.kindEditedAt && !candidate.isTransfer) return false;
    // A transfer of its own to a third account is that transfer's leg.
    if (candidate.isTransfer && candidate.transferAccountId) {
      const itsOther = ownerOf(candidate.transferAccountId, accounts);
      if (!itsOther || !itsOther._id.equals(here._id)) return false;
    }
    return true;
  });

  // Closest in time; at the same distance, a row known to be on that
  // account over one nobody could place.
  const distance = (row: HydratedDocument<TransactionDoc>) => Math.abs(row.occurredAt.getTime() - at);
  fitting.sort((a, b) => distance(a) - distance(b) || Number(Boolean(a.accountUnknown)) - Number(Boolean(b.accountUnknown)));
  return fitting[0] ?? null;
}

/** The transfer-shaped fields of a row as they were before an edit. */
export type TransferSnapshot = Pick<
  TransactionDoc,
  "type" | "amountMinor" | "occurredAt" | "accountId" | "isTransfer" | "transferAccountId" | "transferPairId"
>;

export function sameId(a: Types.ObjectId | null | undefined, b: Types.ObjectId | null | undefined): boolean {
  return a && b ? a.equals(b) : !a && !b;
}

/**
 * Keeps the other leg in step after a row was edited, then makes sure the
 * row has one. `before` is the row as it was.
 *
 *   - no longer a transfer, or pointed at a different account: a
 *     written-in leg is deleted; a confirmed one is unpaired and stops
 *     naming this row's account, since the person has just said the money
 *     did not go there. Then the new account gets its leg in the usual way;
 *   - otherwise a written-in leg takes the new amount, day and direction,
 *     and the new account this side is on. A confirmed leg only learns
 *     the new account; what it says about itself is its own.
 */
export async function syncTransferLegs(
  row: HydratedDocument<TransactionDoc>,
  before: TransferSnapshot
): Promise<TransferLegResult | null> {
  // Most edits are to rows that are not transfers and never were.
  if (!row.isTransfer && !before.isTransfer && !before.transferPairId) return null;

  const accounts = await accountsOf(row.userId);
  const ends = !row.isTransfer || !row.transferAccountId;
  const retargeted =
    !ends && !sameId(ownerOf(row.transferAccountId, accounts)?._id, ownerOf(before.transferAccountId, accounts)?._id);
  // Something new was said about where the money went, so a leg deleted
  // for the old answer is no reason to leave the new one without.
  if (ends || retargeted) row.legDeclined = false;

  const partner = before.transferPairId
    ? await Transaction.findOne({ _id: before.transferPairId, userId: row.userId })
    : null;
  if (before.transferPairId && !partner) row.transferPairId = null;

  if (partner) {
    const unconfirmed = isUnconfirmedLegOf(partner, row);
    if (ends || retargeted) {
      if (unconfirmed) {
        await partner.deleteOne();
      } else if (partner.transferPairId?.equals(row._id)) {
        partner.transferPairId = null;
        partner.transferAccountId = null;
        await partner.save();
      }
      row.transferPairId = null;
    } else if (unconfirmed) {
      const ownAccountId = row.accountId ?? hereOf(row, accounts)?._id ?? null;
      partner.amountMinor = row.amountMinor;
      partner.occurredAt = row.occurredAt;
      partner.type = opposite(row.type);
      partner.transferAccountId = ownAccountId;
      const own = ownAccountId ? accounts.get(ownAccountId.toString()) : null;
      if (own) partner.merchant = legMerchant(partner.type, own);
      await partner.save();
    } else if (row.accountId && !sameId(partner.transferAccountId, row.accountId)) {
      partner.transferAccountId = row.accountId;
      await partner.save();
    }
  }

  if (row.isModified()) await row.save();
  if (ends) return null;
  return ensureTransferLegs(row, accounts);
}

/**
 * What deleting a row does to the other leg of its transfer.
 *
 * A leg written in for it and never confirmed goes with it: it only ever
 * stood for the far side of this one row. Anything else - a row a message
 * reported, or one a person has edited - is real money of its own, and is
 * only unpaired. It falls back to moving the deleted row's account by
 * itself, the way a one-row transfer always has, and is marked legDeclined
 * so a later edit does not write back the leg that was just deleted.
 */
export async function releaseLegs(deleted: Pick<TransactionDoc, "_id" | "userId" | "transferPairId" | "autoLeg" | "autoLegOf">): Promise<void> {
  if (!deleted.transferPairId) return;
  const partner = await Transaction.findOne({ _id: deleted.transferPairId, userId: deleted.userId });
  if (!partner || !partner.transferPairId?.equals(deleted._id)) return;

  if (isUnconfirmedLegOf(partner, deleted)) {
    await partner.deleteOne();
    return;
  }
  partner.transferPairId = null;
  partner.legDeclined = true;
  await partner.save();
}

/**
 * Before two rows are paired by hand: whatever either was paired with
 * until now. A leg written in for it goes; any other row is unpaired and
 * handed back, so the caller can give it a leg of its own once the new
 * pair is saved.
 */
export async function releaseForRepair(
  row: HydratedDocument<TransactionDoc>,
  newPartner: { _id: Types.ObjectId }
): Promise<HydratedDocument<TransactionDoc> | null> {
  if (!row.transferPairId || row.transferPairId.equals(newPartner._id)) return null;
  const old = await Transaction.findOne({ _id: row.transferPairId, userId: row.userId });
  if (!old || !old.transferPairId?.equals(row._id)) return null;

  if (isUnconfirmedLegOf(old, row)) {
    await old.deleteOne();
    return null;
  }
  old.transferPairId = null;
  await old.save();
  return old;
}

/**
 * A row merged into another is the same money, so its place in a transfer
 * passes to the row it was merged into: the usual case is a written-in leg
 * merged with the bank's own row for it, which arrived too late to adopt
 * it. When the surviving row is already a leg of something else, the
 * absorbed one's transfer is let go as if it had been deleted.
 */
export async function handOverLegs(
  absorbed: HydratedDocument<TransactionDoc>,
  target: HydratedDocument<TransactionDoc>
): Promise<void> {
  if (!absorbed.transferPairId || absorbed.transferPairId.equals(target._id)) return;
  if (target.transferPairId) return releaseLegs(absorbed);

  const partner = await Transaction.findOne({ _id: absorbed.transferPairId, userId: absorbed.userId });
  if (!partner || !partner.transferPairId?.equals(absorbed._id)) return;
  target.isTransfer = true;
  target.transferAccountId = absorbed.transferAccountId ?? null;
  target.transferPairId = partner._id;
  partner.transferPairId = target._id;
  if (target.accountId) partner.transferAccountId = target.accountId;
  await partner.save();
}

/**
 * The unconfirmed leg a message arriving now is the real version of: on
 * the account the message names (or a debit card of it), the same
 * direction and amount, within three days. Null when there is none, or
 * when the message names no account - one nobody can place is no evidence
 * for a particular account's leg.
 *
 * On a credit card the leg is the card's side of a bill payment, written
 * in at the moment the bank let the money go. The card's own message
 * comes up to four days after that (a day before, at most), and is never
 * money coming back: a refund of the same amount is a refund.
 */
export async function findAutoLeg(params: {
  userId: Types.ObjectId;
  accountId: Types.ObjectId | null;
  type: TransactionType;
  amountMinor: number;
  occurredAt: Date;
  /// The message's words, for telling a card's payment from its refund.
  rawText?: string | null;
}): Promise<HydratedDocument<TransactionDoc> | null> {
  if (!params.accountId) return null;
  const accounts = await accountsOf(params.userId);
  const owner = ownerOf(params.accountId, accounts);
  if (!owner) return null;
  const onCard = owner.accountType === "CARD";
  if (onCard && !mayBeCardPayment(params.rawText)) return null;

  const at = params.occurredAt.getTime();
  const window = onCard
    ? { $gte: new Date(at - CARD_POSTS_AFTER_DAYS * DAY_MS), $lte: new Date(at + CARD_POSTS_BEFORE_DAYS * DAY_MS) }
    : { $gte: new Date(at - LEG_WINDOW_MS), $lte: new Date(at + LEG_WINDOW_MS) };
  const legs = await Transaction.find({
    userId: params.userId,
    autoLeg: true,
    type: params.type,
    amountMinor: params.amountMinor,
    accountId: { $in: familyOf(owner, accounts) },
    occurredAt: window,
  });
  legs.sort((a, b) => Math.abs(a.occurredAt.getTime() - at) - Math.abs(b.occurredAt.getTime() - at));
  return legs[0] ?? null;
}

/**
 * Whether two accounts could be the one a message was about: the same
 * account, a bank and its debit card, or either one not known.
 */
export async function couldBeSameAccount(
  userId: Types.ObjectId,
  a: Types.ObjectId | null | undefined,
  b: Types.ObjectId | null | undefined
): Promise<boolean> {
  if (!a || !b) return true;
  if (a.equals(b)) return true;
  const accounts = await accountsOf(userId);
  return sameId(ownerOf(a, accounts)?._id, ownerOf(b, accounts)?._id);
}

/**
 * A message has turned up for a leg SpendLog wrote in: the row becomes
 * the message's. Called once ingest has added the message to the row the
 * way it adds any second message (absorbMessage), for what is particular
 * to a written-in leg - the moment and the provenance are the bank's now,
 * not a copy of the other side's. The pairing stays as it was.
 */
export function adoptAutoLeg(leg: HydratedDocument<TransactionDoc>, occurredAt: Date): void {
  // The entry the save hook wrote for a row no message reported. The
  // message replaces it rather than sitting beside it: there was never a
  // second report to split back out.
  const [first, ...rest] = leg.sources;
  if (first && first.source === "MANUAL" && !first.rawText && rest.length > 0) {
    leg.sources = rest as typeof leg.sources;
    leg.source = rest[0].source;
    leg.sourceRef = rest[0].sourceRef ?? null;
    leg.rawText = rest[0].rawText ?? null;
  }
  leg.occurredAt = occurredAt;
  leg.autoLeg = false;
}

/// Raised when the rule for giving a transfer its other leg changes.
export const TRANSFER_LEG_BACKFILL = "transferLegs";
export const TRANSFER_LEG_BACKFILL_VERSION = 1;

/**
 * Gives every one-row transfer of a user's its other leg: each transfer
 * that names another account and has no pair. Oldest first, each row read
 * fresh, since pairing one can take a row still to come. Safe to run
 * twice: a paired row is not looked at again, and one that cannot be
 * given a leg (a card on either side) is left exactly as it was.
 *
 * A transfer that names no other account is not touched - there is no
 * account to put a leg on.
 */
export async function backfillTransferLegs(userId: Types.ObjectId): Promise<{ paired: number; created: number }> {
  const accounts = await accountsOf(userId);
  const ids = await Transaction.find({
    userId,
    isTransfer: true,
    transferAccountId: { $ne: null },
    transferPairId: null,
    cardPaymentFor: null,
    legDeclined: { $ne: true },
  })
    .sort({ occurredAt: 1 })
    .select("_id");

  let paired = 0;
  let created = 0;
  for (const { _id } of ids) {
    const row = await Transaction.findById(_id);
    if (!row) continue;
    const result = await ensureTransferLegs(row, accounts);
    if (result?.action === "paired") paired += 1;
    if (result?.action === "created") created += 1;
  }
  return { paired, created };
}

/** The backfill above, for every user it has not run for (see backfill.ts). */
export async function runTransferLegBackfill(): Promise<{ users: number; changed: number; paired: number; created: number }> {
  let paired = 0;
  let created = 0;
  const result = await runOncePerUser(TRANSFER_LEG_BACKFILL, TRANSFER_LEG_BACKFILL_VERSION, async (userId) => {
    const counts = await backfillTransferLegs(userId);
    paired += counts.paired;
    created += counts.created;
    return counts.paired + counts.created;
  });
  if (result.users > 0) {
    console.log(
      `Transfer legs: ${paired} paired with a row already there, ${created} written in, across ${result.users} user(s).`
    );
  }
  return { ...result, paired, created };
}
