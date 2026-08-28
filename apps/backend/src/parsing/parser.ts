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

const DEBIT_KEYWORDS = /\b(debited|spent|paid|sent|withdrawn|purchase of|debit of)\b/i;
const CREDIT_KEYWORDS = /\b(credited|received|deposited|refund of|credit of)\b/i;

// Phrases that show up constantly in non-transactional bank/telecom SMS and
// should never be treated as a transaction even if they mention an amount.
const NOISE_RE = /\b(otp|one time password|will be debited|is due|due on|minimum due|statement|verification code)\b/i;

const CARD_LAST4_RE = /card\s+(?:no\.?\s*)?(?:ending|ending in|xx+|\*+)\s*(\d{4})/i;
const ACCOUNT_LAST4_RE = /a\/?c\s*(?:no\.?)?\s*[x*]*(\d{4})\b/i;
const GENERIC_LAST4_RE = /[x*]{2,}(\d{4})\b/i;

const UPI_VPA_RE = /to\s+(?:vpa\s+)?([\w.\-]{2,64}@[\w.\-]{2,20})/i;
const MERCHANT_AT_RE = /\bat\s+([A-Za-z0-9&' .\-]{2,40}?)(?:\s+on\b|\s+ref\b|\.|,|$)/i;
const MERCHANT_TO_RE = /\bto\s+([A-Za-z0-9&' .\-]{2,40}?)(?:\s+on\b|\s+ref\b|\.|,|$)/i;

const BANK_NAME_RE =
  /(hdfc|icici|sbi|axis|kotak|yes bank|idfc|indusind|pnb|bank of baroda|canara|union bank|paytm|federal bank)/i;

function parseAmountToMinor(raw: string): number {
  const cleaned = raw.replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Math.round(value * 100);
}

function extractMerchant(text: string): string | null {
  const vpa = text.match(UPI_VPA_RE);
  if (vpa) return vpa[1].trim();

  const at = text.match(MERCHANT_AT_RE);
  if (at) return at[1].trim();

  const to = text.match(MERCHANT_TO_RE);
  if (to) return to[1].trim();

  return null;
}

function extractAccount(text: string): ParsedTransaction["account"] {
  const bankMatch = text.match(BANK_NAME_RE);
  const bankName = bankMatch ? bankMatch[1] : "Unknown Bank";

  const cardMatch = text.match(CARD_LAST4_RE);
  if (cardMatch) {
    return { bankName, last4: cardMatch[1], accountType: "CARD" };
  }

  const acMatch = text.match(ACCOUNT_LAST4_RE) ?? text.match(GENERIC_LAST4_RE);
  if (acMatch) {
    const accountType: AccountType = /upi|vpa/i.test(text) ? "UPI" : "BANK";
    return { bankName, last4: acMatch[1], accountType };
  }

  if (!bankMatch) return null;
  return { bankName, last4: null, accountType: "BANK" };
}

/**
 * Best-effort heuristic parser for bank/UPI transaction SMS and email text.
 * Returns null when the text doesn't look like a transaction at all (OTP,
 * promo, bill-due reminder, etc.) so callers can silently ignore it.
 */
export function parseTransactionText(text: string): ParsedTransaction | null {
  if (NOISE_RE.test(text)) return null;

  const amountMatch = text.match(AMOUNT_RE);
  if (!amountMatch) return null;

  const isDebit = DEBIT_KEYWORDS.test(text);
  const isCredit = CREDIT_KEYWORDS.test(text);
  if (!isDebit && !isCredit) return null;
  // If a message somehow trips both (e.g. quoting a previous balance), we
  // can't trust it — better to skip than to miscategorize direction.
  if (isDebit && isCredit) return null;

  const type: TransactionType = isDebit ? "DEBIT" : "CREDIT";

  return {
    amountMinor: parseAmountToMinor(amountMatch[1]),
    currency: "INR",
    type,
    merchant: extractMerchant(text),
    account: extractAccount(text),
    occurredAt: null,
  };
}
