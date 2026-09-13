/**
 * Per-issuer readers for the transaction table.
 *
 * Issuers agree on what a row means and on nothing else. Between the four
 * here there are three date formats, three ways of writing an amount, and
 * two extra columns that sit between the description and the figure and
 * would otherwise be read as part of the merchant's name.
 *
 * One of them does not mark credits in the text at all - Jupiter prints a
 * refund in a different colour, and colour is not in the text stream. So a
 * reader may decline to say the direction, and the description decides.
 */

export interface RawStatementRow {
  date: string;
  description: string;
  amount: string;
  /// null where the statement gives no sign either way, and the words have
  /// to answer instead.
  credit: boolean | null;
}

export interface StatementReader {
  name: string;
  /// Whether this reader recognises the document, from its headers.
  matches(rows: string[]): boolean;
  row(row: string): RawStatementRow | null;
  /// Whether a row is the tail of a description that wrapped, to be joined
  /// onto the line before it.
  continuation?(row: string): boolean;
}

/** An amount, with or without decimals and with Indian digit grouping. */
const AMOUNT = "[\\d,]+(?:\\.\\d{1,2})?";

/** 12/08/2026, 12-08-26. */
const SLASH_DATE = "\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4}";

/** 17 Jul 26, 17-Jul-2026. */
const NAMED_DATE = "\\d{1,2}[\\s\\-]+[A-Za-z]{3,9}[\\s\\-]+\\d{2,4}";

function anyRowMatches(rows: string[], pattern: RegExp): boolean {
  return rows.some((row) => pattern.test(row));
}

/**
 * ICICI, as on the Amazon Pay card.
 *
 *   12/08/2026  13967833420  AMAZON PAY IN UTILITY BANGALORE IN  95  4,750.00
 *   15/08/2026  13980001263  BBPS Payment received                0  29,693.53 CR
 *
 * Two things would defeat a generic reader. An eleven-digit serial number
 * sits between the date and the description, and a reward-points column
 * sits between the description and the amount - so the last number on the
 * row is the amount only once the points have been accounted for.
 */
