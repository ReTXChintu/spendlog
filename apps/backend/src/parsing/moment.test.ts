import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasStatedTime, statedMoment } from "./moment";

/** An instant written as IST wall-clock time. */
const ist = (wall: string) => new Date(`${wall}+05:30`);

describe("the moment a message says its payment happened", () => {
  // Arrived Fri 23 Oct 2026, 05:15 IST, unless a case says otherwise.
  const arrived = ist("2026-10-23T05:15:00");

  it("reads the user's late Jupiter SMS: American date, 12-hour time", () => {
    const text =
      "Rs.172.00 debited to your Edge CSB Bank RuPay Credit Card ending 6623 on 10/23/26, 1:39 AM - " +
      "(UPI Ref no.629632671192). To dispute,call 8045219280. Thanks for using the Jupiter App.";
    assert.deepEqual(statedMoment(text, arrived), ist("2026-10-23T01:39:00"));
  });

  const formats: [string, string, string][] = [
    ["DD-MM-YY with HH:MM", "Rs 500 debited from A/c XX1234 on 23-10-26 01:39 to VPA x@y", "2026-10-23T01:39:00"],
    ["DD-MM-YYYY", "INR 250.00 spent on card XX4821 on 23-10-2026 at 01:39:22. Avl Lmt INR 44,021.93", "2026-10-23T01:39:22"],
    ["DD/MM/YY", "Txn of Rs.99 on 23/10/26 02:05 on HDFC Bank Card 1377", "2026-10-23T02:05:00"],
    ["DD/MM/YYYY", "Your A/C XXXXX9876 Debited INR 1,000.00 on 22/10/2026 23:10 -Transferred to x", "2026-10-22T23:10:00"],
    ["DD-Mon-YY with at", "Rs 1200 spent on ICICI Card XX1111 on 22-Oct-26 at 21:45 IST at AMAZON", "2026-10-22T21:45:00"],
    ["DDMonYY glued (Federal)", "Debited Rs 161.00 from a/c X5130 on 22Oct26 18:02:11 via UPI to S. Ref 661165147047", "2026-10-22T18:02:11"],
    ["DD Mon YYYY", "A/c XX12 debited by Rs 300 on 22 Oct 2026, 08:30 PM.", "2026-10-22T20:30:00"],
    ["Mon DD, YYYY", "Payment of Rs 450 on Oct 22, 2026 at 10:05:22 hrs on your card", "2026-10-22T10:05:22"],
    ["ISO", "Txn Rs 75.00 on 2026-10-22 19:00:00 card ending 9876", "2026-10-22T19:00:00"],
    ["DD.MM.YYYY", "Rs 60 debited on 22.10.2026 at 7:15 pm from a/c **1234", "2026-10-22T19:15:00"],
    ["01:39AM glued", "Rs 20 paid on 23-10-26 01:39AM via UPI", "2026-10-23T01:39:00"],
    ["12 AM is midnight", "Rs 20 paid on 23-10-26 12:05 AM via UPI", "2026-10-23T00:05:00"],
    ["12 PM is noon", "Rs 20 paid on 22-10-26 12:05 PM via UPI", "2026-10-22T12:05:00"],
    ["a dotted time with PM", "Rs 20 paid on 22-10-26 at 1.39 PM via UPI", "2026-10-22T13:39:00"],
    ["the time before the date", "At 23:50 on 22-10-26 Rs 99 was debited from A/c XX1234", "2026-10-22T23:50:00"],
  ];
  for (const [label, text, expected] of formats) {
    it(`reads ${label}`, () => {
      assert.deepEqual(statedMoment(text, arrived), ist(expected));
    });
  }

  describe("day and month either way round", () => {
    it("takes the reading nearest the arrival that isn't in the future", () => {
      // 03/10/26: 3 Oct (20 days ago) or 10 Mar (seven months ago, too long): 3 Oct.
      assert.deepEqual(statedMoment("Rs 50 debited on 03/10/26 14:00", arrived), ist("2026-10-03T14:00:00"));
      // 10/04/26 arriving 4 Oct: 10 Apr is far too old, 4 Oct fits - the American reading.
      assert.deepEqual(
        statedMoment("Rs 50 debited on 10/04/26 09:00", ist("2026-10-04T09:30:00")),
        ist("2026-10-04T09:00:00")
      );
    });

    it("prefers the nearer of two fitting readings", () => {
      // 05/10/26 arriving 10 Oct: 5 Oct (five days) beats 10 May (five months, beyond 60 days anyway).
      assert.deepEqual(
        statedMoment("Rs 50 on 05/10/26 11:00", ist("2026-10-10T11:00:00")),
        ist("2026-10-05T11:00:00")
      );
    });

    it("gives up when neither reading can be the payment's", () => {
      assert.equal(statedMoment("Rs 50 on 05/11/26 11:00", arrived), null);
    });
  });

  describe("half a moment", () => {
    it("a time alone is that time on the day it arrived", () => {
      assert.deepEqual(statedMoment("Rs 20 debited at 01:39 via UPI", arrived), ist("2026-10-23T01:39:00"));
    });

    it("a time alone that would be in the future is the day before", () => {
      assert.deepEqual(statedMoment("Rs 20 debited at 23:58 via UPI", arrived), ist("2026-10-22T23:58:00"));
    });

    it("a date alone today keeps the arrival time", () => {
      assert.equal(statedMoment("Rs 20 debited from A/c XX1234 on 23-10-26 via UPI", arrived), null);
    });

    it("a date alone on an earlier day is noon that day", () => {
      assert.deepEqual(
        statedMoment("Rs 25,000 credited to A/c XX1234 on 22-10-26 by NEFT", arrived),
        ist("2026-10-22T12:00:00")
      );
    });

    it("a yearless date takes this year, or last year when this one hasn't happened", () => {
      assert.deepEqual(statedMoment("Rs 20 spent on 22 Oct at 10:00", arrived), ist("2026-10-22T10:00:00"));
      assert.deepEqual(
        statedMoment("Rs 20 spent on 31 Dec at 23:00", ist("2027-01-01T08:00:00")),
        ist("2026-12-31T23:00:00")
      );
    });
  });

  describe("what is never the payment's moment", () => {
    it("a due date in the future", () => {
      assert.equal(statedMoment("Your EMI of Rs 5,300 is due on 05-11-26.", arrived), null);
    });

    it("a stated time minutes ahead of arrival is within clock drift; an hour ahead is not", () => {
      assert.deepEqual(statedMoment("Rs 20 on 23-10-26 05:20", arrived), ist("2026-10-23T05:20:00"));
      assert.equal(statedMoment("Rs 20 on 23-10-26 06:30", arrived), null);
    });

    it("a date more than sixty days before arrival", () => {
      assert.equal(statedMoment("Rs 20 on 01-07-26 10:00", arrived), null);
    });

    it("a card's expiry, an amount, a reference or a phone number", () => {
      const text = "Rs.1,234.56 spent on card XX6623 valid till 10/27. Ref 629632671192. Call 18004251199";
      assert.equal(statedMoment(text, arrived), null);
    });

    it("a message with no date or time at all", () => {
      assert.equal(statedMoment("Rs 500 debited from A/c XX1234 to Swiggy", arrived), null);
      assert.equal(statedMoment("", arrived), null);
      assert.equal(statedMoment(null, arrived), null);
    });

    it("a word that starts like a month", () => {
      assert.equal(statedMoment("Rs 20 sent to 1 separately via UPI", arrived), null);
    });

    it("an impossible time or date", () => {
      assert.equal(statedMoment("Rs 20 on 31-02-26 10:00", arrived), null);
      assert.equal(statedMoment("Rs 20 at 25:61", arrived), null);
    });
  });

  it("knows a stated time from an arrival time", () => {
    assert.equal(hasStatedTime(ist("2026-10-23T01:39:00"), arrived), true);
    assert.equal(hasStatedTime(arrived, arrived), false);
    assert.equal(hasStatedTime(arrived, null), false);
  });
});
