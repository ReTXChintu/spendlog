import { Types } from "mongoose";
import { FundAdvice, FundAdviceDoc } from "../../models";
import { istDayKey } from "../../time";
import { monthlyBudgetStatus } from "../budget/budget.monthly";
import { askForJson } from "../ai/ai.gemini";
import { FLAG_RULES } from "./funds.math";
import { PeerScheme, PeerTable, topPicks } from "./funds.peers";
import { HoldingView, loadPortfolio, percent, Portfolio, portfolioTotals } from "./funds.portfolio";
import { goalsFor } from "./goals.service";
import { GOAL_ASSUMPTIONS } from "./goals.plan";

/**
 * The assistant's read of the user's funds: which SIPs are lagging and
 * why, what to add or switch, and a line per goal.
 *
 * Gemini is handed facts the server already worked out - XIRR, category
 * ranks, flags, goals and their monthly need, the budget - never the raw
 * data, and a list of funds it is allowed to name. Every fund in what
 * comes back is checked against that list and dropped if it isn't on it,
 * so a confident-sounding fund the model made up never reaches the app.
 */

export const ADVICE_DISCLAIMER =
  "This is not investment advice. Past returns don't guarantee future returns. Mutual fund investments are " +
  "subject to market risks: read the scheme documents, and check with a SEBI-registered adviser before " +
  "acting on any of it.";

const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;
const pct = (fraction: number | null | undefined) => (fraction === null || fraction === undefined ? "n/a" : `${percent(fraction)}%`);

export interface FundAdviceJson {
  summary: string;
  underperformers: { holdingId: string; schemeName: string; reason: string }[];
  actions: {
    title: string;
    detail: string;
    amountMinor: number | null;
    category: string | null;
    exampleFunds: { schemeCode: number; name: string }[];
  }[];
  goals: { goalId: string; name: string; line: string }[];
  disclaimer: string;
  generatedAt: string;
}

interface AdviceAnswer {
  summary?: string;
  underperformers?: { holdingId?: string; reason?: string }[];
  actions?: {
    title?: string;
    detail?: string;
    amountRupees?: number | null;
    category?: string | null;
    exampleFundCodes?: number[];
  }[];
  goals?: { goalId?: string; line?: string }[];
}

const ADVICE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "Two to four sentences on the portfolio as a whole." },
    underperformers: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          holdingId: { type: "STRING", description: "Exactly one of the holding ids given." },
          reason: { type: "STRING", description: "Why, with the numbers given: XIRR, category rank, returns against the median." },
        },
        required: ["holdingId", "reason"],
      },
    },
    actions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "Under 10 words." },
          detail: { type: "STRING", description: "One to three sentences." },
          amountRupees: { type: "NUMBER", nullable: true, description: "A monthly amount, when the action is one." },
          category: { type: "STRING", nullable: true, description: "The fund category it is about." },
          exampleFundCodes: {
            type: "ARRAY",
            items: { type: "INTEGER" },
            description: "Scheme codes from the candidate list only. Empty when none fits.",
          },
        },
        required: ["title", "detail"],
      },
    },
    goals: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          goalId: { type: "STRING", description: "Exactly one of the goal ids given." },
          line: { type: "STRING", description: "Put ₹X/month into <category>, e.g. <fund from the candidate list>." },
        },
        required: ["goalId", "line"],
      },
    },
  },
  required: ["summary", "underperformers", "actions", "goals"],
};

function holdingLine(view: HoldingView): string {
  const { holding, summary, peers } = view;
  const parts = [
    `id ${holding._id.toString()}: ${holding.schemeName} (${view.categoryLabel}, ${view.assetClass}` +
      `${view.isRegular ? ", REGULAR plan" : ""}${holding.isGrowth ? "" : ", IDCW plan: its returns leave out payouts"})`,
    `invested ${rupees(summary.investedMinor)}, value ${rupees(summary.valueMinor)}, gain ${pct(summary.gainPercent)}`,
    `XIRR ${summary.xirr === null ? "too early to tell" : pct(summary.xirr)}, held ${summary.heldDays} days`,
    view.monthlySipMinor ? `SIP ${rupees(view.monthlySipMinor)}/month` : "no running SIP",
    `fund return 1y ${pct(view.oneYear)}, 3y ${pct(view.threeYear)}`,
  ];
  if (peers) {
    parts.push(
      `category median 1y ${pct(peers.oneYear.median)}, 3y ${pct(peers.threeYear.median)}`,
      peers.rank
        ? `ranks ${peers.rank.rank} of ${peers.rank.of} on ${peers.basis} (beats ${Math.round(peers.rank.percentile)}% of peers)`
        : "no category rank"
    );
  }
  parts.push(`flags: ${view.flags.length ? view.flags.join(", ") : "none"}`);
  return `- ${parts.join("; ")}.`;
}

