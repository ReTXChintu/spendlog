/**
 * Whether a payment reads like travel: a ticket, a stay, a cab.
 *
 * Only a hint, used to put the likely ones first when someone is picking
 * the payments they made before a trip started - the train booked a month
 * out, the hotel's advance. Nothing is filed on its strength alone, so a
 * near miss costs a scroll, not a wrong total. The lists live here, in one
 * place, so a new airline or booking site is a one-line change.
 */

/** Category names that mean travel on their own, matched as whole words. */
const TRAVEL_CATEGORY_WORDS = [
  "travel",
  "transport",
  "hotel",
  "hotels",
  "flight",
  "flights",
  "stay",
  "stays",
  "holiday",
  "vacation",
];

/**
 * Who sells tickets, rooms and rides, as they show up in a merchant name.
 * Whole words, so "ola" finds Ola and not Coca-Cola.
 */
const TRAVEL_MERCHANT_WORDS = [
  // Airlines
  "indigo",
  "air india",
  "air india express",
  "vistara",
  "spicejet",
  "akasa",
  "akasa air",
  "airasia",
  "go first",
  "alliance air",
  "emirates",
  "qatar airways",
  "etihad",
  "lufthansa",
  "singapore airlines",
  "airline",
  "airlines",
  "airways",
  "airport",
  "flight",
  "flights",
  // Trains and buses
  "irctc",
  "railway",
  "railways",
  "redbus",
  "abhibus",
  "zingbus",
  "intrcity",
  "ksrtc",
  "msrtc",
  // Booking sites
  "makemytrip",
  "make my trip",
  "mmt",
  "goibibo",
  "cleartrip",
  "yatra",
  "ixigo",
  "easemytrip",
  "booking.com",
  "agoda",
  "expedia",
  "trivago",
  "airbnb",
  "thomas cook",
  // Stays
  "oyo",
  "treebo",
  "fabhotels",
  "zostel",
  "hotel",
  "hotels",
  "resort",
  "resorts",
  "hostel",
  "homestay",
  "taj",
  "marriott",
  "hyatt",
  "ihcl",
  // Rides and rentals
  "uber",
  "ola",
  "rapido",
  "blusmart",
  "zoomcar",
  "revv",
  "drivezy",
  "savaari",
  "meru",
];

/** Escapes regex metacharacters, so "booking.com" means a literal dot. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One case-insensitive pattern for a list of whole words or phrases. */
function wordsPattern(words: string[]): RegExp {
  // Longest first, so "air india express" is tried before "air india".
  const alternatives = [...words].sort((a, b) => b.length - a.length).map(escapeRegex);
  return new RegExp(`(?:^|[^a-z0-9])(?:${alternatives.join("|")})(?![a-z0-9])`, "i");
}

const TRAVEL_CATEGORY = wordsPattern(TRAVEL_CATEGORY_WORDS);
const TRAVEL_MERCHANT = wordsPattern(TRAVEL_MERCHANT_WORDS);

export function isLikelyTravel(row: { merchant?: string | null; categoryName?: string | null }): boolean {
  if (row.categoryName && TRAVEL_CATEGORY.test(row.categoryName)) return true;
  return Boolean(row.merchant && TRAVEL_MERCHANT.test(row.merchant));
}
