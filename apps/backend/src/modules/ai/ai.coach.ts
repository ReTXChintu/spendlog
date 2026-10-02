import { Types } from "mongoose";
import { AiInsight, FixedCommitment, Loan, SavingsPlan, SavingsPlanDoc, Transaction, User } from "../../models";
import { istDayKey } from "../../time";
import { UserMonth, userMonths } from "../budget/budget.months";
import { ask, askForJson } from "./ai.gemini";

/**
 * The assistant as a coach rather than a chat: a read of the month kept for
 * the day, and a savings plan whose rules are checked as the month goes so
 * the app can say when one is being broken.
 */

const INSIGHT_PROMPT =
  "Give me insights on my spending this month compared with last month: what moved most and why it " +
  "matters, the biggest merchants, how I'm doing against my budget, and two or three specific things I " +
  "could do differently. Keep it short.";

/**
 * Today's insight: made once a day, then served from storage, unless a new
 * one is asked for. Returns null when there is none yet and none was asked
 * to be made.
 */
export async function dailyInsight(
  userId: Types.ObjectId,
  generate: { key: string; model: string } | null,
  force = false,
  now = new Date()
) {
  const day = istDayKey(now);
  const latest = await AiInsight.findOne({ userId }).sort({ day: -1, updatedAt: -1 });
  if (latest && latest.day === day && !force) return latest;
  if (!generate) return latest;

  const { answer } = await ask(userId, generate.key, generate.model, [{ role: "user", text: INSIGHT_PROMPT }], now);
  return AiInsight.findOneAndUpdate(
    { userId, day },
    { $set: { text: answer, model: generate.model } },
    { upsert: true, new: true }
  );
}

/** Spending by category name for a month, on what counts. */
async function spendByCategory(userId: Types.ObjectId, month: Pick<UserMonth, "start" | "end">) {
  const rows = await Transaction.aggregate<{ name: string; total: number }>([
    {
      $match: {
        userId,
        type: "DEBIT",
        countedAmountMinor: { $gt: 0 },
        occurredAt: { $gte: month.start, $lt: month.end },
      },
    },
    { $group: { _id: "$categoryId", total: { $sum: "$countedAmountMinor" } } },
    { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
    { $project: { total: 1, name: { $ifNull: [{ $first: "$category.name" }, "Uncategorized"] } } },
    { $sort: { total: -1 } },
  ]);
  return rows;
}

async function incomeFor(userId: Types.ObjectId, month: Pick<UserMonth, "start" | "end">) {
  const [row] = await Transaction.aggregate<{ total: number }>([
    { $match: { userId, type: "CREDIT", occurredAt: { $gte: month.start, $lt: month.end } } },
    { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
  ]);
  return row?.total ?? 0;
}

const rupees = (minor: number) => `₹${Math.round(minor / 100).toLocaleString("en-IN")}`;

interface PlanAnswer {
  summary: string;
  monthlyTargetRupees?: number | null;
  rules: { text: string; category?: string | null; monthlyCapRupees?: number | null }[];
}

const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING", description: "Two or three sentences: where the money goes and the plan in short." },
    monthlyTargetRupees: { type: "NUMBER", nullable: true, description: "What to put aside each month." },
    rules: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: "One specific rule, in plain words, under 25 words." },
          category: { type: "STRING", nullable: true, description: "Exactly one of the category names given, or null." },
          monthlyCapRupees: { type: "NUMBER", nullable: true, description: "A monthly cap for that category." },
        },
        required: ["text"],
      },
    },
  },
  required: ["summary", "rules"],
};

/**
 * Writes a savings plan from the last few months of the user's own money,
 * and keeps it. The figures are gathered here and handed over whole, so the
 * plan is built on the same totals the rest of the app shows.
 */
