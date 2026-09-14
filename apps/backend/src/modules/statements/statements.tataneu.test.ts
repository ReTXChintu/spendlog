import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { istDayKey } from "../../time";
import { readerFor } from "./statements.issuers";
import { parseStatementRows } from "./statements.parse";

/**
 * A real Tata Neu HDFC statement, as the extractor actually produces it.
 *
 * Every previous reader here was written from a screenshot, and this one
 * read as "no transaction table could be found in this file". Three things
 * in the real text that no screenshot shows:
 *
 *   - the rupee sign extracts as a capital C
 *   - every row ends with a lowercase l, which is the Purchase Indicator dot
 *   - a description too long for its column wraps onto the lines *around*
 *     the figures, leaving a row with a date and an amount and no text
 *
 * Kept as a fixture so none of the three can quietly come back.
 */
const ROWS = [
  "Tata Neu Plus HDFC Bank Credit Card Statement",
  "HSN Code: 997113 HDFC Bank Credit Cards GSTIN: 33AAACH2702H2Z6",
  "BISWAJIT PANDA Credit Card No. 652925XXXXXX1377",
  "204/D THIRD FLOOR ABHIYAN APP NEAR Alternate Account Number 0001010430008391372",
  "Statement Date 01 Jun, 2026",
  "Billing Period 02 May, 2026 - 01 Jun, 2026",
  "PAYMENTS/CREDITS PURCHASES/DEBIT",
  "PREVIOUS STATEMENT DUES FINANCE CHARGES TOTAL AMOUNT DUE",
  "RECEIVED (Current Billing Cycle)",
  "_",
  "C 16,127.47 C 16,127.00 + C 8,168.58 + C 0.00 = C 8,169.00",
  "TOTAL CREDIT LIMIT",
  "AVAILABLE CREDIT LIMIT AVAILABLE CASH LIMIT MINIMUM DUE DUE DATE",
  "(Including Cash)",
  "C 2,018.00 21 Jun, 2026",
  "C 28,000 C 14,855 C 11,200",
  "Past Dues OVER LIMIT 3 MONTHS + 2 MONTHS 1 MONTH CURRENT DUES MINIMUM DUES",
  "(if any) C 0.00 C 0.00 C 0.00 C 0.00 C 2,018.00 C 2,018.00",
  "Domestic Transactions",
  "DATE & TIME TRANSACTION DESCRIPTION Base NeuCoins * AMOUNT PI",
  "BISWAJIT PANDA",
  "01/05/2026| 23:57 UPI-ZEPTO MARKETPLACEPRIVATE C 101.00 l",
  "IGST-VPS2712289045043-RATE 18.0 -24 (Ref#",
  "01/05/2026| 00:00 C 5.40 l",
  "09999999980501005978398)",
  "Page 1 of 4",
  "01/05/2026| 00:00 IGST-VPS2712289045044-RATE 18.0 -24 (Ref# 09999999980501005978414) C 12.96 l",
  "02/05/2026| 11:47 UPI-FATEHSINGH N RATHOD C 70.00 l",
  "15/05/2026| 23:32 CC PAYMENT 488868130131 PayZapp (Ref# 00000000000515018668621) + C 16,127.00 l",
  "16/05/2026| 12:41 INNOVATIVE RETAIL CO C 112.90 l",
  "21/05/2026| 23:26 WWWBIGBASKETCOM C 138.00 l",
  "01/06/2026| 00:00 OFFUS EMI,PRIN NB:11,00000126521249 (Ref# 09999999980601006173203) C 803.00 l",
  "01/06/2026| 00:00 OFFUS EMI,INT NBR:11,00000126521249 (Ref# 09999999980601006173211) C 20.00 l",
  "126521249 07/07/2025 C 9,119.00 12 Months 15% C 814.00 C 10.00 1 Month",
  "SGST-VPS *********** - Rate 9.0 - 33**** SGST VPS************* 9.0 33",
  "Page 4 of 4",
];

const parsed = parseStatementRows(ROWS);

describe("a real Tata Neu HDFC statement", () => {
  it("is read by the HDFC reader", () => {
    assert.equal(readerFor(ROWS).name, "HDFC");
    assert.equal(parsed.issuer, "HDFC");
  });

  it("reads every transaction on it", () => {
    assert.equal(parsed.lines.length, 9);
  });

  it("takes the C for the rupee sign it is", () => {
    const zepto = parsed.lines.find((line) => line.description.includes("ZEPTO"))!;
    assert.equal(zepto.amountMinor, 10100);
    assert.equal(zepto.description, "UPI-ZEPTO MARKETPLACEPRIVATE", "and not a C on the end of it");
  });

  it("reads past the Purchase Indicator on the end of every row", () => {
    // The lowercase l. Before it was allowed for, every single transaction
    // row on the statement failed to match on its last character.
    assert.ok(parsed.lines.every((line) => !line.description.endsWith(" l")));
  });

  it("recovers a row whose description wrapped onto the line above", () => {
    // "01/05/2026| 00:00 C 5.40 l" has no text of its own at all.
    const stranded = parsed.lines.find((line) => line.amountMinor === 540)!;
    assert.ok(stranded.description.startsWith("IGST-VPS2712289045043"));
    assert.equal(stranded.kind, "FEE", "and is still recognised for what it is");
  });

  it("reads the leading plus as the credit it marks", () => {
    const payment = parsed.lines.find((line) => line.amountMinor === 1612700)!;
    assert.equal(payment.type, "CREDIT");
    assert.equal(payment.kind, "PAYMENT", "the bill being paid, never added to the ledger");
  });

  it("finds the card by the digits after the masking", () => {
    // "Credit Card No. 652925XXXXXX1377" puts real digits before the Xs.
    assert.equal(parsed.last4, "1377");
  });

  it("reads a date written with a comma in it", () => {
    assert.equal(istDayKey(parsed.statementDate!), "2026-06-01");
  });

  it("finds the figures printed a row below their heading", () => {
    // A summary block heads one row and prints on another, with a caption
    // and an underscore in between.
    assert.equal(parsed.totalDueMinor, 816900, "the figure after the equals sign, not the first one");
    assert.equal(parsed.minimumDueMinor, 201800);
    assert.equal(istDayKey(parsed.dueDate!), "2026-06-21");
  });

  it("leaves the summary, the loan table and the GST block out", () => {
    for (const line of parsed.lines) {
      assert.ok(!line.description.includes("Months"), line.description);
      assert.ok(!line.description.includes("SGST-VPS *"), line.description);
    }
    assert.ok(!parsed.lines.some((line) => line.amountMinor === 911900), "the loan amount is not a payment");
  });
});
