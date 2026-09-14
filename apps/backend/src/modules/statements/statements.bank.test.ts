import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { istDayKey } from "../../time";
import { looksLikeCardBill } from "./statements.classify";
import { readerFor, readers } from "./statements.issuers";
import { parseStatementRows } from "./statements.parse";

/**
 * A bank statement, as every Indian bank lays one out: a running balance,
 * and withdrawals and deposits in separate columns that both vanish when
 * empty - so a row of either kind arrives as the same two trailing numbers.
 */
const BANK_ROWS = [
  "HDFC BANK LTD - STATEMENT OF ACCOUNT",
  "Account No: 50100XXXXXX4821",
  "Date Narration Chq/Ref No Value Dt Withdrawal Amt Deposit Amt Closing Balance",
  "13/09/26 OPENING BALANCE 45,752.60",
  "14/09/26 UPI-SWIGGY-SWIGGY@ICICI-123456 UPI-123456789 14/09/26 432.50 45,320.10",
  "15/09/26 SALARY SEP 2026 NEFT-0099887 15/09/26 96,000.00 1,41,320.10",
  "16/09/26 CC PAYMENT ICICI 2009 BBPS-556677 16/09/26 29,693.53 1,11,626.57",
  "17/09/26 UPI-MUKHWAS PAN PARLOUR-Q@ybl UPI-778899 17/09/26 102.00 1,11,524.57",
];

describe("recognising a bank statement", () => {
  it("is not claimed by a card reader", () => {
    assert.equal(readerFor(BANK_ROWS).name, "bank");
    assert.equal(readerFor(BANK_ROWS).kind, "BANK");
  });

  it("is not fooled by a bank's name inside a UPI handle", () => {
    // Issuer detection used to read every row, so "SWIGGY@ICICI" on a
    // payment line handed the whole document to the ICICI card reader,
    // which then read nothing at all and said nothing about it. A bank
    // names itself at the top of its own statement.
    const withoutHeader = BANK_ROWS.slice(2);
    assert.equal(readerFor(withoutHeader).name, "bank");
  });
});

describe("reading a bank statement", () => {
  const parsed = parseStatementRows(BANK_ROWS);

  it("takes the amount rather than the balance beside it", () => {
    // The last number on the row is the running balance. Taking it would
    // put a five-figure balance in the ledger as a payment.
    const swiggy = parsed.lines.find((line) => line.description.includes("SWIGGY"))!;
    assert.equal(swiggy.amountMinor, 43250);
  });

  it("works out which way the money went from how the balance moved", () => {
    // Withdrawals and deposits are in separate columns that both vanish
    // when empty, so position says nothing. The balance says everything.
    const swiggy = parsed.lines.find((line) => line.description.includes("SWIGGY"))!;
    const salary = parsed.lines.find((line) => line.description.includes("SALARY"))!;

    assert.equal(swiggy.type, "DEBIT", "balance fell");
    assert.equal(salary.type, "CREDIT", "balance rose");
    assert.equal(salary.amountMinor, 9600000);
  });

  it("treats money arriving in an account as income, not a bill being paid", () => {
    // The one thing a card statement and a bank statement disagree on. On
    // a card an unexplained credit is the bill being settled and is left
    // alone; leaving a salary alone would throw away the very thing the
    // exercise was meant to find.
    const salary = parsed.lines.find((line) => line.description.includes("SALARY"))!;
    assert.equal(salary.kind, "INCOME");
  });

  it("strips the reference number and the value date off the narration", () => {
    const swiggy = parsed.lines.find((line) => line.description.includes("SWIGGY"))!;
    assert.equal(swiggy.description, "UPI-SWIGGY-SWIGGY@ICICI-123456");
  });

  it("leaves the opening balance out", () => {
    assert.ok(!parsed.lines.some((line) => /opening balance/i.test(line.description)));
    assert.equal(parsed.lines.length, 4);
    assert.equal(istDayKey(parsed.lines[0].date), "2026-09-14");
  });

  it("drops a row whose balance does not move by its own amount", () => {
    // A misread row - a reference taken for a figure, a line joined wrongly
    // - is better dropped than guessed at, because a guess puts a wrong
    // number in the ledger that nothing ever questions again.
    const withGarbage = [
      ...BANK_ROWS,
      "18/09/26 GARBLED ROW REF-112233 18/09/26 999.99 1,11,524.57",
      "19/09/26 UPI-ZEPTO-Q@ybl UPI-990011 19/09/26 240.00 1,11,284.57",
    ];

    const lines = parseStatementRows(withGarbage).lines;
    assert.ok(!lines.some((line) => line.description.includes("GARBLED")));
    // And the rows after it still read, rather than one bad row condemning
    // the rest of the page.
    assert.ok(lines.some((line) => line.description.includes("ZEPTO")));
  });

  it("spots the one row that would otherwise double the month", () => {
    // A bank statement lists the card bill going out while the card's own
    // statement lists every purchase behind it.
    const bill = parsed.lines.find((line) => line.description.includes("CC PAYMENT"))!;
    assert.equal(bill.type, "DEBIT");
    assert.equal(looksLikeCardBill(bill.description), true);
  });

  it("does not call an ordinary payment a card bill", () => {
    for (const description of ["UPI-SWIGGY-SWIGGY@ICICI", "SALARY SEP 2026", "ATM WDL"]) {
      assert.equal(looksLikeCardBill(description), false, description);
    }
  });
});

describe("a card statement is still read as one", () => {
  it("keeps treating an unexplained credit as the bill being paid", () => {
    const rows = [
      "EXAMPLE BANK CREDIT CARD STATEMENT",
      "Card No: 4854 XXXX XXXX 1377",
      "18/08/2026 SOMETHING UNREADABLE 1,240.00 Cr",
    ];

    const parsed = parseStatementRows(rows);
    assert.equal(parsed.kind, "CARD");
    assert.equal(parsed.lines[0].kind, "PAYMENT");
  });

  it("reads a bank row through the generic reader without a balance", () => {
    // The generic reader has no running balance to work from, so it must
    // not start claiming to know directions it cannot see.
    const line = readers.generic.row("18/08/2026 AMZNIN MUMBAI IN 1,240.00");
    assert.equal(line?.balance, undefined);
  });
});

describe("finding which account a bank statement is for", () => {
  it("reads a masked account number", () => {
    assert.equal(parseStatementRows(BANK_ROWS).last4, "4821");
  });

  it("reads one that is not masked at all", () => {
    // The reported gap. A bank statement has no card number on it, and
    // nothing here looked for an account number - so every one of them
    // read perfectly and then landed on "no account number could be found
    // in this statement", with only cards offered to point it at.
    for (const row of [
      "Account Number 50100123454821",
      "Account No. : 50100123454821",
      "A/c No 50100123454821",
      "Acct Number: 50100123454821",
      "Alternate Account Number 0001010430008391372",
    ]) {
      const parsed = parseStatementRows([row, ...BANK_ROWS.slice(2)]);
      assert.equal(parsed.last4, row.includes("0001010") ? "1372" : "4821", row);
    }
  });

  it("still prefers a card number where a statement prints both", () => {
    // A card statement often carries the account the card is billed to,
    // and it is the card the statement belongs to.
    const rows = [
      "BISWAJIT PANDA Credit Card No. 652925XXXXXX1377",
      "Alternate Account Number 0001010430008391372",
      ...BANK_ROWS.slice(2),
    ];
    assert.equal(parseStatementRows(rows).last4, "1377");
  });
});
