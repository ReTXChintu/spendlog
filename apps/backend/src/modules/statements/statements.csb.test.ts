import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { istDayKey } from "../../time";
import { parseStatementRows } from "./statements.parse";

/**
 * A real Jupiter-on-CSB statement, as the extractor actually produces it.
 *
 * It read as 102 transactions worth Rs 80,309 when the table holds 90
 * worth Rs 36,737, and every merchant on the first seven pages came
 * through with an hour glued to the front of its name. Four separate
 * faults, all of which this fixture holds down:
 *
 *   - "17 JUL 2026 - 16 AUG 2026" is the running header of all eleven
 *     pages, and the year of its closing date was read as an amount, so
 *     the ledger gained eleven charges of Rs 2,026
 *   - "17/07/2026 Rs. 21,286.25" is the previous balance printed above
 *     the table, and arrived as a transaction to a merchant named "Rs"
 *   - the timestamp wraps, leaving a dangling "08:" that the fallback
 *     kept as part of the description
 *   - and it wraps completely from 01 Aug, leaving no time on the row at
 *     all, which the Jupiter reader had not allowed for
 */
const ROWS: string[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "csb-statement.json"), "utf8")
);

const parsed = parseStatementRows(ROWS);

describe("a real Jupiter on CSB statement", () => {
  it("reads every transaction on it and nothing else", () => {
    assert.equal(parsed.lines.length, 90);
  });

  it("does not take the running page header for a transaction", () => {
    // "17 JUL 2026 - 16 AUG 2026", eleven times, at Rs 2,026 each.
    assert.equal(
      parsed.lines.filter((line) => line.amountMinor === 202600).length,
      0,
      "a billing period is not a purchase"
    );
    assert.ok(parsed.lines.every((line) => !line.description.includes("AUG")));
  });

  it("does not take the balance above the table for a transaction", () => {
    // "17/07/2026 Rs. 21,286.25" - a date, a currency mark and a figure,
    // with nobody it was paid to.
    assert.ok(parsed.lines.every((line) => !/^(?:Rs|INR)$/i.test(line.description)));
  });

  it("leaves the wrapped timestamp out of the merchant's name", () => {
    // The hour keeps its colon when the minutes wrap onto the next line,
    // and seventy rows on this statement are printed that way.
    assert.ok(
      parsed.lines.every((line) => !/^\d{1,2}:/.test(line.description)),
      parsed.lines.find((line) => /^\d{1,2}:/.test(line.description))?.description
    );

    const mukhwas = parsed.lines.filter((line) => line.description === "MUKHWAS PAN PARLOUR");
    assert.equal(mukhwas.length, 15, "one merchant, not one per hour of the day");
  });

  it("reads the rows printed with no time on them at all", () => {
    // From 01 Aug the timestamp wraps completely. Nineteen transactions
    // are on the far side of that change.
    const august = parsed.lines.filter((line) => istDayKey(line.date) >= "2026-08-01");
    assert.equal(august.length, 19);

    const swiggy = august.find((line) => istDayKey(line.date) === "2026-08-01")!;
    assert.equal(swiggy.description, "SWIGGY");
    assert.equal(swiggy.amountMinor, 36400);
  });

  it("adds up to what the table adds up to", () => {
    const total = parsed.lines.reduce((sum, line) => sum + line.amountMinor, 0);
    assert.equal(total, 3673725);
  });

  it("knows the bill being paid from the things bought", () => {
    const repayment = parsed.lines.find((line) => line.amountMinor === 2128625)!;
    assert.equal(repayment.kind, "PAYMENT");
    assert.equal(repayment.type, "CREDIT");

    // Four refunds, none of them spending.
    assert.equal(parsed.lines.filter((line) => line.kind === "REVERSAL").length, 4);
  });

  it("finds the card by the digits on the section heading", () => {
    assert.equal(parsed.last4, "6623");
  });
});
