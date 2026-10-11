import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { perLot } from "./ipos.estimate";
import { itemsOf, normaliseRow, toNumber, toPaise } from "./ipos.guru";

const gmp = (premiumMinor: number) => ({ premiumMinor, percent: null, updatedAtLabel: null });

describe("one lot at today's GMP", () => {
  it("works out the cost, the value and the gain", () => {
    // 142 shares at ₹105, GMP ₹12.
    assert.deepEqual(perLot({ lotSize: 142, priceMaxMinor: 10_500, gmp: gmp(1_200) }), {
      costMinor: 1_491_000,
      atGmpMinor: 1_661_400,
      gainMinor: 170_400,
      gainPercent: 11.43,
    });
  });

  it("shows a loss when the grey market is below the issue price", () => {
    assert.deepEqual(perLot({ lotSize: 50, priceMaxMinor: 30_000, gmp: gmp(-1_500) }), {
      costMinor: 1_500_000,
      atGmpMinor: 1_425_000,
      gainMinor: -75_000,
      gainPercent: -5,
    });
  });

  it("treats a GMP of 0 as a real reading - no premium, not unknown", () => {
    const lot = perLot({ lotSize: 10, priceMaxMinor: 50_000, gmp: gmp(0) });
    assert.deepEqual(lot, { costMinor: 500_000, atGmpMinor: 500_000, gainMinor: 0, gainPercent: 0 });
  });

  it("has no figure without a GMP, a price or a lot size", () => {
    assert.equal(perLot({ lotSize: 10, priceMaxMinor: 50_000, gmp: null }), null);
    assert.equal(perLot({ lotSize: 10, priceMaxMinor: null, gmp: gmp(100) }), null);
    assert.equal(perLot({ lotSize: null, priceMaxMinor: 50_000, gmp: gmp(100) }), null);
  });
});

describe("reading IPO Guru's fields", () => {
  it("reads numbers out of strings, in rupees and paise", () => {
    assert.equal(toNumber("₹1,05,000"), 105_000);
    assert.equal(toNumber("Rs. 105"), 105);
    assert.equal(toNumber("12.5x"), 12.5);
    assert.equal(toNumber("-15"), -15);
    assert.equal(toNumber("0"), 0);
    assert.equal(toNumber(null), null);
    assert.equal(toNumber(""), null);
    assert.equal(toNumber("-"), null);
    assert.equal(toPaise("104.55"), 10_455);
    assert.equal(toPaise(105), 10_500);
  });

  it("tags SME issues and treats everything else as mainboard", () => {
    const base = { slug: "x", name: "X Ltd", status: "Open" };
    assert.equal(normaliseRow({ ...base, type: "SME" })?.type, "SME");
    assert.equal(normaliseRow({ ...base, type: "sme" })?.type, "SME");
    assert.equal(normaliseRow({ ...base, type: "Mainboard" })?.type, "MAINBOARD");
    assert.equal(normaliseRow({ ...base })?.type, "MAINBOARD");
  });

  it("drops what's already listed, and anything without a name", () => {
    assert.equal(normaliseRow({ slug: "x", name: "X Ltd", is_listed: true }), null);
    assert.equal(normaliseRow({ slug: "x", name: "X Ltd", is_listed: "true" }), null);
    assert.equal(normaliseRow({ slug: "x" }), null);
  });

  it("falls back to the band's top price, and to the dates for an unknown status", () => {
    const row = normaliseRow(
      { name: "New Co", price_band: "₹1,000 - ₹1,050", status: "Allotted", open_date: "2026-10-01", close_date: "2026-10-03" },
      new Date("2026-10-11T06:00:00Z")
    );
    assert.equal(row?.priceMaxMinor, 105_000);
    assert.equal(row?.status, "CLOSED");
    assert.equal(row?.slug, "new-co");
  });

  it("takes GMP as missing when it has no price, and works out a missing percentage", () => {
    assert.equal(normaliseRow({ slug: "x", name: "X", price_max: "100", gmp: { price: null } })?.gmp, null);
    assert.deepEqual(normaliseRow({ slug: "x", name: "X", price_max: "200", gmp: { price: "10", updated_at: "2026-10-11" } })?.gmp, {
      premiumMinor: 1_000,
      percent: 5,
      updatedAtLabel: "2026-10-11",
    });
  });

  it("finds the list in any envelope, and ignores the free tier's locked note", () => {
    assert.equal(itemsOf([{ slug: "a" }]).length, 1);
    assert.equal(itemsOf({ data: [{ slug: "a" }, { slug: "b" }], locked: { fields: ["kostak"] } }).length, 2);
    assert.equal(itemsOf({ open: [{ slug: "a" }], upcoming: [{ slug: "b" }], locked: [{ x: 1 }] }).length, 2);
    assert.equal(itemsOf("nope").length, 0);
  });
});
