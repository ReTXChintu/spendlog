import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDays,
  buildLedger,
  cagr,
  categoryStats,
  downsample,
  fundFlags,
  NavSeries,
  rankAmong,
  sipDates,
  summariseHolding,
  trailingReturn,
  xirr,
} from "./funds.math";

/** Weekday NAVs from `from` to `to`, growing at `annual` a year from `start`. */
function series(from: string, to: string, start = 10, annual = 0.1, skip: string[] = []): NavSeries {
  const days: string[] = [];
  const navs: number[] = [];
  for (let day = from, offset = 0; day <= to; day = addDays(day, 1), offset += 1) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6 || skip.includes(day)) continue;
    days.push(day);
    navs.push(start * Math.pow(1 + annual, offset / 365));
  }
  return { days, navs };
}

const near = (actual: number | null, expected: number, within = 1e-6) => {
  assert.ok(actual !== null, `expected ${expected}, got null`);
  assert.ok(Math.abs(actual - expected) < within, `expected ${expected}, got ${actual}`);
};

describe("xirr", () => {
  it("matches the spreadsheet example", () => {
    // The worked example from Excel's own XIRR documentation.
    const rate = xirr([
      { day: "2008-01-01", amount: -10_000 },
      { day: "2008-03-01", amount: 2_750 },
      { day: "2008-10-30", amount: 4_250 },
      { day: "2009-02-15", amount: 3_250 },
      { day: "2009-04-01", amount: 2_750 },
    ]);
    near(rate, 0.373362535, 1e-6);
  });

  it("is the plain annual growth for one investment and its value", () => {
    near(xirr([{ day: "2025-01-01", amount: -1_000 }, { day: "2026-01-01", amount: 1_100 }]), 0.1);
  });

  it("finds a near-total loss, where Newton's method can't", () => {
    const rate = xirr([{ day: "2025-01-01", amount: -1_000 }, { day: "2026-01-01", amount: 1 }]);
    near(rate, -0.999, 1e-6);
  });

  it("is null with nothing to solve", () => {
    assert.equal(xirr([{ day: "2025-01-01", amount: -1_000 }]), null);
    assert.equal(xirr([{ day: "2025-01-01", amount: -1_000 }, { day: "2025-06-01", amount: -1_000 }]), null);
    assert.equal(xirr([{ day: "2025-01-01", amount: -1_000 }, { day: "2025-01-01", amount: 1_050 }]), null);
    assert.equal(xirr([]), null);
  });

  it("weights money by how long it was in", () => {
    // Two equal instalments a year apart, worth 10% a year on each.
    const rate = xirr([
      { day: "2024-01-01", amount: -1_000 },
      { day: "2025-01-01", amount: -1_000 },
      { day: "2026-01-01", amount: 1_000 * Math.pow(1.1, 731 / 365) + 1_000 * 1.1 },
    ]);
    near(rate, 0.1, 1e-6);
  });
});

describe("cagr and trailing returns", () => {
  it("annualises growth over the days given", () => {
    near(cagr(100, 121, 730), 0.1);
    assert.equal(cagr(0, 121, 730), null);
    assert.equal(cagr(100, 121, 0), null);
  });

  it("reads 1y and 3y from the history, stepping back over a weekend", () => {
    // 2023-10-08 is a Sunday, so 3y back from 2026-10-08 lands on the Friday.
    const history = series("2020-01-01", "2026-10-08", 10, 0.12);
    near(trailingReturn(history, 1), 0.12);
    near(trailingReturn(history, 3), 0.12);
  });

  it("is null for a fund younger than the period", () => {
    const young = series("2025-01-01", "2026-10-09");
    assert.ok(trailingReturn(young, 1) !== null);
    assert.equal(trailingReturn(young, 3), null);
  });

  it("is null across a hole in the history rather than reaching far back", () => {
    const history = series("2020-01-01", "2026-10-09");
    const target = "2025-10-09";
    const holed = {
      days: history.days.filter((day) => day < addDays(target, -20) || day > target),
      navs: history.navs.filter((_, i) => history.days[i] < addDays(target, -20) || history.days[i] > target),
    };
    assert.equal(trailingReturn(holed, 1), null);
  });
});

