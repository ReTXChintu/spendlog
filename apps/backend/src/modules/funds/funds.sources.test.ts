import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assetClassOf, categoryOf } from "./funds.category";
import { isLikelyLink, scoreDebit } from "./funds.links";
import { activeRows, buildPeerTable, groupPeers, looksLikeTradingDay, snapshotDays, topPicks } from "./funds.peers";
import {
  displayName,
  isDirectPlan,
  isGrowthOption,
  isRegularPlan,
  parseMfapiScheme,
  parseMfapiSearch,
  parseNavFile,
  toAmfiDate,
  toDayKey,
} from "./funds.sources";

// NAVAll.txt as AMFI serves it now: plan and option in their own columns,
// two generations of category names, fund house lines, blank spacer
// lines, CRLF line ends and a scheme long since wound up.
const NAV_ALL = [
  "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date",
  " ",
  "Open Ended Schemes(Equity Scheme - Flexi Cap Fund)",
  " ",
  "PPFAS Mutual Fund",
  " ",
  "122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;88.9258;09-Oct-2026",
  "122640;INF879O01019;-;Parag Parikh Flexi Cap Fund;Regular Plan;Growth;82.1234;09-Oct-2026",
  "153964;INF879O01AA1;-;Parag Parikh Flexi Cap Fund;Direct Plan;Monthly IDCW Payout;25.4410;09-Oct-2026",
  " ",
  "Open Ended Schemes(Equity Schemes - Flexi Cap Fund)",
  " ",
  "Axis Mutual Fund",
  " ",
  "120465;INF846K01DP8;-;Axis Flexi Cap Fund;Direct Plan;Growth Option;30.0600;09-Oct-2026",
  "120466;INF846K01DN3;INF846K01DO1;Axis Flexi Cap Fund;Direct Plan;IDCW Option;23.9300;09-Oct-2026",
  "119527;INF209K01YX9;INF209K01YW1;Old Wound Up Fund;;;87.70;16-Sep-2022",
  " ",
  "Open Ended Schemes(Debt Scheme - Liquid Fund)",
  " ",
  "Axis Mutual Fund",
  " ",
  "120389;INF846K01CH7;-;Axis Liquid Fund;Direct Plan;Growth Option;3001.4567;11-Oct-2026",
  "120390;INF846K01CJ3;-;Axis Liquid Fund;Direct Plan;Daily IDCW;1001.2000;11-Oct-2026",
  " ",
  "Open Ended Schemes(Other Scheme - Index Funds)",
  " ",
  "UTI Mutual Fund",
  " ",
  "120716;INF789F01XA0;-;UTI Nifty 50 Index Fund;Direct Plan;Growth Option;180.5521;09-Oct-2026",
  "150702;INF209KB14N1;-;Crisil IBX Gilt Apr 2028 Index Fund;Direct Plan;GROWTH;13.4005;09-Oct-2026",
  "Close Ended Schemes(Income/Debt Oriented Schemes - Fixed Term Plan)",
  "UTI Mutual Fund",
  "140001;INF789F01ZZ1;-;UTI Fixed Term Income Fund Series XXXI;Direct Plan;Growth;12.1000;09-Oct-2026",
  "120999;INF789F01ZZ9;-;Something Unpriced;Direct Plan;Growth;N.A.;09-Oct-2026",
].join("\r\n");

// The NAV history report for one day: another column order, the plan in
// the name too, and spaces inside the category brackets.
function historyFile(day: string, navs: Record<number, number>) {
  return [
    "Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date",
    "",
    "Open Ended Schemes ( Equity Scheme - Flexi Cap Fund )",
    "",
    "",
    "PPFAS Mutual Fund",
    `122639;Parag Parikh Flexi Cap Fund - Direct Plan - Growth;Direct Plan;Growth;INF879O01027;;${navs[122639]};${day}`,
    "",
    "Open Ended Schemes ( Equity Schemes - Flexi Cap Fund )",
    "",
    "Axis Mutual Fund",
    `120465;Axis Flexi Cap Fund - Direct Plan - Growth Option;Direct Plan;Growth Option;INF846K01DP8;;${navs[120465]};${day}`,
    "",
    "Open Ended Schemes ( Debt Scheme - Liquid Fund )",
    "",
    "Axis Mutual Fund",
    `120389;Axis Liquid Fund - Direct Plan - Growth Option;Direct Plan;Growth Option;INF846K01CH7;;${navs[120389]};${day}`,
  ].join("\n");
}

