import { AccountType, TransactionType } from "../types";

export interface ParsedTransaction {
  amountMinor: number;
  currency: string;
  type: TransactionType;
  merchant: string | null;
  account: {
    bankName: string;
    last4: string | null;
    accountType: AccountType;
  } | null;
  occurredAt: Date | null; // null = caller should fall back to message timestamp
}

const AMOUNT_RE = /(?:rs\.?|inr|₹)\s?([\d,]+(?:\.\d{1,2})?)/i;

// Phrases that mean "this is not a completed transaction" — OTPs, bill
// reminders, autopay pre-notifications, balance enquiries. Checked before
// anything else so these never produce a transaction.
const NOISE_RE =
  /\b(otp|one time password|will be debited|is due|due on|minimum due|statement|verification code|has been requested|requesting money|collect request)\b/i;

const CREDIT_RE = /\b(credited|received|deposited|refund(?:ed)?|credit of|added to)\b/i;
const DEBIT_RE = /\b(debited|spent|paid|sent|withdrawn|deducted|charged|purchase of|debit of|used for|was used)\b/i;
// Weak signal: card alerts often say only "Txn Rs.105.00". Only trusted
// when the message also identifies a specific account/card or a UPI handle,
// so marketing texts mentioning a "txn" don't become transactions.
const GENERIC_TXN_RE = /\b(txn|transaction)\b/i;

// Bank/card-issuer safety boilerplate. Everything from the first of these
// markers onward is dropped before extracting a merchant, so helpline
// numbers ("SMS BLOCK 2009 to 9215676766"), reference ids, and running
// balances can't be mistaken for transaction details.
const BOILERPLATE_RE =
  /(not you\??|if not you|to raise an issue|to report|thank you for using|call \d{6,}|call \d{4}\s\d{4}|sms block|avl\.?\s*(?:bal|limit)|available balance|ref(?:erence)?\.?\s*(?:no\.?|#)?\s*:?\s*\d{6,}|\bbal\b\s*rs)/i;

const BANK_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /\bhdfc\b/i, name: "HDFC Bank" },
  { pattern: /\bicici\b/i, name: "ICICI Bank" },
  { pattern: /\b(?:sbi|state bank)\b/i, name: "SBI" },
  { pattern: /\baxis\b/i, name: "Axis Bank" },
  { pattern: /\bkotak\b/i, name: "Kotak Bank" },
  { pattern: /\byes bank\b/i, name: "Yes Bank" },
  { pattern: /\bidfc\b/i, name: "IDFC First Bank" },
  { pattern: /\bindusind\b/i, name: "IndusInd Bank" },
  { pattern: /\b(?:pnb|punjab national)\b/i, name: "Punjab National Bank" },
  { pattern: /\b(?:bank of baroda|bob)\b/i, name: "Bank of Baroda" },
  { pattern: /\bcanara\b/i, name: "Canara Bank" },
  { pattern: /\bunion bank\b/i, name: "Union Bank" },
  { pattern: /\bfederal bank\b/i, name: "Federal Bank" },
  { pattern: /\bcsb\b/i, name: "CSB Bank" },
  { pattern: /\brbl\b/i, name: "RBL Bank" },
  { pattern: /\bidbi\b/i, name: "IDBI Bank" },
  { pattern: /\bindian bank\b/i, name: "Indian Bank" },
  { pattern: /\bbandhan\b/i, name: "Bandhan Bank" },
  { pattern: /\bau small finance\b/i, name: "AU Small Finance Bank" },
  { pattern: /\bstandard chartered\b/i, name: "Standard Chartered" },
  { pattern: /\b(?:amex|american express)\b/i, name: "American Express" },
  { pattern: /\bhsbc\b/i, name: "HSBC" },
  { pattern: /\bciti(?:bank)?\b/i, name: "Citibank" },
  { pattern: /\bdbs\b/i, name: "DBS Bank" },
  { pattern: /\bpaytm\b/i, name: "Paytm Payments Bank" },
  { pattern: /\bjupiter\b/i, name: "Jupiter" },
  { pattern: /\bslice\b/i, name: "Slice" },
  { pattern: /\bonecard\b/i, name: "OneCard" },
  { pattern: /\bfi money\b/i, name: "Fi" },
];

// "-Federal Bank" / "- HDFC Bank" style sender signature at the very end.
const SIGNATURE_RE = /[-–]\s*([A-Za-z][A-Za-z ]{2,30})\s*$/;

// "Card 1377", "Card XX2009", "Card ending 1234", "Card ending in 4321"
const CARD_LAST4_RE = /card\s*(?:no\.?\s*)?(?:ending(?:\s+in|\s+with)?\s*)?(?:x+|\*+)?\s*(\d{4})\b/i;
// "a/c X5130", "A/c XX1234", "ac no 1234"
const ACCOUNT_LAST4_RE = /a\/?c\s*(?:no\.?)?\s*(?:x+|\*+)?\s*(\d{4})\b/i;
const ACCOUNT_WORD_LAST4_RE = /account\s*(?:no\.?)?\s*(?:x+|\*+)?\s*(\d{4})\b/i;
const MASKED_LAST4_RE = /(?:x{2,}|\*{2,})\s*(\d{4})\b/i;

const CARD_CONTEXT_RE = /\b(credit card|debit card|rupay|visa|mastercard|card)\b/i;

// A UPI handle anywhere in the message ("At paytmqr6g6fjc@ptys",
// "to VPA swiggy@icici") is the most reliable merchant signal there is.
const VPA_RE = /\b([\w.\-]{2,64}@[\w.\-]{2,20})\b/;

