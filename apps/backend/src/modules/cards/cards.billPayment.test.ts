import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BillCard, CardBillInput, isCardBillCommitment, pickCard, recogniseCardBill } from "./cards.billPayment";

// The user's credit cards. The bank account the bills are paid from ends
// 9876 throughout, so no card's digits are ever the account's.
const HDFC: BillCard = { id: "hdfc", bankName: "HDFC Bank", last4: "5678", isActive: true };
const ICICI: BillCard = { id: "icici", bankName: "ICICI Bank", last4: "2009", isActive: true };
const SBI: BillCard = { id: "sbi", bankName: "SBI", last4: "4321", isActive: true };
const AXIS: BillCard = { id: "axis", bankName: "Axis Bank", last4: "7788", isActive: true };
const KOTAK: BillCard = { id: "kotak", bankName: "Kotak Bank", last4: "3344", isActive: true };
const AMEX: BillCard = { id: "amex", bankName: "American Express", last4: "1004", isActive: true };
const IDFC: BillCard = { id: "idfc", bankName: "IDFC First Bank", last4: "4455", isActive: true };
const ALL_CARDS = [HDFC, ICICI, SBI, AXIS, KOTAK, AMEX, IDFC];

const debit = (text: string, extra: Partial<CardBillInput> = {}): CardBillInput => ({
  text,
  type: "DEBIT",
  accountType: "BANK",
  ...extra,
});
const credit = (text: string, extra: Partial<CardBillInput> = {}): CardBillInput => ({
  text,
  type: "CREDIT",
  accountType: "CARD",
  ...extra,
});

describe("recognising a card bill paid from the bank", () => {
  const cases: [string, string, string][] = [
    [
      "HDFC, towards the card by number",
      "Rs.15,000.00 debited from A/c **9876 on 05-10-26 towards HDFC Bank Credit Card XX5678. Avl bal Rs 42,000.00 -HDFC Bank",
      "hdfc",
    ],
    [
      "HDFC, through BillDesk's HDFC CARDS payee",
      "Money Transfer: Rs 15000.00 from HDFC Bank A/c **9876 on 05-10-26 to BILLDESK-HDFC CARDS UPI: 627812345678. Not you? Call 18002586161",
      "hdfc",
    ],
    [
      "ICICI, the card named as the payee",
      "ICICI Bank Acct XX876 debited for Rs 15000.00 on 05-Oct-26; ICICI Bank Credit Card XX2009 credited. UPI:627812345678. Call 18002662 for dispute.",
      "icici",
    ],
    [
      "SBI Card, from an SBI account",
      "Your A/C XXXXX9876 Debited INR 15,000.00 on 05/10/26 -Transferred to SBI Card. Avl Balance INR 40,000.00-SBI",
      "sbi",
    ],
    [
      "Axis, over UPI to AXIS CC",
      "INR 15000.00 debited A/c no. XX9876 05-10-26, 11:22:33 UPI/P2M/627812345678/AXIS CC Not you? SMS BLOCKUPI Cust ID to 919951860002 Axis Bank",
      "axis",
    ],
    [
      "Kotak, to the card's UPI bill handle",
      "Sent Rs.15000.00 from Kotak Bank AC X9876 to kotakcc.3344@kotak on 05-10-26.UPI Ref 627812345678. Not you, https://kotak.com/fraud",
      "kotak",
    ],
    [
      "American Express, by NEFT",
      "INR 15,000.00 debited from A/c XX9876 on 05-10-26 by NEFT to AMERICAN EXPRESS BANKING CORP. Ref N278261234567 -HDFC Bank",
      "amex",
    ],
    [
      "IDFC FIRST",
      "Your A/c XX9876 is debited for INR 15,000.00 on 05-10-2026 towards IDFC FIRST Bank Credit Card XX4455 payment. - IDFC FIRST Bank",
      "idfc",
    ],
    [
      "BBPS, which only says the card",
      "Thank you for payment of Rs.15000.00 for ICICI Credit Card XX2009 on 05-10-2026 via Bharat BillPay (BBPS). Ref no. CC0123456789",
      "icici",
    ],
    [
      "a bank statement's narration",
      "CC PAYMENT ICICI 2009 BBPS-556677",
      "icici",
    ],
    [
      "a card bill from one bank to another bank's card",
      "Rs 15,000.00 sent from HDFC Bank A/c XX9876 to ICICI Bank Credit Card on 05-10-26 -HDFC Bank",
      "icici",
    ],
    [
      "CRED, with the card's number",
      "Rs 15,000 debited from A/c XX9876 to CRED on 05-10-26 for card XX5678",
      "hdfc",
    ],
  ];

  for (const [name, text, card] of cases) {
    it(name, () => {
      assert.deepEqual(recogniseCardBill(debit(text), ALL_CARDS), { side: "PAYMENT", cardId: card });
    });
  }

  it("reads BBPS as the bank paying even when the parser filed it under the card", () => {
    const text =
      "Thank you for payment of Rs.15000.00 for ICICI Credit Card XX2009 on 05-10-2026 via Bharat BillPay (BBPS).";
    assert.deepEqual(recogniseCardBill(debit(text, { accountType: "CARD" }), ALL_CARDS), {
      side: "PAYMENT",
      cardId: "icici",
    });
  });

  it("recognises CRED's card bill handle, and links the only card there is", () => {
    const text =
      "Rs.15000.00 debited from A/c XX9876 on 05-10-26 to VPA cred.club@axisbank (UPI Ref No 627812345678). Not you? Call 18002586161 -HDFC Bank";
    assert.deepEqual(recogniseCardBill(debit(text), [HDFC]), { side: "PAYMENT", cardId: "hdfc" });
    // Clearly a bill, but which of seven cards is anyone's guess.
    assert.deepEqual(recogniseCardBill(debit(text), ALL_CARDS), { side: "PAYMENT", cardId: null });
  });

  it("needs more than CRED's name, until the card confirms the payment arrived", () => {
    const text =
      "Your A/C XXXXX9876 Debited INR 15,000.00 on 05/10/26 -Transferred to CRED. Avl Balance INR 40,000.00-SBI";
    assert.equal(recogniseCardBill(debit(text), ALL_CARDS), null);
    assert.deepEqual(recogniseCardBill(debit(text, { confirmed: true }), [HDFC]), {
      side: "PAYMENT",
      cardId: "hdfc",
    });
  });
});

