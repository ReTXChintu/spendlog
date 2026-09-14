import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, CardVault, Transaction } from "../../models";
import { cardStatuses } from "../cards/cards.status";
import { upcomingBills } from "../statements/statements.bills";
import { ACCOUNT_TYPES } from "../../types";

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

// GET /accounts — the bank accounts and cards, whether detected from
// messages or added by hand.
accountsRouter.get("/", async (req, res) => {
  const accounts = await Account.find({ userId: currentUserId(req) }).sort({
    isActive: -1,
    bankName: 1,
    last4: 1,
  });
  res.json(accounts);
});

/**
 * GET /accounts/overview — every account with everything its own panel
 * shows, in one request.
 *
 * The accounts screen draws a card per account: what it is, where it
 * stands this cycle, when its statement and its bill fall, whether a
 * statement password and card details are stored. Left to the client that
 * is four requests per account and a waterfall; the figures already exist
 * together on the server, because the dashboard needs the same ones.
 */
accountsRouter.get("/overview", async (req, res) => {
  const userId = currentUserId(req);

  const [accounts, statuses, vaults, bills] = await Promise.all([
    Account.find({ userId }).sort({ isActive: -1, accountType: 1, bankName: 1, last4: 1 }),
    cardStatuses(userId),
    CardVault.find({ userId }).select("accountId last4"),
    upcomingBills(userId),
  ]);

  const statusFor = new Map(statuses.map((status) => [status.accountId, status]));
  const nameFor = new Map(
    accounts.map((account) => [account._id.toString(), account.nickname || account.bankName])
  );

  const cardsOn = new Map<string, typeof accounts>();
  for (const account of accounts) {
    if (account.accountType !== "DEBIT" || !account.linkedAccountId) continue;
    const key = account.linkedAccountId.toString();
    cardsOn.set(key, [...(cardsOn.get(key) ?? []), account]);
  }
  const vaultFor = new Map(vaults.map((vault) => [vault.accountId.toString(), vault]));
  const billFor = new Map(bills.map((bill) => [bill.accountId, bill]));

  res.json(
    accounts.map((account) => {
      const id = account._id.toString();
      const status = statusFor.get(id) ?? null;

      return {
        ...account.toJSON(),
        /// Null for anything that is not an active card: a savings account
        /// has no cycle and no limit, and inventing zeroes for it would
        /// put an empty progress bar on screen that means nothing.
        cycle: status
          ? {
              statementOn: status.statementOn,
              dueOn: status.dueOn,
              floatDays: status.floatDays,
              spentMinor: status.spentMinor,
              limitMinor: status.limitMinor,
              remainingMinor: status.remainingMinor,
              state: status.state,
            }
          : null,
        /// The last bill read off a statement, which is the only figure
        /// here that comes from the bank rather than from adding up
        /// messages.
        bill: billFor.get(id)
          ? {
              totalDueMinor: billFor.get(id)!.totalDueMinor,
              dueOn: billFor.get(id)!.dueDate,
              daysUntilDue: billFor.get(id)!.daysUntilDue,
              isPaid: billFor.get(id)!.isPaid,
            }
          : null,
        hasCardDetails: vaultFor.has(id),
        /// What a debit card draws on, named rather than referenced - the
        /// panel says "draws on HDFC Savings", and an id would mean the
        /// client holding the whole list to turn it into that.
        linkedAccount: account.linkedAccountId
          ? (nameFor.get(account.linkedAccountId.toString()) ?? null)
          : null,
        /// For a bank account, the debit cards that reach it. Its spending
        /// includes theirs.
        debitCards: (cardsOn.get(id) ?? []).map((card) => ({
          id: card._id.toString(),
          name: card.nickname || card.bankName,
          last4: card.last4 ?? null,
          network: card.cardNetwork ?? null,
        })),
      };
    })
  );
});

const accountFields = {
  bankName: z.string().min(1).max(80),
  last4: z.string().regex(/^\d{2,6}$/).nullable().optional(),
  accountType: z.enum(ACCOUNT_TYPES),
  nickname: z.string().max(60).nullable().optional(),
  issuer: z.string().max(80).nullable().optional(),
  cardNetwork: z.string().max(40).nullable().optional(),
  linkedAccountId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .nullable()
    .optional(),
  creditLimitMinor: z.number().int().nonnegative().nullable().optional(),
  spendLimitMinor: z.number().int().nonnegative().nullable().optional(),
  statementDay: z.number().int().min(1).max(31).nullable().optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  isActive: z.boolean().optional(),
  color: z.string().max(20).nullable().optional(),
};

const createAccountSchema = z.object(accountFields);

// POST /accounts — for an account no message has revealed yet, typically
// cash or a bank that never texts.
accountsRouter.post("/", async (req, res) => {
  const parsed = createAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const { bankName, last4 = null, accountType } = parsed.data;

  // One cash account is enough; a second would only split the same pocket
  // in two.
  if (accountType === "CASH") {
    const existing = await Account.findOne({ userId, accountType: "CASH" });
    if (existing) {
      return res.status(409).json({ error: "You already have a cash account", accountId: existing.id });
    }
  }

  // The same real account added twice would break self-transfer detection,
  // which relies on one row per account.
  const clash = await Account.findOne({
    userId,
    $or: [{ bankName, last4, accountType }, { aliases: { $elemMatch: { bankName, last4, accountType } } }],
  });
  if (clash) {
    return res.status(409).json({ error: "That account already exists", accountId: clash.id });
  }

  const link = await resolveLink(userId, parsed.data);
  if (typeof link === "string") return res.status(400).json({ error: link });

  const created = await Account.create({ userId, ...parsed.data, last4, linkedAccountId: link });
  res.status(201).json(created);
});

