import { Types } from "mongoose";
import { FundHolding, FundHoldingDoc, FundNavDoc, FundTxn, FundTxnDoc, Transaction } from "../../models";
import { istDayKey } from "../../time";
import { ASSET_CLASSES, AssetClass, categoryOf } from "./funds.category";
import { peers as loadPeers, Peers, schemeHistories, STALE_AFTER_MS } from "./funds.cache";
import {
  addDays,
  addYears,
  buildLedger,
  CashFlow,
  daysBetween,
  downsample,
  FundFlag,
  fundFlags,
  HoldingSummary,
  LedgerEntry,
  LinkedInput,
  ManualInput,
  MIN_XIRR_DAYS,
  NavSeries,
  PlanMonth,
  rankAmong,
  sipMonthPlan,
  summariseHolding,
  trailingReturn,
  xirr,
} from "./funds.math";
import { isRegularPlan } from "./funds.sources";
import { addMonths, isPaused, monthOf, SipPlan, sipSteps, stepFor } from "./funds.sip";

/**
 * A user's funds, read: each holding's ledger, totals and returns, where
 * it ranks in its category and what's wrong with it, and the portfolio as
 * a whole. Everything is worked out on each read from what is stored -
 * see funds.math.ts for the rules.
 */

/** A fraction to a percentage with two places, or null. */
export const percent = (fraction: number | null | undefined) =>
  fraction === null || fraction === undefined || !Number.isFinite(fraction) ? null : Math.round(fraction * 10_000) / 100;

const statsJson = (stats: { count: number; average: number | null; median: number | null }) => ({
  count: stats.count,
  averagePercent: percent(stats.average),
  medianPercent: percent(stats.median),
});

export interface HoldingView {
  holding: FundHoldingDoc;
  series: NavSeries;
  ledger: LedgerEntry[];
  summary: HoldingSummary;
  categoryKey: string;
  categoryLabel: string;
  assetClass: AssetClass;
  isRegular: boolean;
  oneYear: number | null;
  threeYear: number | null;
  peers: {
    oneYear: { count: number; average: number | null; median: number | null };
    threeYear: { count: number; average: number | null; median: number | null };
    basis: "3y" | "1y" | null;
    rank: ReturnType<typeof rankAmong>;
  } | null;
  flags: FundFlag[];
  /// What goes in each month now: the SIP step in force when one is
  /// running, nothing while it's paused.
  monthlySipMinor: number;
  /// A SIP that hasn't been stopped or ended - paused or not.
  sipRunning: boolean;
  sipPaused: boolean;
  nav: { fetchedAt: Date | null; lastError: string | null; lastErrorAt: Date | null };
}

function sipRunning(holding: FundHoldingDoc, today: string): boolean {
  return !!holding.sip?.active && (!holding.sip.endOn || holding.sip.endOn >= today);
}

/** The debits behind each holding's links and connected commitment, as ledger input. */
async function linkedInputs(userId: Types.ObjectId, holdings: FundHoldingDoc[], txns: FundTxnDoc[]) {
  const linkedIds = txns.filter((txn) => txn.kind === "LINKED" && txn.transactionId).map((txn) => txn.transactionId!);
  const commitmentIds = holdings.map((holding) => holding.commitmentId).filter((id): id is Types.ObjectId => !!id);

  const [linked, viaCommitment] = await Promise.all([
    linkedIds.length
      ? Transaction.find({ _id: { $in: linkedIds }, userId }).select("occurredAt amountMinor").lean()
      : Promise.resolve([]),
    commitmentIds.length
      ? Transaction.find({ userId, type: "DEBIT", commitmentId: { $in: commitmentIds } })
          .select("occurredAt amountMinor commitmentId")
          .lean()
      : Promise.resolve([]),
  ]);
  const transactions = new Map(linked.map((row) => [row._id.toString(), row]));

  const byHolding = new Map<string, LinkedInput[]>();
  const add = (holdingId: string, input: LinkedInput) => {
    const list = byHolding.get(holdingId) ?? [];
    list.push(input);
    byHolding.set(holdingId, list);
  };

  for (const txn of txns) {
    if (txn.kind !== "LINKED" || !txn.transactionId) continue;
    // The transaction's own date and amount, so an edit to it flows
    // through; a deleted one drops out.
    const transaction = transactions.get(txn.transactionId.toString());
    if (!transaction) continue;
    add(txn.holdingId.toString(), {
      transactionId: txn.transactionId.toString(),
      txnId: txn._id.toString(),
      on: istDayKey(transaction.occurredAt),
      amountMinor: transaction.amountMinor,
      via: "link",
    });
  }

  for (const holding of holdings) {
    if (!holding.commitmentId) continue;
    for (const row of viaCommitment) {
      if (!row.commitmentId?.equals(holding.commitmentId)) continue;
      add(holding._id.toString(), {
        transactionId: row._id.toString(),
        on: istDayKey(row.occurredAt),
        amountMinor: row.amountMinor,
        via: "commitment",
      });
    }
  }
  return byHolding;
}