describe("not mistaking other payments for a card bill", () => {
  const negatives: [string, string, Partial<CardBillInput>][] = [
    [
      "a purchase on a credit card",
      "Rs.2,499.00 spent on your ICICI Bank Credit Card XX2009 at AMAZON on 05-Oct-26. Avl Lmt: Rs 1,20,000. To dispute, call 18001080",
      { accountType: "CARD" },
    ],
    [
      "a purchase on a credit card, account not yet known",
      "Rs.2,499.00 spent on your ICICI Bank Credit Card XX2009 at AMAZON on 05-Oct-26.",
      { accountType: null },
    ],
    [
      "a card alert that only says Txn",
      "Txn Rs.105.00\nOn HDFC Bank Card 1377\nAt paytmqr6g6fjc@ptys \nby UPI 661266604357\nOn 03-09\nNot You?\nCall 18002586161/SMS BLOCK CC 1377 to 7308080808",
      { accountType: "CARD" },
    ],
    [
      "a credit card paying a merchant",
      "₹654.00 paid from your Edge CSB Bank RuPay Credit Card to FlipkartInternetPvtLtd Bengaluru kaIN on 2026-09-02T20:14:43.739597+05:30 IST.",
      { accountType: "CARD" },
    ],
    [
      "rent through CRED, on the card",
      "Rs 25,000.00 spent on your HDFC Bank Credit Card XX5678 at CRED RENT on 05-10-26",
      { accountType: "CARD" },
    ],
    [
      "rent through CRED, from the bank",
      "Rs 25,000.00 debited from A/c XX9876 to CRED for rent payment on 05-10-26",
      {},
    ],
    [
      "an ordinary payment to CRED",
      "Rs.500.00 debited from A/c XX9876 to CRED on 05-10-26",
      {},
    ],
    [
      "a loan EMI",
      "EMI of Rs 4,500.00 for your loan a/c XX7788 has been debited from A/c XX9876 on 05-10-26",
      {},
    ],
    [
      "a card EMI paid from the bank",
      "Rs 2,345.00 debited from A/c XX9876 towards EMI for HDFC Bank Credit Card",
      {},
    ],
    [
      "a loan repayment",
      "Rs 12,000.00 debited from A/c XX9876 towards Personal Loan repayment 123456 on 05-10-26",
      {},
    ],
    [
      "an ordinary UPI payment",
      "Rs 349 debited from A/c XX9876 on 15-08-26 to VPA swiggy@icici Ref 4433221100 -Axis Bank",
      {},
    ],
    [
      "a debit card purchase",
      "Rs 800 debited from a/c **9876 on 05-10-26 using HDFC Bank Debit Card XX9999 at DMART",
      {},
    ],
  ];

  for (const [name, text, extra] of negatives) {
    it(name, () => {
      assert.equal(recogniseCardBill(debit(text, extra), ALL_CARDS), null);
    });
  }
});

