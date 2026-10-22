import { Types } from "mongoose";
import { Account, Subscription, User } from "../../models";
import { runDailyJob } from "../../jobs/daily";
import { sendNotification } from "../family/family.push";
import { addDays, daysBetween, frequencyLabel, todayKey } from "./subscriptions.schedule";
import { Sub, frequencyOf, reconcileSubscription } from "./subscriptions.service";

/**
 * What the phone is told about subscriptions, once a morning: a renewal
 * coming up (so a card has the money on it, or the plan is cancelled in
 * time), a trial about to turn into a charge, and a renewal that never
 * came. Each is said once per renewal, whatever the morning the job
 * happens to run.
 */

export const SUBSCRIPTION_NOTICE_HOUR_IST = 9;
const JOB_KEY = "subscriptionNotices";

export interface Notice {
  title: string;
  body: string;
  data: Record<string, string>;
}

const rupees = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

function when(day: string, today: string): string {
  const days = daysBetween(today, day);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  const date = new Date(`${day}T12:00:00+05:30`);
  return `on ${date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}`;
}

function accountLabel(account: { nickname?: string | null; bankName: string; last4?: string | null } | null): string {
  if (!account) return "";
  const name = account.nickname || account.bankName;
  return account.last4 ? `${name} ••${account.last4}` : name;
}

/**
 * The notices due for one subscription today, and the marks that stop
 * them repeating. Does not save; the caller does once per subscription.
 */
export function noticesFor(sub: Sub, today: string, account: { nickname?: string | null; bankName: string; last4?: string | null } | null): Notice[] {
  const notices: Notice[] = [];
  if (sub.status !== "active" && sub.status !== "trial") return notices;
  const amount = rupees(sub.amountMinor);
  const from = account ? ` from ${accountLabel(account)}` : "";
  const cycle = frequencyLabel(frequencyOf(sub)).toLowerCase();
  const data = { type: "SUBSCRIPTION", subscriptionId: sub._id.toString() };

  // The renewal ahead: said on the day the reminder falls on, or the first
  // morning after it when the job missed that day, never after the renewal.
  if (sub.remindDaysBefore > 0) {
    const remindOn = addDays(sub.nextRenewalOn, -sub.remindDaysBefore);
    const due = remindOn <= today && today <= sub.nextRenewalOn && sub.lastRemindedOn !== sub.nextRenewalOn;
    if (due && sub.status === "active") {
      notices.push({
        title: `${sub.name} renews ${when(sub.nextRenewalOn, today)}`,
        body: `${amount}${from} · ${cycle}. Tap to see your subscriptions.`,
        data,
      });
      sub.lastRemindedOn = sub.nextRenewalOn;
    }
    if (sub.status === "trial" && sub.trialEndsOn) {
      const trialRemindOn = addDays(sub.trialEndsOn, -sub.remindDaysBefore);
      if (trialRemindOn <= today && today <= sub.trialEndsOn && sub.trialRemindedOn !== sub.trialEndsOn) {
        notices.push({
          title: `${sub.name}'s free trial ends ${when(sub.trialEndsOn, today)}`,
          body: `${amount} ${cycle} after that${from}, unless you cancel first.`,
          data,
        });
        sub.trialRemindedOn = sub.trialEndsOn;
      }
    }
  }

  // A renewal with no payment behind it, a week on.
  const missed = sub.renewals.filter(
    (renewal) => renewal.status === "missed" && (!sub.lastNudgedOn || renewal.dueOn > sub.lastNudgedOn)
  );
  if (missed.length > 0) {
    const latest = missed[missed.length - 1];
    const date = new Date(`${latest.dueOn}T12:00:00+05:30`).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      timeZone: "Asia/Kolkata",
    });
    notices.push({
      title: `${sub.name}: no payment seen`,
      body: `${amount} was due on ${date}, but no payment has shown up. Did it go through, or was it paid another way?`,
      data,
    });
    sub.lastNudgedOn = latest.dueOn;
  }
  return notices;
}

/** One user's subscriptions brought up to date and their notices sent. Returns how many were sent. */
export async function notifySubscriptions(userId: Types.ObjectId, now = new Date()): Promise<number> {
  const today = todayKey(now);
  const subs = await Subscription.find({ userId, status: { $in: ["active", "trial"] } });
  if (subs.length === 0) return 0;
  const accounts = await Account.find({ userId, _id: { $in: subs.map((sub) => sub.accountId).filter(Boolean) } })
    .select("nickname bankName last4")
    .lean();
  const accountById = new Map(accounts.map((account) => [account._id.toString(), account]));

  let sent = 0;
  for (const sub of subs) {
    await reconcileSubscription(sub, today);
    const notices = noticesFor(sub, today, sub.accountId ? (accountById.get(sub.accountId.toString()) ?? null) : null);
    if (notices.length === 0) continue;
    for (const notice of notices) {
      const result = await sendNotification(userId, notice);
      if (result.sent) sent += 1;
    }
    await sub.save();
  }
  return sent;
}

/** Every owner's, once a morning. Asked every half hour; runs when due. */
export async function runSubscriptionNotices(now = new Date()): Promise<{ ran: boolean; users: number; sent: number }> {
  const run = await runDailyJob(JOB_KEY, { hour: SUBSCRIPTION_NOTICE_HOUR_IST }, now, async () => {
    const owners = await User.find({ role: { $ne: "KID" }, "fcmTokens.0": { $exists: true } }).select("_id");
    let sent = 0;
    for (const owner of owners) {
      sent += await notifySubscriptions(owner._id, now).catch((error) => {
        console.error("Subscription notices failed:", error);
        return 0;
      });
    }
    return { users: owners.length, sent };
  });
  return run.ran ? { ran: true, ...run.result } : { ran: false, users: 0, sent: 0 };
}
