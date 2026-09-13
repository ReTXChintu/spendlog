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
    statementOn: istDayKey(cycle!.statementOn),
    dueOn: cycle!.dueOn ? istDayKey(cycle!.dueOn) : null,
  };
}

describe("cycleFor", () => {
  const card = { statementDay: 12, dueDay: 1 };

  it("puts a payment before the statement day on this month's bill", () => {
    assert.deepEqual(days(cycleFor(card, on("2026-09-05"))), {
      start: "2026-08-13",
      statementOn: "2026-09-12",
      dueOn: "2026-10-01",
    });
  });

  it("includes the statement day itself in that bill", () => {
    assert.equal(days(cycleFor(card, on("2026-09-12"))).statementOn, "2026-09-12");
  });

  it("puts the day after the statement on next month's bill", () => {
    // The case that decides which card to pay with.
    assert.deepEqual(days(cycleFor(card, on("2026-09-13"))), {
      start: "2026-09-13",
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

    it("starts the March cycle the day after February's statement", () => {
      assert.equal(days(cycleFor(lateCard, on("2026-03-10"))).start, "2026-03-01");
    });
  });

  describe("due dates", () => {
    it("falls in the next month when the due day is earlier than the statement", () => {
      const cycle = cycleFor({ statementDay: 12, dueDay: 1 }, on("2026-09-05"));
      assert.equal(days(cycle).dueOn, "2026-10-01");
    });

    it("falls in the same month when the due day is later", () => {
      // A card that statements on the 1st and is due on the 20th.
      const cycle = cycleFor({ statementDay: 1, dueDay: 20 }, on("2026-09-01"));
      assert.equal(days(cycle).statementOn, "2026-09-01");
      assert.equal(days(cycle).dueOn, "2026-09-20");
    });

    it("rolls over the year", () => {
      const cycle = cycleFor({ statementDay: 28, dueDay: 15 }, on("2026-12-20"));
      assert.equal(days(cycle).statementOn, "2026-12-28");
      assert.equal(days(cycle).dueOn, "2027-01-15");
    });
  });

  it("covers every day without a gap or an overlap", () => {
    // Walking a year day by day, each one must belong to exactly one cycle,
    // and consecutive cycles must butt up against each other.
    const seen = new Set<string>();
    let previousStatement: string | null = null;

    for (let i = 0; i < 365; i += 1) {
      const date = new Date(Date.parse("2026-01-01T12:00:00+05:30") + i * 86400000);
      const cycle = days(cycleFor({ statementDay: 31, dueDay: 20 }, date));

      assert.ok(
        istDayKey(new Date(`${cycle.start}T00:00:00+05:30`)) <= istDayKey(date),
        `${istDayKey(date)} is before its own cycle`
      );
      assert.ok(istDayKey(date) <= cycle.statementOn, `${istDayKey(date)} is after its statement`);

      if (previousStatement && cycle.statementOn !== previousStatement) {
        seen.add(cycle.statementOn);
      }
      previousStatement = cycle.statementOn;
    }

    assert.ok(seen.size >= 11, `expected a statement a month, saw ${seen.size}`);
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

  it("is shortest on the statement day itself", () => {
    const card = { statementDay: 17, dueDay: 6 };
    const onStatement = floatDays(card, on("2026-09-17"))!;
    const dayAfter = floatDays(card, on("2026-09-18"))!;

    assert.ok(dayAfter > onStatement, "the day after resets the clock");
    assert.equal(dayAfter - onStatement, 30, "a whole cycle of difference in one day");
  });

  it("is null for a card with no dates recorded", () => {
    assert.equal(floatDays({ statementDay: null, dueDay: null }, on("2026-09-13")), null);
  });
});
