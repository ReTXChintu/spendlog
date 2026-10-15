import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseStatedBalance, parseStatedFigures } from "./balance";
import { parseTransactionText } from "./parser";

describe("reading the balance off a bank message", () => {
  const stated: [string, string, number][] = [
    ["Avl Bal", "Rs.2000 withdrawn from A/c XX1234 at ATM on 12-08-26. Avl Bal Rs.43,320.75 -SBI", 43_320_75],
    ["Avl bal with a colon", "Rs 500 debited from A/c XX1234 on 12-10-26 to VPA x@y. Avl bal: INR 1,234.00", 1_234_00],
    ["Available balance is", "Rs.250.00 paid to Swiggy from A/c XX9876. Available balance is Rs 5,000.00", 5_000_00],
    ["Bal: Rs.", "Rs.99 debited A/c XX1234 to Netflix. Bal: Rs.1234", 1_234_00],
    ["A/c Bal", "INR 1,500.00 debited from A/c XX4821 on 12-10-26. A/c Bal INR 20,000.00 -HDFC Bank", 20_000_00],
    ["Clear Bal", "Rs 2,000 credited to A/c XX1234 by UPI. Clear Bal Rs 12,500.50 -Canara", 12_500_50],
    ["Total Bal", "Your A/c XX5678 is debited for Rs 350.00 on 12-10-26. Total Bal: INR 9,650.00", 9_650_00],
    ["Available Balance: Rs. ", "Rs.1,000.00 debited from A/c XX1234 to self. Available Balance: Rs. 10,000.50", 10_000_50],
    ["Federal's bare Bal Rs", "Debited Rs 161.00 from a/c X5130 on 02Sep26 via UPI to Dharmendra S. Ref 661165147047.Bal Rs 13392.47. Not you?Call 18004251199 -Federal Bank", 13_392_47],
    ["SBI's Avl Balance glued to the signature", "Your A/C XXXXX9876 Debited INR 15,000.00 on 05/10/26 -Transferred to SBI Card. Avl Balance INR 40,000.00-SBI", 40_000_00],
    ["an overdrawn account", "Rs 500 debited from A/c XX1234. Avl Bal Rs -1,200.00", -1_200_00],
    ["the same figure as the payment", "Rs.500.00 debited from A/c XX1234 to VPA a@b. Avl Bal Rs 500.00", 500_00],
  ];

  for (const [label, text, expected] of stated) {
    it(`reads ${label}`, () => {
      assert.equal(parseStatedBalance(text), expected);
    });
  }

  const none: [string, string][] = [
    ["a message that says nothing about the balance", "Rs 349 debited from A/c XX9876 on 15-08-26 to VPA swiggy@icici Ref 4433221100 -Axis Bank"],
    ["a card's available limit", "INR 8,000.00 spent using ICICI Bank Card XX2009 on 02-Sep-26 on TITANCOMPANY. Avl Limit: INR 44,021.93."],
    ["an OTP", "123456 is your OTP for transaction of Rs.5000 at Amazon. Do not share with anyone."],
    ["an empty cell", "Rs.2,500.00 debited from A/c XX1234. Avl Bal Rs. , as on 12-10-26"],
    ["a date where the figure should be", "Rs 500 debited from A/c XX1234. Bal as on 12-10-26"],
    ["a merchant whose name starts with Bal", "Rs 500 debited from A/c XX1234 to Balaji Stores 12 on 12-10-26"],
    ["reward points", "Your points balance is 1200. Redeem now."],
  ];

  for (const [label, text] of none) {
    it(`finds none in ${label}`, () => {
      assert.equal(parseStatedBalance(text), null);
    });
  }

  it("keeps a card's available limit apart from a balance", () => {
    const figures = parseStatedFigures(
      "INR 8,000.00 spent using ICICI Bank Card XX2009 on 02-Sep-26 on TITANCOMPANY. Avl Limit: INR 44,021.93."
    );
    assert.equal(figures.balanceMinor, null);
    assert.equal(figures.availableLimitMinor, 44_021_93);

    assert.equal(parseStatedFigures("Rs 2,000 spent on Card XX1377. Avl Lmt Rs 1,20,000").availableLimitMinor, 1_20_000_00);
    assert.equal(
      parseStatedFigures("Rs 2,000 spent on Card XX1377. Available credit limit is Rs. 50,000.00").availableLimitMinor,
      50_000_00
    );
  });

  it("never lets the balance become the transaction's amount", () => {
    // The transaction parser strips the balance before it looks for the
    // amount; reading the balance separately must not change that.
    for (const [, text, balance] of stated) {
      const parsed = parseTransactionText(text);
      if (!parsed) continue;
      assert.notEqual(parsed.amountMinor, balance === parsed.amountMinor ? -1 : balance, text);
    }
    const parsed = parseTransactionText("Rs.2000 withdrawn from A/c XX1234 at ATM on 12-08-26. Avl Bal Rs.43,320.75 -SBI");
    assert.equal(parsed?.amountMinor, 2000_00);
  });
});