/**
 * The bank account a debit card draws on, checked before it is stored.
 *
 * Only a debit card has one, and it must point at a bank account of this
 * user's. A link to a credit card or to somebody else's account would make
 * the reconciler treat two unrelated pots as one, and it would do it
 * quietly.
 *
 * Returns the id to store, null for no link, or a sentence saying why not.
 */
async function resolveLink(
  userId: Types.ObjectId,
  fields: { accountType?: string; linkedAccountId?: string | null }
): Promise<Types.ObjectId | null | string> {
  if (fields.linkedAccountId === undefined) return null;
  if (fields.linkedAccountId === null) return null;

  if (fields.accountType !== undefined && fields.accountType !== "DEBIT") {
    return "Only a debit card draws on a bank account.";
  }

  const bank = await Account.findOne({
    _id: fields.linkedAccountId,
    userId,
    accountType: "BANK",
  });
  if (!bank) return "That is not one of your bank accounts.";

  return bank._id;
}

// Identity is editable, but changing it moves what incoming messages match.
const updateAccountSchema = z.object(accountFields).partial();

accountsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const account = await Account.findOne({ _id: req.params.id, userId });
  if (!account) return res.status(404).json({ error: "Not found" });

  // Checked against what the account will be, not what it is: a card can
  // be made a debit card and linked in the same edit.
  const link = await resolveLink(userId, {
    accountType: parsed.data.accountType ?? account.accountType,
    linkedAccountId: parsed.data.linkedAccountId,
  });
  if (typeof link === "string") return res.status(400).json({ error: link });

  const updated = await Account.findOneAndUpdate(
    { _id: req.params.id, userId },
    {
      $set: {
        ...parsed.data,
        ...(parsed.data.linkedAccountId === undefined ? {} : { linkedAccountId: link }),
      },
    },
    { new: true, runValidators: true }
  );
  if (!updated) return res.status(404).json({ error: "Not found" });

  res.json(updated);
});

// DELETE /accounts/:id — refused while transactions still point at it, so
// history is never silently detached. ?unassign=true clears them instead.
accountsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const account = await Account.findOne({ _id: req.params.id, userId });
  if (!account) return res.status(404).json({ error: "Not found" });

  // Cash is a fixture, not something the user added — every account needs
  // somewhere to put a payment that came out of a pocket. Closing it hides
  // it from the pickers without losing what was already filed under it.
  if (account.accountType === "CASH") {
    return res.status(400).json({
      error: "Cash can't be deleted. Mark it closed instead if you never use it.",
    });
  }

  const inUse = await Transaction.countDocuments({ userId, accountId: account._id });
  if (inUse > 0 && req.query.unassign !== "true") {
    return res.status(409).json({
      error: `${inUse} ${inUse === 1 ? "transaction uses" : "transactions use"} this account`,
      transactionCount: inUse,
      hint: "Merge it into another account, or delete with ?unassign=true to clear it from them",
    });
  }

  if (inUse > 0) {
    await Transaction.updateMany({ userId, accountId: account._id }, { $set: { accountId: null } });
  }
  await account.deleteOne();

  res.status(204).end();
});

const mergeAccountSchema = z.object({
  // The account being absorbed. Its transactions and identity move across.
  fromId: z.string().regex(/^[0-9a-fA-F]{24}$/),
});

// POST /accounts/:id/merge — the same real account detected twice, because
// one bank writes "HDFC" in an SMS and "HDFC Bank" in an email.
accountsRouter.post("/:id/merge", validObjectIdParam("id"), async (req, res) => {
  const parsed = mergeAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.fromId === req.params.id) {
    return res.status(400).json({ error: "An account cannot be merged into itself" });
  }

  const userId = currentUserId(req);
  const [target, source] = await Promise.all([
    Account.findOne({ _id: req.params.id, userId }),
    Account.findOne({ _id: parsed.data.fromId, userId }),
  ]);
  if (!target || !source) return res.status(404).json({ error: "Not found" });

  await Transaction.updateMany(
    { userId, accountId: source._id },
    { $set: { accountId: target._id } }
  );

  // The absorbed account's identity — and anything it had already absorbed
  // — becomes an alias, so the next message that spells it that way lands
  // on the survivor instead of recreating the row just deleted.
  const incoming = [
    { bankName: source.bankName, last4: source.last4 ?? null, accountType: source.accountType },
    ...source.aliases,
  ];
  for (const alias of incoming) {
    const known = target.aliases.some(
      (a) =>
        a.bankName === alias.bankName &&
        (a.last4 ?? null) === (alias.last4 ?? null) &&
        a.accountType === alias.accountType
    );
    const isTargetItself =
      target.bankName === alias.bankName &&
      (target.last4 ?? null) === (alias.last4 ?? null) &&
      target.accountType === alias.accountType;

    if (!known && !isTargetItself) target.aliases.push(alias);
  }

  await source.deleteOne();
  await target.save();

  res.json(target);
});
