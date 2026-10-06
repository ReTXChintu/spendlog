import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, MerchantPreset, User } from "../../models";
import { MIN_PASSWORD_LENGTH, hashPassword } from "./family.password";
import { pushAvailable } from "./family.push";

export const familyRouter = Router();
familyRouter.use(requireAuth);

/**
 * The owner's side of kids' logins: making them, choosing which pocket
 * money accounts each one sees, resetting a password, and taking a login
 * away. A kid can never do any of this for themselves - there is no
 * sign-up for a kid, only what a parent sets up here.
 */

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

function kidJson(kid: InstanceType<typeof User>) {
  return {
    id: kid._id.toString(),
    name: kid.name ?? "",
    email: kid.email,
    accountIds: (kid.kidAccountIds ?? []).map((id) => id.toString()),
    createdAt: kid.createdAt,
  };
}

/**
 * The accounts a kid may be given: the owner's own pocket-money accounts,
 * none of which already belongs to another kid. Returns an error sentence,
 * or null when every one is fine.
 */
async function checkAccounts(ownerId: Types.ObjectId, accountIds: string[], kidId: Types.ObjectId | null) {
  if (new Set(accountIds).size !== accountIds.length) return "The same account is in the list twice.";
  if (accountIds.length === 0) return null;

  const accounts = await Account.find({ _id: { $in: accountIds }, userId: ownerId });
  if (accounts.length !== accountIds.length) return "Unknown account";
  if (accounts.some((account) => !account.pocketMoney)) {
    return "Only a pocket money account can be given to a kid. Make it pocket money first.";
  }

  const taken = await User.findOne({
    role: "KID",
    parentId: ownerId,
    kidAccountIds: { $in: accountIds.map((id) => new Types.ObjectId(id)) },
    ...(kidId ? { _id: { $ne: kidId } } : {}),
  });
  return taken ? `One of those accounts already belongs to ${taken.name ?? taken.email}.` : null;
}

// GET /family/kids — every kid's login on this account.
familyRouter.get("/kids", async (req, res) => {
  const kids = await User.find({ role: "KID", parentId: currentUserId(req) }).sort({ createdAt: 1 });
  res.json({ kids: kids.map(kidJson), pushAvailable: pushAvailable() });
});

const createKidSchema = z.object({
  name: z.string().trim().min(1).max(40),
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(100),
  accountIds: z.array(z.string().regex(OBJECT_ID)).max(20).default([]),
});

// POST /family/kids — a new kid's login. The email is not checked or
// written to; it only has to be one nobody uses on SpendLog already.
familyRouter.post("/kids", async (req, res) => {
  const parsed = createKidSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: `Give a name, an email, and a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
    });
  }

  const ownerId = currentUserId(req);
  if (await User.exists({ email: parsed.data.email })) {
    return res.status(409).json({ error: "That email is already used on SpendLog. Use a different one." });
  }
  const problem = await checkAccounts(ownerId, parsed.data.accountIds, null);
  if (problem) return res.status(400).json({ error: problem });

  const { hash, salt } = hashPassword(parsed.data.password);
  const kid = await User.create({
    email: parsed.data.email,
    name: parsed.data.name,
    role: "KID",
    parentId: ownerId,
    kidAccountIds: parsed.data.accountIds,
    passwordHash: hash,
    passwordSalt: salt,
    // No ledger of their own to start in: everything a kid sees is the
    // parent's.
    ledgerFrom: null,
  });
  res.status(201).json(kidJson(kid));
});

const updateKidSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  accountIds: z.array(z.string().regex(OBJECT_ID)).max(20).optional(),
  /// A new password, typed by the parent. Signs the kid's phone out.
  password: z.string().min(MIN_PASSWORD_LENGTH).max(100).optional(),
});

// PATCH /family/kids/:id — rename, change accounts, reset the password.
familyRouter.patch("/kids/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateKidSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `A password needs at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const ownerId = currentUserId(req);
  const kid = await User.findOne({ _id: req.params.id, role: "KID", parentId: ownerId });
  if (!kid) return res.status(404).json({ error: "Not found" });

  if (parsed.data.accountIds) {
    const problem = await checkAccounts(ownerId, parsed.data.accountIds, kid._id);
    if (problem) return res.status(400).json({ error: problem });
    kid.kidAccountIds = parsed.data.accountIds.map((id) => new Types.ObjectId(id));
  }
  if (parsed.data.name) kid.name = parsed.data.name;
  if (parsed.data.password) {
    const { hash, salt } = hashPassword(parsed.data.password);
    kid.passwordHash = hash;
    kid.passwordSalt = salt;
    kid.tokenVersion = (kid.tokenVersion ?? 0) + 1;
    kid.failedLogins = 0;
    kid.loginLockedUntil = null;
  }
  await kid.save();
  res.json(kidJson(kid));
});

// DELETE /family/kids/:id — the login goes; the transactions it touched
// stay, since they were always the parent's.
familyRouter.delete("/kids/:id", validObjectIdParam("id"), async (req, res) => {
  const kid = await User.findOneAndDelete({ _id: req.params.id, role: "KID", parentId: currentUserId(req) });
  if (!kid) return res.status(404).json({ error: "Not found" });
  await MerchantPreset.deleteMany({ userId: kid._id });
  res.status(204).end();
});

const deviceSchema = z.object({ token: z.string().min(20).max(4096) });

// POST /family/devices — this phone can be woken to read SMS when a kid
// refreshes. Called by the owner's app after sign-in and whenever Firebase
// hands it a new token.
familyRouter.post("/devices", async (req, res) => {
  const parsed = deviceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A device token is required" });

  const ownerId = currentUserId(req);
  await User.updateOne({ _id: ownerId }, { $pull: { fcmTokens: { token: parsed.data.token } } });
  await User.updateOne(
    { _id: ownerId },
    // The newest few: a phone reinstalled ten times should not be woken ten times.
    { $push: { fcmTokens: { $each: [{ token: parsed.data.token, updatedAt: new Date() }], $slice: -5 } } }
  );
  res.status(204).end();
});

// DELETE /family/devices — this phone no longer wants waking (signed out).
familyRouter.delete("/devices", async (req, res) => {
  const parsed = deviceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A device token is required" });
  await User.updateOne({ _id: currentUserId(req) }, { $pull: { fcmTokens: { token: parsed.data.token } } });
  res.status(204).end();
});
