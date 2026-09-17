import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { istDayKey } from "../../time";
import { cycleFor, floatDays } from "./cards.cycle";

/** An IST calendar day, as an instant at noon so no boundary is grazed. */
function on(day: string): Date {
  return new Date(`${day}T12:00:00+05:30`);
}

function days(cycle: ReturnType<typeof cycleFor>) {
  return {
    start: istDayKey(cycle!.start),
    endsOn: istDayKey(cycle!.endsOn),
    statementOn: istDayKey(cycle!.statementOn),
    dueOn: cycle!.dueOn ? istDayKey(cycle!.dueOn) : null,
  };
}

describe("cycleFor", () => {
  const card = { statementDay: 12, dueDay: 1 };

  it("puts a payment before the statement day on this month's bill", () => {
    assert.deepEqual(days(cycleFor(card, on("2026-09-05"))), {
      start: "2026-08-12",
      endsOn: "2026-09-11",
      statementOn: "2026-09-12",
      dueOn: "2026-10-01",
    });
  });

  it("starts a new cycle on the statement day itself", () => {
    // The one that decides whether a limit has reset. A bill drawn on the
    // 12th covers up to the 11th, so what is spent on the 12th is on the
    // next bill - and the counter for this cycle is back at zero.
    assert.deepEqual(days(cycleFor(card, on("2026-09-12"))), {
      start: "2026-09-12",
      endsOn: "2026-10-11",
      statementOn: "2026-10-12",
      dueOn: "2026-11-01",
    });
  });

  it("puts the day after the statement in that same new cycle", () => {
    assert.deepEqual(days(cycleFor(card, on("2026-09-13"))), {
      start: "2026-09-12",
      endsOn: "2026-10-11",
      statementOn: "2026-10-12",
      dueOn: "2026-11-01",
    });
  });

  it("has no cycle for a card with no statement day", () => {
    assert.equal(cycleFor({ statementDay: null, dueDay: 5 }, on("2026-09-13")), null);
  });

  it("has no due date for a card with no due day", () => {
    assert.equal(cycleFor({ statementDay: 12 }, on("2026-09-05"))!.dueOn, null);
  });

  describe("month ends", () => {
    const lateCard = { statementDay: 31, dueDay: 20 };

    it("clamps a statement day past the end of a short month", () => {
      assert.equal(days(cycleFor(lateCard, on("2026-02-10"))).statementOn, "2026-02-28");
    });

    it("uses the real length of a leap February", () => {
      assert.equal(days(cycleFor(lateCard, on("2028-02-10"))).statementOn, "2028-02-29");
    });

    it("goes back to the 31st the following month", () => {
      // The clamp applies to February alone, not to every month after it.
      assert.equal(days(cycleFor(lateCard, on("2026-03-10"))).statementOn, "2026-03-31");
    });

    it("starts the March cycle on February's statement day", () => {
      assert.equal(days(cycleFor(lateCard, on("2026-03-10"))).start, "2026-02-28");
    });
  });

  describe("due dates", () => {
    it("falls in the next month when the due day is earlier than the statement", () => {
      const cycle = cycleFor({ statementDay: 12, dueDay: 1 }, on("2026-09-05"));
      assert.equal(days(cycle).dueOn, "2026-10-01");
    });

    it("falls in the same month when the due day is later", () => {
      // A card that statements on the 1st and is due on the 20th. The 1st
      // opens a cycle, so the bill in question is the next one.
      const cycle = cycleFor({ statementDay: 1, dueDay: 20 }, on("2026-09-01"));
      assert.equal(days(cycle).statementOn, "2026-10-01");
      assert.equal(days(cycle).dueOn, "2026-10-20");
    });

    it("rolls over the year", () => {
      const cycle = cycleFor({ statementDay: 28, dueDay: 15 }, on("2026-12-20"));
      assert.equal(days(cycle).statementOn, "2026-12-28");
      assert.equal(days(cycle).dueOn, "2027-01-15");
    });
  });

  it("covers every day without a gap or an overlap", () => {
    // Walking a year day by day. Each day must fall inside its own cycle,
    // and each cycle must butt up against the one before it - the day
    // after one ends is the day the next begins. The 31st is the worst
    // case, because February moves it and March moves it back.
    const seen = new Set<string>();
    let previous: ReturnType<typeof days> | null = null;

    for (let i = 0; i < 365; i += 1) {
      const date = new Date(Date.parse("2026-01-01T12:00:00+05:30") + i * 86400000);
      const today = istDayKey(date);
      const cycle = days(cycleFor({ statementDay: 31, dueDay: 20 }, date));

      assert.ok(cycle.start <= today, `${today} is before its own cycle`);
      assert.ok(today <= cycle.endsOn, `${today} is after its own cycle`);

      if (previous && previous.start !== cycle.start) {
        const dayAfterPrevious = istDayKey(
          new Date(Date.parse(`${previous.endsOn}T12:00:00+05:30`) + 86400000)
        );
        assert.equal(cycle.start, dayAfterPrevious, `a gap after ${previous.endsOn}`);
        seen.add(cycle.start);
      }
      previous = cycle;
    }

    assert.ok(seen.size >= 11, `expected a cycle a month, saw ${seen.size}`);
  });
});

describe("floatDays", () => {
  it("gives the days until a payment today has to be paid for", () => {
    const card = { statementDay: 12, dueDay: 1 };
    // Spent on the 13th: bill on 12 Oct, due 1 Nov.
    assert.equal(floatDays(card, on("2026-09-13")), 49);
  });

  it("answers the two-card question", () => {
    // The real one: two RuPay cards, statements on the 1st and the 17th,
    // both due twenty days later. Paying on the 13th, one has just opened
    // a fresh cycle and the other is about to close.
    const first = { statementDay: 1, dueDay: 20 };
    const seventeenth = { statementDay: 17, dueDay: 6 };

    const firstFloat = floatDays(first, on("2026-09-13"))!;
    const seventeenthFloat = floatDays(seventeenth, on("2026-09-13"))!;

    assert.equal(firstFloat, 37, "bill on 1 Oct, due 20 Oct");
    assert.equal(seventeenthFloat, 23, "bill on 17 Sep, due 6 Oct");
    assert.ok(firstFloat > seventeenthFloat, "the fresh cycle wins by a fortnight");
  });

  it("is longest on the statement day itself", () => {
    // The bill has just been drawn, so a purchase this morning has the
    // whole of the new cycle plus the grace period before it is paid for.
    // The day before has none of that: it is on the bill arriving tomorrow.
    const card = { statementDay: 17, dueDay: 6 };
    const dayBefore = floatDays(card, on("2026-09-16"))!;
    const onStatement = floatDays(card, on("2026-09-17"))!;

    assert.equal(dayBefore, 20, "bill on 17 Sep, due 6 Oct");
    assert.equal(onStatement, 50, "bill on 17 Oct, due 6 Nov");
    assert.ok(onStatement > dayBefore, "the statement day resets the clock");
  });

  it("is null for a card with no dates recorded", () => {
    assert.equal(floatDays({ statementDay: null, dueDay: null }, on("2026-09-13")), null);
  });
});
