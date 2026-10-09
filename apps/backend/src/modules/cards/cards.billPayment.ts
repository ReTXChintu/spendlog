import { AccountType, TransactionType } from "../../types";

/**
 * Recognising a credit card bill being paid, from the words of the message
 * that reported it.
 *
 * Every purchase on a card was counted the day it was made. When the bill
 * is paid a month later the same money leaves the bank account, and the
 * bank's SMS for that looks like any other payment: "Rs 15,000 debited from
 * A/c XX1234". Counted as spending, it books the month's card purchases a
 * second time - which is exactly what the monthly budget was doing.
 *
 * Two messages can describe one bill payment, and both need recognising:
 *
 *   PAYMENT           the bank side - money out of an account, towards a
 *                     card. Linked to the card it paid (cardPaymentFor).
 *   PAYMENT_RECEIVED  the card side - the issuer saying the payment
 *                     arrived. Money in, but not income: it is the same
 *                     money as the debit, landing on the card.
 *
 * Pure on purpose. Everything here is a judgement about wording, which is
 * where the mistakes will be, so it is kept away from the database and
 * tested against real messages directly. The service beside it does the
 * writing.
 *
 * The expensive mistake is the false positive: a purchase read as a bill
 * payment disappears from every total. So a message has to say "card bill"
 * in one of the ways banks actually say it; a payee alone is not enough
 * when that payee does other things too (CRED takes rent as well).
 */

export type CardBillSide = "PAYMENT" | "PAYMENT_RECEIVED";

/** A credit card of the user's, as much of it as matching needs. */
export interface BillCard {
  id: string;
  bankName?: string | null;
  issuer?: string | null;
  nickname?: string | null;
  aliases?: { bankName: string }[] | null;
  last4?: string | null;
  isActive?: boolean | null;
}

export interface CardBillInput {
  /// The message, or every message, that reported the transaction. The
  /// merchant can be added too: a statement row has nothing else.
  text: string;
  type: TransactionType;
  /// The account the transaction was filed under, when it is known.
  accountId?: string | null;
  accountType?: AccountType | null;
  /// Set when a matching payment has already been seen on the other side.
  /// A payee that is only probably a card bill (CRED) is then certainly
  /// one: the card said the money arrived.
  confirmed?: boolean;
}

export interface CardBillMatch {
  side: CardBillSide;
  /// The card this paid, or was paid into. Null when it is clearly a card
  /// bill but no single card of the user's can be named without guessing.
  cardId: string | null;
}

// Issuers, by a key that a card and a message can both be reduced to. The
// optional glued suffix covers the way payee names are squashed together
// in narrations and UPI handles: "HDFCCC", "SBICARD", "AXISBANK".
const ISSUERS: { key: string; pattern: string; cardOnly?: boolean }[] = [
  { key: "hdfc", pattern: "hdfc" },
  { key: "icici", pattern: "icici" },
  { key: "sbi", pattern: "sbi|state\\s*bank" },
  { key: "axis", pattern: "axis" },
  { key: "kotak", pattern: "kotak" },
  { key: "amex", pattern: "amex|american\\s*express", cardOnly: true },
  { key: "idfc", pattern: "idfc(?:\\s*first)?" },
  { key: "indusind", pattern: "indusind" },
  { key: "yes", pattern: "yes\\s*bank" },
  { key: "rbl", pattern: "rbl" },
  { key: "au", pattern: "au\\s*small\\s*finance|au\\s*bank" },
  { key: "hsbc", pattern: "hsbc" },
  { key: "citi", pattern: "citi(?:bank)?" },
  { key: "sc", pattern: "standard\\s*chartered|stanchart" },
  { key: "bob", pattern: "bank\\s*of\\s*baroda|bob" },
  { key: "federal", pattern: "federal\\s*bank" },
  { key: "csb", pattern: "csb" },
  { key: "onecard", pattern: "one\\s*card", cardOnly: true },
  { key: "slice", pattern: "slice", cardOnly: true },
  { key: "pnb", pattern: "pnb|punjab\\s*national" },
  { key: "canara", pattern: "canara" },
  { key: "union", pattern: "union\\s*bank" },
  { key: "idbi", pattern: "idbi" },
  { key: "dbs", pattern: "dbs" },
];

