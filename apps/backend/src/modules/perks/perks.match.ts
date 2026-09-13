import { PerkDoc } from "../../models";

/**
 * Deciding whether a perk applies to where you are standing.
 *
 * Kept away from the database because the awkward cases are all about text
 * - what someone types at a till against what they typed into a form three
 * weeks earlier - and those are far easier to check directly than through
 * an endpoint.
 */

/**
 * The words people put in front of a shop's name when they are telling you
 * where they are rather than searching for it.
 */
const LEAD_IN_RE =
  /^\s*(?:i(?:'?m| am)?\s+)?(?:currently\s+)?(?:at|in|inside|near|shopping\s+at|buying\s+(?:from|at)|paying\s+at)\s+/i;

/** Noise that clings to a merchant's name on a statement or a signboard. */
const TRAILING_NOISE_RE =
  /\b(?:pvt\.?|private|ltd\.?|limited|llp|inc\.?|india|in|store|stores|retail|outlet|branch)\b/gi;

/**
 * What was actually meant by what was typed.
 *
 * "I'm at Gucci" and "GUCCI INDIA PVT LTD" both have to find a perk saved
 * as "gucci", so both ends are reduced to the part that carries meaning.
 */
export function normaliseMerchantQuery(raw: string): string {
  const bare = raw
    .replace(LEAD_IN_RE, "")
    // Punctuation a card network leaves behind: "AMAZON*RETAIL", "SWIGGY.IN"
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  const trimmed = bare.replace(TRAILING_NOISE_RE, " ").replace(/\s+/g, " ").trim();

  // A shop really called "India" or "Store" would otherwise reduce to
  // nothing, and nothing matches everything.
  return trimmed || bare;
}

function words(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

/** Whether `needle` appears in `haystack` as a run of whole words. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

function isPrefix(full: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.length <= full.length && prefix.every((word, i) => full[i] === word);
}

/**
 * Whether a stored pattern and a typed query are about the same place.
 *
 * Two rules, and not a plain substring test in both directions - that was
 * the first attempt and it let a perk saved for "blue tokai coffee" answer
 * a query of "coffee", which is the wrong shop and a wasted trip.
 *
 *  - The pattern appearing in the query as whole words. A perk saved as
 *    "amazon" should answer "AMAZON PAY IN UTILITY", and one saved as
 *    "swiggy" should answer "PAYTM*SWIGGY".
 *  - The query being the start of the pattern. Someone typing "third wave"
 *    means the perk saved as "third wave coffee"; someone typing "coffee"
 *    does not, because a name is typed from its beginning.
 */
export function merchantMatches(pattern: string, query: string): boolean {
  const stored = words(normaliseMerchantQuery(pattern));
  const typed = words(normaliseMerchantQuery(query));
  if (stored.length === 0 || typed.length === 0) return false;

  return containsSequence(typed, stored) || isPrefix(stored, typed);
}

export type PerkReach = "MERCHANT" | "CATEGORY" | "ANYWHERE";

/**
 * How a perk applies here, or null if it does not.
 *
 * The three answers are ranked in the caller: a perk naming this shop beats
 * one covering the category, which beats one that applies everywhere.
 */
export function perkReach(
  perk: Pick<PerkDoc, "merchants" | "categoryId">,
  query: string,
  categoryId: string | null
): PerkReach | null {
  if (perk.merchants.length > 0) {
    return perk.merchants.some((pattern) => merchantMatches(pattern, query)) ? "MERCHANT" : null;
  }

  if (perk.categoryId) {
    return categoryId && perk.categoryId.toString() === categoryId ? "CATEGORY" : null;
  }

  // Neither a merchant nor a category: a flat "2% on everything" card.
  return "ANYWHERE";
}

/**
 * Whether a perk can be used at all today.
 *
 * Deliberately strict. There is no worse answer here than being told to
 * hand over a code that has expired or was used last week.
 */
export function perkIsLive(
  perk: Pick<PerkDoc, "isActive" | "usedAt" | "startsOn" | "expiresOn">,
  now: Date
): boolean {
  if (!perk.isActive || perk.usedAt) return false;
  if (perk.startsOn && perk.startsOn.getTime() > now.getTime()) return false;
  if (perk.expiresOn && perk.expiresOn.getTime() < now.getTime()) return false;
  return true;
}

/**
 * What a perk is worth on a given spend, where that can be worked out.
 *
 * Null when the spend is unknown - which is the normal case, since the
 * question is asked before buying anything. A percentage with no amount to
 * apply it to is still worth showing; it just cannot be ranked by rupees.
 */
export function perkValueMinor(
  perk: Pick<PerkDoc, "percent" | "flatMinor" | "maxDiscountMinor" | "minSpendMinor">,
  spendMinor: number | null
): number | null {
  if (perk.flatMinor) return perk.flatMinor;
  if (!perk.percent || spendMinor === null) return null;
  if (perk.minSpendMinor && spendMinor < perk.minSpendMinor) return 0;

  const raw = Math.round((spendMinor * perk.percent) / 100);
  return perk.maxDiscountMinor ? Math.min(raw, perk.maxDiscountMinor) : raw;
}

/**
 * Best first.
 *
 * Specificity before size: an offer naming this shop is more likely to be
 * the one that applies than a bigger number attached to a whole category,
 * and a coupon is worth more attention than a standing offer because it is
 * the one that will be gone if it is not used.
 */
export function comparePerks(
  a: { reach: PerkReach; kind: string; valueMinor: number | null; percent?: number | null },
  b: { reach: PerkReach; kind: string; valueMinor: number | null; percent?: number | null }
): number {
  const reachRank = { MERCHANT: 0, CATEGORY: 1, ANYWHERE: 2 };
  if (reachRank[a.reach] !== reachRank[b.reach]) return reachRank[a.reach] - reachRank[b.reach];

  if ((a.kind === "COUPON") !== (b.kind === "COUPON")) return a.kind === "COUPON" ? -1 : 1;

  if (a.valueMinor !== null && b.valueMinor !== null && a.valueMinor !== b.valueMinor) {
    return b.valueMinor - a.valueMinor;
  }

  return (b.percent ?? 0) - (a.percent ?? 0);
}
