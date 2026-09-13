import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { istDayKey } from "../../time";
import { classifyStatementLine, countsAsStatementSpend, isLedgerWorthy } from "./statements.classify";
import { extractStatementRows, StatementLockedError } from "./statements.pdf";
import { parseStatementDate, parseStatementRow, parseStatementRows } from "./statements.parse";

const FIXTURES = path.join(__dirname, "fixtures");
const plain = () => fs.readFileSync(path.join(FIXTURES, "statement.pdf"));
const locked = () => fs.readFileSync(path.join(FIXTURES, "statement-locked.pdf"));

describe("parseStatementDate", () => {
  it("reads the Indian day-first formats a statement prints", () => {
    for (const raw of ["02/09/2026", "02-09-2026", "02.09.26", "02 Sep 2026", "2-September-2026"]) {
      assert.equal(istDayKey(parseStatementDate(raw)!), "2026-09-02", raw);
    }
  });

  it("puts the date at midnight IST, not midnight UTC", () => {
    // The difference is what decides which day the ledger files it under.
    assert.equal(parseStatementDate("02/09/2026")!.toISOString(), "2026-09-01T18:30:00.000Z");
  });

  it("reads a bare day and month against the statement's year", () => {
    assert.equal(istDayKey(parseStatementDate("02 Sep", 2026)!), "2026-09-02");
    assert.equal(parseStatementDate("02 Sep"), null);
  });

  it("rejects a day that does not exist rather than rolling it forward", () => {
    assert.equal(parseStatementDate("31/02/2026"), null);
    assert.equal(parseStatementDate("31/04/2026"), null);
    assert.equal(istDayKey(parseStatementDate("29/02/2024")!), "2024-02-29");
  });
});

describe("parseStatementRow", () => {
  it("reads a date, a description and an amount", () => {
    const line = parseStatementRow("18/08/2026 AMZNIN MUMBAI IN 1,240.00")!;
    assert.equal(line.description, "AMZNIN MUMBAI IN");
    assert.equal(line.amountMinor, 124000);
    assert.equal(line.type, "DEBIT");
    assert.equal(line.kind, "SPEND");
  });

  it("treats a Cr marker as the credit it is", () => {
    const line = parseStatementRow("22/08/2026 PAYMENT RECEIVED - THANK YOU 25,000.00 Cr")!;
    assert.equal(line.type, "CREDIT");
    assert.equal(line.kind, "PAYMENT");
  });

  it("keeps digits inside a merchant's name out of the amount", () => {
    // The amount is taken from the end of the row for exactly this case.
    const line = parseStatementRow("05/09/2026 SHELL 1234 BANGALORE 890.10")!;
    assert.equal(line.description, "SHELL 1234 BANGALORE");
    assert.equal(line.amountMinor, 89010);
  });

  it("drops a second date column without eating the merchant", () => {
    const line = parseStatementRow("18/08/2026 20/08/2026 AMZNIN MUMBAI IN 1,240.00")!;
    assert.equal(line.description, "AMZNIN MUMBAI IN");
  });

  it("reads Indian digit grouping", () => {
    assert.equal(parseStatementRow("01/09/2026 CAR INSURANCE 1,24,000.50")!.amountMinor, 12400050);
  });

  it("ignores anything that is not a dated row ending in an amount", () => {
    for (const row of [
      "Transaction Details",
      "Earn 5X reward points on 10 categories",
      "Card No: 4854 XXXX XXXX 1377",
      "18/08/2026",
    ]) {
      assert.equal(parseStatementRow(row), null, row);
    }
  });
});