describe("AMFI's files", () => {
  it("reads NAVAll by its header, with the category and fund house of each row", () => {
    const rows = parseNavFile(NAV_ALL);
    const ppfas = rows.find((row) => row.schemeCode === 122639)!;
    assert.deepEqual(ppfas, {
      schemeCode: 122639,
      name: "Parag Parikh Flexi Cap Fund",
      plan: "Direct Plan",
      option: "Growth",
      nav: 88.9258,
      day: "2026-10-09",
      schemeType: "Open Ended Schemes",
      category: "Equity Scheme - Flexi Cap Fund",
      fundHouse: "PPFAS Mutual Fund",
    });
    assert.equal(rows.find((row) => row.schemeCode === 120465)!.category, "Equity Schemes - Flexi Cap Fund");
    assert.equal(rows.find((row) => row.schemeCode === 140001)!.schemeType, "Close Ended Schemes");
    // "N.A." isn't a price.
    assert.equal(rows.some((row) => row.schemeCode === 120999), false);
    assert.equal(rows.length, 11);
  });

  it("reads the history report's other column order", () => {
    const rows = parseNavFile(historyFile("09-Oct-2025", { 122639: 93.1663, 120465: 28.5, 120389: 2815.25 }));
    assert.equal(rows.length, 3);
    assert.deepEqual(
      { ...rows[0] },
      {
        schemeCode: 122639,
        name: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
        plan: "Direct Plan",
        option: "Growth",
        nav: 93.1663,
        day: "2025-10-09",
        schemeType: "Open Ended Schemes",
        category: "Equity Scheme - Flexi Cap Fund",
        fundHouse: "PPFAS Mutual Fund",
      }
    );
  });

  it("reads nothing out of a page that isn't one of its files", () => {
    assert.deepEqual(parseNavFile("<head><title>Document Moved</title></head>"), []);
  });

  it("converts dates both ways", () => {
    assert.equal(toDayKey("09-Oct-2026"), "2026-10-09");
    assert.equal(toDayKey("9-10-2026"), "2026-10-09");
    assert.equal(toDayKey("2026-10-09"), null);
    assert.equal(toAmfiDate("2025-03-07"), "07-Mar-2025");
  });

  it("tells plans and options apart from the columns or the name", () => {
    assert.equal(isDirectPlan("Parag Parikh Flexi Cap Fund", "Direct Plan"), true);
    assert.equal(isDirectPlan("Parag Parikh Flexi Cap Fund - Regular Plan - Growth"), false);
    assert.equal(isRegularPlan("Parag Parikh Flexi Cap Fund - Regular Plan - Growth"), true);
    assert.equal(isRegularPlan("Nippon India ETF Nifty 50 BeES"), false);
    assert.equal(isGrowthOption("Axis Liquid Fund", "Daily IDCW"), false);
    assert.equal(isGrowthOption("Some Liquid Fund - Direct Plan - Cumulative"), true);
    assert.equal(isGrowthOption("HDFC Mid Cap Fund - Growth Option - Direct Plan"), true);
    assert.equal(displayName({ name: "Axis Liquid Fund", plan: "Direct Plan", option: "Growth Option" }), "Axis Liquid Fund - Direct Plan - Growth Option");
    assert.equal(displayName({ name: "X Fund - Direct Plan - Growth", plan: "Direct Plan", option: "Growth" }), "X Fund - Direct Plan - Growth");
  });
});

describe("mfapi.in", () => {
  it("reads a scheme's details and history, oldest first", () => {
    const body = {
      meta: {
        fund_house: "PPFAS Mutual Fund",
        scheme_type: "Open Ended Schemes",
        scheme_category: "Equity Scheme - Flexi Cap Fund",
        scheme_code: 122639,
        scheme_name: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
        isin_growth: "INF879O01027",
        isin_div_reinvestment: null,
      },
      data: [
        { date: "09-10-2026", nav: "88.92580" },
        { date: "08-10-2026", nav: "87.65550" },
        { date: "08-10-2026", nav: "87.00000" },
        { date: "07-10-2026", nav: "0.00000" },
        { date: "06-10-2026", nav: "88.99700" },
      ],
      status: "SUCCESS",
    };
    assert.deepEqual(parseMfapiScheme(body), {
      schemeCode: 122639,
      schemeName: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
      fundHouse: "PPFAS Mutual Fund",
      schemeType: "Open Ended Schemes",
      category: "Equity Scheme - Flexi Cap Fund",
      isin: "INF879O01027",
      days: ["2026-10-06", "2026-10-08", "2026-10-09"],
      navs: [88.997, 87.6555, 88.9258],
    });
  });

  it("reads an unknown code as nothing", () => {
    const empty = {
      meta: { fund_house: "", scheme_type: "", scheme_category: "", scheme_code: 0, scheme_name: "", isin_growth: null },
      data: [],
      status: "SUCCESS",
    };
    assert.equal(parseMfapiScheme(empty), null);
    assert.equal(parseMfapiScheme("nope"), null);
  });

  it("reads search results", () => {
    assert.deepEqual(
      parseMfapiSearch([
        { schemeCode: 122640, schemeName: "Parag Parikh Flexi Cap Fund - Regular Plan - Growth" },
        { schemeCode: "x", schemeName: "Broken" },
      ]),
      [{ schemeCode: 122640, schemeName: "Parag Parikh Flexi Cap Fund - Regular Plan - Growth" }]
    );
    assert.deepEqual(parseMfapiSearch({}), []);
  });
});