const issuerRe = (pattern: string) => new RegExp(`\\b(?:${pattern})(?:cc|cards?|bank)?\\b`, "i");

// The issuer written as the card's own name - "ICICI Bank Credit Card",
// "HDFC CARDS", "AXIS CC", "IDFC FIRST Bank Credit Card" - or straight
// after the words for paying one, as in "CC PAYMENT ICICI 2009". A bank
// named anywhere else in a bank's SMS is usually the bank being debited.
const cardIssuerRe = (pattern: string) =>
  new RegExp(
    `\\b(?:${pattern})(?:cc|cards?)\\b` +
      `|\\b(?:${pattern})\\s*(?:bank\\s*)?(?:ltd\\.?\\s*)?(?:first\\s*(?:bank\\s*)?)?(?:credit\\s*ca(?:rds?)?|cards?|cc)\\b` +
      `|\\b(?:cc|card)\\s*(?:bill\\s*)?(?:payment|pymt|pmt|bill)?\\s*[-:*/]?\\s*(?:${pattern})\\b`,
    "i"
  );

// A loan or an EMI is its own kind of payment, with its own matcher. A
// card's EMI is part of the card's bill and was counted as an instalment;
// neither is ever a bill payment in its own right.
const LOAN_OR_EMI_RE = /\b(?:emi|emis|loan|mortgage|instal+ments?)\b/i;

// The card was what paid: "spent on your ICICI Bank Credit Card", "paid
// from your Edge CSB Bank RuPay Credit Card to Flipkart", "using HDFC Bank
// Debit Card". That is a purchase, whatever else the message says. The
// lookahead keeps "by credit card payment" from reading as one, and the
// words in between may not be "to" or "towards": in "sent from HDFC Bank
// to ICICI Credit Card" the card is where the money went, not what paid.
const CARD_INSTRUMENT_RE = new RegExp(
  "\\b(?:on|using|via|with|from|through|thru|by)\\s+(?:your\\s+|ur\\s+)?" +
    "(?:(?!(?:to|towards|for|of)\\b)[a-z&]+\\s+){0,4}?" +
    "(?:credit\\s+|debit\\s+)?card\\b(?!\\s*(?:bill|payment|pymt|pmt|dues?)\\b)" +
    "|\\bcard\\b.{0,40}?\\b(?:has\\s+been\\s+|was\\s+|is\\s+)?(?:used|swiped)\\b" +
    "|\\bthank\\s*you\\s*for\\s*using\\s*your\\b.{0,40}?\\bcard\\b",
  "i"
);

// Signs the money came out of a bank account rather than a card. "account"
// only when it is not a card's: issuers say "Credit Card Account". A bill
// paid through BBPS or a bill desk came from a bank too - a card cannot
// pay its own bill.
const BANK_SOURCE_RE =
  /\b(?:a\/c|acct|a\/c\s*no|savings|neft|imps|rtgs|upi|vpa|net\s*banking|netbanking|bbps|bharat\s*bill\s*pay|billdesk)\b|(?<!card\s)\baccount\b/i;

// The ways a bank says a card bill was paid. Any one is enough on a debit
// from a bank account.
const BILL_PHRASE_RE = new RegExp(
  [
    "\\bcredit\\s*card\\s*(?:bill\\s*)?(?:payment|pymt|pmt|repayment|dues?|bill)\\b",
    "\\bcc\\s*(?:bill\\s*)?(?:payment|pymt|pmt|bill|repay(?:ment)?)\\b",
    "\\b(?:ccpay|ccpymt|ccbill|bdcc)\\b",
    "\\bcard\\s*(?:bill|dues)\\b",
    "\\b(?:towards|to|for)\\s+(?:the\\s+|your\\s+|ur\\s+)?(?:[a-z&]+\\s+){0,4}?credit\\s*card\\b",
    "\\bpayment\\s+(?:made\\s+)?(?:to|towards|for)\\s+(?:your\\s+)?(?:[a-z&]+\\s+){0,4}?card\\s*(?:no\\.?\\s*)?(?:ending|[x*]|\\d{4})",
  ].join("|"),
  "i"
);

