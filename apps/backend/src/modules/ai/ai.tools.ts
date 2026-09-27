import { PipelineStage, Types } from "mongoose";
import {
  Account,
  Category,
  EmiInstalment,
  EmiPlan,
  Loan,
  LoanInstalment,
  Transaction,
} from "../../models";
import { IST_OFFSET, istDayEnd, istDayKey, istDayStart, istMonthKey, istMonthStart } from "../../time";
import { budgetPace } from "../budget/budget.pace";
import { dailyBudget } from "../budget/budget.daily";
import { loanProgress } from "../loans/loans.routes";

/**
 * What the assistant is allowed to look at, as functions it can call.
 *
 * Every one of these is read-only and scoped to the user asking - the
 * model never writes anything and never sees a query it built itself. It
 * picks a function and fills in its arguments; this file decides what that
 * means against the database.
 *
 * Figures go out in rupees rather than paise. A model reading 45000 where
 * it should read ₹450 is exactly the mistake worth designing out.
 */

/** Gemini's function-declaration shape - an OpenAPI subset. */
interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: "OBJECT";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const dateParam = (what: string) => ({
  type: "STRING",
  description: `${what}, as YYYY-MM-DD in IST. Inclusive.`,
});

const categoriesParam = {
  type: "ARRAY",
  items: { type: "STRING" },
  description:
    "Only these categories, by name as list_categories returns them. " +
    'Use "Uncategorized" for transactions with no category.',
};

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "list_categories",
    description:
      "Every category this user can file a transaction under. Call this first whenever the question " +
      'names a kind of spending ("eating out", "travel") so the right category names can be used.',
  },
  {
    name: "spending_summary",
    description:
      "Totals for a date range, optionally grouped. Use for any 'how much' question. Amounts are what " +
      "counts as real spending or income: transfers between own accounts, card bill payments and the " +
      "part of a split bill owed back are already excluded.",
    parameters: {
      type: "OBJECT",
      properties: {
        from: dateParam("Start date"),
        to: dateParam("End date"),
        type: {
          type: "STRING",
          enum: ["DEBIT", "CREDIT"],
          description: "DEBIT for money spent (the default), CREDIT for money received.",
        },
        groupBy: {
          type: "STRING",
          enum: ["none", "category", "merchant", "month", "day", "account"],
          description: "How to break the total down. Defaults to none.",
        },
        categories: categoriesParam,
        merchant: { type: "STRING", description: "Only merchants whose name contains this text." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "find_transactions",
    description:
      "Individual transactions matching filters, for questions about specific payments ('what was my " +
      "biggest purchase', 'when did I last pay Swiggy'). Returns at most 50, plus the total count.",
    parameters: {
      type: "OBJECT",
      properties: {
        from: dateParam("Start date"),
        to: dateParam("End date"),
        type: { type: "STRING", enum: ["DEBIT", "CREDIT"], description: "Leave out for both." },
        categories: categoriesParam,
        merchant: { type: "STRING", description: "Only merchants whose name contains this text." },
        text: { type: "STRING", description: "Matches the merchant or the user's own note." },
        minRupees: { type: "NUMBER", description: "Only amounts at or above this." },
        maxRupees: { type: "NUMBER", description: "Only amounts at or below this." },
        sort: {
          type: "STRING",
          enum: ["recent", "largest"],
          description: "Newest first (default) or biggest first.",
        },
        limit: { type: "INTEGER", description: "How many to return, 1-50. Defaults to 20." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "budget_status",
    description:
      "The user's budget right now: salary pace (what is left to spend until the next salary, per day), " +
      "fixed monthly commitments such as rent and whether each is paid, and the daily budget's savings " +
      "bucket. Use for 'how am I doing', 'can I afford', 'how much can I spend' questions.",
  },
  {
    name: "loans_and_emis",
    description: "Every loan and card EMI plan still running: monthly amount, how many paid, what is left.",
  },
];

type Args = Record<string, unknown>;

const rupees = (minor: number) => Math.round(minor) / 100;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A date argument, defaulting to the start or end of this month. */
function dayArg(value: unknown, fallback: string): string {
  const text = asString(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function range(args: Args): { from: string; to: string; start: Date; end: Date } {
  const today = istDayKey(new Date());
  const from = dayArg(args.from, istDayKey(istMonthStart(istMonthKey(new Date()))));
  const to = dayArg(args.to, today);
  return { from, to, start: istDayStart(from), end: istDayEnd(to) };
}

/** Text typed by a model, made safe to put inside a regular expression. */
function literal(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function userCategories(userId: Types.ObjectId) {
  return Category.find({ $or: [{ userId }, { userId: null }] }).select("name direction");
}

/**
 * Category names to ids, forgivingly: exact first, then containing.
 *
 * Names that match nothing are handed back rather than ignored - silently
 * dropping "Food" from a filter would answer a different question than the
 * one asked, with total confidence.
 */
async function resolveCategories(userId: Types.ObjectId, names: unknown) {
  if (!Array.isArray(names) || names.length === 0) return { filter: undefined, unmatched: [] as string[] };

  const all = await userCategories(userId);
  const ids: (Types.ObjectId | null)[] = [];
  const unmatched: string[] = [];

  for (const raw of names) {
    const name = asString(raw);
    if (!name) continue;
    if (/^(uncategori[sz]ed|none)$/i.test(name)) {
      ids.push(null);
      continue;
    }
    const lower = name.toLowerCase();
    const exact = all.filter((category) => category.name.toLowerCase() === lower);
    const partial = exact.length ? exact : all.filter((category) => category.name.toLowerCase().includes(lower));
    if (partial.length === 0) unmatched.push(name);
    ids.push(...partial.map((category) => category._id));
  }

  return { filter: ids.length ? { $in: ids } : undefined, unmatched };
}

async function listCategories(userId: Types.ObjectId) {
  const categories = await userCategories(userId);
  return {
    categories: categories.map((category) => ({ name: category.name, direction: category.direction })),
  };
}

async function spendingSummary(userId: Types.ObjectId, args: Args) {
  const { from, to, start, end } = range(args);
  const type = args.type === "CREDIT" ? "CREDIT" : "DEBIT";
  const groupBy = asString(args.groupBy) ?? "none";
  const categories = await resolveCategories(userId, args.categories);
  const merchant = asString(args.merchant);

  const match: Record<string, unknown> = {
    userId,
    type,
    occurredAt: { $gte: start, $lte: end },
    countedAmountMinor: { $gt: 0 },
  };
  if (categories.filter) match.categoryId = categories.filter;
  if (merchant) match.merchant = literal(merchant);

  const keys: Record<string, unknown> = {
    none: null,
    category: "$categoryId",
    merchant: { $toLower: { $ifNull: ["$merchant", "(no merchant)"] } },
    month: { $dateToString: { format: "%Y-%m", date: "$occurredAt", timezone: IST_OFFSET } },
    day: { $dateToString: { format: "%Y-%m-%d", date: "$occurredAt", timezone: IST_OFFSET } },
    account: "$accountId",
  };

  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $group: {
        _id: keys[groupBy] ?? null,
        label: { $first: "$merchant" },
        amountMinor: { $sum: "$countedAmountMinor" },
        count: { $sum: 1 },
      },
    },
    { $sort: groupBy === "month" || groupBy === "day" ? { _id: 1 } : { amountMinor: -1 } },
  ];
  const rows = await Transaction.aggregate<{ _id: unknown; label: string | null; amountMinor: number; count: number }>(
    pipeline
  );

  const names = await groupNames(userId, groupBy, rows.map((row) => row._id));
  const total = rows.reduce((sum, row) => sum + row.amountMinor, 0);
  const count = rows.reduce((sum, row) => sum + row.count, 0);

  return {
    from,
    to,
    type,
    totalRupees: rupees(total),
    transactionCount: count,
    ...(categories.unmatched.length ? { unmatchedCategories: categories.unmatched } : {}),
    ...(groupBy === "none"
      ? {}
      : {
          groups: rows.slice(0, 40).map((row) => ({
            name:
              groupBy === "merchant"
                ? (row.label ?? String(row._id))
                : (names.get(String(row._id)) ?? String(row._id ?? "none")),
            totalRupees: rupees(row.amountMinor),
            count: row.count,
          })),
          ...(rows.length > 40 ? { moreGroups: rows.length - 40 } : {}),
        }),
  };
}

/** Readable names for category and account ids. */
async function groupNames(userId: Types.ObjectId, groupBy: string, ids: unknown[]) {
  const names = new Map<string, string>();
  const objectIds = ids.filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);

  if (groupBy === "category") {
    names.set("null", "Uncategorized");
    const categories = await Category.find({ _id: { $in: objectIds } }).select("name");
    for (const category of categories) names.set(category._id.toString(), category.name);
  }
  if (groupBy === "account") {
    names.set("null", "No account");
    const accounts = await Account.find({ _id: { $in: objectIds }, userId });
    for (const account of accounts) names.set(account._id.toString(), accountName(account));
  }
  return names;
}

function accountName(account: { nickname?: string | null; bankName: string; last4?: string | null; accountType: string }) {
  if (account.nickname) return account.nickname;
  return `${account.bankName}${account.last4 ? ` ••${account.last4}` : ""} (${account.accountType.toLowerCase()})`;
}

async function findTransactions(userId: Types.ObjectId, args: Args) {
  const { from, to, start, end } = range(args);
  const categories = await resolveCategories(userId, args.categories);
  const merchant = asString(args.merchant);
  const text = asString(args.text);
  const minRupees = asNumber(args.minRupees);
  const maxRupees = asNumber(args.maxRupees);
  const limit = Math.min(Math.max(Math.round(asNumber(args.limit) ?? 20), 1), 50);

  const query: Record<string, unknown> = { userId, occurredAt: { $gte: start, $lte: end } };
  if (args.type === "DEBIT" || args.type === "CREDIT") query.type = args.type;
  if (categories.filter) query.categoryId = categories.filter;
  if (merchant) query.merchant = literal(merchant);
  if (text) query.$or = [{ merchant: literal(text) }, { note: literal(text) }];
  if (minRupees !== undefined || maxRupees !== undefined) {
    query.amountMinor = {
      ...(minRupees !== undefined ? { $gte: Math.round(minRupees * 100) } : {}),
      ...(maxRupees !== undefined ? { $lte: Math.round(maxRupees * 100) } : {}),
    };
  }

  const [total, rows] = await Promise.all([
    Transaction.aggregate<{ count: number; countedMinor: number }>([
      { $match: query },
      { $group: { _id: null, count: { $sum: 1 }, countedMinor: { $sum: "$countedAmountMinor" } } },
    ]),
    Transaction.find(query)
      .sort(args.sort === "largest" ? { amountMinor: -1 } : { occurredAt: -1 })
      .limit(limit)
      .populate("category")
      .populate("account"),
  ]);

  return {
    from,
    to,
    matching: total[0]?.count ?? 0,
    countedTotalRupees: rupees(total[0]?.countedMinor ?? 0),
    ...(categories.unmatched.length ? { unmatchedCategories: categories.unmatched } : {}),
    transactions: rows.map((row) => {
      const json = row.toJSON() as {
        category?: { name: string } | null;
        account?: { nickname?: string | null; bankName: string; last4?: string | null; accountType: string } | null;
      };
      return {
        date: istDayKey(row.occurredAt),
        type: row.type,
        amountRupees: rupees(row.amountMinor),
        // Differs from the amount when only part of it counts - a split,
        // a transfer, a card bill - and the reason says which.
        countedRupees: rupees(row.countedAmountMinor),
        countedReason: row.countedReason,
        merchant: row.merchant ?? null,
        note: row.note ?? null,
        category: json.category?.name ?? "Uncategorized",
        account: json.account ? accountName(json.account) : null,
      };
    }),
  };
}

async function budgetStatus(userId: Types.ObjectId) {
  const [pace, daily] = await Promise.all([budgetPace(userId), dailyBudget(userId)]);

  return {
    salaryPace: pace.configured
      ? {
          periodStart: istDayKey(pace.periodStart),
          periodEnd: istDayKey(pace.periodEnd),
          daysLeft: pace.daysLeft,
          salaryRupees: rupees(pace.salaryMinor),
          spentThisPeriodRupees: rupees(pace.spentMinor),
          fixedCostsStillToGoOutRupees: rupees(pace.commitmentsRemainingMinor),
          leftToSpendRupees: rupees(pace.remainingMinor),
          perDayFromHereRupees: rupees(pace.perDayMinor),
          lastWeekPerDayRupees: rupees(pace.recentPerDayMinor),
          state: pace.state,
          fixedCommitments: pace.commitments.map((commitment) => ({
            name: commitment.name,
            amountRupees: rupees(commitment.amountMinor),
            dayOfMonth: commitment.dayOfMonth,
            paid: commitment.isPaid,
          })),
        }
      : "Not set up - the user has not entered a salary and pay day in Settings.",
    dailyBudget: daily.configured
      ? {
          perDayRupees: rupees(daily.dailyBudgetMinor),
          daysCounted: daily.daysCounted,
          allowedSoFarRupees: rupees(daily.allowedMinor),
          spentSoFarRupees: rupees(daily.spentMinor),
          savingsBucketRupees: rupees(daily.bucketMinor),
          todaySpentRupees: rupees(daily.todaySpentMinor),
          daysOverBudget: daily.daysOver,
          keptOutRupees: rupees(daily.keptOutMinor),
        }
      : "Not set up - the user has not chosen a daily budget in Settings.",
  };
}

async function loansAndEmis(userId: Types.ObjectId) {
  const [loans, plans] = await Promise.all([
    Loan.find({ userId, status: "ACTIVE" }),
    EmiPlan.find({ userId, status: "ACTIVE" }),
  ]);
  const [loanInstalments, emiInstalments] = await Promise.all([
    LoanInstalment.find({ loanId: { $in: loans.map((loan) => loan._id) } }),
    EmiInstalment.find({ planId: { $in: plans.map((plan) => plan._id) } }),
  ]);

  const describe = (
    label: string,
    plan: { principalMinor: number; months: number; monthlyAmountMinor: number },
    progress: ReturnType<typeof loanProgress>
  ) => ({
    label,
    borrowedRupees: rupees(plan.principalMinor),
    monthlyRupees: rupees(plan.monthlyAmountMinor),
    instalmentsPaid: progress.paidCount,
    instalmentsTotal: plan.months,
    leftToRepayRupees: rupees(progress.remainingMinor),
    nextDue: progress.nextDue
      ? { date: istDayKey(progress.nextDue.dueDate), amountRupees: rupees(progress.nextDue.amountMinor) }
      : null,
  });

  return {
    loans: loans.map((loan) =>
      describe(loan.label, loan, loanProgress(loanInstalments.filter((row) => row.loanId.equals(loan._id))))
    ),
    cardEmis: plans.map((plan) =>
      describe(
        plan.label ?? "Card EMI",
        plan,
        loanProgress(emiInstalments.filter((row) => row.planId.equals(plan._id)))
      )
    ),
  };
}

/** Runs one call the model asked for. Never throws: an error is an answer too. */
export async function runTool(userId: Types.ObjectId, name: string, args: Args): Promise<Record<string, unknown>> {
  try {
    switch (name) {
      case "list_categories":
        return await listCategories(userId);
      case "spending_summary":
        return await spendingSummary(userId, args);
      case "find_transactions":
        return await findTransactions(userId, args);
      case "budget_status":
        return await budgetStatus(userId);
      case "loans_and_emis":
        return await loansAndEmis(userId);
      default:
        return { error: `No function called ${name}.` };
    }
  } catch (error) {
    console.error(`AI tool ${name} failed:`, error);
    return { error: "That lookup failed on the server." };
  }
}
