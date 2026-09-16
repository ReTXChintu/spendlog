import { Types } from "mongoose";
import { Account } from "../../models";
import { PerkKind } from "../../types";
import { VisionProvider, VisionUnavailableError } from "./perks.vision";

/**
 * Reading a coupon off a picture.
 *
 * A perk is twelve fields, and the hard half is not reading the text - it
 * is deciding that "20% off up to ₹150 on orders above ₹499" means a
 * percentage of 20, a cap of 15000 and a floor of 49900. That is the part
 * a model is genuinely good at and a regex is genuinely bad at, which is
 * why this asks for structure rather than for words.
 *
 * Nothing here saves anything. It returns a draft for somebody to look at
 * and correct, and that is deliberate: a model that reads "20% up to ₹150"
 * as "₹150 off" is wrong in a way nobody would notice until they were at a
 * till with the wrong card out. Checking six fields beats typing twelve,
 * and it keeps a mistake in front of a person rather than inside a total.
 */

export interface PerkDraft {
  kind: PerkKind;
  title: string;
  merchants: string[];
  percent: number | null;
  flatMinor: number | null;
  maxDiscountMinor: number | null;
  minSpendMinor: number | null;
  startsOn: string | null;
  expiresOn: string | null;
  code: string | null;
  notes: string | null;
  /// The card it names, matched to one of yours where the name is close
  /// enough. Null when it named none, or named one you do not have.
  accountId: string | null;
  /// What it said the card was, kept even when nothing matched so the
  /// screen can say "it says HDFC Regalia, which you have not added".
  cardNamed: string | null;
  /// Fields it could not find. Shown so the form can point at them rather
  /// than leaving somebody to spot the blanks.
  missing: string[];
}

/**
 * Asked for strictly, because the whole value of this is structure.
 *
 * Written as rules rather than prose: a smaller model follows a numbered
 * list far better than a paragraph, and every rule here exists because of
 * a way coupons are actually written in India.
 */
const PROMPT = `You are reading a picture of a discount coupon or a credit card offer.

Reply with ONE JSON object and nothing else. No explanation, no markdown fence.

{
  "kind": "COUPON" or "CARD_OFFER",
  "title": short name, e.g. "20% off at Zomato",
  "merchants": array of shop or brand names it applies to, lowercase, [] if any,
  "percent": the percentage off as a number, or null,
  "flatAmount": a flat rupee amount off as a number, or null,
  "maxDiscount": the cap in rupees on a percentage, or null,
  "minSpend": the minimum order in rupees, or null,
  "startsOn": "YYYY-MM-DD" or null,
  "expiresOn": "YYYY-MM-DD" or null,
  "code": the coupon code exactly as printed, or null,
  "card": the credit or debit card it requires, or null,
  "notes": anything else that limits it, one short sentence, or null
}

Rules:
1. "CARD_OFFER" only when it needs a particular bank card. Otherwise "COUPON".
2. Amounts in rupees as plain numbers. "₹1,500" is 1500. Never write the symbol.
3. "20% off up to ₹150" means percent 20 and maxDiscount 150. Both.
4. "Flat ₹200 off" means flatAmount 200 and percent null.
5. "on orders above ₹499" or "min. order ₹499" means minSpend 499.
6. Dates in Indian order: 04/08/26 is 4 August 2026. Assume 20xx.
7. "Valid till 31 Dec" with no year means the next 31 December still ahead.
8. Use null for anything not printed. Do not guess.`;

/** A rupee figure the model wrote as a number, in paise. */
function toMinor(value: unknown): number | null {
  const amount = typeof value === "string" ? Number(value.replace(/[^\d.]/g, "")) : value;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;

  return Math.round(amount * 100);
}

