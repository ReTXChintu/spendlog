import { istDayKey } from "../../time";

/**
 * Indian IPOs and their grey market premium, from IPO Guru's API.
 *
 * Plain fetch, as with Gemini: two GET endpoints and a JSON shape. The
 * free key allows one call a minute and ten a day, so nothing in here
 * retries - the cache in ipos.routes.ts decides when a call is worth
 * spending.
 *
 * Everything that comes back is reshaped into IpoRow before it goes
 * anywhere. IPO Guru sends money and counts as strings as often as
 * numbers, and null for anything it doesn't know yet, so each field is
 * read on its own and a bad one becomes null rather than failing the row.
 */

const API = "https://www.ipoguru.in/api/v2";
const TIMEOUT_MS = 20_000;

/** The free key's one-call-a-minute limit, and a second to spare. */
export const GMP_GAP_MS = 61_000;

export class IpoError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface IpoGmp {
  /// Per share, in paise. Negative when the grey market is below the issue
  /// price; 0 is a real reading, not a missing one.
  premiumMinor: number;
  percent: number | null;
  /// IPO Guru's own "2 hours ago"-style label, or its timestamp.
  updatedAtLabel: string | null;
}

export interface IpoRow {
  slug: string;
  name: string;
  type: "MAINBOARD" | "SME";
  status: "UPCOMING" | "OPEN" | "CLOSED";
  /// YYYY-MM-DD, or null when not announced yet.
  openDate: string | null;
  closeDate: string | null;
  allotmentDate: string | null;
  listingDate: string | null;
  /// As IPO Guru words it, e.g. "₹100 - ₹105".
  priceBand: string | null;
  priceMaxMinor: number | null;
  lotSize: number | null;
  minInvestmentMinor: number | null;
  gmp: IpoGmp | null;
  /// Times subscribed overall, e.g. 12.5.
  subscriptionTimes: number | null;
  webUrl: string | null;
}

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function guru(key: string, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: { "X-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new IpoError("Couldn't reach IPO Guru. Try again in a while.", 502);
  }

  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new IpoError("IPO Guru sent something that couldn't be read.", 502);
    }
  }

  const detail = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403) {
    throw new IpoError("IPO Guru turned down the API key. Check IPO_API_KEY on the server.", 502);
  }
  if (response.status === 429) {
    throw new IpoError("IPO Guru's daily limit is used up. It'll refresh later.", 429);
  }
  console.error(`IPO Guru ${response.status} on ${path}:`, detail.slice(0, 500));
  throw new IpoError("IPO Guru couldn't answer just now.", 502);
}

/**
 * The list inside a response, whatever it's wrapped in.
 *
 * The envelope isn't documented: a bare array, `{ data: [...] }`, or an
 * object of arrays all read the same. `locked` is the free tier's note
 * about fields a paid key would see, and is not a list of IPOs.
 */
export function itemsOf(body: unknown): Raw[] {
  if (Array.isArray(body)) return body.filter(isObject);
  if (!isObject(body)) return [];
  if ("data" in body) return itemsOf(body.data);
  return Object.entries(body)
    .filter(([name, value]) => name !== "locked" && Array.isArray(value))
    .flatMap(([, value]) => (value as unknown[]).filter(isObject));
}

/** Whether a response says there's a page after this one. */
export function hasMorePages(body: unknown): boolean {
  if (!isObject(body)) return false;
  const meta = isObject(body.meta) ? body.meta : isObject(body.pagination) ? body.pagination : body;
  const links = isObject(body.links) ? body.links : {};
  if (meta.next || meta.next_page || meta.next_page_url || links.next) return true;
  const page = toNumber(meta.page ?? meta.current_page);
  const last = toNumber(meta.total_pages ?? meta.last_page ?? meta.pages);
  return page !== null && last !== null && page < last;
}

/**
 * A number out of whatever IPO Guru sent: 105, "105", "₹1,05,000",
 * "12.5x". Null for null, "", "-" and anything with no digits.
 */
export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  // The first number in it, so "Rs. 105" isn't read as ".105".
  const match = value.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : null;
}

/** Rupees, as a number or a string, to whole paise. */
export function toPaise(value: unknown): number | null {
  const rupees = toNumber(value);
  return rupees === null ? null : Math.round(rupees * 100);
}

function toText(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}

