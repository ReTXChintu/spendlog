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
    const result = resolveCountedAmount({ amountMinor: 3600000, emiPlanId: "plan-1" });
    assert.deepEqual(result, { countedAmountMinor: 0, countedReason: "EMI_PARENT" });
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
        emiPlanId: "plan-1",
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
