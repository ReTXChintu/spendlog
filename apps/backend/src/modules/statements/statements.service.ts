import { gmail_v1, google } from "googleapis";
import { HydratedDocument, Types } from "mongoose";
import { Account, CardStatement, CardStatementDoc, EmailConnection } from "../../models";
import { createOAuthClient } from "../ingestion/gmail.service";
import { decryptPassword } from "./statements.crypto";
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
  const cards = await Account.find({ userId, accountType: "CARD" });
  const passwords = [
    null,
    ...new Set(cards.map((card) => decryptPassword(card.statementPassword)).filter(Boolean)),
  ] as (string | null)[];

  const after = Math.floor((Date.now() - (options?.days ?? FIRST_RUN_DAYS) * 24 * 60 * 60 * 1000) / 1000);

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
 * One attachment, from "have we seen this" through to reconciled.
 *
 * Returns how many transactions it added, or why it could not get that far.
 * Nothing in here throws for a statement that simply cannot be read - one
 * unreadable file must not stop the rest of the mailbox being scanned.
 */
async function readOneStatement(params: {
  gmail: gmail_v1.Gmail;
  userId: Types.ObjectId;
  messageId: string;
  subject: string | null;
  attachment: PdfAttachment;
  passwords: (string | null)[];
  cards: HydratedDocument<import("../../models").AccountDoc>[];
}): Promise<ReadOutcome> {
  const sourceRef = `${params.messageId}#${params.attachment.attachmentId}`;

  // The first and strongest guard against reading the same statement twice.
  const existing = await CardStatement.findOne({ userId: params.userId, sourceRef });
  if (existing && existing.status === "PARSED" && existing.reconciledAt) return "skipped";

  if (params.attachment.size > MAX_ATTACHMENT_BYTES) {
    await recordProblem(params.userId, sourceRef, params, "UNREADABLE", "The attachment is too large to be a statement");
    return "skipped";
  }

  const file = await downloadAttachment(params.gmail, params.messageId, params.attachment.attachmentId);
  if (!file) {
    await recordProblem(params.userId, sourceRef, params, "UNREADABLE", "The attachment could not be downloaded");
    return "skipped";
  }

  let rows: string[] | null = null;
  let everNeededPassword = false;

  for (const password of params.passwords) {
    try {
      rows = await extractStatementRows(file, password);
      break;
    } catch (error) {
      if (error instanceof StatementLockedError) {
        everNeededPassword = true;
        continue;
      }
      // Not a readable PDF at all. Recorded rather than thrown so the rest
      // of the mailbox still gets scanned.
      await recordProblem(params.userId, sourceRef, params, "UNREADABLE", "This file could not be opened as a PDF");
      return "skipped";
    }
  }

  if (!rows) {
    await recordProblem(
      params.userId,
      sourceRef,
      params,
      "LOCKED",
      everNeededPassword
        ? "No stored password opened this statement. Set the right one on the card in Settings."
        : "This statement is password protected"
    );
    return "locked";
  }

  const parsed = parseStatementRows(rows);
  if (parsed.lines.length === 0) {
    await recordProblem(
      params.userId,
      sourceRef,
      params,
      "UNREADABLE",
      "No transaction table could be found in this file"
    );
    return "skipped";
  }

  // By the card number printed inside, never by which password worked.
  const card = parsed.last4 ? params.cards.find((candidate) => candidate.last4 === parsed.last4) : undefined;

  const statement = await CardStatement.findOneAndUpdate(
    { userId: params.userId, sourceRef },
    {
      $set: {
        accountId: card?._id ?? null,
        subject: params.subject,
        fileName: params.attachment.fileName,
        issuer: parsed.issuer,
        status: card ? "PARSED" : "UNIDENTIFIED",
        problem: card
          ? null
          : parsed.last4
            ? `No card ending ${parsed.last4} in SpendLog. Add it, then read this again.`
            : "No card number could be found in this statement",
        statementDate: parsed.statementDate,
        dueDate: parsed.dueDate,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        totalDueMinor: parsed.totalDueMinor,
        minimumDueMinor: parsed.minimumDueMinor,
        lines: parsed.lines.map((line) => ({ ...line, resolution: "SKIPPED", transactionId: null })),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (!card) return "unidentified";

  const summary = await reconcileStatement(statement);
  return summary.added;
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
  userId: Types.ObjectId,
  sourceRef: string,
  params: { subject: string | null; attachment: PdfAttachment },
  status: CardStatementDoc["status"],
  problem: string
): Promise<void> {
  await CardStatement.findOneAndUpdate(
    { userId, sourceRef },
    {
      $set: { status, problem, subject: params.subject, fileName: params.attachment.fileName },
      $setOnInsert: { lines: [] },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

/**
 * Read one already-known statement again, for after a password is set or a
 * missing card is added. The attachment is fetched afresh rather than kept:
 * a statement PDF is the most sensitive file in the mailbox and there is no
 * reason for this app to hold a copy of one.
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

  const connections = await EmailConnection.find({ userId });
  const cards = await Account.find({ userId, accountType: "CARD" });
  const passwords = [
    null,
    ...new Set(cards.map((card) => decryptPassword(card.statementPassword)).filter(Boolean)),
  ] as (string | null)[];

  for (const connection of connections) {
    const client = createOAuthClient();
    client.setCredentials({
      access_token: connection.accessToken,
      refresh_token: connection.refreshToken,
    });
    const gmail = google.gmail({ version: "v1", auth: client });

    let subject: string | null = statement.subject ?? null;
    try {
      const message = await gmail.users.messages.get({ userId: "me", id: messageId, format: "metadata" });
      subject = headerValue(message.data.payload, "Subject") ?? subject;
    } catch {
      // The mailbox this statement came from may not be this connection.
      continue;
    }

    const outcome = await readOneStatement({
      gmail,
      userId,
      messageId,
      subject,
      attachment: { attachmentId, fileName: statement.fileName ?? "statement.pdf", size: 0 },
      passwords,
      cards,
    });

    return {
      scanned: 1,
      read: typeof outcome === "number" ? 1 : 0,
      locked: outcome === "locked" ? 1 : 0,
      unidentified: outcome === "unidentified" ? 1 : 0,
      added: typeof outcome === "number" ? outcome : 0,
    };
  }

  return null;
}
