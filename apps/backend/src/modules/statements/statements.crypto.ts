import crypto from "node:crypto";

/**
 * Statement passwords, encrypted at rest.
 *
 * These are not ordinary secrets. An Indian card issuer builds the password
 * from a date of birth and a name, so the same string opens statements from
 * every other card the person holds, and a good deal else besides. Storing
 * one in plain text alongside the transactions it unlocks would be the
 * worst place in the app to keep it.
 *
 * So: AES-256-GCM, with the key held in the environment rather than the
 * database. A copy of the Atlas data on its own decrypts nothing.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      "STATEMENT_ENCRYPTION_KEY is not set, so statement passwords cannot be stored. " +
        "Generate one with `openssl rand -hex 32` and put it in the .env at the repo root."
    );
    this.name = "MissingEncryptionKeyError";
  }
}

/**
 * Read at call time rather than at import: the tests set the variable after
 * the module graph is already loaded, and a deployment that adds the key
 * should not need a different code path from one that always had it.
 */
function key(): Buffer {
  const raw = process.env.STATEMENT_ENCRYPTION_KEY ?? "";
  if (!raw) throw new MissingEncryptionKeyError();

  // 64 hex characters is the format the .env documents. Anything else is
  // treated as a passphrase and stretched, so a key that was set by hand
  // still works instead of failing at the moment someone saves a password.
  const hex = /^[0-9a-f]{64}$/i.test(raw);
  const derived = hex ? Buffer.from(raw, "hex") : crypto.scryptSync(raw, "spendlog-statement", KEY_BYTES);

  if (derived.length !== KEY_BYTES) throw new MissingEncryptionKeyError();
  return derived;
}

/** Whether a password can be stored at all. Used to explain, not to guess. */
export function encryptionAvailable(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * One opaque string, so the schema needs a single field and the ciphertext
 * carries everything needed to read it back except the key.
 */
export function encryptPassword(plain: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);

  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}

/**
 * Returns null rather than throwing when the stored value cannot be read —
 * a rotated key should leave the statement saying "locked" and the password
 * needing to be set again, not take the whole sync down with it.
 */
export function decryptPassword(stored: string | null | undefined): string | null {
  if (!stored) return null;

  const parts = stored.split(".");
  if (parts.length !== 3) return null;

  try {
    const [iv, tag, encrypted] = parts.map((part) => Buffer.from(part, "base64"));
    const decipher = crypto.createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
