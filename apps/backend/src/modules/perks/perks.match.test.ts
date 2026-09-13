import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  comparePerks,
  merchantMatches,
  normaliseMerchantQuery,
  perkIsLive,
  perkReach,
  perkValueMinor,
} from "./perks.match";

describe("normaliseMerchantQuery", () => {
  it("strips the way a person says where they are", () => {
    for (const typed of ["I'm at Gucci", "im at gucci", "I am at Gucci", "at Gucci", "Gucci"]) {
      assert.equal(normaliseMerchantQuery(typed), "gucci", typed);
    }
  });

  it("strips what a card network leaves on a merchant's name", () => {
    assert.equal(normaliseMerchantQuery("GUCCI INDIA PVT LTD"), "gucci");
    // "retail" goes with the rest of the boilerplate, which is the point.
    assert.equal(normaliseMerchantQuery("AMAZON*RETAIL"), "amazon");
    assert.equal(normaliseMerchantQuery("SWIGGY.IN"), "swiggy");
  });

  it("leaves a name that is only noise words alone rather than emptying it", () => {
    // A shop called "India" would otherwise reduce to nothing, and nothing
    // matches everything.
    assert.equal(normaliseMerchantQuery("India"), "india");
    assert.equal(merchantMatches("India", "i'm at India"), true);
  });
});

describe("merchantMatches", () => {
  it("matches however long each side happens to be", () => {
    // Neither side is reliably the longer one.
    assert.equal(merchantMatches("amazon", "AMAZON PAY IN UTILITY BANGALORE"), true);
    assert.equal(merchantMatches("third wave coffee", "third wave"), true);
  });

  it("finds a single-word pattern inside a longer query", () => {
    assert.equal(merchantMatches("gucci", "gucci gurgaon"), true);
  });

  it("does not let a common word claim a shop it was never meant for", () => {
    // A name is typed from its beginning, so "coffee" does not mean the
    // perk saved for "blue tokai coffee" - that is the wrong shop and a
    // wasted trip.
    assert.equal(merchantMatches("blue tokai coffee", "coffee"), false);
    assert.equal(merchantMatches("blue tokai coffee", "blue tokai"), true);
  });

  it("finds the pattern buried in an aggregator's merchant string", () => {
    assert.equal(merchantMatches("swiggy", "PAYTM*SWIGGY"), true);
  });

  it("says no to things that are simply different", () => {
    assert.equal(merchantMatches("gucci", "zara"), false);
    assert.equal(merchantMatches("gucci", ""), false);
  });
});

describe("perkReach", () => {
  const category = "65f000000000000000000001";

  it("prefers a perk that names the shop", () => {
    assert.equal(perkReach({ merchants: ["croma"], categoryId: null }, "Croma", null), "MERCHANT");
    assert.equal(perkReach({ merchants: ["croma"], categoryId: null }, "Zara", null), null);
  });

  it("matches a category offer only when the category is known", () => {
    const perk = { merchants: [], categoryId: category as never };
    assert.equal(perkReach(perk, "Some Restaurant", category), "CATEGORY");
    assert.equal(perkReach(perk, "Some Restaurant", null), null);
  });

  it("treats a perk with neither as applying anywhere", () => {
    // What a flat "2% on everything" card is.
    assert.equal(perkReach({ merchants: [], categoryId: null }, "anywhere at all", null), "ANYWHERE");
  });

  it("does not fall back to anywhere when a named merchant misses", () => {
    assert.equal(perkReach({ merchants: ["croma"], categoryId: null }, "Gucci", null), null);
  });
});

describe("perkIsLive", () => {
  const now = new Date("2026-09-14T12:00:00Z");

  it("hides what cannot be used", () => {
    // The worst answer here is being told to hand over a dead code.
    assert.equal(perkIsLive({ isActive: false, usedAt: null, startsOn: null, expiresOn: null }, now), false);
    assert.equal(perkIsLive({ isActive: true, usedAt: new Date(), startsOn: null, expiresOn: null }, now), false);
    assert.equal(
      perkIsLive({ isActive: true, usedAt: null, startsOn: null, expiresOn: new Date("2026-09-13") }, now),
      false
    );
    assert.equal(
      perkIsLive({ isActive: true, usedAt: null, startsOn: new Date("2026-10-01"), expiresOn: null }, now),
      false
    );
  });

  it("shows one with room either side", () => {
    assert.equal(
      perkIsLive(
        { isActive: true, usedAt: null, startsOn: new Date("2026-09-01"), expiresOn: new Date("2026-09-30") },
        now
      ),
      true
    );
  });
});

describe("perkValueMinor", () => {
  it("takes a flat amount as it is", () => {
    assert.equal(perkValueMinor({ flatMinor: 50000, percent: null, maxDiscountMinor: null, minSpendMinor: null }, null), 50000);
  });

  it("cannot price a percentage until there is something to apply it to", () => {
    assert.equal(perkValueMinor({ percent: 5, flatMinor: null, maxDiscountMinor: null, minSpendMinor: null }, null), null);
    assert.equal(perkValueMinor({ percent: 5, flatMinor: null, maxDiscountMinor: null, minSpendMinor: null }, 1000000), 50000);
  });

  it("honours the cap in the small print", () => {
    assert.equal(
      perkValueMinor({ percent: 5, flatMinor: null, maxDiscountMinor: 50000, minSpendMinor: null }, 5000000),
      50000
    );
  });

  it("is worth nothing below the floor", () => {
    assert.equal(
      perkValueMinor({ percent: 5, flatMinor: null, maxDiscountMinor: null, minSpendMinor: 500000 }, 100000),
      0
    );
  });
});

describe("comparePerks", () => {
  const perk = (over: Partial<Parameters<typeof comparePerks>[0]>) => ({
    reach: "MERCHANT" as const,
    kind: "CARD_OFFER",
    valueMinor: null,
    percent: null,
    ...over,
  });

  it("puts the one that names this shop above one covering the category", () => {
    const sorted = [perk({ reach: "ANYWHERE" }), perk({ reach: "CATEGORY" }), perk({ reach: "MERCHANT" })].sort(
      comparePerks
    );
    assert.deepEqual(sorted.map((p) => p.reach), ["MERCHANT", "CATEGORY", "ANYWHERE"]);
  });

  it("puts a coupon above a standing offer of the same reach", () => {
    // The coupon is the one that will be gone if it is not used.
    const sorted = [perk({ kind: "CARD_OFFER" }), perk({ kind: "COUPON" })].sort(comparePerks);
    assert.deepEqual(sorted.map((p) => p.kind), ["COUPON", "CARD_OFFER"]);
  });

  it("puts the bigger number first once the kind is the same", () => {
    const sorted = [perk({ percent: 2 }), perk({ percent: 5 })].sort(comparePerks);
    assert.deepEqual(sorted.map((p) => p.percent), [5, 2]);
  });
});
