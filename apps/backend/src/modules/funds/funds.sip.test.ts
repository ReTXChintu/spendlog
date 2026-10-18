import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, buildLedger, NavSeries, sipMonthPlan, summariseHolding } from "./funds.math";
import {
  addMonths,
  isPaused,
  resumedFrom,
  SipPlan,
  sipSlots,
  sipSteps,
  sipToStore,
  stepFor,
  StoredSip,
  withAmountFrom,
  withoutSkip,
  withPause,
  withSkip,
} from "./funds.sip";

/** Weekday NAVs from `from` to `to`, growing at `annual` a year. */
function series(from: string, to: string, start = 100, annual = 0.12): NavSeries {
  const days: string[] = [];
  const navs: number[] = [];
  for (let day = from, offset = 0; day <= to; day = addDays(day, 1), offset += 1) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    days.push(day);
    navs.push(start * Math.pow(1 + annual, offset / 365));
  }
  return { days, navs };
}

const near = (actual: number | null, expected: number, within = 1e-6) => {
  assert.ok(actual !== null, `expected ${expected}, got null`);
  assert.ok(Math.abs(actual - expected) < within, `expected ${expected}, got ${actual}`);
};

const stored = (result: ReturnType<typeof sipToStore>): StoredSip => {
  assert.ok(!("error" in result), "error" in result ? result.error : "");
  return result as StoredSip;
};
const problem = (result: ReturnType<typeof sipToStore>) => ("error" in result ? result.error : null);

const nav = series("2025-06-01", "2026-10-09");
const today = "2026-10-11";
const navFor = (day: string) => nav.navs[nav.days.indexOf(day)];

/**
 * The user's own: 1,000 a month, then 2,000 for two months, then a month
 * skipped, then 1,000 again. Steps from January, May and August; July
 * skipped.
 */
const theirs: SipPlan = {
  amountMinor: 100_000,
  dayOfMonth: 5,
  startOn: "2026-01-05",
  steps: [
    { fromOn: "2026-01-05", amountMinor: 100_000 },
    { fromOn: "2026-05-01", amountMinor: 200_000 },
    { fromOn: "2026-08-01", amountMinor: 100_000 },
  ],
  skips: ["2026-07"],
};

const scheduled = (entries: ReturnType<typeof buildLedger>) => entries.filter((entry) => entry.kind === "SIP_SCHEDULED");

