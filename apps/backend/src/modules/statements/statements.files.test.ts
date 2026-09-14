import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Types } from "mongoose";
import {
  deleteStatementFile,
  fileStoreAvailable,
  readStatementFile,
  saveStatementFile,
} from "./statements.files";

let store: string;
const previousDir = process.env.STATEMENT_FILE_DIR;
const previousKey = process.env.STATEMENT_ENCRYPTION_KEY;

before(async () => {
  store = await fs.mkdtemp(path.join(os.tmpdir(), "spendlog-statements-"));
  process.env.STATEMENT_FILE_DIR = store;
  process.env.STATEMENT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
});

after(async () => {
  await fs.rm(store, { recursive: true, force: true });

  if (previousDir === undefined) delete process.env.STATEMENT_FILE_DIR;
  else process.env.STATEMENT_FILE_DIR = previousDir;

  if (previousKey === undefined) delete process.env.STATEMENT_ENCRYPTION_KEY;
  else process.env.STATEMENT_ENCRYPTION_KEY = previousKey;
});

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), crypto.randomBytes(4096)]);

describe("the statement file store", () => {
  it("gives back exactly what it was given", async () => {
    const id = new Types.ObjectId();

    assert.equal(await saveStatementFile(id, PDF), PDF.length);
    assert.deepEqual(await readStatementFile(id), PDF);
  });

  it("writes nothing a stolen disk could read", async () => {
    const id = new Types.ObjectId();
    await saveStatementFile(id, PDF);

    const onDisk = await fs.readFile(path.join(store, `${id.toString()}.enc`));
    assert.ok(!onDisk.includes(Buffer.from("%PDF")), "the file is not a PDF at rest");
    assert.ok(onDisk.length > PDF.length, "and carries its own nonce and tag");
  });

  it("will not read one back under a different key", async () => {
    const id = new Types.ObjectId();
    await saveStatementFile(id, PDF);

    const rightKey = process.env.STATEMENT_ENCRYPTION_KEY;
    process.env.STATEMENT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
    try {
      assert.equal(await readStatementFile(id), null, "and does not throw about it either");
    } finally {
      process.env.STATEMENT_ENCRYPTION_KEY = rightKey;
    }
  });

  it("leaves no half-written file behind to decrypt to nothing", async () => {
    const id = new Types.ObjectId();
    await saveStatementFile(id, PDF);

    const left = await fs.readdir(store);
    assert.ok(!left.some((name) => name.endsWith(".part")), left.join(", "));
  });

  it("forgets one when its statement goes", async () => {
    const id = new Types.ObjectId();
    await saveStatementFile(id, PDF);
    await deleteStatementFile(id);

    assert.equal(await readStatementFile(id), null);
    // Deleting one that was never there is a success, not an error: there
    // is nothing the person deleting a statement can do about it.
    await deleteStatementFile(new Types.ObjectId());
  });

  it("says nothing can be stored when there is no key", async () => {
    const key = process.env.STATEMENT_ENCRYPTION_KEY;
    delete process.env.STATEMENT_ENCRYPTION_KEY;
    try {
      assert.equal(fileStoreAvailable(), false);
      // And a sync that finds a statement still finishes, rather than
      // falling over because the server was never given a key.
      assert.equal(await saveStatementFile(new Types.ObjectId(), PDF), null);
    } finally {
      process.env.STATEMENT_ENCRYPTION_KEY = key;
    }
  });

  it("refuses a name that is not a statement id", async () => {
    // This value ends up in a filesystem path, so what matters is that
    // nothing lands outside the store - and that a bad one is a quiet no
    // rather than an exception out of the middle of a mailbox scan.
    const before = await fs.readdir(store);

    for (const bad of ["../../etc/passwd", "..", "a/b", ""]) {
      assert.equal(await saveStatementFile(bad, PDF), null, bad);
      assert.equal(await readStatementFile(bad), null, bad);
    }

    assert.deepEqual(await fs.readdir(store), before, "nothing was written");
  });
});