describe("sipDates", () => {
  it("falls on the last day of short months for a SIP on the 31st", () => {
    assert.deepEqual(sipDates({ amountMinor: 1, dayOfMonth: 31, startOn: "2026-01-15" }, "2026-04-30"), [
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("starts on the first SIP day on or after the start, and stops at the end date or today", () => {
    const sip = { amountMinor: 1, dayOfMonth: 5, startOn: "2026-01-06", endOn: "2026-05-04" };
    assert.deepEqual(sipDates(sip, "2026-10-11"), ["2026-02-05", "2026-03-05", "2026-04-05"]);
    assert.deepEqual(sipDates({ ...sip, endOn: null }, "2026-06-04"), ["2026-02-05", "2026-03-05", "2026-04-05", "2026-05-05"]);
  });

  it("leaves out everything on or before a cut-off", () => {
    const sip = { amountMinor: 1, dayOfMonth: 5, startOn: "2026-01-01" };
    assert.deepEqual(sipDates(sip, "2026-05-10", "2026-03-05"), ["2026-04-05", "2026-05-05"]);
  });
});

describe("buildLedger", () => {
  // Weekdays only, with a holiday on Thursday 5 March 2026.
  const nav = series("2025-01-01", "2026-10-09", 100, 0.1, ["2026-03-05"]);
  const sip = { amountMinor: 500_000, dayOfMonth: 5, startOn: "2026-01-01" };
  const today = "2026-10-11";
  const scheduled = (entries: ReturnType<typeof buildLedger>) => entries.filter((entry) => entry.kind === "SIP_SCHEDULED");

  it("works out each instalment from the NAV on its day, or the next one for a holiday", () => {
    const entries = buildLedger({ sip, series: nav, today });
    assert.equal(entries.length, 10); // January to October
    const march = entries.find((entry) => entry.on === "2026-03-05")!;
    assert.equal(march.navDay, "2026-03-06");
    near(march.units, 5_000 / march.nav!);
    // 4 and 5 April 2026 are a weekend: Monday's NAV.
    assert.equal(entries.find((entry) => entry.on === "2026-04-05")!.navDay, "2026-04-06");
  });

  it("leaves out an instalment whose NAV isn't out yet", () => {
    const entries = buildLedger({ sip: { ...sip, dayOfMonth: 10 }, series: nav, today });
    // Due 10 October, but the last NAV is the 9th.
    assert.equal(entries.at(-1)!.on, "2026-09-10");
  });

  it("lets a linked debit replace the scheduled instalment of the same cycle", () => {
    const entries = buildLedger({
      sip,
      series: nav,
      today,
      linked: [{ transactionId: "t1", on: "2026-06-04", amountMinor: 500_500, via: "link" }],
    });
    assert.equal(entries.length, 10);
    assert.equal(scheduled(entries).some((entry) => entry.on === "2026-06-05"), false);
    const linked = entries.find((entry) => entry.kind === "LINKED")!;
    assert.equal(linked.amountMinor, 500_500);
    assert.equal(linked.counted, true);
    assert.equal(linked.navDay, "2026-06-04");
  });

  it("matches across a month boundary: a SIP on the 1st debited on the 31st", () => {
    const entries = buildLedger({
      sip: { ...sip, dayOfMonth: 1 },
      series: nav,
      today,
      linked: [{ transactionId: "t1", on: "2026-07-31", amountMinor: 500_000, via: "link" }],
    });
    const dates = scheduled(entries).map((entry) => entry.on);
    assert.ok(!dates.includes("2026-08-01"));
    assert.ok(dates.includes("2026-07-01"));
    assert.equal(entries.length, 10);
  });

  it("adds a second debit in the same cycle as an extra purchase", () => {
    const entries = buildLedger({
      sip,
      series: nav,
      today,
      linked: [
        { transactionId: "t1", on: "2026-06-05", amountMinor: 500_000, via: "link" },
        { transactionId: "t2", on: "2026-06-08", amountMinor: 200_000, via: "link" },
      ],
    });
    assert.equal(entries.length, 11);
  });

  it("counts a debit linked by hand and through a commitment once", () => {
    const entries = buildLedger({
      sip,
      series: nav,
      today,
      linked: [
        { transactionId: "t1", on: "2026-06-05", amountMinor: 500_000, via: "commitment" },
        { transactionId: "t1", txnId: "x", on: "2026-06-05", amountMinor: 500_000, via: "link" },
      ],
    });
    const linked = entries.filter((entry) => entry.kind === "LINKED");
    assert.equal(linked.length, 1);
    assert.equal(linked[0].via, "link");
  });

  it("treats the opening snapshot as everything up to its day", () => {
    const opening = { units: 300, investedMinor: 3_000_000, asOf: "2026-06-30" };
    const entries = buildLedger({
      sip: { ...sip, startOn: "2025-01-01" },
      opening,
      series: nav,
      today,
      linked: [{ transactionId: "t1", on: "2026-06-05", amountMinor: 500_000, via: "link" }],
      manual: [{ txnId: "m1", kind: "MANUAL_BUY", on: "2026-05-02", amountMinor: 100_000 }],
    });
    // In date order: what the snapshot already holds comes before it.
    assert.deepEqual(
      entries.slice(0, 3).map((entry) => entry.kind),
      ["MANUAL_BUY", "LINKED", "OPENING"]
    );
    assert.deepEqual(
      scheduled(entries).map((entry) => entry.on),
      ["2026-07-05", "2026-08-05", "2026-09-05", "2026-10-05"]
    );
    const inside = entries.filter((entry) => entry.kind === "LINKED" || entry.kind === "MANUAL_BUY");
    assert.ok(inside.every((entry) => !entry.counted && entry.units === 0 && entry.note === "Inside the opening balance"));

    const summary = summariseHolding(entries, nav, opening);
    const sipUnits = scheduled(entries).reduce((sum, entry) => sum + entry.units, 0);
    near(summary.units, 300 + sipUnits);
    assert.equal(summary.investedMinor, 3_000_000 + 4 * 500_000);
  });

  it("keeps a debit whose NAV isn't out yet out of the totals until it is", () => {
    const entries = buildLedger({
      series: nav,
      today,
      linked: [{ transactionId: "t1", on: "2026-10-10", amountMinor: 500_000, via: "link" }],
    });
    assert.equal(entries[0].pending, true);
    assert.equal(entries[0].note, "Waiting for the NAV");
    const summary = summariseHolding(entries, nav);
    assert.equal(summary.investedMinor, 0);
    assert.equal(summary.units, 0);
  });
});

describe("summariseHolding", () => {
  const nav = series("2023-01-01", "2026-10-09", 100, 0.12);
  const today = "2026-10-11";

  it("adds up a SIP, with an XIRR near the fund's own growth", () => {
    const sip = { amountMinor: 500_000, dayOfMonth: 5, startOn: "2024-01-01" };
    const entries = buildLedger({ sip, series: nav, today });
    const summary = summariseHolding(entries, nav);
    assert.equal(summary.investedMinor, entries.length * 500_000);
    assert.equal(summary.totalInvestedMinor, summary.investedMinor);
    assert.ok(summary.valueMinor > summary.investedMinor);
    near(summary.xirr, 0.12, 0.002);
    assert.equal(summary.firstOn, "2024-01-05");
    assert.equal(summary.nav!.day, "2026-10-09");
    assert.ok(summary.dayChangeMinor > 0);
  });

  it("leaves XIRR out until the money has been in for 90 days", () => {
    const entries = buildLedger({ sip: { amountMinor: 500_000, dayOfMonth: 5, startOn: "2026-08-01" }, series: nav, today });
    assert.equal(summariseHolding(entries, nav).xirr, null);
  });

  it("measures an opening snapshot from its own value on the day, or from halfway since the first investment", () => {
    const at = nav.navs[nav.days.indexOf("2025-10-09")];
    const opening = { units: 1_000, investedMinor: 50_000 * 100, asOf: "2025-10-09" };
    const sinceSnapshot = summariseHolding(buildLedger({ opening, series: nav, today }), nav, opening);
    assert.equal(sinceSnapshot.investedMinor, 5_000_000);
    near(sinceSnapshot.valueMinor / 100, 1_000 * nav.navs.at(-1)!, 0.01);
    // Value on the day to value now: the fund's 12%.
    near(sinceSnapshot.xirr, 0.12, 1e-4);
    assert.ok(at > 0);

    const withStart = { ...opening, firstOn: "2023-10-09" };
    const placed = summariseHolding(buildLedger({ opening: withStart, series: nav, today }), nav, withStart);
    assert.equal(placed.firstOn, "2023-10-09");
    assert.ok(placed.heldDays > 1000);
    assert.notEqual(placed.xirr, sinceSnapshot.xirr);
  });

  it("takes redemptions out at average cost", () => {
    const entries = buildLedger({
      series: nav,
      today,
      manual: [
        { txnId: "a", kind: "MANUAL_BUY", on: "2025-01-06", amountMinor: 1_000_000, units: 100 },
        { txnId: "b", kind: "MANUAL_BUY", on: "2025-02-03", amountMinor: 3_000_000, units: 100 },
        { txnId: "c", kind: "REDEEM", on: "2025-06-02", amountMinor: 2_500_000, units: 50 },
      ],
    });
    const summary = summariseHolding(entries, nav);
    assert.equal(summary.units, 150);
    // 200 units cost 40,000; 50 of them sold cost 10,000 and fetched 25,000.
    assert.equal(summary.investedMinor, 3_000_000);
    assert.equal(summary.realisedGainMinor, 1_500_000);
    assert.equal(summary.totalInvestedMinor, 4_000_000);
  });
});

describe("category ranks and flags", () => {
  it("works out the median and average", () => {
    const stats = categoryStats([0.1, 0.3, 0.2]);
    assert.equal(stats.count, 3);
    assert.equal(stats.median, 0.2);
    near(stats.average, 0.2);
    assert.equal(categoryStats([0.1, 0.2, 0.3, 0.4]).median, 0.25);
    assert.deepEqual(categoryStats([]), { count: 0, average: null, median: null });
  });

  it("ranks a return among its peers", () => {
    const rank = rankAmong(0.1, [0.05, 0.2, 0.15])!;
    assert.equal(rank.rank, 3);
    assert.equal(rank.of, 4);
    near(rank.percentile, 100 / 3);
    assert.equal(rankAmong(0.1, []), null);
  });

  const peers = [0.08, 0.1, 0.12, 0.14, 0.16, 0.18, 0.2];
  const base = { xirr: 0.12, heldDays: 500, isRegular: false, basis: "3y" as const };

  it("flags the bottom quartile of a category", () => {
    const fundReturn = 0.09;
    assert.deepEqual(fundFlags({ ...base, fundReturn, median: 0.14, rank: rankAmong(fundReturn, peers) }), ["lagging_category"]);
  });

  it("flags a fund well under the category median even outside the bottom quartile", () => {
    // Beats 2 of 7 (28%), but 2.5 points under a 14% median.
    const fundReturn = 0.115;
    assert.deepEqual(fundFlags({ ...base, fundReturn, median: 0.14, rank: rankAmong(fundReturn, peers) }), ["lagging_category"]);
    // On 1y the margin is 3 points, so the same gap passes.
    assert.deepEqual(fundFlags({ ...base, basis: "1y", fundReturn, median: 0.14, rank: rankAmong(fundReturn, peers) }), []);
  });

  it("doesn't rank against too few peers", () => {
    assert.deepEqual(fundFlags({ ...base, fundReturn: 0.01, median: 0.1, rank: rankAmong(0.01, [0.1, 0.2]) }), []);
  });

  it("flags a negative XIRR, and one under a liquid fund's after a year", () => {
    const none = { basis: null, fundReturn: null, median: null, rank: null, isRegular: false };
    assert.deepEqual(fundFlags({ ...none, xirr: -0.02, heldDays: 120 }), ["low_xirr"]);
    assert.deepEqual(fundFlags({ ...none, xirr: 0.05, heldDays: 200 }), []);
    assert.deepEqual(fundFlags({ ...none, xirr: 0.05, heldDays: 400 }), ["low_xirr"]);
    assert.deepEqual(fundFlags({ ...none, xirr: null, heldDays: 400 }), []);
  });

  it("flags a regular plan", () => {
    assert.deepEqual(fundFlags({ xirr: null, heldDays: 0, isRegular: true, basis: null, fundReturn: null, median: null, rank: null }), [
      "regular_plan",
    ]);
  });
});

describe("downsample", () => {
  it("thins a year of NAVs, keeping the last", () => {
    const nav = series("2024-01-01", "2026-10-09");
    const points = downsample(nav, "2025-10-09", 60);
    assert.ok(points.length >= 50 && points.length <= 62, `${points.length}`);
    assert.equal(points[0].day >= "2025-10-09", true);
    assert.equal(points.at(-1)!.day, "2026-10-09");
  });
});
