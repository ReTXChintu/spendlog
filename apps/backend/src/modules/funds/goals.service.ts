import { Types } from "mongoose";
import { Goal, GoalDoc } from "../../models";
import { percent, Portfolio, recentMonthlyMinor } from "./funds.portfolio";
import { PeerTable, topPicks } from "./funds.peers";
import { GOAL_ASSUMPTIONS, GoalAssumption, goalPlan } from "./goals.plan";

/**
 * Goals, each read against the holdings put towards it: how far along,
 * what it needs a month, whether what's going in now gets there, and
 * where the monthly amount should go.
 */

const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;

/** An assumption as the app shows it - the pick rules are the server's business. */
export function assumptionJson(assumption: GoalAssumption) {
  return {
    id: assumption.id,
    fromMonths: assumption.fromMonths,
    toMonths: assumption.toMonths,
    annualReturnPercent: assumption.annualReturnPercent,
    category: assumption.category,
    why: assumption.why,
  };
}

export const ASSUMPTIONS_JSON = GOAL_ASSUMPTIONS.map(assumptionJson);

/** The example funds for an assumption: the best direct-growth schemes in its category. */
export function exampleFunds(table: PeerTable | null, assumption: GoalAssumption, count = 3) {
  if (!table) return [];
  return topPicks(table, assumption.picks, count).map((scheme) => ({
    schemeCode: scheme.code,
    name: scheme.name,
    fundHouse: scheme.house,
    categoryLabel: scheme.label,
    oneYearPercent: percent(scheme.r1),
    threeYearPercent: percent(scheme.r3),
  }));
}

export function goalJson(goal: GoalDoc, portfolio: Portfolio) {
  const ids = new Set(goal.holdingIds.map((id) => id.toString()));
  const linked = portfolio.views.filter((view) => ids.has(view.holding._id.toString()));
  const holdingsValueMinor = linked.reduce((sum, view) => sum + view.summary.valueMinor, 0);
  const currentMinor = holdingsValueMinor + (goal.savedMinor ?? 0);
  // A running SIP is what goes in each month; a holding without one is
  // read from what actually went in over the last three months.
  const actualMonthlyMinor = linked.reduce(
    (sum, view) => sum + (view.monthlySipMinor > 0 ? view.monthlySipMinor : recentMonthlyMinor(view, portfolio.today)),
    0
  );

  const plan = goalPlan({
    targetMinor: goal.targetMinor,
    targetOn: goal.targetOn,
    currentMinor,
    actualMonthlyMinor,
    today: portfolio.today,
  });

  let warning: string | null = null;
  if (plan.status === "behind") {
    warning =
      plan.lumpSumNeededMinor > 0
        ? `${rupees(plan.lumpSumNeededMinor)} short, with the date here.`
        : `${rupees(plan.shortfallMonthlyMinor)} a month short: put in ${rupees(plan.requiredMonthlyMinor)} a month to get there by ${goal.targetOn}.`;
  }

  return {
    id: goal._id.toString(),
    name: goal.name,
    targetMinor: goal.targetMinor,
    targetOn: goal.targetOn,
    savedMinor: goal.savedMinor ?? 0,
    holdingIds: goal.holdingIds.map((id) => id.toString()),
    createdAt: goal.createdAt,
    progress: { currentMinor, holdingsValueMinor, savedMinor: goal.savedMinor ?? 0, percent: plan.progressPercent },
    monthsLeft: plan.monthsLeft,
    requiredMonthlyMinor: plan.requiredMonthlyMinor,
    lumpSumNeededMinor: plan.lumpSumNeededMinor,
    actualMonthlyMinor,
    projectedMinor: plan.projectedMinor,
    shortfallMonthlyMinor: plan.shortfallMonthlyMinor,
    status: plan.status,
    warning,
    assumption: assumptionJson(plan.assumption),
    suggestedCategory: plan.assumption.category,
    exampleFunds: exampleFunds(portfolio.peers?.table ?? null, plan.assumption),
  };
}

export async function goalsFor(userId: Types.ObjectId, portfolio: Portfolio) {
  const goals = await Goal.find({ userId }).sort({ targetOn: 1, createdAt: 1 }).lean<GoalDoc[]>();
  return goals.map((goal) => goalJson(goal, portfolio));
}
