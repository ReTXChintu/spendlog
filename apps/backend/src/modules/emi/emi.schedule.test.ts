import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addMonths, buildSchedule, monthlyInstalmentMinor } from "./emi.schedule";

describe("monthlyInstalmentMinor", () => {
  it("splits a no-cost EMI evenly", () => {
    // ₹36,000 over 12 months at no interest.
    assert.equal(monthlyInstalmentMinor(3600000, 12, 0), 300000);
  });

  it("computes a reducing-balance instalment", () => {
    // ₹36,000 over 12 months at 14% a year. Standard tables put this at
    // roughly ₹3,233 a month.
    const monthly = monthlyInstalmentMinor(3600000, 12, 14);
    assert.ok(monthly > 320000 && monthly < 325000, `got ${monthly}`);
  });

  it("charges more per month over a shorter term", () => {
    const short = monthlyInstalmentMinor(3600000, 6, 14);
    const long = monthlyInstalmentMinor(3600000, 24, 14);
    assert.ok(short > long);
  });

  it("collects more in total over a longer term", () => {
    const short = monthlyInstalmentMinor(3600000, 6, 14) * 6;
    const long = monthlyInstalmentMinor(3600000, 24, 14) * 24;
    assert.ok(long > short, "a longer term costs more interest overall");
  });

  it("repays the whole principal in a single month", () => {
    assert.equal(monthlyInstalmentMinor(500000, 1, 0), 500000);
  });

  it("refuses a term of no months", () => {
    assert.throws(() => monthlyInstalmentMinor(500000, 0, 12));
  });
});

describe("addMonths", () => {
  it("keeps the same day of the month", () => {
    const result = addMonths(new Date("2026-01-15T00:00:00Z"), 1);
    assert.equal(result.toISOString().slice(0, 10), "2026-02-15");
  });

  it("clamps to the end of a shorter month", () => {
    // Rolling over to 2 March would put two instalments in March and none
    // in February.
    const result = addMonths(new Date("2026-01-31T00:00:00Z"), 1);
    assert.equal(result.toISOString().slice(0, 10), "2026-02-28");
  });

  it("uses the real length of a leap February", () => {
    const result = addMonths(new Date("2028-01-31T00:00:00Z"), 1);
    assert.equal(result.toISOString().slice(0, 10), "2028-02-29");
  });

  it("does not lose the original day on the following month", () => {
    // The clamp applies to February alone; March still bills on the 31st.
    const start = new Date("2026-01-31T00:00:00Z");
    assert.equal(addMonths(start, 2).toISOString().slice(0, 10), "2026-03-31");
  });

  it("crosses a year boundary", () => {
    const result = addMonths(new Date("2026-11-20T00:00:00Z"), 3);
    assert.equal(result.toISOString().slice(0, 10), "2027-02-20");
  });
});

describe("buildSchedule", () => {
  it("bills every month at the same amount", () => {
    const schedule = buildSchedule(new Date("2026-09-10T00:00:00Z"), 12, 320000);

    assert.equal(schedule.length, 12);
    assert.ok(schedule.every((entry) => entry.amountMinor === 320000));
    assert.deepEqual(
      schedule.map((entry) => entry.seq),
      Array.from({ length: 12 }, (_, i) => i + 1)
    );
  });

  it("starts on the purchase date and runs monthly from there", () => {
    const schedule = buildSchedule(new Date("2026-09-10T00:00:00Z"), 3, 100000);

    assert.deepEqual(
      schedule.map((entry) => entry.dueDate.toISOString().slice(0, 10)),
      ["2026-09-10", "2026-10-10", "2026-11-10"]
    );
  });

  it("totals the monthly amount times the term", () => {
    const schedule = buildSchedule(new Date("2026-09-10T00:00:00Z"), 12, 320000);
    const total = schedule.reduce((sum, entry) => sum + entry.amountMinor, 0);

    assert.equal(total, 320000 * 12);
  });
});
