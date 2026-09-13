import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  decryptPassword,
  encryptionAvailable,
  encryptPassword,
  MissingEncryptionKeyError,
} from "./statements.crypto";

const KEY = crypto.randomBytes(32).toString("hex");

function withKey(value: string | undefined, run: () => void) {
  const previous = process.env.STATEMENT_ENCRYPTION_KEY;
  if (value === undefined) delete process.env.STATEMENT_ENCRYPTION_KEY;
  else process.env.STATEMENT_ENCRYPTION_KEY = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.STATEMENT_ENCRYPTION_KEY;
    else process.env.STATEMENT_ENCRYPTION_KEY = previous;
  }
}

afterEach(() => {
  delete process.env.STATEMENT_ENCRYPTION_KEY;
});

describe("statement password encryption", () => {
  it("reads back what it stored", () => {
    withKey(KEY, () => {
      assert.equal(decryptPassword(encryptPassword("ABCD1503")), "ABCD1503");
    });
  });

  it("never stores the password in the clear", () => {
    withKey(KEY, () => {
      const stored = encryptPassword("ABCD1503");
      assert.ok(!stored.includes("ABCD1503"));
      assert.ok(!Buffer.from(stored, "base64").toString("utf8").includes("ABCD1503"));
    });
  });

  it("writes a different ciphertext each time", () => {
    // A repeated password must not produce a repeated value, or which two
    // cards share a password becomes readable from the database alone.
    withKey(KEY, () => {
      assert.notEqual(encryptPassword("ABCD1503"), encryptPassword("ABCD1503"));
    });
  });

  it("refuses to store anything without a key", () => {
    withKey(undefined, () => {
      assert.equal(encryptionAvailable(), false);
      assert.throws(() => encryptPassword("ABCD1503"), MissingEncryptionKeyError);
    });
  });

  it("stretches a key that is not 32 bytes of hex", () => {
    // So a value someone typed by hand still works, rather than failing at
    // the moment they try to save a password.
    withKey("a passphrase someone typed", () => {
      assert.equal(encryptionAvailable(), true);
      assert.equal(decryptPassword(encryptPassword("ABCD1503")), "ABCD1503");
    });
  });

  it("returns nothing rather than throwing when the key has changed", () => {
    // A rotated key should leave the statement saying "locked", not take
    // the whole sync down with it.
    let stored = "";
    withKey(KEY, () => {
      stored = encryptPassword("ABCD1503");
    });
    withKey(crypto.randomBytes(32).toString("hex"), () => {
      assert.equal(decryptPassword(stored), null);
    });
  });

  it("rejects a ciphertext that has been tampered with", () => {
    withKey(KEY, () => {
      const stored = encryptPassword("ABCD1503");
      const [iv, tag, encrypted] = stored.split(".");
      const flipped = Buffer.from(encrypted, "base64");
      flipped[0] ^= 0xff;

      assert.equal(decryptPassword([iv, tag, flipped.toString("base64")].join(".")), null);
    });
  });

  it("has nothing to say about a card with no password", () => {
    withKey(KEY, () => {
      assert.equal(decryptPassword(null), null);
      assert.equal(decryptPassword(""), null);
      assert.equal(decryptPassword("not-a-ciphertext"), null);
    });
  });
});