function manualInputs(txns: FundTxnDoc[]) {
  const byHolding = new Map<string, ManualInput[]>();
  for (const txn of txns) {
    if (txn.kind !== "MANUAL_BUY" && txn.kind !== "REDEEM") continue;
    const list = byHolding.get(txn.holdingId.toString()) ?? [];
    list.push({ txnId: txn._id.toString(), kind: txn.kind, on: txn.on, amountMinor: txn.amountMinor, units: txn.units });
    byHolding.set(txn.holdingId.toString(), list);
  }
  return byHolding;
}

/** One holding read against its own history and its category. */
export function viewHolding(
  holding: FundHoldingDoc,
  history: FundNavDoc | undefined,
  linked: LinkedInput[],
  manual: ManualInput[],
  peerData: Peers | null,
  today: string
): HoldingView {
  const series: NavSeries = { days: history?.days ?? [], navs: history?.navs ?? [] };
  const ledger = buildLedger({ sip: holding.sip, opening: holding.opening, linked, manual, series, today });
  const summary = summariseHolding(ledger, series, holding.opening);

  // The peer table's category for this scheme when it has one, so the
  // fund is grouped exactly as its peers are; the stored one otherwise.
  const listed = peerData?.table.schemes.find((scheme) => scheme.code === holding.schemeCode);
  const category = listed
    ? { key: listed.key, label: listed.label, assetClass: listed.cls }
    : categoryOf(holding.category, holding.schemeName);

  const oneYear = trailingReturn(series, 1);
  const threeYear = trailingReturn(series, 3);
  const group = peerData?.groups.get(category.key);

  let peerView: HoldingView["peers"] = null;
  if (group) {
    const others = group.schemes.filter((scheme) => scheme.code !== holding.schemeCode);
    const basis = threeYear !== null && group.threeYear.count > 0 ? "3y" : oneYear !== null && group.oneYear.count > 0 ? "1y" : null;
    const fundReturn = basis === "3y" ? threeYear : basis === "1y" ? oneYear : null;
    const peerReturns = others.flatMap((scheme) => {
      const value = basis === "3y" ? scheme.r3 : scheme.r1;
      return value === null ? [] : [value];
    });
    peerView = {
      oneYear: group.oneYear,
      threeYear: group.threeYear,
      basis,
      rank: fundReturn !== null ? rankAmong(fundReturn, peerReturns) : null,
    };
  }

  const isRegular = isRegularPlan(holding.schemeName);
  const thisMonth = monthOf(today);
  const running = sipRunning(holding, today);
  const paused = running && isPaused(holding.sip!, thisMonth);
  // An IDCW plan's NAV drops by every payout, which no NAV-based return
  // sees, so it would always look like it lags. Only the plan is flagged.
  const flags = fundFlags({
    xirr: summary.xirr,
    heldDays: summary.heldDays,
    isRegular,
    basis: peerView?.basis ?? null,
    fundReturn: peerView?.basis === "3y" ? threeYear : peerView?.basis === "1y" ? oneYear : null,
    median: peerView?.basis === "3y" ? peerView.threeYear.median : peerView?.basis === "1y" ? peerView.oneYear.median : null,
    rank: peerView?.rank ?? null,
  }).filter((flag) => holding.isGrowth || flag === "regular_plan");

  return {
    holding,
    series,
    ledger,
    summary,
    categoryKey: category.key,
    categoryLabel: category.label,
    assetClass: category.assetClass,
    isRegular,
    oneYear,
    threeYear,
    peers: peerView,
    flags,
    monthlySipMinor: running && !paused ? stepFor(holding.sip!, thisMonth).amountMinor : 0,
    sipRunning: running,
    sipPaused: paused,
    nav: { fetchedAt: history?.fetchedAt ?? null, lastError: history?.lastError ?? null, lastErrorAt: history?.lastErrorAt ?? null },
  };
}

export interface Portfolio {
  views: HoldingView[];
  peers: Peers | null;
  today: string;
  now: Date;
}

