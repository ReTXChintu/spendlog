import { StatementKind, TransactionType } from "../../types";
import { istDayStart } from "../../time";
import { classifyStatementLine, creditByDescription } from "./statements.classify";
import { allReaders, readerFor, StatementReader } from "./statements.issuers";
import { StatementLineKind } from "../../types";

/**
 * Reading a statement's table out of the text of its pages.
 *
 * Issuers differ in layout but agree on shape: a date, a description, and
 * an amount, with credits marked rather than signed. So one generic reader
 * handles the common case and a per-issuer reader can be registered where
 * a layout defeats it - which keeps adding a bank to a contained change
 * instead of a rewrite.
 */

export interface ParsedStatementLine {
  date: Date;
  description: string;
  amountMinor: number;
  type: TransactionType;
  kind: StatementLineKind;
  /// The running balance after this row, where the statement prints one.
  /// Only a bank statement does, and it is what settles the direction.
  balanceMinor?: number | null;
}

export interface ParsedStatement {
  /// Which reader read it, so an unrecognised layout is visible rather
  /// than silently producing a short list of lines.
  issuer: string;
  kind: StatementKind;
  lines: ParsedStatementLine[];
  last4: string | null;
  statementDate: Date | null;
  dueDate: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  totalDueMinor: number | null;
  minimumDueMinor: number | null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// 02/09/2026, 02-09-2026, 02.09.26
const NUMERIC_DATE_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/;
// 02 Sep 2026, 02-Sep-26, 2 September 2026
// The comma matters: HDFC writes its statement date as "01 Jun, 2026", and
// without it the whole summary block read as having no dates in it.
const NAMED_DATE_RE = /^(\d{1,2})[\s\-/,]*([a-z]{3,9})[\s\-/,]*(\d{2,4})$/i;

/**
 * Indian statements are day-first without exception, so there is no
 * ambiguity to resolve - 02/09 is the second of September.
 *
 * The result is midnight IST, which is what makes a statement date and a
 * ledger date comparable. Reading it as UTC would put a transaction on the
 * previous day for everything before half past five in the morning.
 */
export function parseStatementDate(raw: string, fallbackYear?: number): Date | null {
  const value = raw.trim();

  const numeric = value.match(NUMERIC_DATE_RE);
  if (numeric) {
    const [, day, month, year] = numeric;
    return buildDate(Number(day), Number(month) - 1, Number(year));
  }

  const named = value.match(NAMED_DATE_RE);
  if (named) {
    const [, day, monthName, year] = named;
    const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    return buildDate(Number(day), month, Number(year));
  }

  // "02 Sep" with the year only printed in the statement header.
  const partial = value.match(/^(\d{1,2})[\s\-/]+([a-z]{3,9})$/i);
  if (partial && fallbackYear !== undefined) {
    const month = MONTHS[partial[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) return buildDate(Number(partial[1]), month, fallbackYear);
  }

  return null;
}

function buildDate(day: number, month: number, year: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;

  // A two-digit year on a statement is always this century.
  const fullYear = year < 100 ? 2000 + year : year;
  if (fullYear < 2000 || fullYear > 2100) return null;

  // Rejects the 31st of February rather than letting it roll into March.
  const probe = new Date(Date.UTC(fullYear, month, day));
  if (probe.getUTCMonth() !== month || probe.getUTCDate() !== day) return null;

  const pad = (value: number) => String(value).padStart(2, "0");
  return istDayStart(`${fullYear}-${pad(month + 1)}-${pad(day)}`);
}

// 1,240.00 / 1240 / 1,24,000.50 - Indian grouping included.
const AMOUNT_RE = /(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

export function parseAmountToMinor(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/**
 * One row, read by whichever reader recognised the document.
 *
 * Where the reader could not say which way the money went - Jupiter prints
 * a refund in a different colour and colour is not in the text - the words
 * decide, and anything they do not clearly mark as coming back is treated
 * as a debit.
 */
export function parseStatementRow(
  row: string,
  reader: StatementReader,
  fallbackYear?: number
): ParsedStatementLine | null {
  const raw = reader.row(row);
  if (!raw) return null;

  const date = parseStatementDate(raw.date, fallbackYear);
  if (!date) return null;

  const amountMinor = parseAmountToMinor(raw.amount);
  if (amountMinor === null || amountMinor <= 0) return null;

  // An empty description is allowed through, because a row whose text
  // wrapped onto the lines around its figures arrives with none - and the
  // caller can put it back from the line above. Dropping the row here
  // instead would lose the money along with the name.

  const type: TransactionType = raw.credit ?? creditByDescription(raw.description) ? "CREDIT" : "DEBIT";

  return {
    date,
    description: raw.description,
    amountMinor,
    type,
    kind: classifyStatementLine(raw.description, type, reader.kind),
    balanceMinor: raw.balance ? parseAmountToMinor(raw.balance) : null,
  };
}

/**
 * Which way each row on a bank statement went, from how the balance moved.
 *
 * Withdrawals and deposits sit in separate columns, both of which vanish
 * when empty, so a row of either kind arrives as the same two numbers and
 * the position says nothing. The balance says everything: down by the
 * amount means money out, up by it means money in.
 *
 * It also checks the parse. A row whose balance moves by something other
 * than its own amount was misread - a reference number taken for a figure,
 * a wrapped line joined wrongly - and a row that cannot be trusted is
 * better dropped than guessed at, because guessing puts a wrong number in
 * the ledger and nothing ever questions it again.
 */
function directionsFromBalance(lines: ParsedStatementLine[]): ParsedStatementLine[] {
  const kept: ParsedStatementLine[] = [];
  let previous: number | null = null;

  for (const line of lines) {
    const balance = line.balanceMinor;
    if (balance == null) {
      kept.push(line);
      continue;
    }

    if (previous !== null) {
      const moved = balance - previous;

      if (Math.abs(moved + line.amountMinor) <= 1) line.type = "DEBIT";
      else if (Math.abs(moved - line.amountMinor) <= 1) line.type = "CREDIT";
      else {
        // The balance did not move by this row's amount, so one of the two
        // was read wrongly. Dropped, and the running balance picked up
        // again from here so one bad row does not condemn the rest.
        previous = balance;
        continue;
      }

      line.kind = classifyStatementLine(line.description, line.type, "BANK");
    }

    previous = balance;
    kept.push(line);
  }

  return kept;
}

/**
 * The first reader that finds anything, starting with the likeliest.
 *
 * A reader that finds nothing has not proved the document is unreadable,
 * only that it is not the document that reader expects - so the others get
 * a turn before anyone is told there is no table in it.
 */
function firstReaderThatFinds(
  rows: string[],
  preferred: StatementReader,
  fallbackYear: number | undefined
): { reader: StatementReader; lines: ParsedStatementLine[] } {
  const order = [preferred, ...allReaders.filter((candidate) => candidate !== preferred)];

  let best: { reader: StatementReader; lines: ParsedStatementLine[] } = { reader: preferred, lines: [] };

  for (const reader of order) {
    const lines = readWith(rows, reader, fallbackYear);
    if (lines.length > best.lines.length) best = { reader, lines };

    // Two rows is enough to say a reader understands the document, but only
    // a reader that was written for an issuer is entitled to say it. The
    // fallback matches every document by design, so stopping on its word
    // was stopping on no evidence at all: a Jupiter statement whose
    // letterhead never says "Jupiter" was read by the fallback, which found
    // the table and also found the page header eleven times.
    if (best.lines.length >= 2 && !best.reader.fallback) break;
  }

  return best;
}

function readWith(
  rows: string[],
  reader: StatementReader,
  fallbackYear: number | undefined
): ParsedStatementLine[] {
  const lines: ParsedStatementLine[] = [];

  // The last row that was not itself a transaction. A description too long
  // for its column wraps onto the lines *around* the figures rather than
  // after them, so a row can arrive with its date and amount and no text at
  // all - and what it said is sitting just above.
  let orphan: string | null = null;

  for (const row of rows) {
    const line = parseStatementRow(row, reader, fallbackYear);
    if (line) {
      if (!line.description && orphan) {
        line.description = orphan.trim();
        line.kind = classifyStatementLine(line.description, line.type, reader.kind);
      }
      orphan = null;
      lines.push(line);
      continue;
    }

    // Kept only if it could be a description: long enough to be words, and
    // not a page footer or a column heading.
    orphan = looksLikeStrandedText(row) ? row : null;

    // A merchant name too long for its column wraps, leaving its tail on a
    // line of its own. Joined back on, because a name cut in half matches
    // nothing and reads as a mistake.
    const previous = lines[lines.length - 1];
    if (previous && reader.continuation?.(row)) {
      previous.description = `${previous.description} ${row.trim()}`.replace(/\s+/g, " ");
      previous.kind = classifyStatementLine(previous.description, previous.type, reader.kind);
    }
  }

  return lines;
}

/** A labelled figure from the summary block, e.g. "Total Dues 47,850.25". */
/**
 * Whether a row could be the text of a transaction whose figures landed on
 * a different line.
 *
 * Deliberately shy. Attaching the wrong words to an amount is worse than
 * leaving it unnamed, so page furniture, column headings and anything too
 * short to be a merchant are all refused.
 */
function looksLikeStrandedText(row: string): boolean {
  const text = row.trim();
  if (text.length < 6 || text.length > 90) return false;
  if (!/[A-Za-z]{3}/.test(text)) return false;

  return !/^(page\s|hsn|note|domestic|international|date\s*&|transaction\s|total|important)/i.test(text);
}

/**
 * How far past a label to keep looking for its value.
 *
 * A summary block puts its headings on one row and its figures on another,
 * with a stray caption or an underscore between them. Reading only the
 * label's own row found nothing on a real statement, so the total due and
 * the due date both came out empty.
 */
const LOOKAHEAD_ROWS = 4;

function findLabelledAmount(rows: string[], label: RegExp): number | null {
  for (let index = 0; index < rows.length; index += 1) {
    const match = rows[index].match(label);
    if (!match) continue;

    const after = rows[index].slice((match.index ?? 0) + match[0].length);
    const sameRow = after.match(new RegExp(`^[^\\d-]{0,20}${AMOUNT_RE.source}`));
    if (sameRow) return parseAmountToMinor(sameRow[1]);

    for (let ahead = index + 1; ahead <= index + LOOKAHEAD_ROWS && ahead < rows.length; ahead += 1) {
      const figure = amountOnSummaryRow(rows[ahead]);
      if (figure !== null) return figure;
    }
  }
  return null;
}

/**
 * The figure a summary row is actually reporting.
 *
 * A row of workings - "C 16,127.47 C 16,127.00 + C 8,168.58 + C 0.00 =
 * C 8,169.00" - is answering with the number after the equals sign, not
 * the first one on the line. Anywhere else the first is what was meant.
 */
function amountOnSummaryRow(row: string): number | null {
  const total = row.match(new RegExp(`=[^\\d-]{0,10}${AMOUNT_RE.source}`));
  if (total) return parseAmountToMinor(total[1]);

  const first = row.match(new RegExp(`(?:^|\\s)[^\\d\\s-]{0,3}\\s*${AMOUNT_RE.source}`));
  return first ? parseAmountToMinor(first[1]) : null;
}

/** A date as a statement writes one, including "01 Jun, 2026". */
// Letters rather than word characters in the middle. \w admits digits, so
// "C 2,018.00 21 Jun, 2026" read its own minimum-due figure as the date and
// the real date was never reached.
const LOOSE_DATE_RE =
  /(\d{1,2}[\s\-.,/]+[A-Za-z]{3,9}[\s\-.,/]+\d{2,4}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})/;

function findLabelledDate(rows: string[], label: RegExp): Date | null {
  for (let index = 0; index < rows.length; index += 1) {
    const match = rows[index].match(label);
    if (!match) continue;

    const after = rows[index].slice((match.index ?? 0) + match[0].length);
    const sameRow = after.match(LOOSE_DATE_RE);
    if (sameRow) {
      const parsed = parseStatementDate(sameRow[1]);
      if (parsed) return parsed;
    }

    for (let ahead = index + 1; ahead <= index + LOOKAHEAD_ROWS && ahead < rows.length; ahead += 1) {
      const nearby = rows[ahead].match(LOOSE_DATE_RE);
      const parsed = nearby ? parseStatementDate(nearby[1]) : null;
      if (parsed) return parsed;
    }
  }
  return null;
}

// "Card No: 4854 XXXX XXXX 1377", "Card Number XXXX XXXX XXXX 1377".
const CARD_NUMBER_RE = /(?:\d{4}|[xX*]{4})[\s-]*[xX*]{2,6}[\s-]*[xX*]{2,6}[\s-]*(\d{4})\b/;

export function findCardLast4(rows: string[]): string | null {
  for (const row of rows) {
    const masked = row.match(CARD_NUMBER_RE);
    if (masked) return masked[1];

    const labelled = row.match(/card\s*(?:no|number|ending(?:\s*(?:in|with))?)\.?\s*:?\s*(?:[xX*]+\s*)?(\d{4})\b/i);
    if (labelled) return labelled[1];

    // Some statements never print the card number at all, and name the card
    // only on the heading above its table: "Rupay Transactions - 6623".
    // Without this the statement reads perfectly and then has to be pointed
    // at its card by hand.
    const heading = row.match(
      /\b(?:rupay|visa|mastercard|master\s*card|amex)\b[^\d\n]{0,24}?(\d{4})\b/i
    );
    if (heading) return heading[1];
  }
  return null;
}

/**
 * The generic reader. Everything it finds is best-effort: a statement whose
 * summary block cannot be read is still worth reconciling on its lines
 * alone, so nothing here is allowed to fail the whole parse.
 */
export function parseStatementRows(rows: string[]): ParsedStatement {
  const statementDate =
    findLabelledDate(rows, /statement\s*(?:date|generated\s*on)/i) ?? findLabelledDate(rows, /statement/i);

  const dueDate =
    findLabelledDate(rows, /(?:payment\s*)?due\s*date/i) ?? findLabelledDate(rows, /pay\s*by/i);

  // The year the lines belong to, for issuers that print "02 Sep" with no
  // year on each row. A cycle can straddle new year, which the reconciler
  // sorts out by date proximity rather than this guess.
  const fallbackYear = statementDate?.getUTCFullYear();

  // The reader the headers point at, then every other one, then the
  // fallback. Picking by header is a good guess and not a promise: a bank
  // changes its layout, or names itself on a page whose table looks like
  // somebody else's. Before this, a reader chosen and then failing meant
  // "no transaction table could be found in this file" - which was never
  // true of the file, only of the one reader that had been tried.
  const preferred = readerFor(rows);
  const { reader, lines } = firstReaderThatFinds(rows, preferred, fallbackYear);

  const settled = reader.kind === "BANK" ? directionsFromBalance(lines) : lines;
  const dated = settled.map((line) => line.date.getTime());

  return {
    issuer: reader.name,
    kind: reader.kind,
    lines: settled,
    last4: findCardLast4(rows),
    statementDate,
    dueDate,
    periodStart: dated.length ? new Date(Math.min(...dated)) : null,
    periodEnd: dated.length ? new Date(Math.max(...dated)) : null,
    totalDueMinor: findLabelledAmount(rows, /total\s*(?:amount\s*)?(?:due|dues|payable)/i),
    minimumDueMinor: findLabelledAmount(rows, /min(?:imum)?\.?\s*(?:amount\s*)?due/i),
  };
}