/** The funds the model may name: the best in each category that matters to this user. */
function candidateFunds(portfolio: Portfolio, goalCategories: string[][]): Map<number, PeerScheme & { why: string }> {
  const table = portfolio.peers?.table;
  const candidates = new Map<number, PeerScheme & { why: string }>();
  if (!table) return candidates;
  const add = (schemes: PeerScheme[], why: string) => {
    for (const scheme of schemes) if (!candidates.has(scheme.code)) candidates.set(scheme.code, { ...scheme, why });
  };

  // Better funds in each category held, as switch candidates.
  for (const view of portfolio.views) {
    const picks = topPicks(table, { keys: [view.categoryKey], rankBy: "3y" });
    add(picks.length ? picks : topPicks(table, { keys: [view.categoryKey], rankBy: "1y" }), `top of ${view.categoryLabel}`);
  }
  // Each goal's horizon, and the rest of the horizons for a portfolio
  // with gaps in it.
  for (const assumption of GOAL_ASSUMPTIONS) {
    add(topPicks(table, assumption.picks), `for ${assumption.category}`);
  }
  for (const keys of goalCategories) {
    add(topPicks(table, { keys, rankBy: "3y" }), "goal");
  }
  // A diversified core most portfolios can build on.
  add(topPicks(table, { keys: ["equity:flexi cap"], rankBy: "3y" }), "top of Flexi Cap");
  return candidates;
}

/**
 * Today's advice: made once a day, then served from storage, unless a new
 * one is asked for. Null when there is none and none could be made.
 */
export async function fundAdvice(
  userId: Types.ObjectId,
  generate: { key: string; model: string } | null,
  force = false,
  now = new Date()
): Promise<{ doc: FundAdviceDoc | null; cached: boolean }> {
  const latest = await FundAdvice.findOne({ userId }).sort({ day: -1, updatedAt: -1 }).lean<FundAdviceDoc>();
  if (latest && latest.day === istDayKey(now) && !force) return { doc: latest, cached: true };
  if (!generate) return { doc: latest, cached: true };

  const portfolio = await loadPortfolio(userId, now, true);
  const [goals, budget] = await Promise.all([
    goalsFor(userId, portfolio),
    monthlyBudgetStatus(userId, undefined, now).catch(() => null),
  ]);
  const { totals, allocation } = portfolioTotals(portfolio.views);
  const candidates = candidateFunds(
    portfolio,
    goals.map((goal) => GOAL_ASSUMPTIONS.find((band) => band.id === goal.assumption.id)?.picks.keys ?? [])
  );

  const lines: string[] = [];
  lines.push(`Today is ${portfolio.today}.`);
  if (portfolio.views.length) {
    lines.push(
      `Portfolio: invested ${rupees(totals.investedMinor)}, value ${rupees(totals.valueMinor)}, ` +
        `XIRR ${totals.xirrPercent === null ? "too early to tell" : `${totals.xirrPercent}%`}, ` +
        `SIPs ${rupees(totals.monthlySipMinor)}/month.`,
      `Allocation: ${allocation.map((row) => `${row.assetClass} ${row.percent}%`).join(", ")}.`,
      "Holdings:",
      ...portfolio.views.map(holdingLine)
    );
  } else {
    lines.push("No mutual fund holdings yet.");
  }
  lines.push(
    `Flag meanings: lagging_category = bottom quarter of its category, or more than ${FLAG_RULES.belowMedianPp["3y"]} ` +
      `points a year under the category median on 3y returns (${FLAG_RULES.belowMedianPp["1y"]} on 1y when under three ` +
      `years old); low_xirr = negative, or under ${FLAG_RULES.liquidRate * 100}% after a year; regular_plan = pays ` +
      "distributor commission a direct plan of the same fund doesn't."
  );

  if (goals.length) {
    lines.push("Goals:");
    for (const goal of goals) {
      lines.push(
        `- id ${goal.id}: ${goal.name}, ${rupees(goal.targetMinor)} by ${goal.targetOn} (${goal.monthsLeft} months). ` +
          `Has ${rupees(goal.progress.currentMinor)}; needs ${rupees(goal.requiredMonthlyMinor)}/month at ` +
          `${goal.assumption.annualReturnPercent}% a year in a ${goal.assumption.category}; going in now ` +
          `${rupees(goal.actualMonthlyMinor)}/month; status ${goal.status}.`
      );
    }
  } else {
    lines.push("No goals set.");
  }

  if (budget?.configured) {
    lines.push(
      `Monthly budget ${rupees(budget.budgetMinor!)} (it already includes SIP debits), ` +
        `${rupees(budget.leftMinor!)} left this month.`
    );
  }
  if (budget?.bucket.configured) lines.push(`Savings bucket balance: ${rupees(budget.bucket.balanceMinor)}.`);

  lines.push("Candidate funds (the only funds you may name; direct growth plans, annualised returns):");
  for (const scheme of candidates.values()) {
    lines.push(`- code ${scheme.code}: ${scheme.name} (${scheme.label}); 1y ${pct(scheme.r1)}, 3y ${pct(scheme.r3)}; ${scheme.why}.`);
  }

  const instruction = [
    "You are a careful mutual fund coach for someone in India. Use only the figures given; never invent numbers.",
    "Say which SIPs or holdings are underperforming and why, quoting the numbers (XIRR, category rank, return",
    "against the category median); a regular plan is worth switching to the direct plan of the same fund. Then say",
    "what to add or switch, keeping the allocation sensible for their goals. For every goal give one line: 'Put",
    "₹X/month into <category>, e.g. <fund>'. Name funds ONLY from the candidate list, by their scheme code in",
    "exampleFundCodes; never mention any other fund by name. Keep monthly amounts within what the budget can take",
    "when a budget is given. Amounts are in rupees. Be brief and specific. 2 to 5 actions.",
  ].join(" ");

  const answer = await askForJson<AdviceAnswer>(generate.key, generate.model, instruction, lines.join("\n"), ADVICE_SCHEMA);
  const advice = validateAdvice(answer, portfolio, goals, candidates, now, portfolio.peers?.table ?? null);

  const doc = await FundAdvice.findOneAndUpdate(
    { userId, day: portfolio.today },
    { $set: { advice, model: generate.model } },
    { upsert: true, new: true }
  ).lean<FundAdviceDoc>();
  return { doc, cached: false };
}

