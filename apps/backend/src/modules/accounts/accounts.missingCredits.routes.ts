import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Category, Contact, MissingCredit, Transaction } from "../../models";
import { MISSING_CREDIT_ANSWERS, MISSING_CREDIT_STATUSES } from "../../types";
import { istDayKey } from "../../time";
import { peopleCategoryId, transferCategoryId } from "../categories/categories.system";
import { syncRefundTotal } from "../transactions/transactions.routes";
import { ensureTransferLegs, legMerchant } from "../transactions/transactions.transfer";
import { tripForOccurredAt } from "../trips/trips.service";
import { describeMissingCredits, settleMissingCredits } from "./accounts.missingCredits";

/**
 * Saying what came in.
 *
 * A missing credit is a to-do, not a row (accounts.missingCredits). These
 * are the answers: each writes the real credit on the account, dated in
 * the window the money arrived in, with the fields that make it what the
 * user says it was - and only then does it count as anything.
 *
 * Mounted on /accounts ahead of the routes that take an account id.
 */
export const missingCreditsRouter = Router();

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

const listQuerySchema = z.object({
  status: z.enum([...MISSING_CREDIT_STATUSES, "all"]).default("open"),
  accountId: z.string().regex(OBJECT_ID).optional(),
});

// GET /accounts/missing-credits?status=open - each with what it most
// likely was.
missingCreditsRouter.get("/missing-credits", async (req, res) => {
  const query = listQuerySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.flatten() });

  const userId = currentUserId(req);
  await settleMissingCredits(userId, query.data.accountId ? [query.data.accountId] : undefined);
  const credits = await MissingCredit.find({
    userId,
    ...(query.data.status === "all" ? {} : { status: query.data.status }),
    ...(query.data.accountId ? { accountId: query.data.accountId } : {}),
  })
    .sort({ before: -1 })
    .limit(100);
  res.json(await describeMissingCredits(userId, credits));
});

// GET /accounts/missing-credits/:id - one, from its passbook row.
missingCreditsRouter.get("/missing-credits/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const credit = await MissingCredit.findOne({ _id: req.params.id, userId });
  if (!credit) return res.status(404).json({ error: "Not found" });
  res.json((await describeMissingCredits(userId, [credit]))[0]);
});

const resolveSchema = z.object({
  as: z.enum(MISSING_CREDIT_ANSWERS),
  /// transfer: the account it came from.
  fromAccountId: z.string().regex(OBJECT_ID).optional(),
  /// paid_back: who paid.
  contactId: z.string().regex(OBJECT_ID).optional(),
  /// refund: the purchase it gave money back from, when it is known now.
  /// The refund sheet can link more afterwards.
  refundOf: z.string().regex(OBJECT_ID).optional(),
  /// income (or any): what to file it under.
  categoryId: z.string().regex(OBJECT_ID).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  /// When it landed, if the user knows: somewhere in the window.
  on: z.coerce.date().optional(),
});

/**
 * When the answer's row is dated. Strictly inside the window: on or
 * before the first figure it would already have been in that figure, and
 * at the second figure's own instant it could sort after it - either way
 * the gap would stay open. A second before the second figure when no day
 * is given; a day given is held to the window by IST day and then nudged
 * inside it.
 */
function dateInWindow(after: Date, before: Date, on?: Date): Date | string {
  const low = after.getTime() + 1;
  const high = before.getTime() - 1;
  const middle = new Date(Math.floor((after.getTime() + before.getTime()) / 2));
  if (high < low) return middle;
  if (!on) return new Date(Math.max(low, before.getTime() - 1000));
  if (istDayKey(on) < istDayKey(after) || istDayKey(on) > istDayKey(before)) {
    return "That day is outside the window the money arrived in.";
  }
  return new Date(Math.min(high, Math.max(low, on.getTime())));
}

/**
 * POST /accounts/missing-credits/:id/resolve - what it was, in one tap.
 *
 *   transfer   from another of the user's accounts: a transfer, given its
 *              other leg - the debit already on that account when there is
 *              one (its bank texts debits, so usually there is), written in
 *              when there is not;
 *   salary     the month's pay;
 *   refund     money given back, linked to the purchase when one is named;
 *   paid_back  someone settling up, as the editor's "Paid back" does;
 *   income     anything else, in the category given.
 */