/**
 * Every holding of the user's, read. The peer table comes along when
 * there's something to rank, or when asked for - goals and advice want
 * example funds even before the first holding.
 */
export async function loadPortfolio(userId: Types.ObjectId, now = new Date(), withPeers = false): Promise<Portfolio> {
  const holdings = await FundHolding.find({ userId }).sort({ createdAt: 1 }).lean<FundHoldingDoc[]>();
  const today = istDayKey(now);
  if (holdings.length === 0) return { views: [], peers: withPeers ? await loadPeers(now) : null, today, now };

  const [histories, txns, peerData] = await Promise.all([
    schemeHistories(holdings.map((holding) => holding.schemeCode), now),
    FundTxn.find({ userId, holdingId: { $in: holdings.map((holding) => holding._id) } }).lean<FundTxnDoc[]>(),
    loadPeers(now),
  ]);
  const linked = await linkedInputs(userId, holdings, txns);
  const manual = manualInputs(txns);

  const views = holdings.map((holding) =>
    viewHolding(
      holding,
      histories.get(holding.schemeCode),
      linked.get(holding._id.toString()) ?? [],
      manual.get(holding._id.toString()) ?? [],
      peerData,
      today
    )
  );
  return { views, peers: peerData, today, now };
}

/** A holding as the app gets it, in the list. */
export function holdingJson(view: HoldingView, now: Date) {
  const { holding, summary } = view;
  return {
    id: holding._id.toString(),
    schemeCode: holding.schemeCode,
    schemeName: holding.schemeName,
    fundHouse: holding.fundHouse,
    category: holding.category,
    categoryKey: view.categoryKey,
    categoryLabel: view.categoryLabel,
    assetClass: view.assetClass,
    isDirect: holding.isDirect,
    isGrowth: holding.isGrowth,
    isRegular: view.isRegular,
    folio: holding.folio ?? null,
    sip: holding.sip ? sipJson(holding.sip, istDayKey(now)) : null,
    opening: holding.opening ?? null,
    commitmentId: holding.commitmentId?.toString() ?? null,
    units: Math.round(summary.units * 1000) / 1000,
    investedMinor: summary.investedMinor,
    totalInvestedMinor: summary.totalInvestedMinor,
    valueMinor: summary.valueMinor,
    gainMinor: summary.gainMinor,
    gainPercent: percent(summary.gainPercent),
    realisedGainMinor: summary.realisedGainMinor,
    xirrPercent: percent(summary.xirr),
    dayChangeMinor: summary.dayChangeMinor,
    dayChangePercent: percent(summary.dayChangePercent),
    nav: summary.nav,
    firstOn: summary.firstOn,
    heldDays: summary.heldDays,
    monthlySipMinor: view.monthlySipMinor,
    sipPaused: view.sipPaused,
    returns: { oneYearPercent: percent(view.oneYear), threeYearPercent: percent(view.threeYear) },
    peers: view.peers
      ? {
          oneYear: statsJson(view.peers.oneYear),
          threeYear: statsJson(view.peers.threeYear),
          basis: view.peers.basis,
          rank: view.peers.rank
            ? {
                rank: view.peers.rank.rank,
                of: view.peers.rank.of,
                percentile: Math.round(view.peers.rank.percentile),
              }
            : null,
        }
      : null,
    flags: view.flags,
    pendingCount: view.ledger.filter((entry) => entry.pending).length,
    stale: !view.nav.fetchedAt || now.getTime() - view.nav.fetchedAt.getTime() > STALE_AFTER_MS,
  };
}

/** The whole portfolio's figures, from its holdings. */
export function portfolioTotals(views: HoldingView[]) {
  const sum = (pick: (view: HoldingView) => number) => views.reduce((total, view) => total + pick(view), 0);
  const investedMinor = sum((view) => view.summary.investedMinor);
  const valueMinor = sum((view) => view.summary.valueMinor);
  const dayChangeMinor = sum((view) => view.summary.dayChangeMinor);

  const latestDay = views.reduce<string | null>(
    (latest, view) => (view.summary.nav && (!latest || view.summary.nav.day > latest) ? view.summary.nav.day : latest),
    null
  );
  const flows: CashFlow[] = views.flatMap((view) => view.summary.flows);
  const firstFlow = flows.reduce<string | null>((earliest, flow) => (!earliest || flow.day < earliest ? flow.day : earliest), null);
  const rate =
    latestDay && firstFlow && daysBetween(firstFlow, latestDay) >= MIN_XIRR_DAYS
      ? xirr(valueMinor > 0 ? [...flows, { day: latestDay, amount: valueMinor }] : flows)
      : null;

  const allocation = ASSET_CLASSES.map((assetClass) => {
    const classValue = sum((view) => (view.assetClass === assetClass ? view.summary.valueMinor : 0));
    return {
      assetClass,
      valueMinor: classValue,
      percent: valueMinor > 0 ? Math.round((classValue / valueMinor) * 1000) / 10 : 0,
    };
  });

  const previousValue = valueMinor - dayChangeMinor;
  return {
    totals: {
      investedMinor,
      valueMinor,
      gainMinor: valueMinor - investedMinor,
      gainPercent: percent(investedMinor > 0 ? (valueMinor - investedMinor) / investedMinor : null),
      xirrPercent: percent(rate),
      dayChangeMinor,
      dayChangePercent: percent(previousValue > 0 ? dayChangeMinor / previousValue : null),
      monthlySipMinor: sum((view) => view.monthlySipMinor),
    },
    allocation,
    lastNavDate: latestDay,
  };
}

