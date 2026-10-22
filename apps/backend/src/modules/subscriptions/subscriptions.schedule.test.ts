import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDays,
  daysBetween,
  firstRenewalFrom,
  frequencyFromGaps,
  frequencyLabel,
  monthlyEquivalentMinor,
  renewalAfter,
  renewalAt,
  renewalsBetween,
  yearlyEquivalentMinor,
} from "./subscriptions.schedule";

const monthly = { every: 1, unit: "month" } as const;
const yearly = { every: 1, unit: "year" } as const;

describe("when a subscription renews", () => {
  it("keeps the day of the month, falling back to a short month's last day without drifting", () => {
    assert.equal(renewalAt("2026-01-31", monthly, 1), "2026-02-28");
    assert.equal(renewalAt("2026-01-31", monthly, 2), "2026-03-31");
    assert.equal(renewalAt("2026-01-31", monthly, 13), "2027-02-28");
    assert.equal(renewalAt("2024-02-29", yearly, 1), "2025-02-28");
    assert.equal(renewalAt("2024-02-29", yearly, 4), "2028-02-29");
    assert.equal(renewalAt("2026-10-05", { every: 3, unit: "month" }, 1), "2027-01-05");
    assert.equal(renewalAt("2026-10-05", { every: 2, unit: "week" }, 2), "2026-11-02");
    assert.equal(renewalAt("2026-10-05", { every: 45, unit: "day" }, 1), "2026-11-19");
  });

  it("finds the next one from any day", () => {
    assert.equal(firstRenewalFrom("2026-01-31", monthly, "2026-02-28"), "2026-02-28");
    assert.equal(firstRenewalFrom("2026-01-31", monthly, "2026-03-01"), "2026-03-31");
    assert.equal(firstRenewalFrom("2026-01-31", monthly, "2025-12-01"), "2026-01-31", "not before the start");
    assert.equal(renewalAfter("2026-01-31", monthly, "2026-02-28"), "2026-03-31");
    assert.equal(renewalAfter("2026-01-05", monthly, "2026-10-22"), "2026-11-05");
    assert.equal(renewalAfter("2026-01-05", { every: 1, unit: "week" }, "2026-10-19"), "2026-10-26");
  });

  it("lists the renewals inside a month, both ends in", () => {
    assert.deepEqual(renewalsBetween("2026-01-05", monthly, "2026-10-01", "2026-10-31"), ["2026-10-05"]);
    assert.deepEqual(renewalsBetween("2026-01-05", { every: 1, unit: "week" }, "2026-10-15", "2026-11-14"), [
      "2026-10-19",
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
    ]);
    assert.deepEqual(renewalsBetween("2026-01-05", yearly, "2026-10-15", "2026-11-14"), []);
    assert.deepEqual(renewalsBetween("2026-10-20", monthly, "2026-10-15", "2026-11-14"), ["2026-10-20"]);
    assert.deepEqual(renewalsBetween("2026-10-20", monthly, "2026-11-15", "2026-11-14"), []);
  });

  it("does day arithmetic across month ends", () => {
    assert.equal(addDays("2026-10-30", 4), "2026-11-03");
    assert.equal(daysBetween("2026-10-30", "2026-11-03"), 4);
    assert.equal(daysBetween("2026-11-03", "2026-10-30"), -4);
  });
});

describe("what a subscription comes to", () => {
  it("as a monthly and a yearly equivalent", () => {
    assert.equal(monthlyEquivalentMinor(649_00, monthly), 649_00);
    assert.equal(yearlyEquivalentMinor(649_00, monthly), 7788_00);
    assert.equal(monthlyEquivalentMinor(1499_00, yearly), 124_92);
    assert.equal(yearlyEquivalentMinor(1499_00, yearly), 1499_00);
    assert.equal(monthlyEquivalentMinor(100_00, { every: 1, unit: "week" }), 434_82);
    assert.equal(monthlyEquivalentMinor(900_00, { every: 3, unit: "month" }), 300_00);
  });

  it("in words", () => {
    assert.equal(frequencyLabel(monthly), "Monthly");
    assert.equal(frequencyLabel({ every: 3, unit: "month" }), "Quarterly");
    assert.equal(frequencyLabel({ every: 6, unit: "month" }), "Half-yearly");
    assert.equal(frequencyLabel(yearly), "Yearly");
    assert.equal(frequencyLabel({ every: 2, unit: "week" }), "Every 2 weeks");
    assert.equal(frequencyLabel({ every: 45, unit: "day" }), "Every 45 days");
  });
});

describe("telling a subscription from its charges", () => {
  it("reads the frequency off the gaps, with a weekend's slack", () => {
    assert.deepEqual(frequencyFromGaps([30, 31, 30]), monthly);
    assert.deepEqual(frequencyFromGaps([28, 33, 31]), monthly);
    assert.deepEqual(frequencyFromGaps([7, 7, 8]), { every: 1, unit: "week" });
    assert.deepEqual(frequencyFromGaps([91, 92]), { every: 3, unit: "month" });
    assert.deepEqual(frequencyFromGaps([365]), yearly);
    assert.equal(frequencyFromGaps([3, 30, 12]), null, "random spending is not a subscription");
    assert.equal(frequencyFromGaps([]), null);
  });
});