// The Bharat BillPay rail. It also pays electricity and broadband, so it
// only counts when the bill it paid is a card's.
const BBPS_RE = /\bbbps\b/i;
const CARD_WORD_RE = /\bcredit\s*card\b|\bcc\b|\bcard\s*bill\b|\bcard\s*(?:no\.?\s*)?(?:ending|[x*]+\s?\d{4})/i;

// Payees that are nothing but a card issuer's bill desk.
const ISSUER_PAYEE_RE = new RegExp(
  "\\b(?:hdfc|icici|axis|kotak|sbi|idfc(?:\\s*first)?|indusind|rbl|yes|au|hsbc|citi|sc|bob|federal)" +
    "\\s*(?:bank\\s*)?(?:cards|cc|credit\\s*ca(?:rds?)?)\\b" +
    "|\\bsbi\\s*cards?\\b|\\bsbicard\\b|\\bamex\\b|\\bamerican\\s*express\\b",
  "i"
);

const VPA_RE = /\b([\w.-]{2,64})@([\w.-]{2,20})\b/g;
// A UPI handle that is a card's bill account: "ccpay.4375xxxxxxxx2009@icici",
// "sbicard.4xxx1234@sbi", "hdfccc.0000000000001234@hdfcbank".
const CARD_HANDLE_RE =
  /^(?:(?:cc|ccpay|ccbill|creditcard|cardbill|sbicard|amex|bobcard|onecard)(?:[._-]?[\dx*]{4,19})?|[a-z]{2,12}cc[._-]?[\dx*]{4,19})$/i;

// CRED pays card bills, but also rent, school fees and other bills. Only a
// card bill when something else says so.
const CRED_RE = /\bcred\b|\bdreamplug\b/i;
// Its card bill desk, as a UPI handle and as the name banks print for it.
const CRED_BILL_HANDLE_RE = /\bcred\.?\s*club\b/i;
const CRED_OTHER_RE =
  /\b(?:rent|rentpay|maintenance|education|tuition|school|fees?|deposit|electricity|broadband|wallet|cash\s*back|cashback|rewards?)\b/i;

// The card side: the issuer saying a payment has arrived.
const PAYMENT_RECEIVED_RE = new RegExp(
  "\\bpayment\\b.{0,80}?\\b(?:received|credited|realised|realized|posted|accepted|successful(?:ly)?|processed)\\b" +
    "|\\b(?:received|credited)\\b.{0,30}?\\bpayment\\b" +
    "|\\bthank\\s*you\\s*for\\s*(?:your\\s*|the\\s*)?payment\\b",
  "i"
);
const CARD_SIDE_WORD_RE = /\bcard\b|\bcc\b/i;
// Money coming back is not a payment, however it is worded.
const NOT_A_PAYMENT_RE = /\b(?:refund(?:ed)?|reversal|reversed|cash\s*back|cashback|charge\s*back|chargeback)\b/i;
// Money landing in a bank account, rather than on a card.
const BANK_CREDITED_RE = /\bcredited\s+(?:to|in(?:to)?)\s+(?:your\s+)?(?:[a-z&]+\s+){0,3}?(?:a\/c|acct|account|savings)\b/i;

/** The message as one line, so a pattern cannot be split by a line break. */
function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Every issuer named anywhere in a piece of text. */
export function issuersIn(text: string): string[] {
  return ISSUERS.filter((issuer) => issuerRe(issuer.pattern).test(text)).map((issuer) => issuer.key);
}

/**
 * The issuers a bank-side message names as the card being paid. Narrower
 * than issuersIn, because "debited from HDFC Bank A/c towards ICICI Credit
 * Card" names both banks and only one of them is the card.
 */
function cardIssuersIn(text: string): string[] {
  const named = ISSUERS.filter((issuer) => issuer.cardOnly || cardIssuerRe(issuer.pattern).test(text))
    .filter((issuer) => issuerRe(issuer.pattern).test(text))
    .map((issuer) => issuer.key);

  // A card's bill handle sits at the issuer's own bank: "...@icici".
  for (const [, local, domain] of text.matchAll(VPA_RE)) {
    if (CARD_HANDLE_RE.test(local)) named.push(...issuersIn(`${local} ${domain}`));
  }
  return [...new Set(named)];
}

