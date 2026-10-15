/**
 * The bank's own figure for the balance, read off a transaction message.
 *
 * Many Indian bank SMS end with what the account held once the money had
 * moved: "Avl Bal Rs.12,345.67", "Bal: INR 1,234.00", "Available balance
 * is Rs 5,000.00". The transaction parser deliberately throws that tail
 * away before it looks for the amount - a five-figure balance must never
 * be taken for the payment - so the balance is read here, off the
 * original text, by a pattern that wants the word "balance" first.
 *
 * Many banks say nothing of the kind. A message with no balance in it is
 * the ordinary case, not a failure, and comes back as null.
 *
 * A credit card's "Avl Limit" is not a balance. It is read too, and kept
 * apart, because it is what the card still has to spend - which is a
 * different question with a different answer.
 */

export interface StatedFigures {
  /// What the account held after this transaction, in paise. Signed, since
  /// an overdrawn account prints a minus.
  balanceMinor: number | null;
  /// What was left of a card's limit after this charge, in paise.
  availableLimitMinor: number | null;
}

// A label for the balance, then the figure. The label is the word "bal" or
// "balance" on its own, with the bank's qualifier before it: "Avl Bal",
// "A/c Bal", "Clear Bal", "Total Bal", "Available Balance". Then up to a
// few words of filler ("is", ":", "now", "as of") that must contain no
// digit, so a date between the label and the figure cannot be read as the
// figure; the currency, which banks sometimes drop; and the amount itself,
// which must start with a digit - an empty table cell prints "Rs. ," and a
// bare comma is not a balance.
//
// The two lookaheads after the figure stop a date being read as one: in
// "Bal as on 12-10-26" the "12" is followed by "-1", and backtracking to
// "1" is refused because a digit follows it.
const BALANCE_RE =
  /\b(?:(?:avl|avail|available|a\/c|ac|acct|account|clear|clr|total|closing|current|net|updated|new|ledger|eff(?:ective)?)\.?\s*)?(?<!\b(?:points?|pts|rewards?)\s*)bal(?:ance)?\b\.?(?!\s*(?:points?|pts)\b)[^\d\n]{0,20}?(?:rs\.?|inr|₹)?\s*(-?\d[\d,]*(?:\.\d{1,2})?)(?!\d)(?![-/]\d)/i;

// "Avl Limit: INR 44,021.93", "Avl Lmt Rs 1,20,000", "Available credit
// limit is Rs. 50,000.00".
const LIMIT_RE =
  /\b(?:avl|avail|available)\.?\s*(?:credit\s*)?(?:limit|lmt)\b[^\d\n]{0,12}?(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d{1,2})?)(?!\d)(?![-/]\d)/i;

function toMinor(raw: string): number | null {
  const value = Number.parseFloat(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** The balance and the available limit a message states, where it states either. */
export function parseStatedFigures(text: string): StatedFigures {
  const balance = text.match(BALANCE_RE);
  const limit = text.match(LIMIT_RE);
  return {
    balanceMinor: balance ? toMinor(balance[1]) : null,
    availableLimitMinor: limit ? toMinor(limit[1]) : null,
  };
}

/** Just the balance, for callers with no interest in cards. */
export function parseStatedBalance(text: string): number | null {
  return parseStatedFigures(text).balanceMinor;
}
