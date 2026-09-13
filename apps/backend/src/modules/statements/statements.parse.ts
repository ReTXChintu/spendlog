import { TransactionType } from "../../types";
import { istDayStart } from "../../time";
import { classifyStatementLine } from "./statements.classify";
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
}

export interface ParsedStatement {
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
const NAMED_DATE_RE = /^(\d{1,2})[\s\-/]*([a-z]{3,9})[\s\-/]*(\d{2,4})$/i;

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

// 1,240.00 / 1240 / 1,24,000.50 — Indian grouping included.
const AMOUNT_RE = /(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;
// Credits are marked, not signed: "1,240.00 Cr", "1,240.00 CR", "(1,240.00)".
const CREDIT_MARKER_RE = /\b(cr|credit)\b\.?\s*$/i;

export function parseAmountToMinor(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/**
 * A row is a transaction when it starts with a date and ends with an
 * amount. Anchoring at both ends is what keeps prose out: a sentence about
 * a reward programme may contain a number, but it does not begin with a
 * date and end with one.
 */
export function parseStatementRow(row: string, fallbackYear?: number): ParsedStatementLine | null {
  const leading = row.match(/^(\d{1,2}[\s/\-.][\w]{2,9}[\s/\-.]?\d{0,4})\s+(.*)$/);
  if (!leading) return null;

  const date = parseStatementDate(leading[1], fallbackYear);
  if (!date) return null;

  let rest = leading[2].trim();
  if (!rest) return null;

  // Some issuers print a second date column - the posting date next to the
  // transaction date. The first is the one that matters; drop the second
  // so it cannot be mistaken for part of the merchant's name.
  const secondDate = rest.match(/^(\d{1,2}[\s/\-.][\w]{2,9}[\s/\-.]?\d{0,4})\s+(.+)$/);
  if (secondDate && parseStatementDate(secondDate[1], fallbackYear)) rest = secondDate[2].trim();

  const isCredit = CREDIT_MARKER_RE.test(rest) || /^\(.*\)$/.test(rest.split(/\s+/).at(-1) ?? "");
  const withoutMarker = rest.replace(CREDIT_MARKER_RE, "").trim();

  // The amount is the last number on the row. Searching from the end keeps
  // digits inside a merchant's name - "SHELL 1234 BANGALORE" - from winning.
  const trailing = withoutMarker.match(new RegExp(`^(.*?)\\s*\\(?${AMOUNT_RE.source}\\)?$`));
  if (!trailing) return null;

  const description = trailing[1].replace(/[\s.,;:\-]+$/, "").trim();
  const amountMinor = parseAmountToMinor(trailing[2]);

  if (!description || amountMinor === null || amountMinor <= 0) return null;

  const type: TransactionType = isCredit ? "CREDIT" : "DEBIT";
  return { date, description, amountMinor, type, kind: classifyStatementLine(description, type) };
}

/** A labelled figure from the summary block, e.g. "Total Dues 47,850.25". */
function findLabelledAmount(rows: string[], label: RegExp): number | null {
  for (const row of rows) {
    const match = row.match(label);
    if (!match) continue;

    const after = row.slice((match.index ?? 0) + match[0].length);
    const amount = after.match(new RegExp(`^[^\\d-]{0,20}${AMOUNT_RE.source}`));
    if (amount) return parseAmountToMinor(amount[1]);
  }
  return null;
}

function findLabelledDate(rows: string[], label: RegExp): Date | null {
  for (const row of rows) {
    const match = row.match(label);
    if (!match) continue;

    const after = row.slice((match.index ?? 0) + match[0].length);
    const date = after.match(/[^\d]{0,10}(\d{1,2}[\s/\-.][\w]{2,9}[\s/\-.]?\d{2,4})/);
    if (date) {
      const parsed = parseStatementDate(date[1]);
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
    findLabelledDate(rows, /statement\s*(?:date|generated\s*on)/i) ?? findLabelledDate(rows, /\bstatement\b/i);

  const dueDate =
    findLabelledDate(rows, /(?:payment\s*)?due\s*date/i) ?? findLabelledDate(rows, /\bpay\s*by\b/i);

  // The year the lines belong to, for issuers that print "02 Sep" with no
  // year on each row. A cycle can straddle new year, which the reconciler
  // sorts out by date proximity rather than this guess.
  const fallbackYear = statementDate?.getUTCFullYear();

  const lines: ParsedStatementLine[] = [];
  for (const row of rows) {
    const line = parseStatementRow(row, fallbackYear);
    if (line) lines.push(line);
  }

  const dated = lines.map((line) => line.date.getTime());

  return {
    lines,
    last4: findCardLast4(rows),
    statementDate,
    dueDate,
    periodStart: dated.length ? new Date(Math.min(...dated)) : null,
    periodEnd: dated.length ? new Date(Math.max(...dated)) : null,
    totalDueMinor: findLabelledAmount(rows, /total\s*(?:amount\s*)?(?:due|dues|payable)/i),
    minimumDueMinor: findLabelledAmount(rows, /min(?:imum)?\.?\s*(?:amount\s*)?due/i),
  };
}