interface DigitGroup {
  digits: string;
  /// Written as a card's number, rather than an account's.
  onCard: boolean;
}

/**
 * The masked numbers a message mentions: "XX1234", "4XXX1234", "ending
 * 51004" (American Express prints five), "Card 1377", and the digits on a
 * card's bill handle. Matched against a card by their last four.
 */
function digitGroupsIn(text: string): DigitGroup[] {
  const groups: DigitGroup[] = [];
  const cardBefore = (index: number) => /\bcard\b|\bcc\b/i.test(text.slice(Math.max(0, index - 30), index));

  for (const match of text.matchAll(/(?<![a-wyz])[x*•]+\s?(\d{4,5})(?!\d)/gi)) {
    groups.push({ digits: match[1], onCard: cardBefore(match.index ?? 0) });
  }
  for (const match of text.matchAll(/\bending\s*(?:in|with)?\s*:?\s*[x*•]*\s*(\d{4,5})(?!\d)/gi)) {
    groups.push({ digits: match[1], onCard: cardBefore(match.index ?? 0) });
  }
  for (const match of text.matchAll(/\bcard\s*(?:no\.?|number|account|a\/c)?\s*:?\s*(\d{4})(?!\d)/gi)) {
    groups.push({ digits: match[1], onCard: true });
  }
  // A bank statement's narration: "CC PAYMENT ICICI 2009". Bare digits
  // soon after the words for a card, as long as they are not an amount or
  // part of a date.
  for (const match of text.matchAll(
    /\b(?:cc|card)\b.{0,25}?(?<!(?:rs\.?|inr|₹)\s?)(?<![\d/.,:-])(\d{4})(?![\d/.,:-])/gi
  )) {
    groups.push({ digits: match[1], onCard: true });
  }
  for (const [, local] of text.matchAll(VPA_RE)) {
    const tail = local.match(/(\d{4})$/);
    if (tail && CARD_HANDLE_RE.test(local)) groups.push({ digits: tail[1], onCard: true });
  }
  return groups;
}

/** The issuer keys a card answers to, from every name it goes by. */
function cardIssuers(card: BillCard): string[] {
  const names = [card.bankName, card.issuer, card.nickname, ...(card.aliases ?? []).map((alias) => alias.bankName)];
  return issuersIn(names.filter(Boolean).join(" "));
}

/**
 * Which of the user's cards a message is about, or null rather than a
 * guess. In order of how sure each is:
 *
 *   1. the card's last four digits appear in the message;
 *   2. the issuer the message names matches exactly one card;
 *   3. the user has exactly one card, and the message names nothing that
 *      contradicts it.
 *
 * A message that names a card number or an issuer which none of the cards
 * have stops there. Falling through to "the only card" would then link the
 * payment to a card it plainly was not for, which is worse than linking it
 * to none.
 */
export function pickCard(params: {
  text: string;
  side: CardBillSide;
  cards: BillCard[];
  accountId?: string | null;
}): string | null {
  const text = normalise(params.text);
  const groups = digitGroupsIn(text);
  const hasDigits = (card: BillCard) =>
    Boolean(card.last4) && groups.some((group) => group.digits.endsWith(card.last4!));

  const named = params.side === "PAYMENT" ? cardIssuersIn(text) : issuersIn(text);
  const byIssuer = (cards: BillCard[]) =>
    cards.filter((card) => cardIssuers(card).some((key) => named.includes(key)));

  const byDigits = params.cards.filter(hasDigits);
  if (byDigits.length === 1) return byDigits[0].id;
  // Two cards sharing the last four: the issuer may still tell them apart.
  if (byDigits.length > 1) {
    const narrowed = byIssuer(byDigits);
    return narrowed.length === 1 ? narrowed[0].id : null;
  }
  if (groups.some((group) => group.onCard)) return null;

  // The card side arrives on the card itself, usually.
  if (params.side === "PAYMENT_RECEIVED" && params.accountId) {
    const own = params.cards.find((card) => card.id === params.accountId);
    if (own) return own.id;
  }

  const active = params.cards.filter((card) => card.isActive !== false);
  if (named.length > 0) {
    const matching = byIssuer(active);
    return matching.length === 1 ? matching[0].id : null;
  }

  return active.length === 1 ? active[0].id : null;
}