describe("categories", () => {
  it("reads AMFI's two generations of names as one", () => {
    const pairs = [
      ["Open Ended Schemes(Equity Scheme - Large Cap Fund)", "Equity Schemes - Large Cap Fund"],
      ["Equity Scheme - ELSS", "Equity Schemes - ELSS- Tax Saver Fund"],
      ["Debt Scheme - Short Duration Fund", "Income/Debt Oriented Schemes - Short Term Fund"],
      ["Debt Scheme - Banking and PSU Fund", "Income/Debt Oriented Schemes - Banking and PSU Debt Fund"],
      ["Hybrid Scheme - Dynamic Asset Allocation or Balanced Advantage", "Hybrid Schemes - Balanced Advantage Fund/ Dynamic Asset Allocation"],
      ["Equity Scheme - Sectoral/ Thematic", "Equity Schemes - Thematic Fund"],
      ["Open Ended Schemes ( Debt Scheme - Liquid Fund )", "Income/Debt Oriented Schemes - Liquid Fund"],
      ["Children’s Fund - Childrens' Fund", "Solution Oriented Scheme - Children’s Fund"],
    ];
    for (const [a, b] of pairs) assert.equal(categoryOf(a).key, categoryOf(b).key, `${a} / ${b}`);
    assert.deepEqual(categoryOf("Equity Scheme - Large Cap Fund"), { key: "equity:large cap", label: "Large Cap", assetClass: "equity" });
    assert.equal(categoryOf("Debt Scheme - Banking and PSU Fund").label, "Banking And PSU");
  });

  it("keeps a category's own brackets", () => {
    assert.equal(
      categoryOf("Open Ended Schemes(Fund of Funds Scheme (Domestic) - Fund of Funds Scheme (Domestic))").key,
      "other:fof domestic"
    );
  });

  it("groups index funds by what they track", () => {
    assert.equal(categoryOf("Other Scheme - Index Funds", "UTI Nifty 50 Index Fund - Direct Plan - Growth").key, "index:equity");
    assert.equal(categoryOf("Index Funds - Equity Funds", "Axis Nifty 50 Index Fund").key, "index:equity");
    assert.equal(categoryOf("Other Scheme - Index Funds", "Crisil IBX Gilt Apr 2028 Index Fund").key, "index:debt");
  });

  it("puts hybrids that mention equity under hybrid", () => {
    assert.equal(assetClassOf("Hybrid Scheme - Equity Savings"), "hybrid");
    assert.equal(assetClassOf("Hybrid Scheme - Arbitrage Fund"), "hybrid");
    assert.equal(assetClassOf("Debt Scheme - Overnight Fund"), "debt");
    assert.equal(assetClassOf("Equity Scheme - Mid Cap Fund"), "equity");
    assert.equal(assetClassOf("Other Scheme - Gold ETF", "Nippon India Gold BeES"), "other");
  });
});

