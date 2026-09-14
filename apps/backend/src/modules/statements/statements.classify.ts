import { StatementKind, StatementLineKind, TransactionType } from "../../types";

/**
 * What a row on a statement actually is.
 *
 * This is the safety mechanism, not a tidying step. A statement lists the
 * payment you made against last month's bill, and inventing a transaction
 * for that would cancel real spending out of the totals: a credit on the
 * card against the debit already recorded on the account it was paid from.
 * detectSelfTransfer cannot save us there - its window is ten minutes and
 * a statement line carries only a date - so the only defence is to know
 * what the row is before anything is written.
 */

// "PAYMENT RECEIVED - THANK YOU", "PAYMENT VIA NEFT", "AUTOPAY RECEIVED".
// Deliberately broad: a payment wrongly treated as a refund costs nothing
// but a line in a review list, while the reverse corrupts the totals.
// The optional plural before each boundary matters more than it looks.
// "FINANCE CHARGES" is how every issuer prints it, and a \b straight after
// "charge" lands between the "e" and the "s" and fails to match at all.
const PLURAL = "(?:e?s)?\\b";

const PAYMENT_RE = new RegExp(
  "\\b(?:payment\\s*(?:received|thank|thankyou|credit)|thank\\s*you|received\\s*-?\\s*thank|autopay" +
    "|auto\\s*debit\\s*received|neft\\s*(?:cr|credit)|imps\\s*(?:cr|credit)|payment\\s*towards)" +
    PLURAL,
  "i"
);

// Money the issuer charged that no alert ever announced. These are the
// whole point of reading a statement, so they are named generously.
const FEE_RE = new RegExp(
  "\\b(?:finance\\s*charge|interest\\s*charge|late\\s*payment|annual\\s*fee|joining\\s*fee" +
    "|renewal\\s*fee|membership\\s*fee|over\\s*limit|overlimit|cash\\s*advance\\s*fee|surcharge" +
    "|processing\\s*fee|service\\s*charge|mark-?up(?:\\s*fee)?|gst|igst|cgst|sgst|vat|cess" +
    "|emi\\s*(?:processing|conversion)|penalty|bounce|return\\s*charge|reward\\s*redemption\\s*fee)" +
    PLURAL,
  "i"
);

// A credit that gives money back for something that was bought.
const REVERSAL_RE = new RegExp(
  "\\b(?:reversal|reversed|refund(?:ed)?|charge\\s*back|chargeback|cancellation|credit\\s*adjust)" +
    "(?:e?s|ment)?\\b",
  "i"
);

// Rows that are summary or furniture rather than events. Checked before
// everything except payments, because "Opening Balance" and "Total Amount
// Due" both carry a date and an amount and would otherwise parse as spend.
const NOISE_RE = new RegExp(
  "\\b(?:opening\\s*balance|closing\\s*balance|previous\\s*balance|balance\\s*(?:b\\/?f|carried|brought)" +
    "|total\\s*(?:amount\\s*)?due|minimum\\s*(?:amount\\s*)?due|statement\\s*(?:date|period|summary)" +
    "|credit\\s*limit|available\\s*(?:credit|limit|cash)|reward\\s*point|point\\s*(?:earned|balance|redeemed|expiring)" +
    "|points\\s*(?:earned|balance|redeemed|expiring)|transaction\\s*detail|date\\s*description" +
    "|page\\s*\\d+\\s*of\\s*\\d+|grand\\s*total|sub\\s*total|amount\\s*\\(in\\s*rs)" +
    PLURAL +
    "|^\\s*total\\s*$",
  "i"
);

/**
 * Classified by what the row says, with its direction as the tiebreak.
 *
 * Order matters. Noise is tested before the money words because a "Total
 * Amount Due" row contains an amount and nothing else distinguishes it,
 * and payments are tested before reversals because "PAYMENT RECEIVED -
 * THANK YOU" and a refund are both credits.
 */
export function classifyStatementLine(
  description: string,
  type: TransactionType,
  statement: StatementKind = "CARD"
): StatementLineKind {
  if (NOISE_RE.test(description)) return "NOISE";

  if (type === "CREDIT") {
    if (PAYMENT_RE.test(description)) return "PAYMENT";
    if (REVERSAL_RE.test(description)) return "REVERSAL";
    // A charge given back: "Fuel Surcharges ... 4.27 Cr" is the waiver of
    // a fee, not a payment against the bill.
    if (FEE_RE.test(description)) return "REVERSAL";

    // The one place the two documents disagree. An unexplained credit on a
    // card is far more often the bill being paid than money coming back,
    // and treating it as a payment leaves it alone. On a bank account it
    // is money arriving - a salary, a refund, someone paying you back -
    // and leaving that alone would be throwing away the income the whole
    // exercise was meant to find.
    return statement === "BANK" ? "INCOME" : "PAYMENT";
  }

  if (FEE_RE.test(description)) return "FEE";
  return "SPEND";
}

/**
 * Whether the words alone say this was money coming back.
 *
 * For the issuers that mark a credit only by printing it in a different
 * colour - Jupiter does - this is the whole of the evidence, because colour
 * is not in a PDF's text stream.
 *
 * Deliberately narrow. Everything not clearly marked as coming back is
 * treated as a debit, which is the recoverable mistake: a credit read as a
 * debit overstates spending on one row, while a debit read as a credit
 * quietly removes real spending from the totals.
 */
export function creditByDescription(description: string): boolean {
  return PAYMENT_RE.test(description) || REVERSAL_RE.test(description);
}

/** Whether a line of this kind may become a transaction. */
export function isLedgerWorthy(kind: StatementLineKind): boolean {
  return kind === "SPEND" || kind === "FEE" || kind === "REVERSAL" || kind === "INCOME";
}

/**
 * Whether a line counts towards "what this statement says you spent".
 *
 * A reversal is excluded rather than subtracted. The figure it is compared
 * against - what the ledger already held - is a sum of debits, so pulling
 * credits out of one side and not the other would make the two numbers
 * disagree for a reason that has nothing to do with anything missing.
 */
export function countsAsStatementSpend(kind: StatementLineKind): boolean {
  return kind === "SPEND" || kind === "FEE";
}

// A bank statement lists paying a card bill, and the card's own statement
// lists every purchase behind it. Importing both without noticing would
// book the same money twice - which is the trap cardPaymentFor exists to
// close, so a line that looks like one is worth marking as it goes in.
const CARD_BILL_RE = new RegExp(
  "\\b(?:cc\\s*(?:payment|pymt|bill)|credit\\s*card\\s*(?:payment|bill)|card\\s*payment" +
    "|bbps\\s*(?:cc|card)|autopay\\s*(?:cc|card)|payment\\s*to\\s*card)" +
    PLURAL,
  "i"
);

/**
 * Whether a debit on a bank statement looks like paying off a card.
 *
 * Only a hint - it names no card, and cannot. What it is for is putting a
 * marker on the row so the person reconciling can see the one line on the
 * statement that would otherwise double their month.
 */
export function looksLikeCardBill(description: string): boolean {
  return CARD_BILL_RE.test(description);
}