describe("recognising the card's own 'payment received'", () => {
  const cases: [string, string, string][] = [
    [
      "HDFC",
      "DEAR CARDMEMBER, PAYMENT OF RS 15000.00 RECEIVED TOWARDS YOUR HDFC BANK CREDIT CARD ENDING 5678 ON 06/OCT/2026. YOUR AVAILABLE LIMIT IS RS 1,50,000.00",
      "hdfc",
    ],
    [
      "ICICI",
      "Dear Customer, Payment of INR 15,000.00 has been received on your ICICI Bank Credit Card Account 4XXX2009 on 06-Oct-26. Thank you.",
      "icici",
    ],
    [
      "SBI Card",
      "We have received payment of Rs.15,000.00 towards your SBI Credit Card ending 4321 on 06/10/26. Your available limit is Rs.85,000.00.",
      "sbi",
    ],
    [
      "Axis",
      "Payment of INR 15000.00 received for Axis Bank Credit Card XX7788 on 06-10-26. Available limit INR 1,00,000.00",
      "axis",
    ],
    ["Kotak", "Payment of Rs.15000 received for your Kotak Credit Card xx3344 on 06/10/2026. Thank you", "kotak"],
    [
      "American Express, which prints five digits",
      "We have received your payment of Rs 15,000.00 towards your American Express Card ending 51004. Thank you.",
      "amex",
    ],
    [
      "IDFC FIRST",
      "Payment of INR 15,000 received towards IDFC FIRST Bank Credit Card ending XX4455 on 06 OCT 2026.",
      "idfc",
    ],
  ];

  for (const [name, text, card] of cases) {
    it(name, () => {
      assert.deepEqual(recogniseCardBill(credit(text), ALL_CARDS), { side: "PAYMENT_RECEIVED", cardId: card });
    });
  }

  it("falls back on the card the credit was filed under", () => {
    const text = "Payment received towards your credit card. Thank you.";
    assert.deepEqual(recogniseCardBill(credit(text, { accountId: "axis" }), ALL_CARDS), {
      side: "PAYMENT_RECEIVED",
      cardId: "axis",
    });
  });

  it("is not a refund, cashback or money into a bank account", () => {
    for (const text of [
      "Refund of Rs 499.00 received on your ICICI Bank Credit Card XX2009 from AMAZON",
      "Cashback of Rs 150 credited to your SBI Credit Card ending 4321",
      "Rs 50,000.00 credited to your A/c XX9876 on 01-10-26 by NEFT from ACME CORP. Payment received. -HDFC Bank",
    ]) {
      assert.equal(recogniseCardBill(credit(text), ALL_CARDS), null, text);
    }
  });
});

describe("choosing the card without guessing", () => {
  it("refuses an issuer that two cards share", () => {
    const second = { ...HDFC, id: "hdfc-2", last4: "1111" };
    const text = "Rs 15000.00 from HDFC Bank A/c **9876 on 05-10-26 to BILLDESK-HDFC CARDS";
    assert.equal(pickCard({ text, side: "PAYMENT", cards: [HDFC, second] }), null);
  });

  it("refuses the only card when the message names a different one", () => {
    const text = "Rs 15,000 debited from A/c XX9876 towards Credit Card XX0000";
    assert.equal(pickCard({ text, side: "PAYMENT", cards: [HDFC] }), null);
  });

  it("refuses the only card when the message names a different issuer", () => {
    const text = "Rs 15,000 sent from A/c XX9876 to ICICI Bank Credit Card";
    assert.equal(pickCard({ text, side: "PAYMENT", cards: [HDFC] }), null);
  });

  it("takes the only active card when nothing is named", () => {
    const closed = { ...ICICI, isActive: false };
    const text = "Rs 15,000 debited from A/c XX9876 towards credit card payment";
    assert.equal(pickCard({ text, side: "PAYMENT", cards: [HDFC, closed] }), "hdfc");
  });

  it("does not read the paying bank as the card's issuer", () => {
    const text = "Rs 15,000.00 debited from HDFC Bank A/c XX9876 towards credit card bill payment";
    assert.equal(pickCard({ text, side: "PAYMENT", cards: [HDFC, ICICI] }), null);
  });
});

describe("a fixed commitment that is a card's bill", () => {
  it("is recognised by its name", () => {
    for (const name of ["HDFC credit card bill", "Amex", "SBI Card", "CC bill", "Card payment"]) {
      assert.equal(isCardBillCommitment({ name, kind: "OTHER" }), true, name);
    }
  });

  it("is not rent, a loan, CRED rent or anything else", () => {
    assert.equal(isCardBillCommitment({ name: "Rent", kind: "RENT" }), false);
    assert.equal(isCardBillCommitment({ name: "Credit card", kind: "SIP" }), false);
    assert.equal(isCardBillCommitment({ name: "Home loan EMI", kind: "LOAN" }), false);
    assert.equal(isCardBillCommitment({ name: "CRED rent", kind: "OTHER" }), false);
    assert.equal(isCardBillCommitment({ name: "Netflix", kind: "OTHER" }), false);
  });
});
