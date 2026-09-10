import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Transaction } from "../../models";
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

const accountFields = {
  bankName: z.string().min(1).max(80),
  last4: z.string().regex(/^\d{2,6}$/).nullable().optional(),
  accountType: z.enum(ACCOUNT_TYPES),
  nickname: z.string().max(60).nullable().optional(),
  issuer: z.string().max(80).nullable().optional(),
  cardNetwork: z.string().max(40).nullable().optional(),
  creditLimitMinor: z.number().int().nonnegative().nullable().optional(),
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

  // The same real account added twice would break self-transfer detection,
  // which relies on one row per account.
  const clash = await Account.findOne({
    userId,
    $or: [{ bankName, last4, accountType }, { aliases: { $elemMatch: { bankName, last4, accountType } } }],
  });
  if (clash) {
    return res.status(409).json({ error: "That account already exists", accountId: clash.id });
  }

  const created = await Account.create({ userId, ...parsed.data, last4 });
  res.status(201).json(created);
});

// Identity is editable, but changing it moves what incoming messages match.
const updateAccountSchema = z.object(accountFields).partial();

accountsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const updated = await Account.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $set: parsed.data },
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
