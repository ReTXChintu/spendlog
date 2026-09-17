import crypto from "node:crypto";
import { gmail_v1, google } from "googleapis";
import { HydratedDocument, Types } from "mongoose";
import { Account, CardStatement, CardStatementDoc, EmailConnection } from "../../models";
import { learnCycleFromStatement } from "../cards/cards.learn";
import { createOAuthClient } from "../ingestion/gmail.service";
import { decryptPassword, encryptionAvailable } from "./statements.crypto";
import { readStatementFile, saveStatementFile } from "./statements.files";
import { horizonFor } from "../ledger/ledger.horizon";
import { allReaders } from "./statements.issuers";
import { parseStatementRows } from "./statements.parse";
import { extractStatementRows, StatementLockedError } from "./statements.pdf";
import { reconcileStatement } from "./statements.reconcile";

/**
 * Finding statements in the mailbox and turning them into reconciliations.
 *
 * Deliberately separate from the transaction sync next door. That one reads
 * alerts, which are text and arrive as things happen; this reads the
 * monthly summary, which is an attachment and arrives once. They share a
 * mailbox and nothing else - the transaction parser explicitly throws away
 * anything mentioning a statement, and should keep doing so.
 */

// Narrow enough not to download every PDF in the mailbox, broad enough to
// catch the several ways issuers word it.
const STATEMENT_QUERY =
  'has:attachment filename:pdf (subject:statement OR subject:"e-statement" OR subject:estatement ' +
  'OR subject:"credit card statement" OR subject:"card statement" OR subject:"monthly statement" ' +
  'OR subject:"account statement" OR subject:"statement of account" OR subject:passbook ' +
  'OR subject:bill)';

/** How far back a first run looks. Later runs only need what is new. */
const FIRST_RUN_DAYS = 120;

/** Statements are a few hundred kilobytes; anything far bigger is not one. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface StatementSyncResult {
  scanned: number;
  read: number;
  locked: number;
  unidentified: number;
  added: number;
}

/**
 * Scan for statements that have not been seen before, read the ones that
 * can be read, and reconcile each against the ledger.
 *
 * Safe to call repeatedly. A statement is stored against the Gmail message
 * and attachment it came from, so a second run finds the existing record
 * rather than reading - and adding from - the same statement twice.
 */
