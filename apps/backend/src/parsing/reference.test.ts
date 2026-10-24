import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conflictingReferences, decodeEntities, htmlToText, sameReference, transactionReference } from "./reference";

describe("the bank's reference for a payment", () => {
  const cases: [string, string, string, string][] = [
    ["HDFC's credit SMS", "Credit Alert! Rs.350.00 credited to HDFC Bank A/c XX8342 on 23-10-26 from VPA *22-2@okicici (UPI 666285487168)", "RRN", "666285487168"],
    ["Jupiter's UPI Ref no.", "Rs.172.00 debited to your Edge CSB Bank RuPay Credit Card ending 6623 on 10/23/26, 1:39 AM - (UPI Ref no.629632671192). To dispute,call 8045219280.", "RRN", "629632671192"],
    ["UPI: with a colon", "Rs 20 debited from a/c XX1234 UPI:629632671100 to x@y", "RRN", "629632671100"],
    ["HDFC email's UPI Reference Number", "Transaction Details: a. Date: 23-10-26 b. Amount: Rs.350.00 c. UPI Reference Number: 666285487168 d. From VPA", "RRN", "666285487168"],
    ["Federal's bare Ref, twelve digits", "Debited Rs 161.00 from a/c X5130 on 02Sep26 via UPI to S. Ref 661165147047.Bal Rs 13392.47", "RRN", "661165147047"],
    ["RRN", "Rs 500 spent on card XX1111 at AMAZON. RRN 123456789012", "RRN", "123456789012"],
    ["a NEFT UTR", "INR 25,000.00 credited to A/c XX1234 by NEFT. UTR No. HDFCN52026102312345678 -HDFC", "UTR", "HDFCN52026102312345678"],
    ["an IMPS reference", "Rs 2,000 sent via IMPS Ref No 6296326711 to A/c XX99", "UTR", "6296326711"],
    ["Ref No.", "Your a/c XX12 is debited with Rs 300. Ref No. AB12345678.", "REF", "AB12345678"],
    ["Ref#", "Rs 300 paid. Ref# 98765432 -Bank", "REF", "98765432"],
    ["a Txn ID", "Payment of Rs 99 successful. Txn ID: T2610231234567", "TXN", "T2610231234567"],
    ["a Transaction ID", "You paid ₹105 to MUKHWAS PAN PARLOUR. Transaction ID 412345678901234", "TXN", "412345678901234"],
    ["a labelled auth code", "Rs 1,200 spent on card XX4821 at SHOP. Auth code: 0A1B2C", "AUTH", "0A1B2C"],
  ];
  for (const [label, text, kind, value] of cases) {
    it(`reads ${label}`, () => {
      assert.deepEqual(transactionReference(text), { kind, value });
    });
  }

  it("reads one out of an HTML email, entities and all", () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body><p>We&#39;re writing to inform you that Rs.350.00 has been " +
      "credited.</p><table><tr><td>UPI Reference Number:</td><td>666291491063</td></tr></table></body></html>";
    const text = htmlToText(html);
    assert.match(text, /We're writing/);
    assert.doesNotMatch(text, /color:red/);
    assert.deepEqual(transactionReference(text), { kind: "RRN", value: "666291491063" });
  });

  it("finds nothing where there is nothing to find", () => {
    for (const text of [
      "Rs 500 debited from A/c XX1234 to Swiggy",
      "Rs.1,234.56 spent on card XX6623. Call 18004251199 to dispute",
      "Your refund of Rs 300 is being processed",
      "Ref: see your statement",
      "",
    ]) {
      assert.equal(transactionReference(text), null, text);
    }
    assert.equal(transactionReference(null), null);
  });

  it("decodes entities", () => {
    assert.equal(decodeEntities("We&#39;re &amp; you&#x27;re &nbsp;ok"), "We're & you're  ok");
  });

  it("matches the same number whatever each message called it", () => {
    const sms = transactionReference("Rs 161 debited. Ref 661165147047");
    const email = transactionReference("UPI Reference Number: 661165147047");
    assert.equal(sameReference(sms, email), true);
    assert.equal(conflictingReferences(sms, email), false);
  });

  it("only references of one kind can conflict", () => {
    const a = { kind: "RRN" as const, value: "666285487168" };
    const b = { kind: "RRN" as const, value: "666291491063" };
    const txn = { kind: "TXN" as const, value: "T2610231234567" };
    assert.equal(conflictingReferences(a, b), true);
    assert.equal(conflictingReferences(a, txn), false);
    assert.equal(conflictingReferences(a, null), false);
    assert.equal(sameReference(a, b), false);
  });
});