/** YYYY-MM-DD, also out of a full timestamp. Anything else is null. */
function toDay(value: unknown): string | null {
  const text = toText(value);
  const day = text?.slice(0, 10) ?? null;
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function toFlag(value: unknown): boolean {
  if (typeof value === "string") return ["true", "1", "yes"].includes(value.trim().toLowerCase());
  return value === true || value === 1;
}

/** The upper end of a band like "₹100 - ₹105", for when price_max is missing. */
function bandTop(band: string | null): number | null {
  const prices = band?.match(/\d[\d,]*(\.\d+)?/g);
  return prices ? toPaise(prices[prices.length - 1]) : null;
}

/**
 * A GMP block. A missing price means no reading, not a premium of 0, so
 * it's null. The percentage is IPO Guru's own when it sends one, worked
 * out from the price when it doesn't.
 */
export function readGmp(block: unknown, priceMaxMinor: number | null): IpoGmp | null {
  if (!isObject(block)) return null;
  const premiumMinor = toPaise(block.price ?? block.gmp);
  if (premiumMinor === null) return null;
  const given = toNumber(block.percentage ?? block.percent);
  const percent =
    given ?? (priceMaxMinor ? Math.round((premiumMinor / priceMaxMinor) * 10_000) / 100 : null);
  return {
    premiumMinor,
    percent,
    updatedAtLabel: toText(block.updated_at_label) ?? toText(block.updated_at),
  };
}

function readStatus(raw: Raw, today: string, openDate: string | null, closeDate: string | null): IpoRow["status"] {
  const status = toText(raw.status)?.toUpperCase();
  if (status === "UPCOMING" || status === "OPEN" || status === "CLOSED") return status;
  // Something new from IPO Guru: go by the dates instead.
  if (!openDate || openDate > today) return "UPCOMING";
  if (closeDate && closeDate < today) return "CLOSED";
  return "OPEN";
}

/**
 * One calendar item in our own shape, or null for one that's already
 * listed (nothing left to apply for) or has no name to show.
 */
export function normaliseRow(raw: Raw, now = new Date()): IpoRow | null {
  if (toFlag(raw.is_listed)) return null;
  const name = toText(raw.display_name) ?? toText(raw.name);
  if (!name) return null;

  const priceBand = toText(raw.price_band);
  const priceMaxMinor = toPaise(raw.price_max) ?? toPaise(raw.issue_price) ?? bandTop(priceBand);
  const lotSize = toNumber(raw.lot_size);
  const openDate = toDay(raw.open_date);
  const closeDate = toDay(raw.close_date);

  return {
    slug: toText(raw.slug) ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name,
    type: /sme/i.test(toText(raw.type) ?? "") ? "SME" : "MAINBOARD",
    status: readStatus(raw, istDayKey(now), openDate, closeDate),
    openDate,
    closeDate,
    allotmentDate: toDay(raw.allotment_date),
    listingDate: toDay(raw.listing_date),
    priceBand,
    priceMaxMinor,
    lotSize: lotSize !== null && lotSize > 0 ? Math.round(lotSize) : null,
    minInvestmentMinor: toPaise(raw.min_investment),
    gmp: readGmp(raw.gmp, priceMaxMinor),
    subscriptionTimes: toNumber(raw.subscription_total),
    webUrl: toText(raw.web_url),
  };
}

/** Each /gmp item's block, by slug: either nested under `gmp` or the item itself. */
export function gmpBySlug(items: Raw[]): Map<string, Raw> {
  const blocks = new Map<string, Raw>();
  for (const item of items) {
    const slug = toText(item.slug) ?? (isObject(item.ipo) ? toText(item.ipo.slug) : null);
    if (slug) blocks.set(slug, isObject(item.gmp) ? item.gmp : item);
  }
  return blocks;
}

export function mergeGmp(rows: IpoRow[], blocks: Map<string, Raw>): IpoRow[] {
  return rows.map((row) => {
    const gmp = readGmp(blocks.get(row.slug), row.priceMaxMinor);
    return gmp ? { ...row, gmp } : row;
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchOptions {
  /// Stands in for the minute between calls, so tests don't wait it out.
  sleep?: (ms: number) => Promise<void>;
  /// Handed the calendar as soon as it's in, when GMP is still a minute
  /// away - so nobody waits on the second call to see the first.
  onCalendar?: (rows: IpoRow[]) => Promise<void>;
  now?: Date;
}

/**
 * The calendar, with GMP.
 *
 * GMP comes on the calendar items when the key's plan includes it. When it
 * doesn't, /gmp has every live IPO's in one call, which the per-minute
 * limit means waiting a minute for. If that second call fails the
 * calendar still stands on its own: dates and lot sizes are most of the
 * screen, and GMP is shown as not known yet.
 */
export async function fetchIpos(key: string, options: FetchOptions = {}): Promise<IpoRow[]> {
  const body = await guru(key, "/ipos");
  const items = itemsOf(body);
  if (!Array.isArray(body) && !isObject(body)) {
    throw new IpoError("IPO Guru sent something that couldn't be read.", 502);
  }
  // Only the first page: the free key can't afford to walk the rest, and
  // the live IPOs come first anyway.
  if (hasMorePages(body)) console.warn("IPO Guru: /ipos has more pages; only the first was read.");

  const rows = items.map((item) => normaliseRow(item, options.now)).filter((row): row is IpoRow => row !== null);
  if (items.some((item) => isObject(item.gmp)) || rows.length === 0) return rows;

  await options.onCalendar?.(rows);
  await (options.sleep ?? wait)(GMP_GAP_MS);
  try {
    return mergeGmp(rows, gmpBySlug(itemsOf(await guru(key, "/gmp"))));
  } catch (error) {
    console.error("IPO Guru: /gmp failed, keeping the calendar without it:", (error as Error).message);
    return rows;
  }
}