describe("the peer table", () => {
  const today = parseNavFile(NAV_ALL);
  const yearAgo = parseNavFile(historyFile("09-Oct-2025", { 122639: 80.8417, 120465: 30.06, 120389: 2814.6 }));
  const threeYearsAgo = parseNavFile(historyFile("10-Oct-2023", { 122639: 59.85, 120465: 25.2, 120389: 2450 }));

  it("keeps running direct-growth open-ended schemes, with their 1y and 3y returns", () => {
    const table = buildPeerTable(today, yearAgo, threeYearsAgo);
    assert.equal(table.asOf, "2026-10-09");
    assert.equal(table.oneYearOn, "2025-10-09");
    assert.equal(table.threeYearOn, "2023-10-10");
    assert.deepEqual(
      table.schemes.map((scheme) => scheme.code).sort(),
      [120389, 120465, 120716, 122639, 150702]
    );

    const ppfas = table.schemes.find((scheme) => scheme.code === 122639)!;
    assert.equal(ppfas.name, "Parag Parikh Flexi Cap Fund - Direct Plan - Growth");
    assert.equal(ppfas.house, "PPFAS Mutual Fund");
    assert.equal(ppfas.key, "equity:flexi cap");
    assert.ok(Math.abs(ppfas.r1! - 0.1) < 0.001, `${ppfas.r1}`);
    assert.ok(Math.abs(ppfas.r3! - 0.14) < 0.002, `${ppfas.r3}`);
    assert.equal(table.schemes.find((scheme) => scheme.code === 120716)!.r1, null);

    const groups = groupPeers(table);
    const flexi = groups.get("equity:flexi cap")!;
    assert.equal(flexi.schemes.length, 2);
    assert.equal(flexi.oneYear.count, 2);
    assert.equal(groups.get("index:equity")!.schemes.length, 1);
    assert.equal(groups.get("index:debt")!.schemes.length, 1);
  });

  it("prices a scheme on the day most schemes are, not a liquid fund's Sunday", () => {
    assert.equal(activeRows(today).asOf, "2026-10-09");
  });

  it("tells a trading day's file from a weekend's", () => {
    const active = activeRows(today).rows.length;
    assert.equal(looksLikeTradingDay(yearAgo, 6), true);
    assert.equal(looksLikeTradingDay(yearAgo.slice(0, 1), active), false);
    assert.equal(looksLikeTradingDay([], active), false);
    assert.deepEqual(snapshotDays("2026-10-09", 1, 3), ["2025-10-09", "2025-10-08", "2025-10-07"]);
    assert.equal(snapshotDays("2028-02-29", 1, 1)[0], "2027-02-28");
  });

  it("picks the best by 3y return, needing three years of history, and by 1y for liquid funds", () => {
    const table = buildPeerTable(today, yearAgo, threeYearsAgo);
    assert.deepEqual(
      topPicks(table, { keys: ["equity:flexi cap"], rankBy: "3y" }).map((scheme) => scheme.code),
      [122639, 120465]
    );
    const noThreeYear = buildPeerTable(today, yearAgo, null);
    assert.deepEqual(topPicks(noThreeYear, { keys: ["equity:flexi cap"], rankBy: "3y" }), []);
    assert.equal(topPicks(noThreeYear, { keys: ["debt:liquid"], rankBy: "1y" })[0].code, 120389);
  });
});

describe("spotting a SIP debit", () => {
  const holding = {
    fundHouse: "PPFAS Mutual Fund",
    schemeName: "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
    sip: { amountMinor: 500_000, dayOfMonth: 5, startOn: "2026-01-01", active: true },
  };
  const at = (day: string) => new Date(`${day}T10:00:00+05:30`);

  it("scores a clearing-house debit of the SIP amount near the SIP day highly", () => {
    const result = scoreDebit({ occurredAt: at("2026-06-04"), amountMinor: 500_000, merchant: "ACH D- INDIAN CLEARING CORP" }, holding);
    assert.equal(result.score, 7);
    assert.deepEqual(result.reasons, ["sip_words", "amount", "day"]);
    assert.equal(isLikelyLink(result, true), true);
  });

  it("knows the fund house and the apps people buy through", () => {
    const groww = scoreDebit({ occurredAt: at("2026-06-15"), amountMinor: 500_000, rawText: "UPI/Groww/autopay" }, holding);
    assert.ok(isLikelyLink(groww, true));
    const house = scoreDebit({ occurredAt: at("2026-06-05"), amountMinor: 499_990, merchant: "PPFAS MF" }, holding);
    assert.deepEqual(house.reasons, ["sip_words", "fund_house", "amount", "day"]);
  });

  it("treats the 30th and the 2nd as three days apart", () => {
    const result = scoreDebit(
      { occurredAt: at("2026-06-30"), amountMinor: 500_000, merchant: "NSE Clearing" },
      { ...holding, sip: { ...holding.sip, dayOfMonth: 2 } }
    );
    assert.ok(result.reasons.includes("day"));
  });

  it("passes over ordinary spending of the same amount", () => {
    const result = scoreDebit({ occurredAt: at("2026-06-05"), amountMinor: 500_000, merchant: "Croma Electronics" }, holding);
    assert.equal(isLikelyLink(result, true), false);
  });

  it("needs the words and the fund house when there's no SIP to compare against", () => {
    const lump = { ...holding, sip: null };
    assert.equal(isLikelyLink(scoreDebit({ occurredAt: at("2026-06-05"), amountMinor: 1_000_000, merchant: "BSE Ltd" }, lump), false), false);
    assert.equal(
      isLikelyLink(scoreDebit({ occurredAt: at("2026-06-05"), amountMinor: 1_000_000, merchant: "BSE Ltd PPFAS" }, lump), false),
      true
    );
  });
});