describe("a SIP with a history", () => {
  it("counts the user's example: 1,000 a month, 2,000 for two, one skipped", () => {
    const entries = buildLedger({ sip: theirs, series: nav, today });
    const lines = scheduled(entries);

    assert.deepEqual(
      lines.map((entry) => [entry.on, entry.amountMinor]),
      [
        ["2026-01-05", 100_000],
        ["2026-02-05", 100_000],
        ["2026-03-05", 100_000],
        ["2026-04-05", 100_000],
        ["2026-05-05", 200_000],
        ["2026-06-05", 200_000],
        ["2026-08-05", 100_000],
        ["2026-09-05", 100_000],
        ["2026-10-05", 100_000],
      ]
    );
    assert.equal(lines.length, 9);
    assert.ok(lines.every((entry) => entry.month === entry.on.slice(0, 7) && entry.plannedMinor === entry.amountMinor));

    // Each month's units from that month's NAV - the next one out for a weekend.
    for (const entry of lines) {
      assert.ok(entry.navDay! >= entry.on);
      near(entry.units, entry.amountMinor / 100 / navFor(entry.navDay!));
    }

    const summary = summariseHolding(entries, nav);
    assert.equal(summary.investedMinor, 7 * 100_000 + 2 * 200_000);
    near(summary.units, lines.reduce((sum, entry) => sum + entry.units, 0));
    // The fund grew 12% a year; so did the money, timing and all.
    near(summary.xirr, 0.12, 0.005);
  });

  it("reads an old SIP with only an amount as one step, with the same figures", () => {
    const old: SipPlan = { amountMinor: 500_000, dayOfMonth: 10, startOn: "2025-08-01" };
    const migrated: SipPlan = { ...old, steps: [{ fromOn: old.startOn, amountMinor: 500_000 }], skips: [], pauses: [] };
    assert.deepEqual(sipSteps(old), [{ fromOn: "2025-08-01", amountMinor: 500_000, dayOfMonth: null }]);

    const before = buildLedger({ sip: old, series: nav, today });
    const after = buildLedger({ sip: migrated, series: nav, today });
    assert.deepEqual(after, before);
    assert.deepEqual(summariseHolding(after, nav), summariseHolding(before, nav));
  });

  it("leaves out every month of a pause, and everything after one not yet resumed", () => {
    const paused: SipPlan = { ...theirs, skips: [], pauses: [{ fromOn: "2026-03-01", toOn: "2026-05-31" }] };
    assert.deepEqual(
      scheduled(buildLedger({ sip: paused, series: nav, today })).map((entry) => entry.on.slice(0, 7)),
      ["2026-01", "2026-02", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]
    );
    assert.ok(isPaused(paused, "2026-04") && !isPaused(paused, "2026-06"));

    const open: SipPlan = { ...theirs, skips: [], pauses: [{ fromOn: "2026-08-10", toOn: null }] };
    const months = scheduled(buildLedger({ sip: open, series: nav, today })).map((entry) => entry.on.slice(0, 7));
    assert.deepEqual(months, ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"]);
    assert.equal(isPaused(open, "2030-01"), true);
  });

  it("counts a debit paid in a skipped month as that month's instalment", () => {
    const entries = buildLedger({
      sip: theirs,
      series: nav,
      today,
      linked: [{ transactionId: "t1", on: "2026-07-06", amountMinor: 100_000, via: "link" }],
    });
    const linked = entries.find((entry) => entry.kind === "LINKED")!;
    assert.equal(linked.counted, true);
    assert.equal(linked.month, "2026-07");
    assert.equal(linked.inSkippedMonth, true);
    assert.equal(linked.plannedMinor, 200_000);
    assert.equal(linked.note, "Paid in a month marked skipped, so it counts as that month's instalment");
    // It stood in for July, not for June or August, which are still there.
    assert.equal(scheduled(entries).length, 9);
    assert.equal(summariseHolding(entries, nav).investedMinor, 1_200_000);

    const plan = sipMonthPlan({ sip: theirs, today }, entries, "2026-06", "2026-08");
    const july = plan.find((month) => month.month === "2026-07")!;
    assert.equal(july.status, "invested");
    assert.equal(july.markedSkipped, true);
    assert.equal(july.linkedTransactionId, "t1");
    assert.equal(july.actualMinor, 100_000);

    // Unlinked, the skip is back.
    const without = sipMonthPlan({ sip: theirs, today }, buildLedger({ sip: theirs, series: nav, today }), "2026-07", "2026-07");
    assert.equal(without[0].status, "skipped");
  });

  it("counts a debit at what it really was, and says what was planned", () => {
    const entries = buildLedger({
      sip: theirs,
      series: nav,
      today,
      linked: [{ transactionId: "t1", on: "2026-03-05", amountMinor: 200_000, via: "link" }],
    });
    const linked = entries.find((entry) => entry.kind === "LINKED")!;
    assert.equal(linked.amountMinor, 200_000);
    assert.equal(linked.plannedMinor, 100_000);
    assert.equal(linked.inSkippedMonth, false);
    assert.equal(linked.note, "₹2,000 paid vs ₹1,000 planned");
    assert.ok(!scheduled(entries).some((entry) => entry.on === "2026-03-05"));
    assert.equal(summariseHolding(entries, nav).investedMinor, 1_100_000 + 100_000);

    const march = sipMonthPlan({ sip: theirs, today }, entries, "2026-03", "2026-03")[0];
    assert.equal(march.plannedMinor, 100_000);
    assert.equal(march.actualMinor, 200_000);
    near(march.units, 2_000 / navFor("2026-03-05"), 1e-9);

    const same = buildLedger({
      sip: theirs,
      series: nav,
      today,
      linked: [{ transactionId: "t1", on: "2026-03-05", amountMinor: 100_000, via: "link" }],
    });
    assert.equal(same.find((entry) => entry.kind === "LINKED")!.note, null);
  });

  it("moves the SIP day with a step that says so", () => {
    const moved: SipPlan = { ...theirs, steps: [...theirs.steps!, { fromOn: "2026-09-01", amountMinor: 100_000, dayOfMonth: 20 }] };
    const slots = sipSlots(moved, today);
    assert.equal(slots.find((slot) => slot.month === "2026-08")!.due, "2026-08-05");
    assert.equal(slots.find((slot) => slot.month === "2026-09")!.due, "2026-09-20");
    assert.equal(slots.at(-1)!.month, "2026-09");
    assert.deepEqual(stepFor(moved, "2026-12"), { amountMinor: 100_000, dayOfMonth: 20 });
  });
});

describe("the month-by-month plan", () => {
  it("says what became of each month: invested, skipped, paused, waiting for its NAV, upcoming", () => {
    const sip: SipPlan = { ...theirs, pauses: [{ fromOn: "2026-02-01", toOn: "2026-02-28" }], dayOfMonth: 10, steps: undefined, amountMinor: 100_000 };
    const entries = buildLedger({ sip, series: nav, today });
    const plan = sipMonthPlan({ sip, today }, entries, "2025-12", "2027-01");

    assert.deepEqual(
      plan.map((month) => [month.month, month.status]),
      [
        ["2026-01", "invested"],
        ["2026-02", "paused"],
        ["2026-03", "invested"],
        ["2026-04", "invested"],
        ["2026-05", "invested"],
        ["2026-06", "invested"],
        ["2026-07", "skipped"],
        ["2026-08", "invested"],
        ["2026-09", "invested"],
        // Due on the 10th; the last NAV is the 9th.
        ["2026-10", "pending_nav"],
        ["2026-11", "upcoming"],
        ["2026-12", "upcoming"],
        ["2027-01", "upcoming"],
      ]
    );
    const january = plan[0];
    assert.equal(january.plannedMinor, 100_000);
    assert.equal(january.actualMinor, 100_000);
    near(january.units, 1_000 / january.nav!, 1e-9);
    assert.equal(plan.at(-1)!.units, null);
  });

  it("marks the months inside the opening snapshot as covered, without units", () => {
    const opening = { units: 50, investedMinor: 500_000, asOf: "2026-04-30" };
    const entries = buildLedger({ sip: theirs, opening, series: nav, today });
    const plan = sipMonthPlan({ sip: theirs, opening, today }, entries, "2026-01", "2026-06");
    assert.deepEqual(
      plan.map((month) => [month.month, month.status, month.covered]),
      [
        ["2026-01", "invested", true],
        ["2026-02", "invested", true],
        ["2026-03", "invested", true],
        ["2026-04", "invested", true],
        ["2026-05", "invested", false],
        ["2026-06", "invested", false],
      ]
    );
    assert.equal(plan[0].units, null);
    assert.ok(plan[4].units! > 0);
  });
});

describe("storing a SIP's history", () => {
  const base = { dayOfMonth: 5, startOn: "2026-01-05" };

  it("is one step for one amount, as before", () => {
    assert.deepEqual(stored(sipToStore({ ...base, amountMinor: 100_000 }, today)), {
      ...base,
      amountMinor: 100_000,
      endOn: null,
      active: true,
      steps: [{ fromOn: "2026-01-05", amountMinor: 100_000, dayOfMonth: null }],
      skips: [],
      pauses: [],
    });
  });

  it("takes the changes alone after the starting amount, sorted, and folds a change that changes nothing", () => {
    const sip = stored(
      sipToStore(
        {
          ...base,
          amountMinor: 100_000,
          steps: [
            { fromOn: "2026-08-01", amountMinor: 100_000 },
            { fromOn: "2026-05-01", amountMinor: 200_000 },
            { fromOn: "2026-09-01", amountMinor: 100_000 },
          ],
          skips: ["2026-07", "2026-03"],
        },
        today
      )
    );
    assert.deepEqual(
      sip.steps.map((step) => [step.fromOn, step.amountMinor]),
      [
        ["2026-01-05", 100_000],
        ["2026-05-01", 200_000],
        ["2026-08-01", 100_000],
      ]
    );
    assert.deepEqual(sip.skips, ["2026-03", "2026-07"]);

    // Every amount given: the one in the start month is what it started at.
    const full = stored(sipToStore({ ...base, steps: [{ fromOn: "2026-01-20", amountMinor: 150_000 }] }, today));
    assert.equal(full.amountMinor, 150_000);
    assert.equal(full.steps[0].fromOn, "2026-01-05");
  });

  it("refuses what can't be: outside the SIP, twice in a month, too small, overlapping", () => {
    const at = (extra: object) => problem(sipToStore({ ...base, amountMinor: 100_000, endOn: "2026-12-31", ...extra }, today));
    assert.equal(at({ steps: [{ fromOn: "2025-12-01", amountMinor: 200_000 }] }), "An amount change has to fall between the SIP's start and its end.");
    assert.equal(at({ steps: [{ fromOn: "2027-01-01", amountMinor: 200_000 }] }), "An amount change has to fall between the SIP's start and its end.");
    assert.equal(
      at({ steps: [{ fromOn: "2026-05-01", amountMinor: 200_000 }, { fromOn: "2026-05-20", amountMinor: 300_000 }] }),
      "Two amount changes can't be in the same month."
    );
    assert.equal(at({ steps: [{ fromOn: "2026-05-01", amountMinor: 50 }] }), "Each SIP amount has to be at least ₹1.");
    assert.equal(at({ skips: ["2025-11"] }), "A skipped month has to fall between the SIP's start and its end.");
    assert.equal(at({ skips: ["2026-03", "2026-03"] }), "The same month is skipped twice.");
    assert.equal(at({ skips: ["2026-3"] }), "A skipped month is written YYYY-MM.");
    assert.equal(
      at({ pauses: [{ fromOn: "2026-03-01", toOn: null }, { fromOn: "2026-06-01", toOn: "2026-07-31" }] }),
      "Two pauses can't overlap."
    );
    assert.equal(at({ pauses: [{ fromOn: "2026-05-01", toOn: "2026-03-31" }] }), "A pause can't end before it starts.");
    assert.equal(problem(sipToStore({ ...base, steps: [{ fromOn: "2026-05-01", amountMinor: 200_000 }] }, today)), "Say what the SIP started at.");
    assert.equal(problem(sipToStore({ ...base }, today)), "Enter the SIP amount.");
  });

  it("keeps the stored history when an edit leaves it out, less what the new dates leave outside", () => {
    const before = stored(sipToStore({ ...base, amountMinor: 100_000, steps: theirs.steps, skips: ["2026-07"] }, today));
    const dayMoved = stored(sipToStore({ ...base, amountMinor: 100_000, dayOfMonth: 8 }, today, before));
    assert.deepEqual(dayMoved.steps, before.steps);
    assert.deepEqual(dayMoved.skips, ["2026-07"]);

    const ended = stored(sipToStore({ ...base, amountMinor: 100_000, endOn: "2026-06-30" }, today, before));
    assert.deepEqual(
      ended.steps.map((step) => step.fromOn),
      ["2026-01-05", "2026-05-01"]
    );
    assert.deepEqual(ended.skips, []);

    // Stopped without an end date: stopped today, history kept.
    const stopped = stored(sipToStore({ ...base, amountMinor: 100_000, active: false }, today, before));
    assert.equal(stopped.endOn, today);
    assert.equal(stopped.steps.length, 3);
  });
});

describe("changing a SIP's history", () => {
  const sip = stored(sipToStore({ dayOfMonth: 5, startOn: "2026-01-05", amountMinor: 100_000 }, today));
  const store = (input: ReturnType<typeof withSkip>) => stored(sipToStore(input, today, sip));

  it("steps the amount up or down from a month, replacing a change already there", () => {
    const up = store(withAmountFrom(sip, "2026-05", 200_000));
    assert.deepEqual(up.steps.map((step) => [step.fromOn, step.amountMinor]), [["2026-01-05", 100_000], ["2026-05-01", 200_000]]);
    const again = stored(sipToStore(withAmountFrom(up, "2026-05", 250_000), today, up));
    assert.deepEqual(again.steps.map((step) => step.amountMinor), [100_000, 250_000]);
    const fromStart = stored(sipToStore(withAmountFrom(up, "2026-01", 150_000), today, up));
    assert.deepEqual(fromStart.steps.map((step) => step.amountMinor), [150_000, 200_000]);
    assert.equal(fromStart.amountMinor, 150_000);
  });

  it("skips a month and takes the skip back, splitting a pause around it", () => {
    const skipped = store(withSkip(sip, "2026-04"));
    assert.deepEqual(skipped.skips, ["2026-04"]);
    assert.deepEqual(store(withSkip(skipped, "2026-04")).skips, ["2026-04"]);
    assert.deepEqual(store(withoutSkip(skipped, "2026-04")).skips, []);

    const paused = store(withPause(sip, "2026-03", "2026-06"));
    const split = stored(sipToStore(withoutSkip(paused, "2026-04"), today, paused));
    assert.deepEqual(split.pauses, [
      { fromOn: "2026-03-01", toOn: "2026-03-31" },
      { fromOn: "2026-05-01", toOn: "2026-06-30" },
    ]);
  });

  it("pauses from a month, joins pauses that touch, and resumes", () => {
    const open = store(withPause(sip, "2026-08", null));
    assert.deepEqual(open.pauses, [{ fromOn: "2026-08-01", toOn: null }]);
    const joined = stored(sipToStore(withPause(store(withPause(sip, "2026-03", "2026-04")), "2026-05", "2026-06"), today, sip));
    assert.deepEqual(joined.pauses, [{ fromOn: "2026-03-01", toOn: "2026-06-30" }]);

    const resumed = stored(sipToStore(resumedFrom(open, "2026-10"), today, open));
    assert.deepEqual(resumed.pauses, [{ fromOn: "2026-08-01", toOn: "2026-09-30" }]);
    // Resumed before it began: the pause is gone.
    assert.deepEqual(stored(sipToStore(resumedFrom(open, "2026-08"), today, open)).pauses, []);
    assert.equal(addMonths("2026-12", 1), "2027-01");
    assert.equal(addMonths("2026-01", -1), "2025-12");
  });
});
