/**
 * Read a statement PDF and print what the parser makes of it.
 *
 * Touches no database and writes nothing. This is how a new issuer's
 * layout gets checked before it is trusted with the ledger: run a real
 * statement through, read the table it prints, and see whether the
 * merchants, amounts and directions came out right.
 *
 *   npm run statements:preview -- path/to/statement.pdf [password]
 *   npm run statements:preview -- path/to/statement.pdf [password] --rows
 *
 * --rows prints the raw extracted text instead, which is what to look at
 * when a reader produces too few lines: it shows exactly what the reader
 * was given, and usually shows the column that moved.
 */
import fs from "node:fs";
import path from "node:path";
import { istDayKey } from "../src/time";
import { readerFor } from "../src/modules/statements/statements.issuers";
import { parseStatementRows } from "../src/modules/statements/statements.parse";
import { extractStatementRows, StatementLockedError } from "../src/modules/statements/statements.pdf";

function rupees(minor: number): string {
  return (minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const args = process.argv.slice(2);
  const showRows = args.includes("--rows");
  const [file, password] = args.filter((arg) => !arg.startsWith("--"));

  if (!file) {
    console.error("Usage: npm run statements:preview -- <statement.pdf> [password] [--rows]");
    process.exit(1);
  }

  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    console.error(`No file at ${resolved}`);
    process.exit(1);
  }

  let rows: string[];
  try {
    rows = await extractStatementRows(fs.readFileSync(resolved), password);
  } catch (error) {
    if (error instanceof StatementLockedError) {
      console.error(
        error.wrongPassword
          ? "That password did not open it."
          : "This statement is password protected. Pass the password as the second argument."
      );
      process.exit(1);
    }
    throw error;
  }

  if (showRows) {
    rows.forEach((row, index) => console.log(String(index).padStart(4), row));
    return;
  }

  const parsed = parseStatementRows(rows);

  console.log(`file        ${path.basename(resolved)}`);
  console.log(`reader      ${readerFor(rows).name}`);
  console.log(`card        ${parsed.last4 ?? "not found — assign it by hand"}`);
  console.log(`statement   ${parsed.statementDate ? istDayKey(parsed.statementDate) : "—"}`);
  console.log(`due         ${parsed.dueDate ? istDayKey(parsed.dueDate) : "—"}`);
  console.log(`total due   ${parsed.totalDueMinor === null ? "—" : rupees(parsed.totalDueMinor)}`);
  console.log(`rows read   ${rows.length}`);
  console.log(`lines found ${parsed.lines.length}`);
  console.log("");

  if (parsed.lines.length === 0) {
    console.log("Nothing was read as a transaction. Run again with --rows to see the text.");
    return;
  }

  const width = Math.min(48, Math.max(...parsed.lines.map((line) => line.description.length)));
  for (const line of parsed.lines) {
    console.log(
      [
        istDayKey(line.date),
        line.description.slice(0, width).padEnd(width),
        rupees(line.amountMinor).padStart(12),
        line.type === "CREDIT" ? "CR" : "  ",
        line.kind.padEnd(8),
      ].join("  ")
    );
  }

  // The two figures that decide what reaches the ledger, so they are worth
  // reading before letting this near it.
  const counted = parsed.lines.filter((line) => line.kind === "SPEND" || line.kind === "FEE");
  const skipped = parsed.lines.filter((line) => line.kind === "PAYMENT" || line.kind === "NOISE");

  console.log("");
  console.log(`spend on this statement   ${rupees(counted.reduce((sum, line) => sum + line.amountMinor, 0))}`);
  console.log(`left alone (payments etc) ${skipped.length} lines`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