/** One ledger line as the app gets it. */
export function ledgerJson(entry: LedgerEntry) {
  return {
    kind: entry.kind,
    on: entry.on,
    navDay: entry.navDay,
    nav: entry.nav,
    amountMinor: entry.amountMinor,
    units: Math.round(entry.units * 1000) / 1000,
    counted: entry.counted,
    pending: entry.pending,
    note: entry.note,
    transactionId: entry.transactionId,
    txnId: entry.txnId,
    via: entry.via,
    month: entry.month,
    plannedMinor: entry.plannedMinor,
    inSkippedMonth: entry.inSkippedMonth,
  };
}

/**
 * A SIP as the app gets it: as stored, its history read the way the maths
 * reads it (so a row the backfill hasn't reached has its one step), and
 * the amount and day in force this month.
 */
export function sipJson(sip: SipPlan, today: string) {
  const steps = sipSteps(sip);
  const current = stepFor(sip, monthOf(today));
  return {
    amountMinor: steps[0].amountMinor,
    dayOfMonth: sip.dayOfMonth,
    startOn: sip.startOn,
    endOn: sip.endOn ?? null,
    active: sip.active ?? true,
    steps: steps.map((step) => ({ fromOn: step.fromOn, amountMinor: step.amountMinor, dayOfMonth: step.dayOfMonth ?? null })),
    skips: [...(sip.skips ?? [])].sort(),
    pauses: (sip.pauses ?? [])
      .map((pause) => ({ fromOn: pause.fromOn, toOn: pause.toOn ?? null }))
      .sort((a, b) => (a.fromOn < b.fromOn ? -1 : a.fromOn > b.fromOn ? 1 : 0)),
    currentAmountMinor: current.amountMinor,
    currentDayOfMonth: current.dayOfMonth,
  };
}

/// How far back the month-by-month plan goes, this month included, and how far ahead.
export const PLAN_PAST_MONTHS = 24;
export const PLAN_AHEAD_MONTHS = 3;

/** The SIP month by month, for the holding's page. */
export function planJson(view: HoldingView, today: string) {
  const thisMonth = monthOf(today);
  const plan = sipMonthPlan(
    { sip: view.holding.sip, opening: view.holding.opening, today },
    view.ledger,
    addMonths(thisMonth, -(PLAN_PAST_MONTHS - 1)),
    addMonths(thisMonth, PLAN_AHEAD_MONTHS)
  );
  return plan.map((month: PlanMonth) => ({
    month: month.month,
    due: month.due,
    plannedMinor: month.plannedMinor,
    status: month.status,
    linkedTransactionId: month.linkedTransactionId,
    actualMinor: month.actualMinor,
    units: month.units === null ? null : Math.round(month.units * 1000) / 1000,
    nav: month.nav,
    navDay: month.navDay,
    covered: month.covered,
    markedSkipped: month.markedSkipped,
  }));
}

/** About a year of NAVs, thinned for a sparkline. */
export function sparkline(series: NavSeries) {
  const last = series.days[series.days.length - 1];
  return last ? downsample(series, addYears(last, -1), 60) : [];
}

/** What went into a holding over the last three months, a month at a time. */
export function recentMonthlyMinor(view: HoldingView, today: string): number {
  const since = addDays(today, -91);
  const total = view.ledger
    .filter((entry) => entry.counted && !entry.pending && entry.kind !== "OPENING" && entry.kind !== "REDEEM" && entry.on > since)
    .reduce((sum, entry) => sum + entry.amountMinor, 0);
  return Math.round(total / 3);
}