export async function syncStatements(userId: Types.ObjectId, options?: { days?: number }): Promise<StatementSyncResult> {
  const result: StatementSyncResult = { scanned: 0, read: 0, locked: 0, unidentified: 0, added: 0 };

  const connections = await EmailConnection.find({ userId });
  if (connections.length === 0) return result;

  // Every card's password is tried against every statement, because the
  // password cannot say which card a file belongs to: an issuer builds it
  // from a date of birth, so one person's cards very often share one.
  // Identification comes from the card number printed inside instead.
  // Bank accounts as well as cards: a bank statement identifies itself
  // by an account number the same way a card statement does by a card
  // number, and both come from the same mailbox.
  const cards = await Account.find({ userId, accountType: { $in: ["CARD", "BANK"] } });
  const passwords = [
    null,
    ...new Set(cards.map((card) => decryptPassword(card.statementPassword)).filter(Boolean)),
  ] as (string | null)[];

  // Never further back than the ledger goes. The window asked for is a
  // ceiling on how much mail to read, not a licence to read past the point
  // the user said their ledger starts.
  const horizon = await horizonFor(userId);
  if (!horizon) return result;

  const asked = Date.now() - (options?.days ?? FIRST_RUN_DAYS) * 24 * 60 * 60 * 1000;
  const after = Math.floor(Math.max(asked, horizon.getTime()) / 1000);

  for (const connection of connections) {
    const client = createOAuthClient();
    client.setCredentials({
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken,
    });
    const gmail = google.gmail({ version: "v1", auth: client });

    let pageToken: string | undefined;
    do {
      const list = await gmail.users.messages.list({
        userId: "me",
        q: `${STATEMENT_QUERY} after:${after}`,
        pageToken,
        maxResults: 25,
      });

      for (const ref of list.data.messages ?? []) {
        if (!ref.id) continue;

        const message = await gmail.users.messages.get({ userId: "me", id: ref.id, format: "full" });
        for (const attachment of pdfAttachments(message.data.payload)) {
          result.scanned += 1;

          const outcome = await readOneStatement({
            gmail,
            userId,
            messageId: ref.id,
            subject: headerValue(message.data.payload, "Subject"),
            receivedAt: mailDate(message.data.internalDate),
            attachment,
            passwords,
            cards,
          });

          if (outcome === "locked") result.locked += 1;
          else if (outcome === "unidentified") result.unidentified += 1;
          else if (typeof outcome === "number") {
            result.read += 1;
            result.added += outcome;
          }
        }
      }

      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  return result;
}

interface PdfAttachment {
  attachmentId: string;
  fileName: string;
  size: number;
}

function pdfAttachments(payload: gmail_v1.Schema$MessagePart | undefined): PdfAttachment[] {
  if (!payload) return [];

  const found: PdfAttachment[] = [];
  const fileName = payload.filename ?? "";

  if (payload.body?.attachmentId && /\.pdf$/i.test(fileName)) {
    found.push({
      attachmentId: payload.body.attachmentId,
      fileName,
      size: payload.body.size ?? 0,
    });
  }

  for (const part of payload.parts ?? []) found.push(...pdfAttachments(part));
  return found;
}

function headerValue(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string | null {
  const header = payload?.headers?.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}

type ReadOutcome = number | "locked" | "unidentified" | "skipped";

/**
 * The three ways a statement names itself: where it came from, the mail it
 * came in, and what it is. Written together on every path, so no statement
 * ends up identified by one of them and not the others.
 */
interface StatementIdentity {
  sourceRef: string;
  mailKey: string;
  fileHash: string | null;
}

/**
 * One attachment, from "have we seen this" through to reconciled.
 *
 * Returns how many transactions it added, or why it could not get that far.
 * Nothing in here throws for a statement that simply cannot be read - one
 * unreadable file must not stop the rest of the mailbox being scanned.
 */
async function readOneStatement(params: {
  /// Absent when the file is already in hand, which is how a re-read works
  /// once the statement has been filed: there is nothing to fetch.
  gmail?: gmail_v1.Gmail;
  userId: Types.ObjectId;
  messageId: string;
  subject: string | null;
  receivedAt: Date | null;
  attachment: PdfAttachment;
  passwords: (string | null)[];
  cards: HydratedDocument<import("../../models").AccountDoc>[];
  /// The statement itself, where it has already been read off disk.
  pdf?: Buffer;
}): Promise<ReadOutcome> {
  const sourceRef = `${params.messageId}#${params.attachment.attachmentId}`;
  const mailKey = `${params.messageId}#${params.attachment.fileName}`;

  // The first and strongest guard against reading the same statement twice,
  // and for a long time it did not hold: it was keyed on the attachment id,
  // which Gmail mints per fetch, so every sync saw every statement as new.
  const existing = await CardStatement.findOne({ userId: params.userId, mailKey });
  if (existing && existing.status === "PARSED" && existing.reconciledAt) return "skipped";

  if (params.attachment.size > MAX_ATTACHMENT_BYTES) {
    await recordProblem(
      { userId: params.userId, mailKey },
      { sourceRef, mailKey, fileHash: null },
      params,
      "UNREADABLE",
      "The attachment is too large to be a statement"
    );
    return "skipped";
  }

  const file =
    params.pdf ??
    (params.gmail
      ? await downloadAttachment(params.gmail, params.messageId, params.attachment.attachmentId)
      : null);
  if (!file) {
    await recordProblem(
      { userId: params.userId, mailKey },
      { sourceRef, mailKey, fileHash: null },
      params,
      "UNREADABLE",
      "The attachment could not be downloaded"
    );
    return "skipped";
  }

  // The backstop mailKey cannot provide: the same PDF, re-sent by the bank
  // under a different message id. Found by what the file is rather than by
  // where it came from, and updated in place rather than forked.
  const fileHash = crypto.createHash("sha256").update(file).digest("hex");

  const twin = existing ?? (await CardStatement.findOne({ userId: params.userId, fileHash }));
  if (twin && twin.status === "PARSED" && twin.reconciledAt) return "skipped";

  // A statement already on file is updated where it sits. Only a genuinely
  // new one is keyed on its mail.
  const identity = { sourceRef, mailKey, fileHash };
  const filter = twin ? { _id: twin._id, userId: params.userId } : { userId: params.userId, mailKey };

  let rows: string[] | null = null;

  for (const password of params.passwords) {
    try {
      rows = await extractStatementRows(file, password);
      break;
    } catch (error) {
      // Locked. Try the next password rather than giving up: one card's
      // password very often opens another's statement.
      if (error instanceof StatementLockedError) continue;
      // Not a readable PDF at all. Recorded rather than thrown so the rest
      // of the mailbox still gets scanned.
      await recordProblem(filter, identity, params, "UNREADABLE", "This file could not be opened as a PDF", file);
      return "skipped";
    }
  }

  if (!rows) {
    // Said in the order someone would fix it. A server with no key cannot
    // store a password at all, so telling them to go and set one would send
    // them somewhere that refuses them; and having no password stored is a
    // different problem from having the wrong one.
    const problem = !encryptionAvailable()
      ? "This statement is password protected, and the server has no STATEMENT_ENCRYPTION_KEY set, " +
        "so no password can be stored yet. Generate one with `openssl rand -hex 32` and put it in " +
        "the .env at the repo root."
      : params.passwords.length <= 1
        ? "This statement is password protected and no card has a statement password set. Add one " +
          "on the card under Accounts and cards."
        : "None of the stored passwords opened this statement. Check the one on this card.";

    await recordProblem(filter, identity, params, "LOCKED", problem, file);
    return "locked";
  }


  const parsed = parseStatementRows(rows);
  if (parsed.lines.length === 0) {
    await recordProblem(
      filter,
      identity,
      params,
      "UNREADABLE",
      "No transaction table could be found in this file",
      file,
      rows
    );
    return "skipped";
  }

  // By the card number printed inside, never by which password worked.
  // Matched against the right sort of account: a card statement belongs to
  // a card and a bank statement to a bank account, and the last four digits
  // alone could otherwise put one on the other.
  const wanted = parsed.kind === "BANK" ? "BANK" : "CARD";
  const card = parsed.last4
    ? params.cards.find(
        (candidate) => candidate.last4 === parsed.last4 && candidate.accountType === wanted
      )
    : undefined;

  const statement = await CardStatement.findOneAndUpdate(
    filter,
    {
      $set: {
        ...identity,
        accountId: card?._id ?? null,
        subject: params.subject,
        fileName: params.attachment.fileName,
        issuer: parsed.issuer,
        kind: parsed.kind,
        status: card ? "PARSED" : "UNIDENTIFIED",
        problem: card
          ? null
          : parsed.last4
            ? `No ${wanted === "BANK" ? "account" : "card"} ending ${parsed.last4} in SpendLog. `
              + "Add it, then read this again."
            : `No ${wanted === "BANK" ? "account" : "card"} number could be found in this statement`,
        statementDate: parsed.statementDate,
        dueDate: parsed.dueDate,
        receivedAt: params.receivedAt,
        // What the readers actually saw. Worth keeping on a statement that
        // read perfectly as well as one that did not: it is the only way
        // to check a row against the page it came off.
        rows,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        totalDueMinor: parsed.totalDueMinor,
        minimumDueMinor: parsed.minimumDueMinor,
        lines: parsed.lines.map((line) => ({ ...line, resolution: "SKIPPED", transactionId: null })),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Filed after the statement exists, because the file is named by its id.
  // A statement whose PDF cannot be kept is still a statement: this records
  // what happened and carries on either way.
  await keepFile(statement, file);

  if (!card) return "unidentified";

  // The card learns its own billing day from its own statement. Both the
  // sync and a re-read come through here, so this is the one place it has
  // to happen - and it happens before the reconcile, so anything that asks
  // where the cycle starts while the rows are going in gets the new answer.
  await learnCycleFromStatement(card, parsed);

  const summary = await reconcileStatement(statement);
  return summary.added;
}

/**
 * Keep the PDF against a statement, and note on the statement that it is
 * there. The size is stored rather than looked up, so a listing can offer
 * the file without a filesystem call per row.
 */
async function keepFile(statement: HydratedDocument<CardStatementDoc>, pdf: Buffer): Promise<void> {
  const bytes = await saveStatementFile(statement._id, pdf);
  if (bytes === null) return;

  statement.fileBytes = bytes;
  await statement.save();
}

/** One statement's outcome in the shape a whole sync reports. */
function countOutcome(outcome: ReadOutcome): StatementSyncResult {
  return {
    scanned: 1,
    read: typeof outcome === "number" ? 1 : 0,
    locked: outcome === "locked" ? 1 : 0,
    unidentified: outcome === "unidentified" ? 1 : 0,
    added: typeof outcome === "number" ? outcome : 0,
  };
}

/**
 * Gmail's internalDate: milliseconds since the epoch, as a string.
 */
function mailDate(internalDate: string | null | undefined): Date | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

async function downloadAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string
): Promise<Buffer | null> {
  try {
    const response = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: attachmentId });
    const data = response.data.data;
    return data ? Buffer.from(data, "base64url") : null;
  } catch {
    return null;
  }
}

/**
 * Remember a statement that could not be read, so it shows up as something
 * to fix rather than vanishing. Lines are left alone on an update: a
 * statement that was read last month and is momentarily unreadable now
 * should not lose the reconciliation it already has.
 */
async function recordProblem(
  filter: Record<string, unknown>,
  identity: StatementIdentity,
  params: { subject: string | null; receivedAt: Date | null; attachment: PdfAttachment },
  status: CardStatementDoc["status"],
  problem: string,
  pdf?: Buffer,
  rows?: string[]
): Promise<void> {
  const statement = await CardStatement.findOneAndUpdate(
    filter,
    {
      $set: {
        ...identity,
        status,
        problem,
        subject: params.subject,
        receivedAt: params.receivedAt,
        fileName: params.attachment.fileName,
        // A statement that opened and had nothing found in it has rows and
        // no lines, and those rows are the whole of the evidence for why.
        ...(rows ? { rows } : {}),
      },
      $setOnInsert: { lines: [] },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // A statement that could not be read is the one most worth keeping the
  // file for. A locked one is read again the moment its password is set,
  // and that should not depend on the mail still being in the mailbox.
  if (pdf && statement) await keepFile(statement, pdf);
}

/**
 * Read one already-known statement again, for after a password is set or a
 * missing card is added.
 *
 * The stored file first, and the mailbox only if there is not one. This is
 * the case the file was kept for: a statement that arrived locked is read
 * again the moment its password is set, and that should not depend on the
 * mail still being there - or on Gmail being connected at all.
 */
export async function rereadStatement(
  userId: Types.ObjectId,
  statementId: Types.ObjectId
): Promise<StatementSyncResult | "alreadyDone" | null> {
  const statement = await CardStatement.findOne({ _id: statementId, userId });
  if (!statement) return null;

  // Re-reading one that already worked would replace its lines, and the
  // transactions it added point at those lines - so they would be orphaned,
  // with nothing left saying where they came from or how to take them back.
  // Undoing what it added first is the way to redo one of these.
  if (statement.status === "PARSED" && statement.reconciledAt) return "alreadyDone";

  const [messageId, attachmentId] = statement.sourceRef.split("#");
  if (!messageId || !attachmentId) return null;

  // Bank accounts as well as cards: a bank statement identifies itself
  // by an account number the same way a card statement does by a card
  // number, and both come from the same mailbox.
  const cards = await Account.find({ userId, accountType: { $in: ["CARD", "BANK"] } });
  const passwords = [
    null,
    ...new Set(cards.map((card) => decryptPassword(card.statementPassword)).filter(Boolean)),
  ] as (string | null)[];

  const stored = await readStatementFile(statement._id);
  if (stored) {
    const outcome = await readOneStatement({
      userId,
      messageId,
      subject: statement.subject ?? null,
      receivedAt: statement.receivedAt ?? null,
      attachment: { attachmentId, fileName: statement.fileName ?? "statement.pdf", size: stored.length },
      passwords,
      cards,
      pdf: stored,
    });

    return countOutcome(outcome);
  }

  const connections = await EmailConnection.find({ userId });

  for (const connection of connections) {
    const client = createOAuthClient();
    client.setCredentials({
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken,
    });
    const gmail = google.gmail({ version: "v1", auth: client });

    let subject: string | null = statement.subject ?? null;
    let receivedAt: Date | null = statement.receivedAt ?? null;
    try {
      const message = await gmail.users.messages.get({ userId: "me", id: messageId, format: "metadata" });
      subject = headerValue(message.data.payload, "Subject") ?? subject;
      receivedAt = mailDate(message.data.internalDate) ?? receivedAt;
    } catch {
      // The mailbox this statement came from may not be this connection.
      continue;
    }

    const outcome = await readOneStatement({
      gmail,
      userId,
      messageId,
      subject,
      receivedAt,
      attachment: { attachmentId, fileName: statement.fileName ?? "statement.pdf", size: 0 },
      passwords,
      cards,
    });

    return countOutcome(outcome);
  }

  return null;
}

/**
 * The text a statement actually extracts to, and what each reader makes of
 * it.
 *
 * For when a statement opens but nothing is found in it. "No transaction
 * table could be found in this file" is a true statement about the readers
 * and a useless one about the file, and without this the only way to learn
 * more was to have the PDF on a machine with the repository on it.
 *
 * The attachment is fetched afresh and thrown away, as everywhere else: a
 * statement is the most sensitive file in the mailbox and there is no
 * reason for this app to keep one.
 */
export async function statementText(
  userId: Types.ObjectId,
  statementId: Types.ObjectId
): Promise<{ rows: string[]; readers: { name: string; lines: number }[] } | null> {
  const statement = await CardStatement.findOne({ _id: statementId, userId });
  if (!statement) return null;

  const [messageId, attachmentId] = statement.sourceRef.split("#");
  if (!messageId || !attachmentId) return null;

  const cards = await Account.find({ userId, accountType: { $in: ["CARD", "BANK"] } });
  const passwords = [
    null,
    ...new Set(cards.map((card) => decryptPassword(card.statementPassword)).filter(Boolean)),
  ] as (string | null)[];

  // The stored file first. This is the question asked of a statement that
  // opened and read as empty, which is exactly the statement most likely
  // to be looked at again months later.
  const stored = await readStatementFile(statement._id);
  if (stored) {
    for (const password of passwords) {
      try {
        return tally(await extractStatementRows(stored, password));
      } catch (error) {
        if (error instanceof StatementLockedError) continue;
        return null;
      }
    }
  }

  for (const connection of await EmailConnection.find({ userId })) {
    const client = createOAuthClient();
    client.setCredentials({
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken,
    });

    const file = await downloadAttachment(
      google.gmail({ version: "v1", auth: client }),
      messageId,
      attachmentId
    );
    if (!file) continue;

    for (const password of passwords) {
      try {
        return tally(await extractStatementRows(file, password));
      } catch (error) {
        if (error instanceof StatementLockedError) continue;
        return null;
      }
    }
  }

  return null;
}

/**
 * The rows, and what every reader makes of them - not only the one the
 * headers chose. A reader finding nothing where another finds forty is the
 * whole answer to why a statement came out empty.
 */
function tally(rows: string[]): { rows: string[]; readers: { name: string; lines: number }[] } {
  return {
    rows,
    readers: allReaders.map((reader) => ({
      name: reader.name,
      lines: rows.filter((row) => reader.row(row) !== null).length,
    })),
  };
}
