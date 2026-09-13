import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { istDayKey } from "../../time";
import { readerFor, readers } from "./statements.issuers";
import { parseStatementRow, parseStatementRows } from "./statements.parse";

/**
 * Rows as each issuer's statement lays them out, taken from real ones.
 *
 * The text is what the extractor produces from a table: the cells of a row
 * joined left to right with single spaces. So an empty column disappears,
 * and a column with something in it becomes another word between the
 * description and the amount - which is exactly what defeats a reader
 * written for a different bank.
 */

describe("ICICI (Amazon Pay)", () => {
  const rows = [
    "Date SerNo. Transaction Details Reward Points Intl.# amount Amount (in₹)",
    "4315XXXXXXXX2009",
    "12/08/2026 13967833420 AMAZON PAY IN UTILITY BANGALORE IN 95 4,750.00",
    "13/08/2026 13973995748 PVR INOX LIMITED AHMEDABAD IN 5 520.00",
    "13/08/2026 13974203817 SHREE JAHU PETROLEUM P AHMEDABAD IN 0 431.97",
    "14/08/2026 13975063452 Fuel Surcharges 0 4.27 CR",
    "15/08/2026 13980001263 BBPS Payment received 0 29,693.53 CR",
    "18/08/2026 14006967238 AMAZON PAY IN E COMMERC BANGALORE -32 653.90 CR",
    "IN",
    "18/08/2026 14007245945 AMAZON PAY IN E COMMERC BANGALORE IN 92 1,854.20",
  ];

  it("is recognised by its own columns", () => {
    assert.equal(readerFor(rows).name, "ICICI");
  });

  it("keeps the serial number and the reward points out of the merchant", () => {
    // The two columns that would otherwise be glued onto the name: an
    // eleven-digit serial in front, a points figure behind.
    const line = parseStatementRow(rows[2], readers.icici)!;
    assert.equal(line.description, "AMAZON PAY IN UTILITY BANGALORE IN");
    assert.equal(line.amountMinor, 475000);
    assert.equal(line.type, "DEBIT");
  });

  it("does not mistake the points for the amount", () => {
    assert.equal(parseStatementRow(rows[3], readers.icici)!.amountMinor, 52000);
    assert.equal(parseStatementRow(rows[4], readers.icici)!.amountMinor, 43197);
  });

  it("reads the trailing CR as a credit", () => {
    const payment = parseStatementRow(rows[6], readers.icici)!;
    assert.equal(payment.type, "CREDIT");
    assert.equal(payment.kind, "PAYMENT", "the bill being paid, never added");
  });

  it("treats a surcharge given back as money returning", () => {
    const waiver = parseStatementRow(rows[5], readers.icici)!;
    assert.equal(waiver.type, "CREDIT");
    assert.equal(waiver.kind, "REVERSAL");
    assert.equal(waiver.amountMinor, 427);
  });

  it("copes with negative reward points on a refund", () => {
    const refund = parseStatementRow(rows[7], readers.icici)!;
    assert.equal(refund.amountMinor, 65390);
    assert.equal(refund.type, "CREDIT");
  });

  it("joins a merchant name back together when it wrapped", () => {
    const parsed = parseStatementRows(rows);
    const wrapped = parsed.lines.find((line) => line.amountMinor === 65390)!;
    assert.equal(wrapped.description, "AMAZON PAY IN E COMMERC BANGALORE IN");
  });

  it("finds the card from the masked number in the header", () => {
    assert.equal(parseStatementRows(rows).last4, "2009");
  });

  it("reads every transaction row and nothing else", () => {
    const parsed = parseStatementRows(rows);
    assert.equal(parsed.issuer, "ICICI");
    assert.equal(parsed.lines.length, 7);
    assert.equal(istDayKey(parsed.lines[0].date), "2026-08-12");
  });
});

