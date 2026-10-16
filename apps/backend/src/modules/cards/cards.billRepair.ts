import { HydratedDocument, Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { Transaction, TransactionDoc } from "../../models";
import { categorizeTransaction } from "../../parsing/categorizer";
import { transferCategoryId } from "../categories/categories.system";
import { adoptAutoLeg, isUnconfirmedLegOf, sameId } from "../transactions/transactions.transfer";
import { mergeTransactions } from "../transactions/transactions.merge";
import { recogniseCardBill } from "./cards.billPayment";
import { cardBillContext, findPaymentTwin, markCardBillPayment, paysItself } from "./cards.billPayment.service";

/**
 * Mending what card bill recognition got wrong before its rules were
 * tightened. Three repairs, each run once per user (see backfill.ts):
 *
 *   self payments    purchases on a card marked as paying that same card -
 *                    Jupiter's "debited to your Edge CSB Bank RuPay Credit
 *                    Card", read as a bill because of its "UPI Ref no." -
 *                    which counted nothing and marked the bill paid;
 *   card credits     money onto a card "from a/c no. XX1614", which the
 *                    recogniser did not know was a payment, left counted
 *                    as income;
 *   payment twins    an issuer's second "payment received" for the same
 *                    payment, kept as a second payment and so paying the
 *                    bill twice.
 *
 * Every row is written with save(), so the counted amount is worked out by
 * the same hook as every other write.
 */

/** Everything that was said about a row, as one piece of text. */
function wordsOf(row: Pick<TransactionDoc, "rawText" | "merchant" | "sources">): string {
  const texts = [row.rawText, ...row.sources.map((entry) => entry.rawText), row.merchant];
  return [...new Set(texts.filter((text): text is string => Boolean(text)))].join(" \n ");
}

function rupees(amountMinor: number): string {
  return `₹${(amountMinor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/// Raised when the rule for a payment that cannot be its card's bill changes.
export const CARD_SELF_PAYMENT_BACKFILL = "cardSelfPayments";
export const CARD_SELF_PAYMENT_BACKFILL_VERSION = 1;

/**
 * Turns one user's purchases that were marked as paying their own card
 * back into purchases: cardPaymentFor cleared, the card side written in
 * for it deleted, a real row it was paired with let go, and the counted
 * amount worked out again - so it counts as spending, and the bill is no
 * longer paid by it.
 *
 * Done even where kindEditedAt is set. That marker is what normally keeps
 * a repair off a person's decision, but these were set by an earlier
 * backfill of ours, and no person can have meant a card to pay itself. A
 * debit on the card itself is never valid, so it is always mended; one
 * through a debit card linked to the card (the other way paysItself
 * refuses) only when its words now read as anything but a payment.
 *
 * Safe to run twice: a mended row no longer pays any card.
 */
export async function repairSelfPayments(userId: Types.ObjectId): Promise<{ rows: number; amountMinor: number }> {
  const context = await cardBillContext(userId);
  const marked = await Transaction.find({ userId, type: "DEBIT", cardPaymentFor: { $ne: null } })
    .sort({ occurredAt: 1 })
    .select("_id accountId cardPaymentFor");
  const ids = marked.filter((row) => paysItself(row.accountId, row.cardPaymentFor, context)).map((row) => row._id);

  const transfers = await transferCategoryId();
  let rows = 0;
  let amountMinor = 0;
  for (const _id of ids) {
    const row = await Transaction.findById(_id);
    if (!row || !paysItself(row.accountId, row.cardPaymentFor, context)) continue;
    const card = row.cardPaymentFor!;
    if (!sameId(row.accountId, card)) {
      const accountId = row.accountId!.toString();
      const match = recogniseCardBill(
        { text: wordsOf(row), type: "DEBIT", accountId, accountType: context.accountTypeOf.get(accountId) ?? null },
        context.cards
      );
      if (match?.side === "PAYMENT") continue;
    }

    // The card side written in for it. Never a message's, so nothing is lost.
    await Transaction.deleteMany({ userId, autoLeg: true, autoLegOf: row._id });

    // A real row it was paired with is let go, and may find the payment it
    // really belongs to below.
    let released: HydratedDocument<TransactionDoc> | null = null;
    if (row.transferPairId) {
      const partner = await Transaction.findOne({ _id: row.transferPairId, userId });
      if (partner && partner.transferPairId?.equals(row._id) && !isUnconfirmedLegOf(partner, row)) {
        partner.transferPairId = null;
        if (sameId(partner.transferAccountId, row.accountId)) partner.transferAccountId = null;
        await partner.save();
        released = partner;
      }
    }

    row.cardPaymentFor = null;
    row.transferPairId = null;
    row.legDeclined = false;
    // Made a transfer to nowhere on the way to being a bill: a purchase is
    // not one, and the transfer category goes with it.
    if (row.isTransfer && (!row.transferAccountId || sameId(row.transferAccountId, card))) {
      row.isTransfer = false;
      row.transferAccountId = null;
      if (transfers && row.categoryId?.equals(transfers)) {
        row.categoryId = await categorizeTransaction({ userId, merchant: row.merchant ?? null, rawText: row.rawText ?? null });
      }
    }
    await row.save();
    if (released) await markCardBillPayment(released, context);

    rows += 1;
    amountMinor += row.amountMinor;
  }
  return { rows, amountMinor };
}

/** The repair above, for every user it has not run for (see backfill.ts). */
export async function runSelfPaymentRepair(): Promise<{ users: number; changed: number; amountMinor: number }> {
  let amountMinor = 0;
  const result = await runOncePerUser(CARD_SELF_PAYMENT_BACKFILL, CARD_SELF_PAYMENT_BACKFILL_VERSION, async (userId) => {
    const repaired = await repairSelfPayments(userId);
    amountMinor += repaired.amountMinor;
    return repaired.rows;
  });
  if (result.users > 0) {
    console.log(
      `Card self-payments: ${result.changed} purchase(s) counted again, ${rupees(amountMinor)}, across ${result.users} user(s).`
    );
  }
  return { ...result, amountMinor };
}

/// Raised when the recogniser learns a new way a card says it was paid.
export const CARD_CREDIT_BACKFILL = "cardCredits";
export const CARD_CREDIT_BACKFILL_VERSION = 1;

/**
 * Looks again at one user's money onto their cards that is still counted
 * as income: neither a transfer nor a refund. One the recogniser now reads
 * as a payment arriving is marked as one (markCardBillPayment) - paired
 * with its bank debit where there is one, otherwise a payment from an
 * account that does not text, which is what pays the bill down.
 *
 * Rows a person has said the kind of are left alone, as at ingest. Safe to
 * run twice: a marked row is a transfer, and not looked at again.
 */
export async function recogniseCardCredits(userId: Types.ObjectId): Promise<number> {
  const context = await cardBillContext(userId);
  const cardIds = context.cards.map((card) => new Types.ObjectId(card.id));
  const ids = await Transaction.find({
    userId,
    type: "CREDIT",
    accountId: { $in: cardIds },
    isTransfer: false,
    cardPaymentFor: null,
    "refundOf.0": { $exists: false },
  })
    .sort({ occurredAt: 1 })
    .select("_id");

  let recognised = 0;
  for (const { _id } of ids) {
    const row = await Transaction.findById(_id);
    if (!row || row.isTransfer) continue;
    if (await markCardBillPayment(row, context)) recognised += 1;
  }
  return recognised;
}

/** The repair above, for every user it has not run for (see backfill.ts). */
export async function runCardCreditBackfill(): Promise<{ users: number; changed: number }> {
  const result = await runOncePerUser(CARD_CREDIT_BACKFILL, CARD_CREDIT_BACKFILL_VERSION, recogniseCardCredits);
  if (result.users > 0) {
    console.log(`Card credits: ${result.changed} recognised as bill payments, across ${result.users} user(s).`);
  }
  return result;
}

/// Raised when the rule for an issuer's second "payment received" changes.
export const PAYMENT_TWIN_BACKFILL = "cardPaymentTwins";
export const PAYMENT_TWIN_BACKFILL_VERSION = 1;

/**
 * Folds each second report of a card payment into the first, card by
 * card: an unpaired "payment received" transfer whose twin - the same
 * amount on the same card within three days (findPaymentTwin) - is paired
 * with its debit, or came first. Merged the way a person merges two rows
 * (mergeTransactions), so the message is kept on the surviving row and an
 * unmerge gives it back.
 *
 * Safe to run twice: a merged row is gone, and one with no twin is left
 * exactly as it was.
 */
export async function mergePaymentTwins(userId: Types.ObjectId): Promise<{ merged: number; amountMinor: number }> {
  const context = await cardBillContext(userId);
  let merged = 0;
  let amountMinor = 0;

  for (const card of context.cards) {
    const cardId = new Types.ObjectId(card.id);
    const ids = await Transaction.find({
      userId,
      type: "CREDIT",
      accountId: cardId,
      isTransfer: true,
      transferPairId: null,
      cardPaymentFor: null,
      "refundOf.0": { $exists: false },
    })
      .sort({ occurredAt: 1 })
      .select("_id");

    for (const { _id } of ids) {
      const duplicate = await Transaction.findById(_id);
      if (!duplicate || duplicate.transferPairId) continue;
      // Itself a card's "payment received", by its words.
      const match = recogniseCardBill(
        { text: wordsOf(duplicate), type: "CREDIT", accountId: card.id, accountType: "CARD" },
        context.cards
      );
      if (match?.side !== "PAYMENT_RECEIVED") continue;

      const kept = await findPaymentTwin({
        userId,
        cardId,
        amountMinor: duplicate.amountMinor,
        occurredAt: duplicate.occurredAt,
        excludeId: duplicate._id,
      });
      if (!kept) continue;
      // Two unpaired reports: the later one is the second, and is folded
      // into the earlier when its own turn comes.
      const first =
        kept.occurredAt.getTime() < duplicate.occurredAt.getTime() ||
        (kept.occurredAt.getTime() === duplicate.occurredAt.getTime() && kept._id.toString() < duplicate._id.toString());
      if (!kept.transferPairId && !first) continue;

      // A written-in side is the real message's now, as at ingest.
      const written = kept.autoLeg;
      const at = duplicate.occurredAt;
      await mergeTransactions(kept, [duplicate]);
      if (written) {
        adoptAutoLeg(kept, at);
        await kept.save();
      }
      merged += 1;
      amountMinor += duplicate.amountMinor;
    }
  }
  return { merged, amountMinor };
}

/** The repair above, for every user it has not run for (see backfill.ts). */
export async function runPaymentTwinBackfill(): Promise<{ users: number; changed: number; amountMinor: number }> {
  let amountMinor = 0;
  const result = await runOncePerUser(PAYMENT_TWIN_BACKFILL, PAYMENT_TWIN_BACKFILL_VERSION, async (userId) => {
    const twins = await mergePaymentTwins(userId);
    amountMinor += twins.amountMinor;
    return twins.merged;
  });
  if (result.users > 0) {
    console.log(
      `Card payment twins: ${result.changed} second report(s) merged, ${rupees(amountMinor)} no longer paid twice, across ${result.users} user(s).`
    );
  }
  return { ...result, amountMinor };
}