missingCreditsRouter.post("/missing-credits/:id/resolve", validObjectIdParam("id"), async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const body = parsed.data;

  const userId = currentUserId(req);
  const credit = await MissingCredit.findOne({ _id: req.params.id, userId });
  if (!credit) return res.status(404).json({ error: "Not found" });
  if (credit.status !== "open") {
    return res.status(409).json({ error: "That has already been answered or dismissed." });
  }
  const account = await Account.findOne({ _id: credit.accountId, userId });
  if (!account) return res.status(404).json({ error: "The account it came into is gone." });

  const occurredAt = dateInWindow(credit.after, credit.before, body.on);
  if (typeof occurredAt === "string") return res.status(400).json({ error: occurredAt });

  if (body.categoryId) {
    const known = await Category.exists({ _id: body.categoryId, $or: [{ userId: null }, { userId }] });
    if (!known) return res.status(400).json({ error: "Unknown category" });
  }

  const fields: Record<string, unknown> = {
    userId,
    accountId: account._id,
    type: "CREDIT",
    amountMinor: credit.amountMinor,
    occurredAt,
    note: body.note ?? null,
    categoryId: body.categoryId ?? null,
    source: "MANUAL",
    tripId: await tripForOccurredAt(userId, occurredAt),
  };

  let purchaseId: Types.ObjectId | null = null;
  switch (body.as) {
    case "transfer": {
      if (!body.fromAccountId) return res.status(400).json({ error: "Say which account it came from." });
      const from = await Account.findOne({ _id: body.fromAccountId, userId });
      if (!from) return res.status(400).json({ error: "Unknown account" });
      const fromOwner =
        from.accountType === "DEBIT" && from.linkedAccountId ? from.linkedAccountId.toString() : from._id.toString();
      if (fromOwner === account._id.toString()) {
        return res.status(400).json({ error: "Money can't come from the account it went into." });
      }
      if (from.accountType === "CARD") {
        return res.status(400).json({ error: "A credit card pays bills, not transfers. Pick a bank account or cash." });
      }
      Object.assign(fields, {
        isTransfer: true,
        transferAccountId: from._id,
        merchant: legMerchant("CREDIT", from),
        categoryId: body.categoryId ?? (await transferCategoryId()),
      });
      break;
    }
    case "salary":
      Object.assign(fields, { isSalary: true, merchant: "Salary" });
      break;
    case "refund": {
      if (body.refundOf) {
        const purchase = await Transaction.findOne({ _id: body.refundOf, userId, type: "DEBIT" });
        if (!purchase) return res.status(400).json({ error: "A refund has to come from your own payments" });
        purchaseId = purchase._id;
        fields.refundOf = [
          { transactionId: purchase._id, amountMinor: Math.min(credit.amountMinor, purchase.amountMinor) },
        ];
        fields.merchant = purchase.merchant ? `Refund from ${purchase.merchant}` : "Refund";
      } else {
        fields.merchant = "Refund";
      }
      break;
    }
    case "paid_back": {
      if (!body.contactId) return res.status(400).json({ error: "Say who paid you back." });
      const contact = await Contact.findOne({ _id: body.contactId, userId });
      if (!contact) return res.status(400).json({ error: "Unknown contact" });
      Object.assign(fields, {
        isSettlement: true,
        people: [{ contactId: contact._id, amountMinor: credit.amountMinor }],
        merchant: contact.name,
        categoryId: body.categoryId ?? (await peopleCategoryId()),
      });
      break;
    }
    case "income": {
      const category = body.categoryId ? await Category.findById(body.categoryId).select("name") : null;
      fields.merchant = category?.name ?? "Money in";
      break;
    }
  }

  const created = await Transaction.create(fields);
  if (purchaseId) await syncRefundTotal(purchaseId, userId);
  // The other account's side of a transfer: paired with its debit, or
  // written in.
  const transferLeg = body.as === "transfer" ? await ensureTransferLegs(created) : null;

  credit.status = "resolved";
  credit.resolvedAs = body.as;
  credit.resolvedTransactionId = created._id;
  credit.closedAt = new Date();
  await credit.save();

  const transaction = await Transaction.findById(created._id).populate("category").populate("account").populate("trip");
  res.status(201).json({
    missingCredit: (await describeMissingCredits(userId, [credit]))[0],
    transaction: transaction!.toJSON(),
    transferLeg,
  });
});

// POST /accounts/missing-credits/:id/dismiss - "not sure". The gap stays
// a gap: the balance shows it again, and the reconciler still lists it.
missingCreditsRouter.post("/missing-credits/:id/dismiss", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const credit = await MissingCredit.findOne({ _id: req.params.id, userId });
  if (!credit) return res.status(404).json({ error: "Not found" });
  if (credit.status !== "open") {
    return res.status(409).json({ error: "That has already been answered or dismissed." });
  }
  credit.status = "dismissed";
  credit.dismissedReason = "user";
  credit.closedAt = new Date();
  await credit.save();
  res.json((await describeMissingCredits(userId, [credit]))[0]);
});

const dismissDueSchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

// POST /accounts/:id/statement-due/dismiss {month} - no statement for that
// month, and no more asking. The to-do itself is in accounts.drift.ts.
missingCreditsRouter.post("/:id/statement-due/dismiss", validObjectIdParam("id"), async (req, res) => {
  const parsed = dismissDueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const account = await Account.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $addToSet: { statementDueDismissed: parsed.data.month } },
    { new: true }
  );
  if (!account) return res.status(404).json({ error: "Not found" });
  res.json({ accountId: account._id.toString(), statementDueDismissed: account.statementDueDismissed });
});
