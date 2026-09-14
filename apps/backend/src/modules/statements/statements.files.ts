import fs from "node:fs/promises";
import path from "node:path";
import { Types } from "mongoose";
import { decryptBytes, encryptBytes, encryptionAvailable } from "./statements.crypto";

/**
 * The statement PDFs, on disk and encrypted.
 *
 * For a long time this app deliberately kept no copy of one: a statement is
 * the most sensitive file in the mailbox, and everything worth having from
 * it — the rows, the totals, the dates — was already extracted and stored.
 * Keeping the file was asked for so a statement can be opened and read
 * against what was made of it, long after the mail it came from is gone.
 *
 * Two things follow from that. They are encrypted with the same key as the
 * passwords, so a stolen disk is as useless as a stolen database; and they
 * live outside the database, because a year of these is a gigabyte and
 * Mongo is the wrong place to put a gigabyte of blobs.
 *
 * One file per statement, named by its id. No directory tree by user or by
 * month: the id is already unique and the database is what answers "which
 * statements are this card's" — a folder layout that also tried to answer
 * it would be a second source of truth to keep in step.
 */

const DEFAULT_DIR = path.join(process.cwd(), "data", "statements");

/**
 * Read at call time, like the key is. A deployment that adds the setting
 * should not need a restart-ordering rule, and the tests point it at a
 * temporary directory after the module is already loaded.
 */
function storeDir(): string {
  return process.env.STATEMENT_FILE_DIR?.trim() || DEFAULT_DIR;
}

function fileFor(statementId: Types.ObjectId | string): string {
  // The id comes from Mongo, so it is 24 hex characters and cannot escape
  // the directory. Asserted rather than assumed: this value ends up in a
  // filesystem path, and a check here is cheaper than the alternative.
  const id = statementId.toString();
  if (!/^[0-9a-f]{24}$/i.test(id)) throw new Error(`Not a statement id: ${id}`);

  return path.join(storeDir(), `${id}.enc`);
}

/** Whether a statement file can be stored at all. Used to explain, not to guess. */
export function fileStoreAvailable(): boolean {
  return encryptionAvailable();
}

/**
 * Keep one statement's PDF.
 *
 * Returns how many bytes the original was, for the listing to show, or null
 * if it could not be stored. Never throws: a statement that reads perfectly
 * and cannot be filed is still a statement worth having, and the sync that
 * found it must not fall over because a disk is full or a key is unset.
 */
export async function saveStatementFile(
  statementId: Types.ObjectId | string,
  pdf: Buffer
): Promise<number | null> {
  if (!encryptionAvailable()) return null;

  try {
    await fs.mkdir(storeDir(), { recursive: true });

    // Written beside the target and moved into place, so a crash midway
    // leaves no half-file that would decrypt to nothing.
    const target = fileFor(statementId);
    const temporary = `${target}.${process.pid}.part`;

    await fs.writeFile(temporary, encryptBytes(pdf), { mode: 0o600 });
    await fs.rename(temporary, target);

    return pdf.length;
  } catch {
    return null;
  }
}

/** The PDF back, or null if there is not one or the key no longer opens it. */
export async function readStatementFile(
  statementId: Types.ObjectId | string
): Promise<Buffer | null> {
  try {
    return decryptBytes(await fs.readFile(fileFor(statementId)));
  } catch {
    return null;
  }
}

/**
 * Forget one, for when its statement is deleted.
 *
 * A file that is already gone is a success: this is called from the delete
 * route, and there is nothing for the person deleting a statement to do
 * about a file that was never written.
 */
export async function deleteStatementFile(statementId: Types.ObjectId | string): Promise<void> {
  try {
    await fs.unlink(fileFor(statementId));
  } catch {
    // Already gone, or never there.
  }
}
