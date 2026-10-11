/**
 * AMFI categories, read into something that can be grouped on.
 *
 * AMFI's files carry two generations of names side by side - "Equity
 * Scheme - Large Cap Fund" for some fund houses and "Equity Schemes -
 * Large Cap Fund" for others, "Debt Scheme - Short Duration Fund" next to
 * "Income/Debt Oriented Schemes - Short Term Fund" - so ranking a fund
 * against "its category" needs both read as one. The key here is what
 * peers are grouped by; the label is what the app shows.
 */

export const ASSET_CLASSES = ["equity", "debt", "hybrid", "other"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

export interface FundCategory {
  /// e.g. "equity:large cap", "debt:short duration". Stable across AMFI's
  /// two wordings.
  key: string;
  /// e.g. "Large Cap", "Short Duration".
  label: string;
  assetClass: AssetClass;
}

/** "Open Ended Schemes(Equity Scheme - Large Cap Fund)" or just the bracketed part, to its two halves. */
function splitCategory(raw: string): { group: string; sub: string } {
  // Only the scheme type's brackets come off: "Fund of Funds Scheme
  // (Domestic)" has brackets of its own.
  const inner = raw.match(/^\s*(?:open ended|close ended|interval)[^(]*\((.*)\)\s*$/i)?.[1] ?? raw;
  const dash = inner.indexOf(" - ");
  if (dash < 0) return { group: "", sub: inner.trim() };
  return { group: inner.slice(0, dash).trim(), sub: inner.slice(dash + 3).trim() };
}

function groupPrefix(group: string, sub: string): string {
  const lower = group.toLowerCase();
  if (/index fund/.test(lower)) return "index";
  if (/exchange traded|etf/.test(lower)) return "etf";
  if (/hybrid/.test(lower)) return "hybrid";
  if (/equity/.test(lower) || /^elss/i.test(sub)) return "equity";
  if (/debt|income/.test(lower)) return "debt";
  if (/solution|children|retirement|life cycle/.test(`${lower} ${sub.toLowerCase()}`)) return "solution";
  return "other";
}

/** Old and new wordings of the same sub-category, both to the new one. */
const SYNONYMS: [RegExp, string][] = [
  [/^elss/, "elss"],
  [/balanced advantage|dynamic asset allocation/, "balanced advantage"],
  [/^banking and psu/, "banking and psu"],
  [/^sectoral|^thematic/, "sectoral/thematic"],
  [/^ultra short term$/, "ultra short duration"],
  [/^short term$/, "short duration"],
  [/^medium to long term$/, "medium to long duration"],
  [/^medium term$/, "medium duration"],
  [/^long term$/, "long duration"],
  [/^dynamic term$/, "dynamic bond"],
  [/^floating interest rates?$/, "floater"],
  [/^equity savings/, "equity savings"],
  [/^multi asset allocation/, "multi asset allocation"],
  [/^(fund of funds.*domestic|fof domestic)/, "fof domestic"],
  [/^(fund of funds investing overseas|fof overseas)/, "fof overseas"],
];

function normaliseSub(sub: string): string {
  let name = sub
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\(etfs\)/g, "")
    .replace(/\/\s+/g, "/")
    .replace(/\s+(funds?|schemes?)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, canonical] of SYNONYMS) {
    if (pattern.test(name)) {
      name = canonical;
      break;
    }
  }
  return name;
}

const LABEL_WORDS: Record<string, string> = { psu: "PSU", elss: "ELSS", etf: "ETF", fof: "FoF" };

function titleCase(text: string): string {
  return text
    .split(" ")
    .map((word) => LABEL_WORDS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
    .replace(/\/(\w)/g, (_match, letter: string) => `/${letter.toUpperCase()}`);
}

/**
 * Equity, debt, hybrid or other, for the allocation. Hybrid is checked
 * first: "Equity Savings" and "Arbitrage" are hybrids that mention equity.
 */
export function assetClassOf(raw: string, schemeName = ""): AssetClass {
  const { group, sub } = splitCategory(raw);
  const text = `${group} ${sub}`.toLowerCase();
  if (/hybrid|arbitrage|balanced|asset allocation|equity savings/.test(text)) return "hybrid";
  if (/debt|income|gilt|liquid|money market|overnight|duration|bond|floater|floating|credit risk|banking and psu|fixed term|constant maturity/.test(text)) {
    return "debt";
  }
  if (/equity|elss|large cap|mid cap|small cap|flexi cap|multi cap|focused|value|contra|dividend yield|sectoral|thematic/.test(text)) {
    return "equity";
  }
  // "Other Scheme - Index Funds" holds Nifty trackers and target-maturity
  // bond funds alike, so for those the name has to say which.
  const name = schemeName.toLowerCase();
  if (/gilt|sdl|bond|psu|crisil|g-sec|gsec|debt|liquid|money market/.test(name)) return /index|etf/.test(text) ? "debt" : "other";
  if (/index|etf/.test(text) && /nifty|sensex|bse|equity/.test(name) && !/gold|silver/.test(name)) return "equity";
  return "other";
}

/**
 * Index funds are grouped by what they track rather than by AMFI's
 * heading, because "Other Scheme - Index Funds" holds Nifty trackers and
 * target-maturity bond funds alike - ranking one against the other says
 * nothing. Equity index funds are still one group, Nifty 50 and sector
 * indices together; that is AMFI's own grouping too.
 */
export function categoryOf(raw: string, schemeName = ""): FundCategory {
  const { group, sub } = splitCategory(raw);
  const name = normaliseSub(sub || group);
  const prefix = groupPrefix(group, sub);
  const assetClass = assetClassOf(raw, schemeName);
  if (prefix === "index" || name === "index") {
    return { key: `index:${assetClass}`, label: `Index Fund (${titleCase(assetClass)})`, assetClass };
  }
  return { key: `${prefix}:${name}`, label: titleCase(name), assetClass };
}
