import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, CardVault, User } from "../../models";
import { decryptPassword, encryptPassword, encryptionAvailable } from "../statements/statements.crypto";
import { VaultLockedError, checkPin, hashPin, isWellFormedPin, pinStatus } from "./vault.pin";

/**
 * Card details, kept under a PIN.
 *
 * Two rules run through every route here. Nothing decrypted is returned
 * without a PIN checked on that same request - there is no unlock that
 * lasts, because a token that lasts is a token that can be stolen while it
 * does. And the CVV is not stored, has no field, and is refused if sent:
 * it is the one value that turns a stolen number into someone else's
 * purchase, and its owner already knows it by heart.
 */

export const vaultRouter = Router();
vaultRouter.use(requireAuth);

const pinBody = z.object({ pin: z.string() });

const detailsBody = z.object({
  pin: z.string(),
  number: z.string().min(12).max(24),
  expiry: z.string().max(7).nullish(),
  nameOnCard: z.string().max(60).nullish(),
  note: z.string().max(400).nullish(),
});

/** The digits, with whatever spacing or dashes were typed around them. */
function digitsOf(raw: string): string {
  return raw.replace(/\D/g, "");
}

async function loadUser(req: Parameters<typeof currentUserId>[0]) {
  return User.findById(currentUserId(req));
}

// GET /vault — whether a PIN is set, and whether it is currently locked out.
vaultRouter.get("/", async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(404).json({ error: "Not found" });

  res.json({ ...pinStatus(user), available: encryptionAvailable() });
});

/**
 * PUT /vault/pin — set a PIN, or change one.
 *
 * Changing requires the current PIN. Because the PIN is a gate and not the
 * key, nothing has to be re-encrypted when it changes - and nothing is
 * lost if it is forgotten, which is why there is a reset below.
 */
vaultRouter.put("/pin", async (req, res) => {
  const parsed = z
    .object({ pin: z.string(), currentPin: z.string().optional() })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A PIN is required" });

  if (!isWellFormedPin(parsed.data.pin)) {
    return res.status(400).json({ error: "A PIN is four to six digits." });
  }

  const user = await loadUser(req);
  if (!user) return res.status(404).json({ error: "Not found" });

  if (user.vaultPin) {
    const current = parsed.data.currentPin ?? "";
    try {
      if (!(await checkPin(user, current))) {
        return res.status(403).json({ error: "That is not the current PIN." });
      }
    } catch (error) {
      if (error instanceof VaultLockedError) return res.status(429).json({ error: error.message });
      throw error;
    }
  }

  user.vaultPin = hashPin(parsed.data.pin);
  await user.save();

  res.json(pinStatus(user));
});

/**
 * DELETE /vault/pin — forget the PIN, and every card detail with it.
 *
 * The honest reset. The PIN cannot be recovered and the details are not
 * worth keeping behind a lock nobody can open, so both go together rather
 * than leaving a vault that can never be read.
 */
vaultRouter.delete("/pin", async (req, res) => {
  if (req.body?.confirm !== "forget my card details") {
    return res.status(400).json({
      error:
        "Resetting the PIN deletes every stored card detail with it. " +
        'Send { "confirm": "forget my card details" }.',
    });
  }

  const userId = currentUserId(req);
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ error: "Not found" });

  const removed = await CardVault.deleteMany({ userId });
  user.vaultPin = null;
  await user.save();

  res.json({ ...pinStatus(user), detailsDeleted: removed.deletedCount ?? 0 });
});

// GET /vault/cards — which accounts have details stored. No PIN needed:
// the answer is a yes or a no and the last four digits, which the account
// already shows.
vaultRouter.get("/cards", async (req, res) => {
  const vaults = await CardVault.find({ userId: currentUserId(req) }).select("accountId last4 updatedAt");

  res.json(
    vaults.map((vault) => ({
      accountId: vault.accountId.toString(),
      last4: vault.last4,
      updatedAt: vault.updatedAt,
    }))
  );
});

/**
 * PUT /vault/cards/:id — store one card's details.
 *
 * The PIN is required to write as well as to read. Writing is how details
 * are replaced, and letting anyone with the session overwrite a card
 * number would make the lock on reading decorative.
 */
