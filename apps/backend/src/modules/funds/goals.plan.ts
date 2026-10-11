import { TopPickSpec } from "./funds.peers";

/**
 * How much to put away each month to reach a goal on time.
 *
 * The return assumed depends on how long there is, because what money can
 * safely be in does: a laptop in eight months can't ride out an equity
 * fall, a house in ten years can. These are deliberately middle-of-the-road
 * long-run figures for each kind of fund in India, not forecasts - the app
 * shows them next to every plan so nobody mistakes them for promises.
 */
export interface GoalAssumption {
  id: "liquid" | "short_debt" | "hybrid" | "equity";
  /// The months-left range it applies to: from (inclusive) to (inclusive), null for open-ended.
  fromMonths: number;
  toMonths: number | null;
  annualReturnPercent: number;
  /// What to invest in, in words, for the app and the advice.
  category: string;
  why: string;
  /// Where example funds are picked from in the peer table.
  picks: TopPickSpec;
}

export const GOAL_ASSUMPTIONS: GoalAssumption[] = [
  {
    id: "liquid",
    fromMonths: 0,
    toMonths: 11,
    annualReturnPercent: 6.5,
    category: "Liquid / overnight fund",
    why: "Under a year: the money has to be there on the day, so no equity at all.",
    picks: { keys: ["debt:liquid"], rankBy: "1y" },
  },
  {
    id: "short_debt",
    fromMonths: 12,
    toMonths: 36,
    annualReturnPercent: 7,
    category: "Short duration / corporate bond debt fund",
    why: "One to three years: a little more than a liquid fund, still without equity's swings.",
    picks: { keys: ["debt:short duration", "debt:corporate bond"], rankBy: "3y" },
  },
  {
    id: "hybrid",
    fromMonths: 37,
    toMonths: 60,
    annualReturnPercent: 9,
    category: "Balanced advantage (dynamic asset allocation) fund",
    why: "Three to five years: some equity for growth, moved into debt when markets are expensive.",
    picks: { keys: ["hybrid:balanced advantage"], rankBy: "3y" },
  },
  {
    id: "equity",
    fromMonths: 61,
    toMonths: null,
    annualReturnPercent: 11,
    category: "Equity index fund (Nifty 50)",
    why: "Over five years: long enough to sit out a fall, and an index fund keeps costs low.",
    picks: {
      keys: ["index:equity"],
      rankBy: "3y",
      nameMatches: /nifty\s*50\b|sensex/i,
      // Smart-beta and sector variants of the Nifty 50 ("Nifty Alpha 50"), not the index itself.
      nameExcludes: /next|equal|value|momentum|quality|alpha\s*\d|low vol|elss|tax saver|arbitrage|etf|fof|fund of fund/i,
    },
  },
];

export function assumptionFor(monthsLeft: number): GoalAssumption {
  return (
    GOAL_ASSUMPTIONS.find((band) => monthsLeft >= band.fromMonths && (band.toMonths === null || monthsLeft <= band.toMonths)) ??
    GOAL_ASSUMPTIONS[GOAL_ASSUMPTIONS.length - 1]
  );
}

/**
 * Whole calendar months from today to the target day - 11 Oct to 11 Oct
 * next year is 12, to 10 Oct is 11 - and 0 once it has come.
 */
export function monthsLeft(today: string, targetOn: string): number {
  if (targetOn <= today) return 0;
  const [fromYear, fromMonth, fromDay] = today.split("-").map(Number);
  const [toYear, toMonth, toDay] = targetOn.split("-").map(Number);
  const months = (toYear - fromYear) * 12 + (toMonth - fromMonth) - (toDay < fromDay ? 1 : 0);
  return Math.max(0, months);
}

function monthlyRate(annualPercent: number): number {
  return Math.pow(1 + annualPercent / 100, 1 / 12) - 1;
}

/**
 * What `n` monthly instalments of 1 grow to, each invested at the start
 * of its month (as a SIP is) and compounding to the end.
 */
function annuityDueFactor(rate: number, months: number): number {
  if (months <= 0) return 0;
  if (rate === 0) return months;
  return ((Math.pow(1 + rate, months) - 1) / rate) * (1 + rate);
}

/** Today's money and a monthly SIP, grown at the assumed rate to the end. */
export function projectValue(currentMinor: number, monthlyMinor: number, months: number, annualPercent: number): number {
  const rate = monthlyRate(annualPercent);
  return currentMinor * Math.pow(1 + rate, months) + monthlyMinor * annuityDueFactor(rate, months);
}

/**
 * The monthly SIP that closes the gap: the target, less what today's money
 * grows to by then, spread over the months left as an annuity due. Zero
 * when today's money gets there on its own; with no months left, the whole
 * gap is due now and comes back as the lump sum.
 */
export function requiredMonthly(
  targetMinor: number,
  currentMinor: number,
  months: number,
  annualPercent: number
): { monthlyMinor: number; lumpSumMinor: number } {
  const rate = monthlyRate(annualPercent);
  const gap = targetMinor - currentMinor * Math.pow(1 + rate, months);
  if (gap <= 0) return { monthlyMinor: 0, lumpSumMinor: 0 };
  if (months <= 0) return { monthlyMinor: 0, lumpSumMinor: Math.round(gap) };
  return { monthlyMinor: Math.ceil(gap / annuityDueFactor(rate, months)), lumpSumMinor: 0 };
}

export const GOAL_STATUSES = ["on_track", "behind", "done"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalPlanInput {
  targetMinor: number;
  targetOn: string;
  /// The linked holdings' value today plus anything saved elsewhere.
  currentMinor: number;
  /// What is actually going in each month now.
  actualMonthlyMinor: number;
  today: string;
}

export interface GoalPlan {
  monthsLeft: number;
  assumption: GoalAssumption;
  requiredMonthlyMinor: number;
  /// Only when the date has come (or is under a month away) and the
  /// money isn't there: what would have to go in now.
  lumpSumNeededMinor: number;
  /// What the current money plus the current monthly amount reach by the date.
  projectedMinor: number;
  shortfallMonthlyMinor: number;
  progressPercent: number;
  status: GoalStatus;
}

/**
 * Where a goal stands. Behind means either the money going in each month
 * is less than the plan needs, or - the same thing said from the other
 * end - what it is on course for falls short of the target. A small
 * tolerance keeps a rounding rupee from turning a goal red.
 */
export function goalPlan(input: GoalPlanInput): GoalPlan {
  const months = monthsLeft(input.today, input.targetOn);
  const assumption = assumptionFor(months);
  const rate = assumption.annualReturnPercent;
  const required = requiredMonthly(input.targetMinor, input.currentMinor, months, rate);
  const projectedMinor = Math.round(projectValue(input.currentMinor, input.actualMonthlyMinor, months, rate));
  const progressPercent = Math.min(100, (input.currentMinor / input.targetMinor) * 100);

  let status: GoalStatus;
  if (input.currentMinor >= input.targetMinor) status = "done";
  else if (
    required.lumpSumMinor > 0 ||
    input.actualMonthlyMinor < required.monthlyMinor * 0.98 ||
    projectedMinor < input.targetMinor * 0.98
  ) {
    status = "behind";
  } else status = "on_track";

  return {
    monthsLeft: months,
    assumption,
    requiredMonthlyMinor: required.monthlyMinor,
    lumpSumNeededMinor: required.lumpSumMinor,
    projectedMinor,
    shortfallMonthlyMinor: Math.max(0, required.monthlyMinor - input.actualMonthlyMinor),
    progressPercent: Math.round(progressPercent * 10) / 10,
    status,
  };
}
