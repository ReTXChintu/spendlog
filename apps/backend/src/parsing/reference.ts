/**
 * The bank's own number for a payment, read off its message.
 *
 * Two payments of the same amount, to the same account, minutes apart, look
 * exactly alike by amount and time - which is all duplicate detection had -
 * and were merged into one. The reference the bank prints ("UPI
 * 666285487168", "UTR No. HDFCN52026102312345678", "Ref 661165147047") is
 * what tells them apart, and what ties an SMS to the email for the same
 * payment however late the email comes.
 *
 * Each reference is kept with its kind. Banks number one payment in more
 * than one scheme - an SMS quotes the UPI reference where the app's email
 * quotes its own transaction id - so two references of different kinds say
 * nothing about each other. Only two of the same kind that differ mean two
 * payments.
 */

export type ReferenceKind = "RRN" | "UTR" | "REF" | "TXN" | "AUTH";

export interface TransactionReference {
  kind: ReferenceKind;
  /// Upper-cased, spaces and punctuation dropped.
  value: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ndash: "-", mdash: "-", rupee: "₹",
};

/** Text with HTML entities spelled out: "We&#39;re" is "We're". */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * An HTML email as the plain text a person reads in it: tags gone, styles
 * and scripts gone, block ends as line breaks, entities decoded.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

// Each label, the punctuation banks put after it, then the value. Most
// specific first: "UPI Ref No" is a UPI reference before it is a "Ref No".
const SEP = String.raw`\s*(?:no\.?|number|num|id|#)?\s*(?:is|:|-|#|\.|\()*\s*`;
const PATTERNS: [ReferenceKind, RegExp][] = [
  // UPI's twelve-digit reference, which is also its RRN.
  ["RRN", new RegExp(String.raw`\bUPI\s*(?:ref(?:erence)?\.?|txn|transaction)?` + SEP + String.raw`(\d{12})(?!\d)`, "i")],
  ["RRN", new RegExp(String.raw`\bRRN` + SEP + String.raw`(\d{10,16})(?!\d)`, "i")],
  ["UTR", new RegExp(String.raw`\bUTR` + SEP + String.raw`([A-Z0-9]{12,22})(?![A-Z0-9])`, "i")],
  ["UTR", new RegExp(String.raw`\b(?:IMPS|NEFT|RTGS)\s*ref(?:erence)?\.?` + SEP + String.raw`([A-Z0-9]{10,22})(?![A-Z0-9])`, "i")],
  ["TXN", new RegExp(String.raw`\b(?:txn|transaction)\s*(?:id|no\.?|number|ref(?:erence)?)\s*(?:is|:|-|#|\.)*\s*([A-Z0-9]{8,30})(?![A-Z0-9])`, "i")],
  ["AUTH", new RegExp(String.raw`\bauth(?:ori[sz]ation)?\s*code\s*(?:is|:|-|#)*\s*([A-Z0-9]{6})(?![A-Z0-9])`, "i")],
  ["REF", new RegExp(String.raw`\bref(?:erence)?(?![a-z])\.?` + SEP + String.raw`([A-Z0-9]{8,22})(?![A-Z0-9])`, "i")],
];

/** How many digits a value needs before it reads as a reference rather than a word. */
const MIN_DIGITS: Record<ReferenceKind, number> = { RRN: 10, UTR: 6, REF: 6, TXN: 4, AUTH: 0 };

function digits(value: string): number {
  return (value.match(/\d/g) ?? []).length;
}

/** The first reference a message carries, by the most specific label it has. */
export function transactionReference(text: string | null | undefined): TransactionReference | null {
  if (!text) return null;
  const plain = decodeEntities(text);
  for (const [kind, pattern] of PATTERNS) {
    const match = plain.match(pattern);
    if (!match) continue;
    const value = match[1].toUpperCase();
    if (digits(value) < MIN_DIGITS[kind]) continue;
    // Twelve digits is UPI's RRN whatever the bank labelled it ("Ref
    // 661165147047" from Federal is the same number HDFC calls "UPI").
    return { kind: /^\d{12}$/.test(value) ? "RRN" : kind, value };
  }
  return null;
}

/** Two references to one payment: the same number, whatever each called it. */
export function sameReference(a: TransactionReference | null, b: TransactionReference | null): boolean {
  return Boolean(a && b && a.value === b.value);
}

/** Two references that can't be one payment's: the same scheme, different numbers. */
export function conflictingReferences(a: TransactionReference | null, b: TransactionReference | null): boolean {
  return Boolean(a && b && a.kind === b.kind && a.value !== b.value);
}