describe("HDFC (IOCL and Tata Neu)", () => {
  const iocl = [
    "Domestic Transactions",
    "DATE & TIME TRANSACTION DESCRIPTION AMOUNT PI",
    "BISWAJIT PANDA [CKYC ID : 10006640951746 ]",
    "15/08/2026| 11:49 BPPY CC PAYMENT DP016227114912uTWx8 (Ref# ST262280083000010107605) + ₹ 405.00",
  ];

  const tataNeu = [
    "DATE & TIME TRANSACTION DESCRIPTION Base NeuCoins* AMOUNT PI",
    "03/08/2026| 10:30 UPI-JAY MEWAD RAJAVADICHA ₹ 143.00",
    "03/08/2026| 19:51 UPI-Virmal ₹ 20.00",
    "04/08/2026| 19:57 EMI UPI-TANISHQ ₹ 8,000.00",
    "04/08/2026| 02:16 UPI-SHREE KRISHNA PANPARLOUR ₹ 105.00",
  ];

  it("is recognised by its date-and-time column", () => {
    assert.equal(readerFor(iocl).name, "HDFC");
    assert.equal(readerFor(tataNeu).name, "HDFC");
  });

  it("reads the time off the date without losing either", () => {
    const line = parseStatementRow(tataNeu[1], readers.hdfc)!;
    assert.equal(istDayKey(line.date), "2026-08-03");
    assert.equal(line.description, "UPI-JAY MEWAD RAJAVADICHA");
    assert.equal(line.amountMinor, 14300);
    assert.equal(line.type, "DEBIT");
  });

  it("takes a leading plus as the credit marker this issuer uses", () => {
    const line = parseStatementRow(iocl[3], readers.hdfc)!;
    assert.equal(line.type, "CREDIT");
    assert.equal(line.kind, "PAYMENT", "a card payment, never added");
    assert.equal(line.amountMinor, 40500);
  });

  it("keeps the EMI badge out of the merchant's name", () => {
    const line = parseStatementRow(tataNeu[3], readers.hdfc)!;
    assert.equal(line.description, "UPI-TANISHQ");
    assert.equal(line.amountMinor, 800000);
  });

  it("reads a reference number in the description without tripping on it", () => {
    assert.ok(
      parseStatementRow(iocl[3], readers.hdfc)!.description.includes("ST262280083000010107605"),
      "the ref is part of what was written, not a second amount"
    );
  });

  it("leaves the name and KYC header alone", () => {
    const parsed = parseStatementRows(iocl);
    assert.equal(parsed.lines.length, 1);
    assert.equal(parsed.last4, null, "no card number is printed on this page");
  });

  it("reads a page of them", () => {
    const parsed = parseStatementRows(tataNeu);
    assert.equal(parsed.lines.length, 4);
    assert.deepEqual(
      parsed.lines.map((line) => line.amountMinor),
      [14300, 2000, 800000, 10500]
    );
  });
});

describe("Jupiter (CSB)", () => {
  const rows = [
    "Date Transaction details Amount (INR)",
    "17 Jul 26 08: Repayment - Thank You Rs. 21,286.25",
    "28 am",
    "17 Jul 26 08: NARENDRA SINGH CHAUHAN Rs. 170.00",
    "59 am",
    "17 Jul 26 08: Blinkit Rs. 1,489",
    "08 pm",
    "18 Jul 26 04: REFUND Rs. 1,345",
    "31 pm",
    "19 Jul 26 08: Instamart Grocery Bangalore KAIN Rs. 294.00",
    "28 am",
  ];

  it("is recognised by its own columns", () => {
    assert.equal(readerFor(rows).name, "Jupiter");
  });

  it("reads a date whose timestamp wrapped onto the next line", () => {
    const line = parseStatementRow(rows[3], readers.jupiter)!;
    assert.equal(istDayKey(line.date), "2026-07-17");
    assert.equal(line.description, "NARENDRA SINGH CHAUHAN");
    assert.equal(line.amountMinor, 17000);
  });

  it("reads an amount printed without decimals", () => {
    assert.equal(parseStatementRow(rows[5], readers.jupiter)!.amountMinor, 148900);
  });

  it("works out a credit from the words, since nothing else says so", () => {
    // This issuer marks a credit by printing it in a different colour, and
    // colour is not in a PDF's text stream. The words are all there is.
    const repayment = parseStatementRow(rows[1], readers.jupiter)!;
    assert.equal(repayment.type, "CREDIT");
    assert.equal(repayment.kind, "PAYMENT");

    const refund = parseStatementRow(rows[7], readers.jupiter)!;
    assert.equal(refund.type, "CREDIT");
    assert.equal(refund.kind, "REVERSAL");
  });

  it("treats an ordinary row as a debit", () => {
    // The recoverable mistake. A debit read as a credit would quietly
    // remove real spending from the totals.
    assert.equal(parseStatementRow(rows[9], readers.jupiter)!.type, "DEBIT");
  });

  it("does not read the stray half of a timestamp as anything", () => {
    for (const orphan of ["28 am", "31 pm", "08 pm"]) {
      assert.equal(parseStatementRow(orphan, readers.jupiter), null, orphan);
    }

    const parsed = parseStatementRows(rows);
    assert.equal(parsed.lines.length, 5);
    assert.ok(
      parsed.lines.every((line) => !/\b\d{2}\s(am|pm)$/.test(line.description)),
      "and never joins one onto a merchant"
    );
  });
});

describe("an issuer nobody has written a reader for", () => {
  it("falls back to date, description, amount", () => {
    const rows = ["01/09/2026 SOME NEW BANK MERCHANT 1,240.00"];
    assert.equal(readerFor(rows).name, "generic");

    const parsed = parseStatementRows(rows);
    assert.equal(parsed.lines.length, 1);
    assert.equal(parsed.lines[0].amountMinor, 124000);
  });
});