vaultRouter.put("/cards/:id", validObjectIdParam("id"), async (req, res) => {
  if (!encryptionAvailable()) {
    return res.status(400).json({
      error:
        "STATEMENT_ENCRYPTION_KEY is not set on the server, so card details cannot be stored. " +
        "Generate one with `openssl rand -hex 32` and put it in the .env at the repo root.",
    });
  }

  // Refused rather than ignored. Somebody sending one should be told why
  // it is not wanted, not left thinking it was saved.
  if (req.body && ("cvv" in req.body || "cvc" in req.body)) {
    return res.status(400).json({
      error:
        "SpendLog does not store a CVV. It is the one field that turns a stolen card number into " +
        "a purchase someone else can make, and you already know yours.",
    });
  }

  const parsed = detailsBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Those card details are not complete." });

  const userId = currentUserId(req);
  const user = await User.findById(userId);
  if (!user?.vaultPin) return res.status(400).json({ error: "Set a PIN before storing card details." });

  try {
    if (!(await checkPin(user, parsed.data.pin))) {
      return res.status(403).json({ error: "Wrong PIN." });
    }
  } catch (error) {
    if (error instanceof VaultLockedError) return res.status(429).json({ error: error.message });
    throw error;
  }

  const accountId = new Types.ObjectId(req.params.id);
  const account = await Account.findOne({ _id: accountId, userId });
  if (!account) return res.status(404).json({ error: "Not found" });

  const digits = digitsOf(parsed.data.number);
  if (digits.length < 12 || digits.length > 19) {
    return res.status(400).json({ error: "That does not look like a card number." });
  }

  const vault = await CardVault.findOneAndUpdate(
    { userId, accountId },
    {
      $set: {
        number: encryptPassword(digits),
        expiry: parsed.data.expiry ? encryptPassword(parsed.data.expiry) : null,
        nameOnCard: parsed.data.nameOnCard ? encryptPassword(parsed.data.nameOnCard) : null,
        note: parsed.data.note ? encryptPassword(parsed.data.note) : null,
        last4: digits.slice(-4),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // The account learns its own last four from this, if it never knew them.
  // A card added by hand often has none until its first message arrives.
  if (!account.last4) {
    account.last4 = vault.last4;
    await account.save();
  }

  res.json({ accountId: accountId.toString(), last4: vault.last4, updatedAt: vault.updatedAt });
});

/**
 * POST /vault/cards/:id/reveal — the details, in the clear, once.
 *
 * A POST rather than a GET because it carries a PIN and because it is not
 * a thing to be cached, linked or logged in a query string.
 */
vaultRouter.post("/cards/:id/reveal", validObjectIdParam("id"), async (req, res) => {
  const parsed = pinBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A PIN is required" });

  const userId = currentUserId(req);
  const user = await User.findById(userId);
  if (!user?.vaultPin) return res.status(400).json({ error: "No PIN is set." });

  try {
    if (!(await checkPin(user, parsed.data.pin))) {
      const { attemptsLeft } = pinStatus(user);
      return res.status(403).json({
        error: attemptsLeft > 0 ? `Wrong PIN. ${attemptsLeft} attempts left.` : "Wrong PIN.",
      });
    }
  } catch (error) {
    if (error instanceof VaultLockedError) return res.status(429).json({ error: error.message });
    throw error;
  }

  const vault = await CardVault.findOne({ userId, accountId: new Types.ObjectId(req.params.id) });
  if (!vault) return res.status(404).json({ error: "No details are stored for this card." });

  res.setHeader("Cache-Control", "no-store, private");
  res.json({
    number: decryptPassword(vault.number),
    expiry: decryptPassword(vault.expiry),
    nameOnCard: decryptPassword(vault.nameOnCard),
    note: decryptPassword(vault.note),
    last4: vault.last4,
    updatedAt: vault.updatedAt,
  });
});

// DELETE /vault/cards/:id — forget one card's details. Behind the PIN like
// everything else: deleting is a change, and the lock covers changes.
vaultRouter.delete("/cards/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = pinBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A PIN is required" });

  const userId = currentUserId(req);
  const user = await User.findById(userId);
  if (!user?.vaultPin) return res.status(400).json({ error: "No PIN is set." });

  try {
    if (!(await checkPin(user, parsed.data.pin))) return res.status(403).json({ error: "Wrong PIN." });
  } catch (error) {
    if (error instanceof VaultLockedError) return res.status(429).json({ error: error.message });
    throw error;
  }

  await CardVault.deleteOne({ userId, accountId: new Types.ObjectId(req.params.id) });
  res.status(204).end();
});