export async function makeSavingsPlan(userId: Types.ObjectId, key: string, model: string, now = new Date()) {
  const [user, months, commitments, loans] = await Promise.all([
    User.findById(userId).select("salaryAmountMinor salaryDay dailyBudgetMinor").orFail(),
    userMonths(userId, now, 4),
    FixedCommitment.find({ userId, isActive: true }),
    Loan.find({ userId, status: "ACTIVE" }),
  ]);

  const lines: string[] = [];
  lines.push(
    `Months run ${months.bySalary ? `from pay day (the ${user.salaryDay}) to pay day` : "by the calendar"}.`
  );
  if (user.salaryAmountMinor) lines.push(`Salary: ${rupees(user.salaryAmountMinor)} a month.`);
  if (user.dailyBudgetMinor) lines.push(`Daily budget they set: ${rupees(user.dailyBudgetMinor)} a day.`);
  if (commitments.length) {
    lines.push(
      `Fixed each month: ${commitments.map((c) => `${c.name} ${rupees(c.amountMinor)}`).join(", ")}.`
    );
  }
  if (loans.length) {
    lines.push(`Loan repayments: ${loans.map((l) => `${l.label} ${rupees(l.monthlyAmountMinor)}`).join(", ")}.`);
  }

  const categoryNames = new Set<string>();
  for (const [index, month] of months.recent.entries()) {
    const [spend, income] = await Promise.all([spendByCategory(userId, month), incomeFor(userId, month)]);
    spend.forEach((row) => categoryNames.add(row.name));
    const total = spend.reduce((sum, row) => sum + row.total, 0);
    lines.push(
      `${index === 0 ? "This month so far" : `Month ${month.from} to ${month.to}`}: spent ${rupees(total)}, ` +
        `money in ${rupees(income)}. By category: ` +
        (spend.length ? spend.map((row) => `${row.name} ${rupees(row.total)}`).join(", ") : "nothing") +
        "."
    );
  }

  const instruction = [
    "You are a careful personal-finance coach for someone in India, writing a savings plan from their real spending.",
    "Use only the figures given. Be specific: name categories and amounts, and make every rule something a person",
    "could actually follow this month. Give 3 to 6 rules. Where a rule caps a category, set category to exactly one",
    `of these names: ${[...categoryNames].join(", ") || "(none)"} - and set a realistic monthly cap, usually 10-25%`,
    "below what they have been spending there, never below what a fixed cost needs. Do not recommend specific",
    "investment products. Amounts are in rupees.",
  ].join(" ");

  const answer = await askForJson<PlanAnswer>(key, model, instruction, lines.join("\n"), PLAN_SCHEMA);

  const known = new Map([...categoryNames].map((name) => [name.toLowerCase(), name]));
  const rules = (answer.rules ?? []).slice(0, 8).map((rule) => {
    const category = rule.category ? (known.get(rule.category.toLowerCase()) ?? null) : null;
    return {
      text: String(rule.text ?? "").slice(0, 300),
      category,
      monthlyCapMinor:
        category && typeof rule.monthlyCapRupees === "number" && rule.monthlyCapRupees > 0
          ? Math.round(rule.monthlyCapRupees * 100)
          : null,
    };
  });

  return SavingsPlan.findOneAndUpdate(
    { userId },
    {
      $set: {
        summary: String(answer.summary ?? "").slice(0, 1200),
        monthlyTargetMinor:
          typeof answer.monthlyTargetRupees === "number" && answer.monthlyTargetRupees > 0
            ? Math.round(answer.monthlyTargetRupees * 100)
            : null,
        rules: rules.filter((rule) => rule.text),
        model,
      },
    },
    { upsert: true, new: true }
  );
}

export type RuleState = "ok" | "watch" | "over";

/**
 * The plan, with each capped rule held up against this month so far.
 *
 * "watch" is ahead of where the cap says this point in the month should
 * be; "over" is past the cap itself. The rest are reminders with nothing
 * to measure.
 */
export async function planStatus(userId: Types.ObjectId, now = new Date()) {
  const plan = await SavingsPlan.findOne({ userId });
  if (!plan) return null;

  const { recent } = await userMonths(userId, now, 1);
  const month = recent[0];
  const spend = await spendByCategory(userId, { start: month.start, end: now });
  const spentBy = new Map(spend.map((row) => [row.name.toLowerCase(), row.total]));

  const length = month.end.getTime() - month.start.getTime();
  const fraction = Math.min(1, Math.max(0, (now.getTime() - month.start.getTime()) / length));

  const rules = plan.rules.map((rule) => {
    if (!rule.category || !rule.monthlyCapMinor) return { ...ruleJson(rule), state: "ok" as RuleState };
    const spentMinor = spentBy.get(rule.category.toLowerCase()) ?? 0;
    const expectedSoFarMinor = Math.round(rule.monthlyCapMinor * fraction);
    const state: RuleState =
      spentMinor > rule.monthlyCapMinor ? "over" : spentMinor > expectedSoFarMinor ? "watch" : "ok";
    return { ...ruleJson(rule), spentMinor, expectedSoFarMinor, state };
  });

  return {
    summary: plan.summary,
    monthlyTargetMinor: plan.monthlyTargetMinor ?? null,
    model: plan.model,
    updatedAt: plan.updatedAt,
    month: { from: month.from, to: month.to },
    rules,
    warnings: rules.filter((rule) => rule.state !== "ok"),
  };
}

function ruleJson(rule: SavingsPlanDoc["rules"][number]) {
  return { text: rule.text, category: rule.category ?? null, monthlyCapMinor: rule.monthlyCapMinor ?? null };
}