/** A date the model wrote, if it really is one. */
function toIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const parsed = new Date(`${value}T00:00:00.000+05:30`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

/**
 * The JSON out of whatever the model actually said.
 *
 * A small model will sometimes wrap it in a markdown fence or put a
 * sentence in front of it however firmly it was asked not to, and throwing
 * the whole answer away over a fence would be a waste of forty seconds.
 * So: the first balanced object in the text.
 */
export function parseModelJson(said: string): Record<string, unknown> | null {
  const start = said.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < said.length; index += 1) {
    const character = said[index];

    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') inString = !inString;
    else if (!inString && character === "{") depth += 1;
    else if (!inString && character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(said.slice(start, index + 1)) as unknown;
          return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

/** Which of yours the card it named is, if any. */
async function matchCard(userId: Types.ObjectId, named: string | null): Promise<string | null> {
  if (!named) return null;

  const accounts = await Account.find({
    userId,
    accountType: { $in: ["CARD", "DEBIT"] },
    isActive: true,
  });

  // Every word of the name has to appear somewhere in the account's, so
  // "HDFC Regalia" does not match an HDFC card that is not a Regalia.
  // Loose enough for "Amazon Pay ICICI" against "ICICI Amazon Pay", strict
  // enough not to file an offer against the wrong card - which is the
  // mistake that would send somebody to a till with the wrong one.
  const words = named.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  if (words.length === 0) return null;

  const match = accounts.find((account) => {
    const haystack = `${account.nickname ?? ""} ${account.bankName} ${account.issuer ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });

  return match?._id.toString() ?? null;
}

/**
 * One picture, one draft.
 *
 * Throws only when the model could not be reached or could not be
 * understood. Anything it simply failed to find comes back as null with
 * the field named in `missing`, because a coupon with no code on it is a
 * normal coupon rather than a failure.
 */
export async function extractPerk(params: {
  userId: Types.ObjectId;
  image: Buffer;
  mimeType: string;
  provider: VisionProvider;
}): Promise<PerkDraft> {
  const said = await params.provider.describe({
    image: params.image,
    mimeType: params.mimeType,
    prompt: PROMPT,
  });

  const raw = parseModelJson(said);
  if (!raw) {
    throw new VisionUnavailableError(
      `${params.provider.name} did not answer with JSON. What it said: ${said.slice(0, 200)}`
    );
  }

  const percent =
    typeof raw.percent === "number" && raw.percent > 0 && raw.percent <= 100 ? raw.percent : null;

  const merchants = Array.isArray(raw.merchants)
    ? raw.merchants
        .filter((one): one is string => typeof one === "string")
        .map((one) => one.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20)
    : [];

  const cardNamed = typeof raw.card === "string" && raw.card.trim() ? raw.card.trim() : null;

  const draft: PerkDraft = {
    // A card offer that names no card is a coupon, whatever it called
    // itself - the distinction is the card, and this is the one place it
    // can be checked against what was actually read.
    kind: raw.kind === "CARD_OFFER" && cardNamed ? "CARD_OFFER" : "COUPON",
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 120) : "",
    merchants,
    percent,
    // Only one of the two. A model that fills both has read a percentage
    // and its cap as two separate discounts, which is the most common way
    // this goes wrong.
    flatMinor: percent === null ? toMinor(raw.flatAmount) : null,
    maxDiscountMinor: percent === null ? null : toMinor(raw.maxDiscount),
    minSpendMinor: toMinor(raw.minSpend),
    startsOn: toIsoDate(raw.startsOn),
    expiresOn: toIsoDate(raw.expiresOn),
    code: typeof raw.code === "string" && raw.code.trim() ? raw.code.trim().slice(0, 60) : null,
    notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim().slice(0, 500) : null,
    accountId: await matchCard(params.userId, cardNamed),
    cardNamed,
    missing: [],
  };

  // Named rather than left blank. The two that matter are the ones that
  // decide whether a perk is worth anything: what it takes off, and when
  // it stops working.
  if (!draft.title) draft.missing.push("title");
  if (draft.percent === null && draft.flatMinor === null) draft.missing.push("discount");
  if (!draft.expiresOn) draft.missing.push("expiresOn");
  if (draft.kind === "COUPON" && !draft.code) draft.missing.push("code");

  return draft;
}
