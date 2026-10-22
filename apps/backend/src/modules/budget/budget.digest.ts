import { Types } from "mongoose";
import { Category, MonthlyDigest, User } from "../../models";
import { runDailyJob } from "../../jobs/daily";
import { sendNotification } from "../family/family.push";
import { addDays, todayKey } from "../subscriptions/subscriptions.schedule";
import { savingsBucket } from "./budget.bucket";
import { MonthlyBudgetStatus, monthlyBudgetStatus, spendingIn } from "./budget.monthly";
import { userMonth, userMonths } from "./budget.months";

/**
 * The month that just closed, in one notification: the morning after pay
 * day, "15 Sep – 14 Oct: ₹42,310 spent · 85% of your ₹50,000 budget ·
 * Biggest: Food ₹12,400 · ₹7,690 moved to savings". Tapping it opens
 * that month on the budget screen.
 *
 * Once per month per person. The morning after pay day is the first the
 * month is over on, whatever day the salary itself lands; a phone that
 * was off that morning gets it on the next, up to a week on, after which
 * the month is old news.
 */

export const DIGEST_HOUR_IST = 9;
export const DIGEST_WINDOW_DAYS = 7;
const JOB_KEY = "monthlyDigest";

const rupees = (minor: number) => `₹${Math.round(Math.abs(minor) / 100).toLocaleString("en-IN")}`;

export interface DigestText {
  title: string;
  body: string;
}

/** The month's biggest kind of spending, by name. */
export function biggestCategory(
  status: Pick<MonthlyBudgetStatus, "categories" | "unassigned">,
  fallback: { name: string; spentMinor: number }[] = []
): { name: string; spentMinor: number } | null {
  const all = [
    ...status.categories.map((category) => ({ name: category.name, spentMinor: category.spentMinor })),
    ...(status.unassigned?.categories ?? []).map((category) => ({ name: category.name, spentMinor: category.spentMinor })),
    ...fallback,
  ].filter((category) => category.spentMinor > 0);
  if (all.length === 0) return null;
  return all.reduce((best, category) => (category.spentMinor > best.spentMinor ? category : best));
}

/**
 * The words. `toBucketMinor` is what the month moved the savings bucket
 * by, once it is settled - null when there is no bucket to speak of.
 */
export function digestText(
  status: Pick<MonthlyBudgetStatus, "month" | "configured" | "budgetMinor" | "spentMinor" | "leftMinor" | "isOver" | "categories" | "unassigned">,
  toBucketMinor: number | null,
  fallbackCategories: { name: string; spentMinor: number }[] = []
): DigestText {
  const title = `${status.month.label}: ${rupees(status.spentMinor)} spent`;
  const parts: string[] = [];
  if (status.configured && status.budgetMinor) {
    const percent = Math.round((status.spentMinor / status.budgetMinor) * 100);
    parts.push(
      status.isOver
        ? `${percent}% of your ${rupees(status.budgetMinor)} budget, ${rupees(status.leftMinor ?? 0)} over`
        : `${percent}% of your ${rupees(status.budgetMinor)} budget`
    );
  }
  const biggest = biggestCategory(status, fallbackCategories);
  if (biggest) parts.push(`Biggest: ${biggest.name} ${rupees(biggest.spentMinor)}`);
  if (toBucketMinor != null && toBucketMinor !== 0) {
    parts.push(toBucketMinor > 0 ? `${rupees(toBucketMinor)} moved to savings` : `${rupees(toBucketMinor)} taken from savings`);
  }
  if (parts.length === 0) parts.push("Tap to see where it went.");
  return { title, body: parts.join(" · ") };
}

/**
 * Which month's digest is owed today, if any: the one before the month
 * running, from the day after it closed for a week, unless it has been
 * sent (or passed over) already.
 */
export async function digestDue(userId: Types.ObjectId, now = new Date()): Promise<string | null> {
  const months = await userMonths(userId, now, 2);
  const [current, previous] = months.recent;
  if (!previous) return null;
  const today = todayKey(now);
  const from = addDays(current.from, 1);
  if (today < from || today > addDays(from, DIGEST_WINDOW_DAYS)) return null;
  if (await MonthlyDigest.exists({ userId, monthKey: previous.key })) return null;
  return previous.key;
}

export type DigestResult =
  | { sent: true; monthKey: string; text: DigestText }
  | { sent: false; reason: "not-due" | "nothing-to-say" | "not-configured" | "no-device"; monthKey?: string };

/** Builds and sends one person's digest when it is owed, and records that it went. */
export async function sendMonthlyDigest(userId: Types.ObjectId, now = new Date()): Promise<DigestResult> {
  const monthKey = await digestDue(userId, now);
  if (!monthKey) return { sent: false, reason: "not-due" };

  const [status, bucket, month] = await Promise.all([
    monthlyBudgetStatus(userId, monthKey, now),
    savingsBucket(userId, now),
    userMonth(userId, monthKey, now),
  ]);
  if (status.spentMinor === 0) {
    await MonthlyDigest.create({ userId, monthKey, sentAt: null, skipped: true });
    return { sent: false, reason: "nothing-to-say", monthKey };
  }

  // Without a budget the status names no categories; the month's own
  // spending by category stands in.
  let fallback: { name: string; spentMinor: number }[] = [];
  if (!status.configured) {
    const byCategory = await spendingIn(userId, month);
    const ids = [...byCategory.keys()].filter((id) => id !== "none").map((id) => new Types.ObjectId(id));
    const names = new Map((await Category.find({ _id: { $in: ids } }).select("name").lean()).map((c) => [c._id.toString(), c.name]));
    fallback = [...byCategory.entries()].map(([id, row]) => ({
      name: id === "none" ? "Uncategorised" : (names.get(id) ?? "Deleted category"),
      spentMinor: row.spent,
    }));
  }
  const settled = bucket.configured ? bucket.months.find((entry) => entry.key === monthKey) : null;
  const text = digestText(status, settled && settled.settled ? settled.toBucketMinor : null, fallback);

  const result = await sendNotification(userId, { ...text, data: { type: "MONTHLY_DIGEST", monthKey } });
  if (!result.sent) return { sent: false, reason: result.reason, monthKey };
  await MonthlyDigest.create({ userId, monthKey, sentAt: now, ...text });
  return { sent: true, monthKey, text };
}

/** Every owner's, once a morning; each person's goes on the morning theirs is owed. */
export async function runMonthlyDigests(now = new Date()): Promise<{ ran: boolean; users: number; sent: number }> {
  const run = await runDailyJob(JOB_KEY, { hour: DIGEST_HOUR_IST }, now, async () => {
    const owners = await User.find({ role: { $ne: "KID" }, "fcmTokens.0": { $exists: true } }).select("_id");
    let sent = 0;
    for (const owner of owners) {
      const result = await sendMonthlyDigest(owner._id, now).catch((error) => {
        console.error("Monthly digest failed:", error);
        return null;
      });
      if (result?.sent) sent += 1;
    }
    return { users: owners.length, sent };
  });
  return run.ran ? { ran: true, ...run.result } : { ran: false, users: 0, sent: 0 };
}
