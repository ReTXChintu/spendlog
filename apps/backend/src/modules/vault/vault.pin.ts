import crypto from "node:crypto";
import { HydratedDocument } from "mongoose";
import { UserDoc } from "../../models";

/**
 * The PIN that unlocks stored card details.
 *
 * It guards a screen rather than a key: the details themselves are
 * encrypted with the server's own key, and this decides who gets to ask
 * for them. That is a deliberate choice and it has a consequence worth
 * being clear about - a PIN can be reset without losing anything, and a
 * server that is compromised can read the cards. The alternative, deriving
 * the key from the PIN, trades a forgotten PIN for a card you re-type.
 *
 * Four to six digits is a million guesses at the outside, so the hash is
 * not what protects it. The counter is. Five wrong answers and nothing is
 * accepted for fifteen minutes, whatever the sixth one says.
 */

const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** Deliberately expensive. A PIN has little entropy to begin with. */
const SCRYPT = { N: 16384, r: 8, p: 1 };

export const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export class VaultLockedError extends Error {
  constructor(public readonly until: Date) {
    const minutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000));
    super(`Too many wrong PINs. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    this.name = "VaultLockedError";
  }
}

/** Four to six digits, and nothing that is not a digit. */
export function isWellFormedPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,6}$/.test(pin);
}

function derive(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, KEY_BYTES, SCRYPT).toString("base64");
}

export function hashPin(pin: string): { hash: string; salt: string; failedAttempts: number } {
  const salt = crypto.randomBytes(SALT_BYTES).toString("base64");
  return { hash: derive(pin, salt), salt, failedAttempts: 0 };
}

/**
 * Check a PIN, and remember that it was checked.
 *
 * Throws when the vault is locked, returns false for a wrong answer, and
 * saves either way - a counter that only persists on the paths someone
 * remembers to save is not a counter.
 */
export async function checkPin(
  user: HydratedDocument<UserDoc>,
  pin: string
): Promise<boolean> {
  const stored = user.vaultPin;
  if (!stored) return false;

  if (stored.lockedUntil && stored.lockedUntil.getTime() > Date.now()) {
    throw new VaultLockedError(stored.lockedUntil);
  }

  // Constant time, on buffers of a known equal length. A PIN check that
  // returns faster for a wrong first digit is a PIN check with a side door.
  const offered = Buffer.from(derive(pin, stored.salt), "base64");
  const expected = Buffer.from(stored.hash, "base64");
  const ok = offered.length === expected.length && crypto.timingSafeEqual(offered, expected);

  if (ok) {
    stored.failedAttempts = 0;
    stored.lockedUntil = null;
  } else {
    stored.failedAttempts += 1;
    if (stored.failedAttempts >= MAX_ATTEMPTS) {
      stored.lockedUntil = new Date(Date.now() + LOCKOUT_MS);
      stored.failedAttempts = 0;
    }
  }

  user.markModified("vaultPin");
  await user.save();

  return ok;
}

/** What a client is told about the lock, which is never the PIN itself. */
export function pinStatus(user: HydratedDocument<UserDoc>): {
  hasPin: boolean;
  lockedUntil: string | null;
  attemptsLeft: number;
} {
  const stored = user.vaultPin;
  const locked = stored?.lockedUntil && stored.lockedUntil.getTime() > Date.now();

  return {
    hasPin: Boolean(stored),
    lockedUntil: locked ? stored!.lockedUntil!.toISOString() : null,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - (stored?.failedAttempts ?? 0)),
  };
}