describe("classifyStatementLine", () => {
  it("never lets a bill payment become a transaction", () => {
    // The one that would do real damage: a credit invented on the card
    // against the debit already recorded on the account it was paid from.
    for (const description of [
      "PAYMENT RECEIVED - THANK YOU",
      "PAYMENT VIA NEFT",
      "AUTOPAY RECEIVED",
      "Thank You For Your Payment",
    ]) {
      assert.equal(classifyStatementLine(description, "CREDIT"), "PAYMENT", description);
    }
    assert.equal(isLedgerWorthy("PAYMENT"), false);
  });

  it("treats an unexplained credit as a payment rather than a refund", () => {
    // Leaving it alone is the recoverable mistake; adding it is not.
    assert.equal(classifyStatementLine("SOME UNREADABLE CREDIT", "CREDIT"), "PAYMENT");
  });

  it("picks out the charges no message ever announces", () => {
    for (const description of [
      "FINANCE CHARGES",
      "IGST-VPS@18%",
      "ANNUAL FEE",
      "LATE PAYMENT CHARGE",
      "CASH ADVANCE FEE",
    ]) {
      assert.equal(classifyStatementLine(description, "DEBIT"), "FEE", description);
    }
    assert.equal(isLedgerWorthy("FEE"), true);
  });

  it("recognises a reversal as money coming back", () => {
    assert.equal(classifyStatementLine("REVERSAL AMZNIN MUMBAI IN", "CREDIT"), "REVERSAL");
    assert.equal(isLedgerWorthy("REVERSAL"), true);
    // Excluded from the spend figure so it is compared like with like.
    assert.equal(countsAsStatementSpend("REVERSAL"), false);
  });

  it("drops the summary rows that carry a date and an amount", () => {
    for (const description of ["Opening Balance", "Total Amount Due", "Reward Points Earned"]) {
      assert.equal(classifyStatementLine(description, "DEBIT"), "NOISE", description);
    }
    assert.equal(isLedgerWorthy("NOISE"), false);
  });
});

describe("extractStatementRows", () => {
  it("rebuilds the table from positioned text", async () => {
    const rows = await extractStatementRows(plain());
    assert.ok(rows.includes("18/08/2026 AMZNIN MUMBAI IN 1,240.00"));
    assert.ok(rows.includes("Card No: 4854 XXXX XXXX 1377"));
  });

  it("says a statement is locked rather than reading nothing", async () => {
    await assert.rejects(
      () => extractStatementRows(locked()),
      (error: unknown) => error instanceof StatementLockedError && error.wrongPassword === false
    );
  });

  it("tells a wrong password apart from a missing one", async () => {
    // Different problems with different fixes, so the UI has to know which.
    await assert.rejects(
      () => extractStatementRows(locked(), "NOTTHEONE"),
      (error: unknown) => error instanceof StatementLockedError && error.wrongPassword === true
    );
  });

  it("opens a locked statement with the right password", async () => {
    const rows = await extractStatementRows(locked(), "OPENME");
    assert.ok(rows.includes("18/08/2026 AMZNIN MUMBAI IN 1,240.00"));
  });
});

describe("parseStatementRows", () => {
  it("reads a whole statement end to end", async () => {
    const parsed = parseStatementRows(await extractStatementRows(plain()));

    assert.equal(parsed.last4, "1377");
    assert.equal(istDayKey(parsed.statementDate!), "2026-09-17");
    assert.equal(istDayKey(parsed.dueDate!), "2026-10-07");
    assert.equal(parsed.totalDueMinor, 4785025);
    assert.equal(parsed.minimumDueMinor, 239300);

    const kinds = parsed.lines.map((line) => `${line.kind}:${line.description}`);
    assert.deepEqual(kinds, [
      "SPEND:AMZNIN MUMBAI IN",
      "SPEND:SWIGGY BANGALORE IN",
      "PAYMENT:PAYMENT RECEIVED - THANK YOU",
      "SPEND:IRCTC NEW DELHI IN",
      "FEE:FINANCE CHARGES",
      "FEE:IGST-VPS@18%",
      "SPEND:BIGBASKET BANGALORE",
      "REVERSAL:REVERSAL AMZNIN MUMBAI IN",
    ]);
  });

  it("covers the period the lines span", async () => {
    const parsed = parseStatementRows(await extractStatementRows(plain()));
    assert.equal(istDayKey(parsed.periodStart!), "2026-08-18");
    assert.equal(istDayKey(parsed.periodEnd!), "2026-09-12");
  });
});
