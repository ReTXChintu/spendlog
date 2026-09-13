import path from "node:path";

/**
 * Turning a statement PDF into lines of text.
 *
 * A PDF has no rows. It has fragments of text, each with a position, laid
 * out in whatever order the generator felt like emitting them. So a row is
 * reconstructed: group fragments that share a baseline, sort them left to
 * right, and join. That is enough to get a statement's table back as text,
 * which is what the line parser then reads.
 */

/**
 * pdfjs raises a PasswordException but does not export the class, so the
 * only way to recognise one is by what it says about itself. code 1 is
 * NEED_PASSWORD, code 2 is INCORRECT_PASSWORD.
 */
function passwordProblem(error: unknown): { wrongPassword: boolean } | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name !== "PasswordException") return null;
  return { wrongPassword: candidate.code === 2 };
}

export class StatementLockedError extends Error {
  /** Whether a password was supplied and rejected, as opposed to missing. */
  readonly wrongPassword: boolean;

  constructor(wrongPassword: boolean) {
    super(wrongPassword ? "The stored password did not open this statement" : "This statement is password protected");
    this.name = "StatementLockedError";
    this.wrongPassword = wrongPassword;
  }
}

// pdfjs is ESM-only from v4, and this backend compiles to CommonJS. A
// plain `await import()` would be downlevelled to require() and fail, so
// the import is built at runtime where TypeScript cannot rewrite it.
// Newer Node versions can require() an ES module directly, but the server
// this runs on is not guaranteed to be one of them.
const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>;

let pdfjs: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null;

async function loadPdfjs() {
  pdfjs ??= await importEsm("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs;
}

/**
 * Where pdfjs keeps the font data it falls back to. A directory path with
 * a trailing separator, which is what the option wants when it is not a URL.
 */
function standardFontsPath(): string {
  const packageJson = require.resolve("pdfjs-dist/package.json");
  return `${path.join(path.dirname(packageJson), "standard_fonts")}${path.sep}`;
}

/** Fragments this close together vertically are on the same line. */
const BASELINE_TOLERANCE = 2.5;

/**
 * The text of a statement, one string per visual row, in reading order.
 *
 * Throws StatementLockedError rather than returning empty when a password
 * is needed or wrong: a locked statement and an unreadable one need
 * different things done about them, and only the caller knows which to say.
 */
export async function extractStatementRows(file: Buffer, password?: string | null): Promise<string[]> {
  const { getDocument } = await loadPdfjs();

  let document;
  try {
    document = await getDocument({
      // Copied because pdfjs takes ownership of the buffer it is given and
      // leaves it detached, which breaks any retry with a second password.
      data: new Uint8Array(file),
      password: password ?? undefined,
      // Nothing is being rendered, so neither is worth the work or the noise.
      useSystemFonts: false,
      isEvalSupported: false,
      // Without this, every page of a statement set in a standard font
      // logs a warning and some glyphs come back missing.
      standardFontDataUrl: standardFontsPath(),
    }).promise;
  } catch (error) {
    const locked = passwordProblem(error);
    if (locked) throw new StatementLockedError(locked.wrongPassword);
    throw error;
  }

  try {
    const rows: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      // Keyed by baseline, so fragments emitted out of order still land on
      // the row they were printed on.
      const baselines = new Map<number, { x: number; text: string }[]>();

      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;

        const y = item.transform[5] as number;
        const existing = [...baselines.keys()].find((known) => Math.abs(known - y) <= BASELINE_TOLERANCE);
        const key = existing ?? y;

        if (!baselines.has(key)) baselines.set(key, []);
        baselines.get(key)!.push({ x: item.transform[4] as number, text: item.str });
      }

      // Top of the page downwards, since the y axis runs the other way.
      for (const [, fragments] of [...baselines.entries()].sort((a, b) => b[0] - a[0])) {
        const row = fragments
          .sort((a, b) => a.x - b.x)
          .map((fragment) => fragment.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        if (row) rows.push(row);
      }
    }

    return rows;
  } finally {
    await document.destroy();
  }
}
