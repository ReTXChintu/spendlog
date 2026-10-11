import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assumptionFor, GOAL_ASSUMPTIONS, goalPlan, monthsLeft, projectValue, requiredMonthly } from "./goals.plan";

describe("the return assumed for a goal", () => {
  it("follows how long there is", () => {
    const at = (months: number) => assumptionFor(months).id;
    assert.equal(at(0), "liquid");
    assert.equal(at(11), "liquid");
    assert.equal(at(12), "short_debt");
    assert.equal(at(36), "short_debt");
    assert.equal(at(37), "hybrid");
    assert.equal(at(60), "hybrid");
    assert.equal(at(61), "equity");
    assert.equal(at(240), "equity");
  });

  it("covers every month with exactly one band", () => {
    for (let months = 0; months <= 120; months += 1) {
      const bands = GOAL_ASSUMPTIONS.filter((band) => months >= band.fromMonths && (band.toMonths === null || months <= band.toMonths));
      assert.equal(bands.length, 1, `month ${months}`);
    }
    assert.deepEqual(
      GOAL_ASSUMPTIONS.map((band) => band.annualReturnPercent),
      [6.5, 7, 9, 11]
    );
  });

  it("counts calendar months", () => {
    assert.equal(monthsLeft("2026-10-11", "2027-10-11"), 12);
    assert.equal(monthsLeft("2026-10-11", "2027-10-10"), 11);
    assert.equal(monthsLeft("2026-10-11", "2026-10-30"), 0);
    assert.equal(monthsLeft("2026-10-11", "2026-01-01"), 0);
  });
});

describe("the monthly SIP a goal needs", () => {
  it("reaches the target exactly, and a little less doesn't", () => {
    const { monthlyMinor } = requiredMonthly(20_000_000, 0, 12, 7);
    // ₹2 lakh in a year at 7%: about ₹16,064 a month.
    assert.ok(Math.abs(monthlyMinor - 1_606_400) < 1_000, `${monthlyMinor}`);
    assert.ok(projectValue(0, monthlyMinor, 12, 7) >= 20_000_000);
    assert.ok(projectValue(0, monthlyMinor - 100, 12, 7) < 20_000_000);
  });

  it("counts what's already there, grown to the date", () => {
    const without = requiredMonthly(20_000_000, 0, 24, 7).monthlyMinor;
    const withSome = requiredMonthly(20_000_000, 5_000_000, 24, 7).monthlyMinor;
    assert.ok(withSome < without);
    const exact = projectValue(5_000_000, withSome, 24, 7);
    assert.ok(exact >= 20_000_000 && exact < 20_000_000 + 30 * 100);
  });

  it("needs nothing when today's money gets there on its own", () => {
    assert.deepEqual(requiredMonthly(10_000_000, 9_800_000, 12, 6.5), { monthlyMinor: 0, lumpSumMinor: 0 });
  });

  it("asks for a lump sum once there are no months left", () => {
    assert.deepEqual(requiredMonthly(10_000_000, 4_000_000, 0, 6.5), { monthlyMinor: 0, lumpSumMinor: 6_000_000 });
  });
});

describe("a goal's status", () => {
  const laptop = { targetMinor: 20_000_000, targetOn: "2027-06-11", today: "2026-10-11" };

  it("plans a laptop in eight months on a liquid fund", () => {
    const plan = goalPlan({ ...laptop, currentMinor: 0, actualMonthlyMinor: 0 });
    assert.equal(plan.monthsLeft, 8);
    assert.equal(plan.assumption.id, "liquid");
    assert.ok(plan.requiredMonthlyMinor > 2_400_000 && plan.requiredMonthlyMinor < 2_500_000, `${plan.requiredMonthlyMinor}`);
    assert.equal(plan.status, "behind");
    assert.equal(plan.shortfallMonthlyMinor, plan.requiredMonthlyMinor);
    assert.equal(plan.progressPercent, 0);
  });

  it("is on track when what goes in each month is enough", () => {
    const needed = goalPlan({ ...laptop, currentMinor: 5_000_000, actualMonthlyMinor: 0 }).requiredMonthlyMinor;
    const plan = goalPlan({ ...laptop, currentMinor: 5_000_000, actualMonthlyMinor: needed });
    assert.equal(plan.status, "on_track");
    assert.equal(plan.shortfallMonthlyMinor, 0);
    assert.ok(plan.projectedMinor >= 20_000_000 * 0.999);
    assert.equal(plan.progressPercent, 25);
  });

  it("is behind when the monthly amount falls short", () => {
    const needed = goalPlan({ ...laptop, currentMinor: 0, actualMonthlyMinor: 0 }).requiredMonthlyMinor;
    const plan = goalPlan({ ...laptop, currentMinor: 0, actualMonthlyMinor: Math.round(needed * 0.8) });
    assert.equal(plan.status, "behind");
    assert.ok(plan.projectedMinor < 20_000_000);
  });

  it("is done once the money is there", () => {
    assert.equal(goalPlan({ ...laptop, currentMinor: 20_500_000, actualMonthlyMinor: 0 }).status, "done");
  });

  it("is behind, with a lump sum, when the date has come and the money hasn't", () => {
    const plan = goalPlan({ ...laptop, today: "2027-06-11", currentMinor: 15_000_000, actualMonthlyMinor: 1_000_000 });
    assert.equal(plan.status, "behind");
    assert.equal(plan.lumpSumNeededMinor, 5_000_000);
  });
});
