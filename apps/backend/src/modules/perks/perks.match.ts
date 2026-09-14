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

/**
 * How far apart two words are, counting a swapped pair as one mistake.
 *
 * Damerau rather than plain Levenshtein because the mistakes that matter
 * here are typing and autocorrect, and both produce transpositions:
 * "wrogn" and "wrong" are one swap apart and two substitutions apart, and
 * only the first number is small enough to be worth allowing.
 */
function editDistance(a: string, b: string): number {
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);

      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }

  return rows[a.length][b.length];
}

/** Below this, a word is too short for a mistake to be told from a different word. */
const MIN_PREFIX = 4;
const MIN_FUZZY = 5;

/**
 * Whether two words mean the same thing, allowing for the two ways they
 * routinely differ.
 *
 * A plural, which is how "flight" misses a coupon saved as "flights" - the
 * prefix test covers that in both directions, since either side may be the
 * one carrying the s.
 *
 * A typo, including the one autocorrect makes: typing a brand it does not
 * know turns "wrogn" into "wrong". Allowed only from five letters up,
 * because at four a single edit is as likely to be a different word -
 * "zara" and "tara" are one apart and are not the same shop.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= MIN_PREFIX && longer.startsWith(shorter)) return true;

  if (shorter.length < MIN_FUZZY) return false;
  const allowed = longer.length >= 8 ? 2 : 1;
  return editDistance(a, b) <= allowed;
}

/** Whether `needle` appears in `haystack` as a run of consecutive words. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((word, offset) => sameWord(haystack[start + offset], word))) return true;
  }
  return false;
}

function isPrefix(full: string[], prefix: string[]): boolean {
  return prefix.length > 0 && prefix.length <= full.length && prefix.every((word, i) => sameWord(full[i], word));
}

/**
 * How well a stored pattern answers what was typed, or null for not at all.
 *
 * Three strengths, because they are not equally trustworthy and the caller
 * ranks by them:
 *
 *  3. The whole pattern appears in the query - "amazon" against "AMAZON PAY
 *     IN UTILITY", or the query being exactly the pattern.
 *  2. The query is the start of the pattern - someone typing "third wave"
 *     for "third wave coffee".
 *  1. Some word of the pattern appears somewhere in the query.
 *
 * That last one used to be refused, on the reasoning that a name is typed
 * from its beginning and so "coffee" should not find "blue tokai coffee".
 * The reasoning does not survive contact with a coupon saved as "MakeMyTrip
 * flights" and someone typing "flight" - which is the same shape and
 * obviously wants to match. So it is allowed and ranked last instead: the
 * answer is a list showing where each perk works, so a wrong guess costs a
 * glance rather than a trip.
 *
 * Short words are still refused there, or "pay" and "card" would answer
 * every question asked.
 */
export function merchantMatchStrength(pattern: string, query: string): number | null {
  const stored = words(normaliseMerchantQuery(pattern));
  const typed = words(normaliseMerchantQuery(query));
  if (stored.length === 0 || typed.length === 0) return null;

  if (containsSequence(typed, stored)) return 3;
  if (isPrefix(stored, typed)) return 2;

  const loose = stored.some(
    (storedWord) =>
      storedWord.length >= MIN_PREFIX && typed.some((typedWord) => sameWord(storedWord, typedWord))
  );
  return loose ? 1 : null;
}

export function merchantMatches(pattern: string, query: string): boolean {
  return merchantMatchStrength(pattern, query) !== null;
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
  a: { reach: PerkReach; strength?: number; kind: string; valueMinor: number | null; percent?: number | null },
  b: { reach: PerkReach; strength?: number; kind: string; valueMinor: number | null; percent?: number | null }
): number {
  const reachRank = { MERCHANT: 0, CATEGORY: 1, ANYWHERE: 2 };
  if (reachRank[a.reach] !== reachRank[b.reach]) return reachRank[a.reach] - reachRank[b.reach];

  // A pattern the query matched squarely before one it only brushed, so a
  // loose word match never outranks the shop actually named.
  if ((a.strength ?? 0) !== (b.strength ?? 0)) return (b.strength ?? 0) - (a.strength ?? 0);

  if ((a.kind === "COUPON") !== (b.kind === "COUPON")) return a.kind === "COUPON" ? -1 : 1;

  if (a.valueMinor !== null && b.valueMinor !== null && a.valueMinor !== b.valueMinor) {
    return b.valueMinor - a.valueMinor;
  }

  return (b.percent ?? 0) - (a.percent ?? 0);
}

/** The best a perk's patterns manage against the query, for ranking. */
export function bestMerchantStrength(merchants: string[], query: string): number {
  return merchants.reduce((best, pattern) => Math.max(best, merchantMatchStrength(pattern, query) ?? 0), 0);
}