const icici: StatementReader = {
  name: "ICICI",

  matches(rows) {
    return (
      anyRowMatches(rows, /\bicici\b/i) ||
      // The column header, for a statement that names the bank only in an
      // image: a serial number column beside reward points is distinctive.
      (anyRowMatches(rows, /\bser\s*no\b/i) && anyRowMatches(rows, /reward\s*points/i))
    );
  },

  row(row) {
    // The trailing group takes every amount at the end of the row, because
    // an international transaction prints the foreign figure before the
    // rupee one. The last is always the rupee amount.
    const match = row.match(
      new RegExp(`^(${SLASH_DATE})\\s+\\d{6,}\\s+(.+?)\\s+(-?\\d+)((?:\\s+${AMOUNT})+)\\s*(CR)?$`, "i")
    );
    if (!match) return null;

    const amounts = match[4].trim().split(/\s+/);
    return {
      date: match[1],
      description: match[2].trim(),
      amount: amounts[amounts.length - 1],
      credit: Boolean(match[5]),
    };
  },

  continuation(row) {
    // A long merchant name wraps, leaving its tail alone on the next line.
    // Letters only: "28 am" and a page number must not be swallowed.
    return /^[A-Za-z][A-Za-z\s&'.-]{0,40}$/.test(row.trim());
  },
};

/**
 * HDFC, as on both the IOCL and Tata Neu cards.
 *
 *   03/08/2026| 10:30   UPI-JAY MEWAD RAJAVADICHA        ₹ 143.00
 *   15/08/2026| 11:49   BPPY CC PAYMENT DP0162271149...  + ₹ 405.00
 *   04/08/2026| 19:57   EMI UPI-TANISHQ                  ₹ 8,000.00
 *
 * A time follows the date, attached by a pipe. Credits carry a leading
 * plus rather than a trailing Cr. Rows converted to an instalment plan
 * carry an EMI badge, which extracts as a word in front of the merchant.
 */
const hdfc: StatementReader = {
  name: "HDFC",

  matches(rows) {
    return (
      anyRowMatches(rows, /\bhdfc\b/i) ||
      (anyRowMatches(rows, /date\s*&\s*time/i) && anyRowMatches(rows, /transaction\s*description/i))
    );
  },

  row(row) {
    const match = row.match(
      new RegExp(
        `^(${SLASH_DATE})\\s*\\|?\\s*\\d{1,2}:\\d{2}\\s*(?:am|pm)?\\s+(.+?)\\s+` +
          `([+-])?\\s*(?:₹|Rs\\.?|INR)?\\s*(${AMOUNT})\\s*(CR|DR)?$`,
        "i"
      ),
      );
    if (!match) return null;

    // The badge is not part of the merchant's name.
    const description = match[2].trim().replace(/^EMI\s+/i, "");
    if (!description) return null;

    const marker = (match[5] ?? "").toUpperCase();
    return {
      date: match[1],
      description,
      amount: match[4],
      credit: match[3] === "+" || marker === "CR" ? true : marker === "DR" || match[3] === "-" ? false : null,
    };
  },
};

/**
 * Jupiter on CSB.
 *
 *   17 Jul 26 08:   Repayment - Thank You   Rs. 21,286.25
 *   18 Jul 26 04:   REFUND                  Rs. 1,345
 *
 * The timestamp wraps mid-way, so the minutes and the am/pm end up on a
 * line of their own and the hour is left with a dangling colon.
 *
 * Nothing in the text says which way the money went - a credit is only
 * printed in a different colour - so this reader never claims to know, and
 * the words decide. "Repayment - Thank You" and "REFUND" are unambiguous,
 * which is what makes that safe here.
 */
const jupiter: StatementReader = {
  name: "Jupiter",

  matches(rows) {
    return (
      anyRowMatches(rows, /\b(jupiter|csb\s*bank|federal\s*bank\s*jupiter)\b/i) ||
      (anyRowMatches(rows, /transaction\s*details/i) && anyRowMatches(rows, /amount\s*\(inr\)/i))
    );
  },

  row(row) {
    const match = row.match(
      new RegExp(
        `^(${NAMED_DATE})\\s+\\d{1,2}:\\s*(?:\\d{2})?\\s*(?:am|pm)?\\s+(.+?)\\s+` +
          `(?:Rs\\.?|₹|INR)\\s*(${AMOUNT})$`,
        "i"
      )
    );
    if (!match) return null;

    return {
      date: match[1],
      description: match[2].trim(),
      amount: match[3],
      // Deliberately unknown. See the note above.
      credit: null,
    };
  },
};

/**
 * The fallback, for an issuer nobody has written a reader for yet.
 *
 *   18/08/2026  AMZNIN MUMBAI IN  1,240.00
 *
 * A date at the front and an amount at the back, with everything between
 * them taken as the description. Anchoring at both ends is what keeps
 * prose out: a sentence about a reward programme may contain a number, but
 * it does not begin with a date and end with one.
 */
const generic: StatementReader = {
  name: "generic",

  matches() {
    return true;
  },

  row(row) {
    const leading = row.match(new RegExp(`^(${SLASH_DATE}|${NAMED_DATE})\\s+(.*)$`));
    if (!leading) return null;

    let rest = leading[2].trim();
    if (!rest) return null;

    // A posting date printed beside the transaction date. The first is the
    // one that matters; drop the second so it cannot be read as a merchant.
    const second = rest.match(new RegExp(`^(?:${SLASH_DATE}|${NAMED_DATE})\\s+(.+)$`));
    if (second) rest = second[1].trim();

    const match = rest.match(new RegExp(`^(.+?)\\s+(?:₹|Rs\\.?|INR)?\\s*\\(?(${AMOUNT})\\)?\\s*(CR|DR)?$`, "i"));
    if (!match) return null;

    const marker = (match[3] ?? "").toUpperCase();
    return {
      date: leading[1],
      description: match[1].replace(/[\s.,;:-]+$/, "").trim(),
      amount: match[2],
      credit: marker === "CR" ? true : marker === "DR" ? false : null,
    };
  },
};

const READERS: StatementReader[] = [icici, hdfc, jupiter];

/**
 * The reader for a document, chosen from what its headers say.
 *
 * Order matters only in that the generic one is last: it matches anything,
 * so it is the answer when no specific reader recognises the layout.
 */
export function readerFor(rows: string[]): StatementReader {
  return READERS.find((reader) => reader.matches(rows)) ?? generic;
}

export const readers = { icici, hdfc, jupiter, generic };
