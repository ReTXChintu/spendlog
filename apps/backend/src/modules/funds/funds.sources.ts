/**
 * Where mutual fund prices come from, and how their files are read.
 *
 * Two free sources, neither needing a key:
 *
 * - mfapi.in: one scheme at a time - its details and its whole NAV
 *   history in one call, plus a name search. Used for what the user holds.
 * - AMFI itself: NAVAll.txt (every scheme's latest NAV, grouped under its
 *   category) and the NAV history report for a single past day (every
 *   scheme's NAV on that day). Three of those - today, a year ago, three
 *   years ago - give every scheme's 1y and 3y return, which is what ranks
 *   a fund against its category without asking mfapi about a thousand
 *   funds.
 *
 * Plain fetch with a timeout, as with Gemini and IPO Guru. Nothing here
 * retries or caches; funds.cache.ts decides when a call is worth making.
 */

const MFAPI = "https://api.mfapi.in/mf";
const AMFI_NAV_ALL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const AMFI_HISTORY = "https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx";

const SCHEME_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 15_000;
/// AMFI's files are 1-1.5 MB and the portal isn't quick.
const FILE_TIMEOUT_MS = 90_000;

export class FundSourceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "09-Oct-2026" (AMFI) or "09-10-2026" (mfapi) to "2026-10-09"; null for anything else. */
export function toDayKey(value: string): string | null {
  const match = value.trim().match(/^(\d{1,2})-([A-Za-z]{3}|\d{1,2})-(\d{4})$/);
  if (!match) return null;
  const [, day, monthText, year] = match;
  const month = /^\d+$/.test(monthText)
    ? Number(monthText)
    : MONTHS.findIndex((name) => name.toLowerCase() === monthText.toLowerCase()) + 1;
  if (month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** "2025-10-09" to "09-Oct-2025", the way AMFI's history report wants it. */
export function toAmfiDate(day: string): string {
  const [year, month, date] = day.split("-");
  return `${date}-${MONTHS[Number(month) - 1]}-${year}`;
}

/** A NAV as AMFI or mfapi writes it. Null for "N.A.", blanks and zero. */
function toNav(value: string | undefined): number | null {
  if (!value) return null;
  const nav = Number.parseFloat(value.replace(/,/g, "").trim());
  return Number.isFinite(nav) && nav > 0 ? nav : null;
}

/**
 * Direct or not, from the plan column when the file has one and the name
 * when it doesn't. ETFs are neither direct nor regular, so this is false
 * for them and isRegularPlan is false too.
 */
export function isDirectPlan(name: string, plan = ""): boolean {
  return /direct/i.test(plan || name);
}

export function isRegularPlan(name: string, plan = ""): boolean {
  return /regular/i.test(plan || name);
}

/**
 * Growth rather than IDCW. Some fund houses still call it "Cumulative".
 * Read from the option column and the name together, because either can
 * be blank.
 */
export function isGrowthOption(name: string, option = ""): boolean {
  const text = `${option} ${name}`;
  if (/idcw|dividend|bonus/i.test(text)) return false;
  return /growth|cumulative/i.test(text);
}

/** One row of NAVAll.txt or of a day's history report. */
export interface NavFileRow {
  schemeCode: number;
  /// As the file has it. NAVAll's newer layout drops the plan and option
  /// from the name; see displayName.
  name: string;
  plan: string;
  option: string;
  nav: number;
  /// YYYY-MM-DD.
  day: string;
  /// "Open Ended Schemes", "Close Ended Schemes", "Interval Fund Schemes".
  schemeType: string;
  /// The part in brackets, e.g. "Equity Scheme - Large Cap Fund".
  category: string;
  fundHouse: string;
}

/** The name with the plan and option on it, as mfapi and the history report write it. */
export function displayName(row: Pick<NavFileRow, "name" | "plan" | "option">): string {
  if (/direct|regular/i.test(row.name) || (!row.plan && !row.option)) return row.name;
  return [row.name, row.plan, row.option].filter(Boolean).join(" - ");
}

/**
 * Reads either of AMFI's semicolon files.
 *
 * The two put their columns in different orders (NAVAll: code, ISINs,
 * name, plan, option, NAV, date; the history report: code, name, plan,
 * option, ISINs, NAV, date) and have changed before, so columns are found
 * by their header rather than by position. Category lines look like
 * "Open Ended Schemes(Equity Scheme - Large Cap Fund)", with or without
 * spaces inside the brackets; any other line without a semicolon is the
 * fund house the rows below it belong to.
 */
export function parseNavFile(text: string): NavFileRow[] {
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /scheme code/i.test(line) && line.includes(";"));
  if (headerIndex < 0) return [];

  const header = lines[headerIndex].split(";").map((cell) => cell.trim().toLowerCase());
  const column = (test: (name: string) => boolean) => header.findIndex(test);
  const codeAt = column((name) => name === "scheme code");
  const nameAt = column((name) => name === "scheme name" || name === "nav name");
  const planAt = column((name) => name === "plan");
  const optionAt = column((name) => name === "option");
  const navAt = column((name) => name === "net asset value");
  const dateAt = column((name) => name === "date");
  if (codeAt < 0 || nameAt < 0 || navAt < 0 || dateAt < 0) return [];

  const rows: NavFileRow[] = [];
  let schemeType = "";
  let category = "";
  let fundHouse = "";

  for (const raw of lines.slice(headerIndex + 1)) {
    const line = raw.trim();
    if (!line) continue;

    if (!line.includes(";")) {
      const heading = line.match(/^([^(]+?)\s*\((.*)\)$/);
      if (heading && /scheme/i.test(heading[1])) {
        schemeType = heading[1].trim();
        category = heading[2].trim();
        fundHouse = "";
      } else {
        fundHouse = line;
      }
      continue;
    }

    const cells = line.split(";");
    const schemeCode = Number(cells[codeAt]);
    const nav = toNav(cells[navAt]);
    const day = toDayKey(cells[dateAt] ?? "");
    if (!Number.isInteger(schemeCode) || schemeCode <= 0 || nav === null || !day) continue;

    rows.push({
      schemeCode,
      name: (cells[nameAt] ?? "").trim(),
      plan: planAt >= 0 ? (cells[planAt] ?? "").trim() : "",
      option: optionAt >= 0 ? (cells[optionAt] ?? "").trim() : "",
      nav,
      day,
      schemeType,
      category,
      fundHouse,
    });
  }
  return rows;
}

/** A scheme's details and NAV history, oldest first. */
export interface SchemeHistory {
  schemeCode: number;
  schemeName: string;
  fundHouse: string;
  schemeType: string;
  category: string;
  isin: string | null;
  days: string[];
  navs: number[];
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * mfapi's /mf/<code>: `{ meta: {...}, data: [{ date: "dd-mm-yyyy", nav: "88.92" }] }`,
 * newest first. An unknown code comes back as a success with an empty
 * meta and no data, which is null here.
 */
export function parseMfapiScheme(body: unknown): SchemeHistory | null {
  if (!isObject(body) || !isObject(body.meta)) return null;
  const meta = body.meta;
  const schemeCode = Number(meta.scheme_code);
  const schemeName = text(meta.scheme_name);
  if (!Number.isInteger(schemeCode) || schemeCode <= 0 || !schemeName) return null;

  // By day, so a day listed twice keeps one NAV, then oldest first.
  const byDay = new Map<string, number>();
  for (const point of Array.isArray(body.data) ? body.data : []) {
    if (!isObject(point)) continue;
    const day = toDayKey(text(point.date));
    const nav = toNav(text(point.nav));
    if (day && nav !== null && !byDay.has(day)) byDay.set(day, nav);
  }
  const days = [...byDay.keys()].sort();

  return {
    schemeCode,
    schemeName,
    fundHouse: text(meta.fund_house),
    schemeType: text(meta.scheme_type),
    category: text(meta.scheme_category),
    isin: text(meta.isin_growth) || text(meta.isin_div_reinvestment) || null,
    days,
    navs: days.map((day) => byDay.get(day)!),
  };
}

export interface SchemeMatch {
  schemeCode: number;
  schemeName: string;
}

export function parseMfapiSearch(body: unknown): SchemeMatch[] {
  if (!Array.isArray(body)) return [];
  return body
    .filter(isObject)
    .map((item) => ({ schemeCode: Number(item.schemeCode), schemeName: text(item.schemeName) }))
    .filter((item) => Number.isInteger(item.schemeCode) && item.schemeCode > 0 && item.schemeName);
}

async function get(url: string, timeoutMs: number, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new FundSourceError(`Couldn't reach ${what}. Try again in a while.`, 502);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`${what} ${response.status} on ${url}:`, detail.slice(0, 300));
    throw new FundSourceError(`${what} couldn't answer just now.`, 502);
  }
  return response;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await get(url, timeoutMs, "mfapi.in");
  try {
    return await response.json();
  } catch {
    throw new FundSourceError("mfapi.in sent something that couldn't be read.", 502);
  }
}

/** A scheme's details and full history. Null for a code mfapi doesn't know. */
export async function fetchScheme(schemeCode: number): Promise<SchemeHistory | null> {
  return parseMfapiScheme(await getJson(`${MFAPI}/${schemeCode}`, SCHEME_TIMEOUT_MS));
}

export async function searchSchemes(query: string): Promise<SchemeMatch[]> {
  return parseMfapiSearch(await getJson(`${MFAPI}/search?q=${encodeURIComponent(query)}`, SEARCH_TIMEOUT_MS));
}

/** Today's NAVAll.txt, parsed. */
export async function fetchNavAll(): Promise<NavFileRow[]> {
  const response = await get(AMFI_NAV_ALL, FILE_TIMEOUT_MS, "AMFI");
  const rows = parseNavFile(await response.text());
  if (rows.length === 0) throw new FundSourceError("AMFI sent a NAV file that couldn't be read.", 502);
  return rows;
}

/**
 * Every scheme's NAV on one past day. A weekend or holiday comes back
 * with only the handful of schemes that publish every day (overnight and
 * liquid funds), and the caller steps back a day.
 */
export async function fetchNavOn(day: string): Promise<NavFileRow[]> {
  const response = await get(`${AMFI_HISTORY}?frmdt=${toAmfiDate(day)}`, FILE_TIMEOUT_MS, "AMFI");
  return parseNavFile(await response.text());
}