const MERCHANT_PREFIX_RES = [
  // Ahead of the others because it is the most specific: in "on 15-08-26
  // towards SWIGGY ORDER" the "on" pattern would otherwise swallow the
  // date and the merchant together, and then reject the lot as date-like.
  /\btowards\s+([A-Za-z0-9&'.\- ]{2,50}?)(?=\s+on\b|\s+ref\b|\s+by\b|[.,]|$)/gi,
  /\bat\s+([A-Za-z0-9&'.\- ]{2,50}?)(?=\s+on\b|\s+ref\b|\s+by\b|[.,]|$)/gi,
  /\bto\s+([A-Za-z0-9&'.\- ]{2,50}?)(?=\s+on\b|\s+ref\b|\s+by\b|[.,]|$)/gi,
  /\bon\s+([A-Za-z0-9&'.\- ]{2,50}?)(?=\s+on\b|\s+ref\b|\s+by\b|[.,]|$)/gi,
];

const DATE_LIKE_RE = /^\d{1,4}\s*[-/]?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/i;
const NON_MERCHANT_RE = /^(vpa|upi|your|a\/?c|account|card|the|ref|rs|inr|atm|no|info)\b/i;

function parseAmountToMinor(raw: string): number {
  const cleaned = raw.replace(/,/g, "");
  return Math.round(Number.parseFloat(cleaned) * 100);
}

/** Text with the trailing safety/helpline boilerplate removed. */
function stripBoilerplate(text: string): string {
  const match = text.match(BOILERPLATE_RE);
  return match?.index !== undefined ? text.slice(0, match.index) : text;
}

function isValidMerchant(candidate: string): boolean {
  const value = candidate.trim();
  if (value.length < 2 || value.length > 60) return false;
  if (/^\d+$/.test(value)) return false;
  // Phone numbers, reference ids and the like.
  const digitCount = (value.match(/\d/g) ?? []).length;
  if (digitCount / value.length > 0.5) return false;
  if (DATE_LIKE_RE.test(value)) return false;
  if (NON_MERCHANT_RE.test(value)) return false;
  return true;
}

function cleanMerchant(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.,;:\s]+$/, "");
}

function extractMerchant(core: string): string | null {
  const vpa = core.match(VPA_RE);
  if (vpa) return cleanMerchant(vpa[1]);

  for (const regex of MERCHANT_PREFIX_RES) {
    regex.lastIndex = 0;
    for (const match of core.matchAll(regex)) {
      const candidate = cleanMerchant(match[1]);
      if (isValidMerchant(candidate)) return candidate;
    }
  }

  return null;
}

function detectBankName(full: string): string | null {
  // A sender signature at the end of the message is more trustworthy than
  // a bank name appearing mid-text (e.g. the "icici" inside "swiggy@icici").
  const signature = full.trim().match(SIGNATURE_RE);
  if (signature) {
    for (const bank of BANK_PATTERNS) {
      if (bank.pattern.test(signature[1])) return bank.name;
    }
  }

  for (const bank of BANK_PATTERNS) {
    if (bank.pattern.test(full)) return bank.name;
  }

  return null;
}

function extractAccount(core: string, full: string): ParsedTransaction["account"] {
  const bankName = detectBankName(full);

  const cardMatch = core.match(CARD_LAST4_RE);
  if (cardMatch) {
    return { bankName: bankName ?? "Unknown Bank", last4: cardMatch[1], accountType: "CARD" };
  }

  const accountMatch =
    core.match(ACCOUNT_LAST4_RE) ?? core.match(ACCOUNT_WORD_LAST4_RE) ?? core.match(MASKED_LAST4_RE);
  if (accountMatch) {
    return { bankName: bankName ?? "Unknown Bank", last4: accountMatch[1], accountType: "BANK" };
  }

  if (!bankName) return null;

  // Known issuer but no visible number (common on co-branded card alerts).
  return {
    bankName,
    last4: null,
    accountType: CARD_CONTEXT_RE.test(core) ? "CARD" : "BANK",
  };
}

function detectType(core: string): TransactionType | null {
  const creditMatch = core.match(CREDIT_RE);
  const debitMatch = core.match(DEBIT_RE);

  if (creditMatch && debitMatch) {
    // Both present (e.g. a reversal notice) — the verb that appears first
    // is the one describing this message's transaction.
    return (creditMatch.index ?? 0) < (debitMatch.index ?? 0) ? "CREDIT" : "DEBIT";
  }
  if (creditMatch) return "CREDIT";
  if (debitMatch) return "DEBIT";
  return null;
}

/**
 * Best-effort heuristic parser for bank/UPI transaction SMS and email text.
 * Returns null when the text doesn't look like a completed transaction
 * (OTP, promo, bill-due reminder, balance enquiry) so callers can silently
 * ignore it.
 */
export function parseTransactionText(text: string): ParsedTransaction | null {
  if (NOISE_RE.test(text)) return null;

  const core = stripBoilerplate(text);

  const amountMatch = core.match(AMOUNT_RE);
  if (!amountMatch) return null;

  const account = extractAccount(core, text);
  const merchant = extractMerchant(core);

  let type = detectType(core);
  if (!type) {
    // No explicit direction verb. Card alerts like "Txn Rs.105.00 On HDFC
    // Bank Card 1377" are debits, but only trust that when the message
    // actually identifies an account/card or UPI handle.
    const hasAccountContext = account?.last4 != null || VPA_RE.test(core);
    if (GENERIC_TXN_RE.test(core) && hasAccountContext) {
      type = "DEBIT";
    } else {
      return null;
    }
  }

  return {
    amountMinor: parseAmountToMinor(amountMatch[1]),
    currency: "INR",
    type,
    merchant,
    account,
    occurredAt: null,
  };
}
