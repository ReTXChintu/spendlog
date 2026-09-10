import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTransactionText } from "./parser";

// The four message formats that actually dominate this user's inbox.
// These are regression tests — if a parser change breaks one of these,
// real transactions start silently going missing.
describe("real-world SMS formats", () => {
  it("parses an HDFC card UPI txn with no direction verb", () => {
    const result = parseTransactionText(
      [
        "Txn Rs.105.00",
        "On HDFC Bank Card 1377",
        "At paytmqr6g6fjc@ptys ",
        "by UPI 661266604357",
        "On 03-09",
        "Not You?",
        "Call 18002586161/SMS BLOCK CC 1377 to 7308080808",
      ].join("\n")
    );

    assert.ok(result, "should not be ignored");
    assert.equal(result.amountMinor, 10500);
    assert.equal(result.type, "DEBIT");
    assert.equal(result.merchant, "paytmqr6g6fjc@ptys");
    assert.equal(result.account?.bankName, "HDFC Bank");
    assert.equal(result.account?.last4, "1377");
    assert.equal(result.account?.accountType, "CARD");
  });

  it("parses a Federal Bank UPI debit to a person", () => {
    const result = parseTransactionText(
      "Debited Rs 161.00 from a/c X5130 on 02Sep26 20:51 via UPI to Dharmendra S. Ref 661165147047.Bal Rs 13392.47. Not you?Call 18004251199 -Federal Bank"
    );

    assert.ok(result);
    assert.equal(result.amountMinor, 16100);
    assert.equal(result.type, "DEBIT");
    assert.equal(result.merchant, "Dharmendra S");
    assert.equal(result.account?.bankName, "Federal Bank");
    assert.equal(result.account?.last4, "5130");
    assert.equal(result.account?.accountType, "BANK");
  });

  it("parses a CSB/Jupiter credit card payment", () => {
    const result = parseTransactionText(
      "₹654.00 paid from your Edge CSB Bank RuPay Credit Card to FlipkartInternetPvtLtd Bengaluru kaIN on 2026-09-02T20:14:43.739597+05:30 IST. To raise an issue, call 8655055086. Thank you for using Jupiter."
    );

    assert.ok(result);
    assert.equal(result.amountMinor, 65400);
    assert.equal(result.type, "DEBIT");
    assert.match(result.merchant ?? "", /Flipkart/i);
    assert.equal(result.account?.bankName, "CSB Bank");
    assert.equal(result.account?.accountType, "CARD");
  });

  it("parses an ICICI card spend without grabbing the helpline number", () => {
    const result = parseTransactionText(
      "INR 8,000.00 spent using ICICI Bank Card XX2009 on 02-Sep-26 on TITANCOMPANY. Avl Limit: INR 44,021.93. If not you, call 1800 2662/SMS BLOCK 2009 to 9215676766."
    );

    assert.ok(result);
    assert.equal(result.amountMinor, 800000);
    assert.equal(result.type, "DEBIT");
    assert.equal(result.merchant, "TITANCOMPANY");
    assert.equal(result.account?.bankName, "ICICI Bank");
    assert.equal(result.account?.last4, "2009");
    assert.equal(result.account?.accountType, "CARD");
  });
});

describe("other common formats", () => {
  it("parses a UPI debit and strips trailing punctuation from the VPA", () => {
    const result = parseTransactionText(
      "Rs.500.00 debited from A/c XX1234 on 12-08-26 to VPA merchant@upi. Ref No 123456789. -HDFC Bank"
    );

    assert.ok(result);
    assert.equal(result.amountMinor, 50000);
    assert.equal(result.merchant, "merchant@upi");
    assert.equal(result.account?.last4, "1234");
  });

  it("prefers the sender signature over a bank name inside a UPI handle", () => {
    const result = parseTransactionText(
      "Rs 349 debited from A/c XX9876 on 15-08-26 to VPA swiggy@icici Ref 4433221100 -Axis Bank"
    );

    assert.ok(result);
    assert.equal(result.account?.bankName, "Axis Bank");
    assert.equal(result.merchant, "swiggy@icici");
  });

  it("parses an incoming credit", () => {
    const result = parseTransactionText(
      "Your a/c XX5678 is credited with Rs 85,000.00 on 01-08-26 towards SALARY. -ICICI Bank"
    );

    assert.ok(result);
    assert.equal(result.type, "CREDIT");
    assert.equal(result.amountMinor, 8500000);
    assert.equal(result.account?.bankName, "ICICI Bank");
  });

  it("parses an ATM withdrawal without picking up the running balance", () => {
    const result = parseTransactionText(
      "Rs.2000 withdrawn from A/c XX1234 at ATM on 12-08-26. Avl Bal Rs.43,320.75 -SBI"
    );

    assert.ok(result);
    assert.equal(result.type, "DEBIT");
    assert.equal(result.amountMinor, 200000);
  });

  it("parses a card spend phrased as 'was used for'", () => {
    const result = parseTransactionText(
      "Your Card ending 4321 was used for Rs.899.00 at RELIANCE SMART on 14-08-26."
    );

    assert.ok(result, "should not be ignored");
    assert.equal(result.type, "DEBIT");
    assert.equal(result.amountMinor, 89900);
    assert.equal(result.merchant, "RELIANCE SMART");
    assert.equal(result.account?.last4, "4321");
  });

  it("parses a spend phrased as 'towards', which bank emails favour", () => {
    const result = parseTransactionText(
      "Dear Customer, Rs 349.00 has been debited from your Axis Bank A/c XX9876 on 15-08-26 towards SWIGGY ORDER. Ref 4433221100."
    );

    assert.ok(result, "should not be ignored");
    assert.equal(result.amountMinor, 34900);
    assert.equal(result.merchant, "SWIGGY ORDER");
  });

  it("does not read the date as the merchant when 'towards' follows it", () => {
    // "on <date> towards <merchant>" is the trap: the "on" pattern would
    // otherwise take the date and the merchant as one string.
    const result = parseTransactionText(
      "Rs 1250 debited towards BIG BAZAAR on 02-09-26 from A/c XX1234 -HDFC Bank"
    );

    assert.equal(result?.merchant, "BIG BAZAAR");
  });
});

describe("messages that must be ignored", () => {
  const ignored = [
    ["an OTP", "123456 is your OTP for transaction of Rs.5000 at Amazon. Do not share with anyone."],
    ["a bill reminder", "Your HDFC Credit Card bill of Rs.12,500 is due on 25-08-26. Minimum due Rs.625."],
    ["a promo", "Get 50% off up to Rs.150 on your next order. Use code SAVE50. T&C apply."],
    ["a balance enquiry", "Available balance in your A/c XX1234 is Rs.45,320.75 as on 12-08-26."],
    ["an autopay pre-notice", "Rs.499 will be debited from your A/c XX1234 on 05-09-26 towards Netflix."],
    ["a collect request", "Rs.250 has been requested by scammer@upi. Pay only if you know the sender."],
    [
      "a promo mentioning a txn",
      "Flat Rs.100 cashback on your next txn above Rs.500. Offer valid till 30-09-26.",
    ],
  ] as const;

  for (const [label, text] of ignored) {
    it(`ignores ${label}`, () => {
      assert.equal(parseTransactionText(text), null);
    });
  }
});
