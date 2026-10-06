import crypto from "node:crypto";

/**
 * A kid's password, as an scrypt hash with its own salt.
 *
 * Owners never have one - they sign in with Google - so this exists only
 * for the logins a parent makes for their children. The parent types the
 * password; nobody can read it back, including the parent.
 */

const KEY_BYTES = 64;

export const MIN_PASSWORD_LENGTH = 6;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_BYTES).toString("hex");
  return { hash, salt };
}

export function checkPassword(password: string, hash: string | null | undefined, salt: string | null | undefined): boolean {
  if (!hash || !salt) return false;
  const candidate = crypto.scryptSync(password, salt, KEY_BYTES);
  const stored = Buffer.from(hash, "hex");
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}