/** "HDFC Mid Cap Fund - Direct Plan - Growth" to "hdfc mid cap fund", for spotting a fund named in text. */
function baseName(name: string): string {
  return name.split(" - ")[0].toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether some text names a fund that is neither a candidate nor held:
 * the base name of any other scheme in the peer table, appearing whole.
 * Short base names are skipped - "Axis Fund" would match too much.
 */
export function namesOtherFund(text: string, allowed: Set<string>, table: PeerTable | null): boolean {
  if (!table) return false;
  const lower = text.toLowerCase();
  return table.schemes.some((scheme) => {
    const base = baseName(scheme.name);
    return base.length >= 12 && !allowed.has(base) && lower.includes(base);
  });
}

/**
 * The model's answer, kept only where it refers to things that exist:
 * this user's holdings and goals, and funds from the candidate list. An
 * action or goal line whose words name any other fund is dropped whole,
 * since there's no fixing a sentence built around it.
 */
export function validateAdvice(
  answer: AdviceAnswer,
  portfolio: Pick<Portfolio, "views">,
  goals: { id: string; name: string }[],
  candidates: Map<number, Pick<PeerScheme, "code" | "name" | "label">>,
  now: Date,
  table: PeerTable | null = null
): FundAdviceJson {
  const holdings = new Map(portfolio.views.map((view) => [view.holding._id.toString(), view.holding.schemeName]));
  const goalNames = new Map(goals.map((goal) => [goal.id, goal.name]));
  const clip = (value: unknown, length: number) => String(value ?? "").trim().slice(0, length);
  const allowed = new Set([...[...candidates.values()].map((scheme) => baseName(scheme.name)), ...[...holdings.values()].map(baseName)]);
  const clean = (text: string) => !namesOtherFund(text, allowed, table);

  const underperformers = (answer.underperformers ?? [])
    .filter((item) => item.holdingId && holdings.has(item.holdingId))
    .map((item) => ({ holdingId: item.holdingId!, schemeName: holdings.get(item.holdingId!)!, reason: clip(item.reason, 600) }))
    .filter((item) => item.reason);

  const actions = (answer.actions ?? []).slice(0, 8).map((action) => {
    const exampleFunds = [...new Set((action.exampleFundCodes ?? []).map(Number))]
      .filter((code) => candidates.has(code))
      .slice(0, 3)
      .map((code) => ({ schemeCode: code, name: candidates.get(code)!.name }));
    return {
      title: clip(action.title, 120),
      detail: clip(action.detail, 800),
      amountMinor:
        typeof action.amountRupees === "number" && action.amountRupees > 0 ? Math.round(action.amountRupees * 100) : null,
      category: action.category ? clip(action.category, 80) : null,
      exampleFunds,
    };
  });

  const goalLines = (answer.goals ?? [])
    .filter((item) => item.goalId && goalNames.has(item.goalId))
    .map((item) => ({ goalId: item.goalId!, name: goalNames.get(item.goalId!)!, line: clip(item.line, 400) }))
    .filter((item) => item.line);

  return {
    summary: clip(answer.summary, 1500),
    underperformers,
    actions: actions.filter((action) => (action.title || action.detail) && clean(`${action.title} ${action.detail}`)),
    goals: goalLines.filter((item) => clean(item.line)),
    disclaimer: ADVICE_DISCLAIMER,
    generatedAt: now.toISOString(),
  };
}
