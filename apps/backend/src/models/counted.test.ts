import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveCountedAmount } from "./counted";

describe("resolveCountedAmount", () => {
  it("counts an ordinary transaction in full", () => {
    const result = resolveCountedAmount({ amountMinor: 45000 });
    assert.deepEqual(result, { countedAmountMinor: 45000, countedReason: "FULL" });
  });

  it("counts a transfer between the user's own accounts as nothing", () => {
    const result = resolveCountedAmount({ amountMinor: 500000, isTransfer: true });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "TRANSFER" });
  });

  it("counts only the user's share of a split bill", () => {
    const result = resolveCountedAmount({
      amountMinor: 120000,
      split: { myShareMinor: 40000 },
    });
    assert.deepEqual(result, { countedAmountMinor: 40000, countedReason: "SPLIT" });
  });

  it("counts a share of zero, rather than treating it as unset", () => {
    // Someone else's bill paid from my card: the whole amount is owed back.
    const result = resolveCountedAmount({ amountMinor: 90000, split: { myShareMinor: 0 } });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "SPLIT" });
  });

  it("counts only the user's share of a credit too, not just a payment", () => {
    // The roommate case: 6,000 comes in, 4,000 of it is rent they fronted
    // coming back rather than new money, and only 2,000 is real income.
    // Nothing here reads type, on purpose - a share is a share whichever
    // way the money moved.
    const result = resolveCountedAmount({ amountMinor: 600000, split: { myShareMinor: 200000 } });
    assert.deepEqual(result, { countedAmountMinor: 200000, countedReason: "SPLIT" });
  });

  it("never counts more than the bank actually moved", () => {
    const result = resolveCountedAmount({
      amountMinor: 100000,
      split: { myShareMinor: 150000 },
    });
    assert.equal(result.countedAmountMinor, 100000);
  });

  it("counts settling up with a friend as nothing", () => {
    const result = resolveCountedAmount({ amountMinor: 85000, isSettlement: true });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "SETTLEMENT" });
  });

  it("counts the purchase behind an EMI as nothing, since the instalments count", () => {
    const result = resolveCountedAmount({ amountMinor: 3600000, emiRole: "PARENT" });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "EMI_PARENT" });
  });

  it("counts an EMI instalment in full, since that is the actual spending", () => {
    const result = resolveCountedAmount({ amountMinor: 320000, emiRole: "INSTALMENT" });
    assert.deepEqual(result, { countedAmountMinor: 320000, countedReason: "FULL" });
  });

  it("counts a manually excluded transaction as nothing", () => {
    const result = resolveCountedAmount({ amountMinor: 20000, excludeFromTotals: true });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "EXCLUDED" });
  });

  describe("precedence", () => {
    it("treats a split transfer as a transfer", () => {
      const result = resolveCountedAmount({
        amountMinor: 120000,
        isTransfer: true,
        split: { myShareMinor: 40000 },
      });
      assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "TRANSFER" });
    });

    it("treats a split EMI purchase as an EMI purchase", () => {
      const result = resolveCountedAmount({
        amountMinor: 3600000,
        emiRole: "PARENT",
        split: { myShareMinor: 1800000 },
      });
      assert.equal(result.countedReason, "EMI_PARENT");
    });

    it("prefers a split share over a blanket exclusion", () => {
      const result = resolveCountedAmount({
        amountMinor: 120000,
        split: { myShareMinor: 40000 },
        excludeFromTotals: true,
      });
      assert.deepEqual(result, { countedAmountMinor: 40000, countedReason: "SPLIT" });
    });
  });

  it("ignores a split with no share set", () => {
    const result = resolveCountedAmount({ amountMinor: 120000, split: { myShareMinor: null } });
    assert.deepEqual(result, { countedAmountMinor: 120000, countedReason: "FULL" });
  });
});

describe("a credit card bill payment", () => {
  it("counts as nothing, because the spending was counted on the card", () => {
    // The trap this whole design is arranged around. Every purchase on the
    // card was counted the day it happened; the bill is that same money
    // reaching the bank a month later.
    const result = resolveCountedAmount({
      amountMinor: 4785025,
      cardPaymentFor: "65f000000000000000000001",
    });

    assert.equal(result.countedAmountMinor, 0);
    assert.equal(result.countedReason, "CARD_BILL");
  });

  it("outranks a split on the same row", () => {
    // Splitting a card bill with a flatmate does not make part of it
    // spending: the purchases behind it were already counted in full.
    const result = resolveCountedAmount({
      amountMinor: 4785025,
      cardPaymentFor: "65f000000000000000000001",
      split: { myShareMinor: 2000000 },
    });

    assert.equal(result.countedAmountMinor, 0);
    assert.equal(result.countedReason, "CARD_BILL");
  });

  it("is ordinary spending again once the card is cleared off it", () => {
    const result = resolveCountedAmount({ amountMinor: 4785025, cardPaymentFor: null });
    assert.equal(result.countedAmountMinor, 4785025);
    assert.equal(result.countedReason, "FULL");
  });
});
