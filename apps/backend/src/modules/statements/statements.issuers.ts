import { StatementKind } from "../../types";

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
  /// The running balance after this row, on a statement that prints one.
  /// It is how a bank statement's direction is worked out - see the note
  /// on the bank reader.
  balance?: string;
}

export interface StatementReader {
  name: string;
  /// What kind of document this reads. Decides what an unexplained credit
  /// means, which is the one thing a card and a bank statement disagree on.
  kind: StatementKind;
  /// Whether this reader recognises the document, from its headers.
  matches(rows: string[]): boolean;
  /// True for the reader that stands in when nothing else fits. It matches
  /// every document by design, so the fact that it found rows is never
  /// evidence that it understood them - which is why selection has to know
  /// which reader this is.
  fallback?: boolean;
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

/**
 * Where a currency mark sits, if the statement prints one at all.
 *
 * A rupee sign in a subset font extracts as whatever glyph that subset
 * used. On a real HDFC statement it comes out as a capital C - which is a
 * letter, and an earlier version of this admitted symbols only and so read
 * nothing at all from those files.
 *
 * So: the known words, any symbol, or a *single* letter. One and not two,
 * which is what keeps "AMZNIN MUMBAI IN 1,240.00" from losing its "IN" to
 * this slot and reading as a merchant called "AMZNIN MUMBAI". There is a
 * test on that row.
 */
const CURRENCY = "(?:Rs\\.?|INR|[^\\w\\s]{1,2}|[A-Za-z])?";

/**
 * What follows the amount on a statement that prints something there.
 *
 * HDFC ends every row with its Purchase Indicator, a coloured dot that
 * extracts as a lowercase L. Left unallowed, every transaction row on the
 * statement failed to match on its last character.
 */
const TRAILING_MARK = "(?:\\s+[^\\d\\s]{1,2})?";

/**
 * How far into a document to look for its letterhead.
 *
 * Issuer detection used to read every row, which meant a bank statement
 * full of UPI handles was claimed by the ICICI card reader on the strength
 * of "SWIGGY@ICICI" - and then read nothing at all, silently. A bank names
 * itself at the top of its own statement, so that is where to look.
 */
const HEADER_ROWS = 20;

function anyRowMatches(rows: string[], pattern: RegExp): boolean {
  return rows.slice(0, HEADER_ROWS).some((row) => pattern.test(row));
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
  kind: "CARD",
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
  kind: "CARD",
  name: "HDFC",

  matches(rows) {
    return (
      anyRowMatches(rows, /\bhdfc\b/i) ||
      (anyRowMatches(rows, /date\s*&\s*time/i) && anyRowMatches(rows, /transaction\s*description/i))
    );
  },

  row(row) {
    // Written against a real statement rather than a screenshot, which is
    // why so little of it is required. The rows read:
    //
    //   01/05/2026| 23:57 UPI-ZEPTO MARKETPLACEPRIVATE C 101.00 l
    //   15/05/2026| 23:32 CC PAYMENT ... (Ref# 000...) + C 16,127.00 l
    //   01/05/2026| 00:00 C 5.40 l
    //
    // The C is the rupee sign as that font subset extracts it. The trailing
    // l is the Purchase Indicator dot. And the third row has no description
    // at all, because its text wrapped onto the lines either side of it -
    // so the description is allowed to be empty and filled in afterwards.
    // The description is optional but, when present, must end at a space.
    // Without that the single-letter currency could be taken off the end of
    // a word instead - "UPI-JAY MEWAD RAJAVADICHA 143.00" read as a
    // merchant called "UPI-JAY MEWAD RAJAVADICH" with an "A" for a rupee.
    const match = row.match(
      new RegExp(
        `^(${SLASH_DATE})\\s*[|]?\\s*(?:\\d{1,2}:\\d{2}(?::\\d{2})?\\s*(?:am|pm)?)?\\s+(?:(.*?)\\s+)?` +
          `([+-])?\\s*${CURRENCY}\\s*(${AMOUNT})\\s*(CR|DR)?${TRAILING_MARK}\\s*$`,
        "i"
      )
    );
    if (!match) return null;

    // The badge is not part of the merchant's name, and nor is a lone
    // currency mark left behind where the description was empty.
    const description = (match[2] ?? "")
      .trim()
      .replace(/^EMI\s+/i, "")
      .replace(/^[A-Za-z]$/, "")
      .trim();

    const marker = (match[5] ?? "").toUpperCase();
    return {
      date: match[1],
      description,
      amount: match[4],
      credit: match[3] === "+" || marker === "CR" ? true : marker === "DR" || match[3] === "-" ? false : null,
    };
  },

  continuation(row) {
    return /^[A-Za-z][A-Za-z\s&'.\-*]{0,40}$/.test(row.trim());
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
 * Later in the same statement it wraps all the way, and the row keeps no
 * part of the time at all:
 *
 *   01 Aug 26   SWIGGY   Rs. 364.00
 *   12:46 pm
 *
 * So the time is optional here. It was not, and the effect was worse than
 * nineteen missing rows: this reader came up short against the fallback,
 * which reads the same table with the hour glued to the front of every
 * merchant's name.
 *
 * Nothing in the text says which way the money went - a credit is only
 * printed in a different colour - so this reader never claims to know, and
 * the words decide. "Repayment - Thank You" and "REFUND" are unambiguous,
 * which is what makes that safe here.
 */
const jupiter: StatementReader = {
  kind: "CARD",
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
        `^(${NAMED_DATE})\\s+(?:\\d{1,2}:\\s*(?:\\d{2})?\\s*(?:am|pm)?\\s+)?(.+?)\\s+` +
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
  kind: "CARD",
  name: "generic",
  fallback: true,

  matches() {
    return true;
  },

  row(row) {
    // The separator is optional and may be flush against the date, which is
    // how HDFC prints it: "03/08/2026| 10:30". Requiring whitespace there
    // was enough to stop this reader standing in for that one.
    const leading = row.match(new RegExp(`^(${SLASH_DATE}|${NAMED_DATE})\\s*[|]?\\s+(.*)$`));
    if (!leading) return null;

    let rest = leading[2].trim();
    if (!rest) return null;

    // A billing period, not a transaction: "17 JUL 2026 - 16 AUG 2026".
    // Nothing here says amount, so the year of the closing date was being
    // read as one - and that line is the running header of every page, so
    // an eleven page statement arrived with eleven charges of Rs 2,026 on
    // it. Anything that is a date, a dash and a date is a range.
    if (new RegExp(`^(?:[-–—]|to)\\s*(?:${SLASH_DATE}|${NAMED_DATE})$`, "i").test(rest)) return null;

    // A posting date printed beside the transaction date. The first is the
    // one that matters; drop the second so it cannot be read as a merchant.
    const second = rest.match(new RegExp(`^(?:${SLASH_DATE}|${NAMED_DATE})\\s+(.+)$`));
    if (second) rest = second[1].trim();

    // A time, where the date carries one. Stripped here as well as in the
    // per-issuer readers, because this one has to stand in for them when
    // their own patterns miss - and a merchant called "10:30 SWIGGY" reads
    // as a mistake even though the amount beside it is right.
    //
    // The minutes are optional because they are not always on the row: CSB
    // wraps its timestamp mid-way and leaves the hour behind with a
    // dangling colon, so seventy merchants came through named "08: MUKHWAS
    // PAN PARLOUR" and "11: MR SHARMA SORABH".
    rest = rest.replace(/^[|]?\s*\d{1,2}:(?:\d{2}(?::\d{2})?)?\s*(?:am|pm)?\s+/i, "").trim();
    if (!rest) return null;

    // Anything short and non-numeric where a currency mark belongs: a rupee
    // sign in a subset font extracts as whatever glyph that subset used.
    const match = rest.match(
      new RegExp(
        `^(.+?)\\s+[+-]?\\s*${CURRENCY}\\s*\\(?(${AMOUNT})\\)?\\s*(CR|DR)?${TRAILING_MARK}\\s*$`,
        "i"
      )
    );
    if (!match) return null;

    const description = match[1].replace(/[\s.,;:-]+$/, "").trim();

    // A date and a figure with nothing but a currency mark between them is
    // a summary line - "17/07/2026 Rs. 21,286.25" is the previous balance,
    // printed above the table. A transaction says who it was paid to.
    if (!description || /^(?:Rs|INR|₹)$/i.test(description)) return null;

    const marker = (match[3] ?? "").toUpperCase();
    return {
      date: leading[1],
      description,
      amount: match[2],
      credit: marker === "CR" ? true : marker === "DR" ? false : null,
    };
  },
};

/**
 * A bank account statement, as every Indian bank lays one out.
 *
 *   14/09/26  UPI-SWIGGY-...  UPI-123456  14/09/26   432.50    45,320.10
 *   15/09/26  SALARY SEP      NEFT-0099   15/09/26  96,000.00  1,41,320.10
 *
 * Two things make this a different document rather than a different bank.
 *
 * There is a running balance, so the last number on a row is never the
 * amount. And withdrawals and deposits sit in separate columns, both of
 * which vanish when empty - so a row of either kind arrives as exactly two
 * trailing numbers and the position tells you nothing about which it was.
 *
 * The balance is what answers it. A row where the balance fell by the
 * amount was money going out; one where it rose was money coming in. That
 * is worked out in a second pass, once the rows are in order - see
 * statements.parse.ts. It also checks itself: a row whose balance does not
 * move by its own amount was misread, and is better dropped than guessed at.
 */
const bank: StatementReader = {
  kind: "BANK",
  name: "bank",

  matches(rows) {
    const hasBalance = anyRowMatches(rows, /closing\s*balance|balance\s*\(inr\)|running\s*balance/i);
    const hasColumns = anyRowMatches(rows, /withdrawal|deposit|debit\s*amount|credit\s*amount|narration/i);
    return hasBalance && hasColumns;
  },

  row(row) {
    // The last two numbers on the row: the balance, and the amount before
    // it. Anything further left is a reference number or a value date.
    const match = row.match(
      new RegExp(`^(${SLASH_DATE}|${NAMED_DATE})\\s+(.+?)\\s+(${AMOUNT})\\s+(${AMOUNT})\\s*$`)
    );
    if (!match) return null;

    // A reference number and a value date sit between the narration and the
    // figures, and neither says anything about what the payment was for.
    const description = match[2]
      .replace(new RegExp(`\\s+${SLASH_DATE}\\s*$`), "")
      .replace(/\s+[A-Za-z]*[-/]?\d{6,}[A-Za-z0-9]*\s*$/, "")
      .replace(new RegExp(`\\s+${SLASH_DATE}\\s*$`), "")
      .trim();

    if (!description) return null;

    return {
      date: match[1],
      description,
      amount: match[3],
      balance: match[4],
      // Settled in the second pass, from how the balance moved.
      credit: null,
    };
  },
};

const READERS: StatementReader[] = [bank, icici, hdfc, jupiter];

/**
 * The reader for a document, chosen from what its headers say.
 *
 * Order matters only in that the generic one is last: it matches anything,
 * so it is the answer when no specific reader recognises the layout.
 */
export function readerFor(rows: string[]): StatementReader {
  return READERS.find((reader) => reader.matches(rows)) ?? generic;
}

export const readers = { bank, icici, hdfc, jupiter, generic };

/// Every reader, likeliest first and the fallback last. Used when the
/// one the headers pointed at turns out to find nothing.
export const allReaders: StatementReader[] = [...READERS, generic];
