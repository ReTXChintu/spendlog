import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  istDayEnd,
  istDayKey,
  istDayStart,
  istMonthEnd,
  istMonthKey,
  istMonthStart,
} from "./time";

describe("istDayKey", () => {
  it("keeps an evening payment on the same day", () => {
    // 11 Sep, 7:21pm in Delhi.
    assert.equal(istDayKey(new Date("2026-09-11T13:51:00Z")), "2026-09-11");
  });

  it("puts an after-midnight payment on the new day", () => {
    // 12 Sep, 1:00am IST. In UTC this is still the 11th, which is what put
    // it on the wrong day before.
    assert.equal(istDayKey(new Date("2026-09-11T19:30:00Z")), "2026-09-12");
  });

  it("puts an early-morning payment on the right day", () => {
    // 11 Sep, 5:00am IST — 10 Sep in UTC.
    assert.equal(istDayKey(new Date("2026-09-10T23:30:00Z")), "2026-09-11");
  });

  it("handles the exact moment a day begins", () => {
    assert.equal(istDayKey(new Date("2026-09-10T18:30:00Z")), "2026-09-11");
  });

  it("handles the last instant of a day", () => {
    assert.equal(istDayKey(new Date("2026-09-10T18:29:59.999Z")), "2026-09-10");
  });
});

describe("istMonthKey", () => {
  it("keeps a late-night payment on the 31st in that month", () => {
    // 31 Aug, 11:30pm IST. UTC calls it 31 Aug 18:00, same month here —
    // but 1 Sep 00:30 IST would have been August in UTC.
    assert.equal(istMonthKey(new Date("2026-08-31T18:00:00Z")), "2026-08");
    assert.equal(istMonthKey(new Date("2026-08-31T19:00:00Z")), "2026-09");
  });
});

describe("istDayStart and istDayEnd", () => {
  it("starts a day at 6:30pm UTC the evening before", () => {
    assert.equal(istDayStart("2026-09-11").toISOString(), "2026-09-10T18:30:00.000Z");
  });

  it("ends a millisecond before the next day starts", () => {
    const end = istDayEnd("2026-09-11");
    assert.equal(end.toISOString(), "2026-09-11T18:29:59.999Z");
    assert.equal(end.getTime() + 1, istDayStart("2026-09-12").getTime());
  });

  it("covers exactly one day", () => {
    const span = istDayEnd("2026-09-11").getTime() - istDayStart("2026-09-11").getTime();
    assert.equal(span, 24 * 60 * 60 * 1000 - 1);
  });

  it("round-trips against istDayKey", () => {
    for (const day of ["2026-01-01", "2026-02-28", "2026-09-11", "2026-12-31"]) {
      assert.equal(istDayKey(istDayStart(day)), day);
      assert.equal(istDayKey(istDayEnd(day)), day);
    }
  });
});

describe("istMonthStart and istMonthEnd", () => {
  it("starts a month at 6:30pm UTC on the last of the previous one", () => {
    assert.equal(istMonthStart("2026-09").toISOString(), "2026-08-31T18:30:00.000Z");
  });

  it("ends where the next month starts", () => {
    assert.equal(istMonthEnd("2026-09").getTime(), istMonthStart("2026-10").getTime());
  });

  it("rolls over the year", () => {
    assert.equal(istMonthEnd("2026-12").toISOString(), "2026-12-31T18:30:00.000Z");
    assert.equal(istMonthKey(istMonthEnd("2026-12")), "2027-01");
  });

  it("covers February without dropping or repeating a day", () => {
    const days = (istMonthEnd("2026-02").getTime() - istMonthStart("2026-02").getTime()) / 86400000;
    assert.equal(days, 28);
    const leapDays = (istMonthEnd("2028-02").getTime() - istMonthStart("2028-02").getTime()) / 86400000;
    assert.equal(leapDays, 29);
  });
});