/** Whether a debit's words say it paid a card bill. */
function isBillPayment(text: string, input: CardBillInput, cards: BillCard[]): boolean {
  if (LOAN_OR_EMI_RE.test(text)) return false;
  if (CARD_INSTRUMENT_RE.test(text)) return false;
  // Filed under a card, and nothing says a bank account paid it: this is
  // the card being charged. (Filed under a card *and* naming the account
  // debited is the parser seeing "Credit Card XX5678" in a bank's message
  // and taking the card for the account - still a payment.)
  if (input.accountType === "CARD" && !BANK_SOURCE_RE.test(text)) return false;

  const handles = [...text.matchAll(VPA_RE)].some(([, local]) => CARD_HANDLE_RE.test(local));
  const strong =
    BILL_PHRASE_RE.test(text) ||
    (BBPS_RE.test(text) && CARD_WORD_RE.test(text)) ||
    handles ||
    ISSUER_PAYEE_RE.test(text);
  if (strong) return true;

  // CRED, which needs something more than its own name.
  if (!CRED_RE.test(text) || CRED_OTHER_RE.test(text)) return false;
  if (input.confirmed || CRED_BILL_HANDLE_RE.test(text) || CARD_WORD_RE.test(text)) return true;
  const groups = digitGroupsIn(text);
  return cards.some((card) => card.last4 && groups.some((group) => group.digits.endsWith(card.last4!)));
}

/** Whether a credit's words say it is a card bill payment arriving. */
function isPaymentReceived(text: string): boolean {
  if (LOAN_OR_EMI_RE.test(text) || NOT_A_PAYMENT_RE.test(text)) return false;
  if (BANK_CREDITED_RE.test(text)) return false;
  return CARD_SIDE_WORD_RE.test(text) && PAYMENT_RECEIVED_RE.test(text);
}

/**
 * Whether a transaction is a card bill being paid, which side of it, and
 * which card - or null when it is anything else.
 */
export function recogniseCardBill(input: CardBillInput, cards: BillCard[]): CardBillMatch | null {
  const text = normalise(input.text);
  if (!text) return null;

  const side: CardBillSide | null =
    input.type === "DEBIT"
      ? isBillPayment(text, input, cards)
        ? "PAYMENT"
        : null
      : isPaymentReceived(text)
        ? "PAYMENT_RECEIVED"
        : null;
  if (!side) return null;

  return { side, cardId: pickCard({ text, side, cards, accountId: input.accountId }) };
}

// A fixed commitment named for a card's bill. Rent, a SIP or insurance is
// never one; a loan's EMI is real spending of its own.
const COMMITMENT_BILL_RE = new RegExp(
  "\\bcredit\\s*card|\\bcc\\b|\\bcard\\s*(?:bill|payment|dues?)\\b|\\bamex\\b|\\bamerican\\s*express\\b" +
    "|\\bsbi\\s*card|\\bsbicard\\b|\\b[a-z]{2,12}cc\\b|\\bcred\\b",
  "i"
);

/**
 * Whether a fixed commitment is a credit card's bill.
 *
 * Such a bill is not a fixed cost. Everything on it was counted the day it
 * was bought, so holding the bill back as "still to go out" counts the
 * month's card spending a second time - against the safe daily figure,
 * which is the number someone actually spends by. Commitments have no
 * link to a card, so the name is the evidence: "HDFC credit card bill".
 */
export function isCardBillCommitment(commitment: {
  name: string;
  merchant?: string | null;
  kind?: string | null;
}): boolean {
  if (commitment.kind && commitment.kind !== "OTHER" && commitment.kind !== "LOAN") return false;
  const text = normalise(`${commitment.name} ${commitment.merchant ?? ""}`);
  if (LOAN_OR_EMI_RE.test(text) || CRED_OTHER_RE.test(text)) return false;
  return COMMITMENT_BILL_RE.test(text);
}
