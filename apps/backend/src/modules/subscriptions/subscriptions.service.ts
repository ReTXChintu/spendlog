import { HydratedDocument, Types } from "mongoose";
import {
  Account,
  AccountDoc,
  Category,
  Subscription,
  SubscriptionDoc,
  SubscriptionRenewal,
  Transaction,
  TransactionDoc,
  User,
} from "../../models";
import { istDayEnd, istDayKey, istDayStart } from "../../time";
import { UserMonth, monthLabel, userMonths } from "../budget/budget.months";
import {
  Frequency,
  addDays,
  daysBetween,
  firstRenewalFrom,
  frequencyFromGaps,
  frequencyLabel,
  frequencyPreset,
  monthlyEquivalentMinor,
  renewalAfter,
  renewalsBetween,
  todayKey,
  yearlyEquivalentMinor,
} from "./subscriptions.schedule";

/**
 * Subscriptions against the ledger: which payment renewed which one, which
 * renewal never came, and what the lot costs a month.
 *
 * A renewal is settled by the charge that lands around its date - up to a
 * few days early (banks charge ahead of weekends) and a few days late.
 * Once a week past due with nothing found it is "missed", the app says so,
 * and the schedule moves on: a charge that turns up later still finds it.
 * The matching is on the merchant the bank names (remembered per
 * subscription, under whatever spellings turn up) and the amount; an
 * amount alone only on the account the subscription is paid from, since
 * ₹649 at a restaurant is not Netflix.
 */

/// A charge can land this many days before its renewal date...
export const GRACE_DAYS_BEFORE = 4;
/// ...and this many after, before the renewal counts as missed.
export const GRACE_DAYS_AFTER = 6;
/// A charge that turns up after that still settles a renewal this recent.
export const LATE_CHARGE_DAYS = 60;
/// Charges over this long ago are not looked at when telling subscriptions apart.
export const DETECT_LOOKBACK_DAYS = 400;

export type Sub = HydratedDocument<SubscriptionDoc>;

/** The spelling-proof form of a merchant: "NETFLIX.COM" and "Netflix Com" are both "netflixcom". */
export function merchantKey(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function frequencyOf(sub: Pick<SubscriptionDoc, "every" | "unit">): Frequency {
  return { every: sub.every, unit: sub.unit };
}

/** A payment that could still be a renewal: nobody's yet, and real spending. */
const UNCLAIMED = {
  type: "DEBIT",
  subscriptionId: null,
  mirrorOf: null,
  offLedger: { $ne: true },
  isTransfer: false,
  isSettlement: false,
  cardPaymentFor: null,
  emiRole: null,
  countedAmountMinor: { $gt: 0 },
} as const;

function matchesMerchant(sub: Pick<SubscriptionDoc, "name" | "merchantKeys">, merchant: string | null | undefined): boolean {
  const key = merchantKey(merchant);
  if (key.length < 3) return false;
  const known = [merchantKey(sub.name), ...sub.merchantKeys].filter((k) => k.length >= 3);
  return known.some((k) => key.includes(k) || k.includes(key));
}

function amountCloseness(sub: Pick<SubscriptionDoc, "amountMinor">, amountMinor: number): "exact" | "near" | "far" {
  const diff = Math.abs(amountMinor - sub.amountMinor) / Math.max(1, sub.amountMinor);
  return diff <= 0.02 ? "exact" : diff <= 0.25 ? "near" : "far";
}

/**
 * The payment that renewed a subscription around `dueOn`, if one has
 * landed: the merchant's, close in amount; or the exact amount on the
 * account it is paid from. The best of what the window holds.
 */
export async function findCharge(
  sub: Sub,
  dueOn: string,
  window: { from: string; to: string } = { from: addDays(dueOn, -GRACE_DAYS_BEFORE), to: addDays(dueOn, GRACE_DAYS_AFTER) }
): Promise<HydratedDocument<TransactionDoc> | null> {
  const rows = await Transaction.find({
    userId: sub.userId,
    ...UNCLAIMED,
    occurredAt: { $gte: istDayStart(window.from), $lte: istDayEnd(window.to) },
  }).sort({ occurredAt: 1 });

  let best: HydratedDocument<TransactionDoc> | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const merchant = matchesMerchant(sub, row.merchant);
    const amount = amountCloseness(sub, row.amountMinor);
    const sameAccount = Boolean(sub.accountId && row.accountId && sub.accountId.equals(row.accountId));
    let score = 0;
    if (merchant && amount !== "far") score = amount === "exact" ? 6 : 4;
    else if (amount === "exact" && sameAccount) score = 3;
    if (score > 0 && sameAccount) score += 1;
    // Nearest the due day wins a tie.
    if (score > bestScore || (score === bestScore && best && closer(row, best, dueOn))) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= 3 ? best : null;
}

function closer(a: TransactionDoc, b: TransactionDoc, dueOn: string): boolean {
  const gap = (row: TransactionDoc) => Math.abs(daysBetween(dueOn, istDayKey(row.occurredAt)));
  return gap(a) < gap(b);
}

/**
 * Writes the link both ways: the payment knows which subscription it
 * renewed (and takes its category when it had none, and the shares of
 * whoever shares it), the subscription knows the renewal is paid and
 * the merchant's spelling for next time. Does not save the subscription.
 */
export async function linkCharge(sub: Sub, row: HydratedDocument<TransactionDoc>, dueOn: string): Promise<void> {
  row.subscriptionId = sub._id;
  if (!row.categoryId && sub.categoryId) row.categoryId = sub.categoryId;
  // A shared plan: their parts owed back, on a payment nothing else has
  // claimed. Only when the parts leave the user something, or the whole
  // charge would read as not theirs at all.
  if (sub.sharedWith.length > 0 && !row.split && row.people.length === 0 && !row.groupId) {
    const theirs = sub.sharedWith.reduce((sum, share) => sum + share.amountMinor, 0);
    if (theirs < row.amountMinor) {
      row.people = sub.sharedWith.map((share) => ({ contactId: share.contactId, amountMinor: share.amountMinor }));
      row.split = { myShareMinor: row.amountMinor - theirs, groupLabel: sub.name.slice(0, 60) };
    }
  }
  await row.save();

  const key = merchantKey(row.merchant);
  if (key.length >= 3 && !sub.merchantKeys.includes(key) && merchantKey(sub.name) !== key) {
    sub.merchantKeys = [...sub.merchantKeys, key].slice(-10);
  }
  settleRenewal(sub, dueOn, {
    status: "paid",
    transactionId: row._id,
    amountMinor: row.amountMinor,
    paidOn: istDayKey(row.occurredAt),
  });
}

/** Records what became of a renewal, replacing anything already said about that date. */
export function settleRenewal(sub: Sub, dueOn: string, outcome: Omit<SubscriptionRenewal, "dueOn">): void {
  const kept = sub.renewals.filter((renewal) => renewal.dueOn !== dueOn);
  kept.push({ dueOn, ...outcome });
  kept.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
  sub.renewals = kept as SubscriptionDoc["renewals"];
}

/** Moves the next renewal past `dueOn`. */
function advance(sub: Sub, dueOn: string): void {
  sub.nextRenewalOn = renewalAfter(sub.anchorOn, frequencyOf(sub), dueOn);
}

/** Whether the schedule is live: paused and cancelled ones sit still. */
export function isLive(sub: Pick<SubscriptionDoc, "status">): boolean {
  return sub.status === "active" || sub.status === "trial";
}

/**
 * Brings one subscription up to date with the ledger as of `today`:
 * every renewal due by now (and a few days ahead, for an early charge)
 * is matched to its payment or, a week past due with none, marked
 * missed; a missed one that a late payment now explains is paid after
 * all; a trial that has ended is active. Saves when anything changed.
 */
export async function reconcileSubscription(sub: Sub, today: string): Promise<boolean> {
  if (!isLive(sub)) return false;
  let changed = false;

  for (let guard = 0; guard < 120; guard += 1) {
    const due = sub.nextRenewalOn;
    if (due > addDays(today, GRACE_DAYS_BEFORE)) break;
    if (sub.renewals.some((renewal) => renewal.dueOn === due)) {
      // Settled by hand before it came round.
      advance(sub, due);
      changed = true;
      continue;
    }
    const charge = await findCharge(sub, due);
    if (charge) {
      await linkCharge(sub, charge, due);
      advance(sub, due);
      changed = true;
      continue;
    }
    if (today > addDays(due, GRACE_DAYS_AFTER)) {
      settleRenewal(sub, due, { status: "missed" });
      advance(sub, due);
      changed = true;
      continue;
    }
    break;
  }

  // A payment that turned up late still settles the renewal it was for.
  for (const renewal of sub.renewals) {
    if (renewal.status !== "missed" || daysBetween(renewal.dueOn, today) > LATE_CHARGE_DAYS) continue;
    const charge = await findCharge(sub, renewal.dueOn, {
      from: addDays(renewal.dueOn, -GRACE_DAYS_BEFORE),
      to: today,
    });
    if (charge) {
      await linkCharge(sub, charge, renewal.dueOn);
      changed = true;
    }
  }

  if (sub.status === "trial" && sub.trialEndsOn && sub.trialEndsOn < today) {
    sub.status = "active";
    changed = true;
  }

  if (changed) await sub.save();
  return changed;
}

/** Every live subscription of a user's, brought up to date. */
export async function reconcileUser(userId: Types.ObjectId, now = new Date()): Promise<Sub[]> {
  const today = todayKey(now);
  const subs = await Subscription.find({ userId }).sort({ nextRenewalOn: 1 });
  for (const sub of subs) await reconcileSubscription(sub, today);
  return subs;
}

/**
 * The charges already in the ledger that were this subscription's, for one
 * tracked after the fact: each becomes a paid renewal on the day it
 * landed. Used when a detected subscription is taken up, so its history
 * is there from the start.
 */
export async function adoptHistory(sub: Sub, today: string): Promise<number> {
  if (sub.merchantKeys.length === 0 && merchantKey(sub.name).length < 3) return 0;
  const rows = await Transaction.find({
    userId: sub.userId,
    ...UNCLAIMED,
    occurredAt: { $gte: istDayStart(addDays(today, -DETECT_LOOKBACK_DAYS)), $lt: istDayStart(sub.nextRenewalOn) },
  }).sort({ occurredAt: 1 });
  let adopted = 0;
  for (const row of rows) {
    if (!matchesMerchant(sub, row.merchant) || amountCloseness(sub, row.amountMinor) === "far") continue;
    await linkCharge(sub, row, istDayKey(row.occurredAt));
    adopted += 1;
  }
  if (adopted > 0) await sub.save();
  return adopted;
}

export interface Suggestion {
  key: string;
  merchant: string;
  amountMinor: number;
  every: number;
  unit: Frequency["unit"];
  label: string;
  monthlyMinor: number;
  count: number;
  firstOn: string;
  lastOn: string;
  nextOn: string;
  accountId: string | null;
  categoryId: string | null;
}

/**
 * Repeating charges that look like subscriptions nobody is tracking:
 * three or more from the same merchant, a regular gap apart, mostly at
 * the same amount. Ones already tracked, and ones the user said are not
 * subscriptions, are left out.
 */
export async function detectSubscriptions(userId: Types.ObjectId, today: string): Promise<Suggestion[]> {
  const [rows, subs, user] = await Promise.all([
    Transaction.find({
      userId,
      ...UNCLAIMED,
      merchant: { $ne: null },
      occurredAt: { $gte: istDayStart(addDays(today, -DETECT_LOOKBACK_DAYS)) },
    })
      .select("merchant amountMinor occurredAt accountId categoryId")
      .lean(),
    Subscription.find({ userId }).select("name merchantKeys").lean(),
    User.findById(userId).select("dismissedSubscriptionKeys").lean(),
  ]);

  const taken = new Set<string>();
  for (const sub of subs) {
    for (const key of [merchantKey(sub.name), ...sub.merchantKeys]) if (key.length >= 3) taken.add(key);
  }
  for (const key of user?.dismissedSubscriptionKeys ?? []) taken.add(key);

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = merchantKey(row.merchant);
    if (key.length < 3 || taken.has(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  const suggestions: Suggestion[] = [];
  for (const [key, group] of groups) {
    // One charge a day: a retry the same day is the same renewal.
    const byDay = new Map<string, (typeof rows)[number]>();
    for (const row of group) byDay.set(istDayKey(row.occurredAt), row);
    const days = [...byDay.keys()].sort();
    if (days.length < 3) continue;

    const gaps = days.slice(1).map((day, i) => daysBetween(days[i], day));
    const frequency = frequencyFromGaps(gaps);
    if (!frequency) continue;

    const charges = days.map((day) => byDay.get(day)!);
    const latest = charges[charges.length - 1];
    const steady = charges.filter((row) => Math.abs(row.amountMinor - latest.amountMinor) <= latest.amountMinor * 0.1).length;
    if (steady / charges.length < 0.6) continue;

    const lastOn = days[days.length - 1];
    suggestions.push({
      key,
      merchant: latest.merchant!,
      amountMinor: latest.amountMinor,
      every: frequency.every,
      unit: frequency.unit,
      label: frequencyLabel(frequency),
      monthlyMinor: monthlyEquivalentMinor(latest.amountMinor, frequency),
      count: charges.length,
      firstOn: days[0],
      lastOn,
      nextOn: firstRenewalFrom(lastOn, frequency, addDays(lastOn, 1)),
      accountId: mostCommon(charges.map((row) => row.accountId?.toString() ?? null)),
      categoryId: mostCommon(charges.map((row) => row.categoryId?.toString() ?? null)),
    });
  }
  return suggestions.sort((a, b) => b.monthlyMinor - a.monthlyMinor).slice(0, 12);
}

function mostCommon(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [value, count] of counts) {
    if (count > most) {
      best = value;
      most = count;
    }
  }
  return best;
}

export type SubscriptionAlert =
  | { kind: "missed"; dueOn: string; amountMinor: number }
  | { kind: "price"; fromMinor: number; toMinor: number; on: string }
  | { kind: "trial_ending"; on: string; amountMinor: number }
  | { kind: "overdue"; dueOn: string; amountMinor: number };

/** What needs saying about a subscription: renewals that never came, a changed price, a trial about to end. */
export function alertsFor(sub: SubscriptionDoc, today: string): SubscriptionAlert[] {
  const alerts: SubscriptionAlert[] = [];
  if (!isLive(sub)) return alerts;

  for (const renewal of sub.renewals) {
    if (renewal.status === "missed" && daysBetween(renewal.dueOn, today) <= LATE_CHARGE_DAYS) {
      alerts.push({ kind: "missed", dueOn: renewal.dueOn, amountMinor: sub.amountMinor });
    }
  }
  // Due, a day or more ago, and nothing found yet - not missed yet either.
  if (sub.nextRenewalOn < today && !sub.renewals.some((r) => r.dueOn === sub.nextRenewalOn)) {
    alerts.push({ kind: "overdue", dueOn: sub.nextRenewalOn, amountMinor: sub.amountMinor });
  }
  const paid = [...sub.renewals].reverse().find((renewal) => renewal.status === "paid" && renewal.amountMinor != null);
  if (paid && paid.amountMinor !== sub.amountMinor && paid.paidOn && paid.paidOn >= lastPriceFrom(sub)) {
    alerts.push({ kind: "price", fromMinor: sub.amountMinor, toMinor: paid.amountMinor!, on: paid.paidOn });
  }
  if (sub.status === "trial" && sub.trialEndsOn && sub.trialEndsOn >= today) {
    alerts.push({ kind: "trial_ending", on: sub.trialEndsOn, amountMinor: sub.amountMinor });
  }
  return alerts;
}

function lastPriceFrom(sub: SubscriptionDoc): string {
  return sub.priceHistory[sub.priceHistory.length - 1]?.fromOn ?? sub.startedOn;
}

export interface SubscriptionView {
  id: string;
  name: string;
  amountMinor: number;
  currency: string;
  every: number;
  unit: Frequency["unit"];
  frequencyLabel: string;
  frequencyPreset: ReturnType<typeof frequencyPreset>;
  monthlyMinor: number;
  yearlyMinor: number;
  nextRenewalOn: string;
  daysToRenewal: number;
  startedOn: string;
  trialEndsOn: string | null;
  payMethod: SubscriptionDoc["payMethod"] | null;
  accountId: string | null;
  account: { id: string; bankName: string; last4: string | null; nickname: string | null; accountType: string } | null;
  categoryId: string | null;
  categoryName: string | null;
  notes: string | null;
  status: SubscriptionDoc["status"];
  pausedOn: string | null;
  cancelledOn: string | null;
  priceHistory: SubscriptionDoc["priceHistory"];
  sharedWith: { contactId: string; amountMinor: number }[];
  myShareMinor: number;
  remindDaysBefore: number;
  renewals: SubscriptionDoc["renewals"];
  lastPaid: { on: string; amountMinor: number } | null;
  alerts: SubscriptionAlert[];
}

/** A subscription as the clients get it, with what is worked out from it. */
export function toView(
  sub: SubscriptionDoc,
  today: string,
  lookups: { accounts: Map<string, AccountDoc>; categories: Map<string, string> }
): SubscriptionView {
  const frequency = frequencyOf(sub);
  const account = sub.accountId ? (lookups.accounts.get(sub.accountId.toString()) ?? null) : null;
  const paid = [...sub.renewals].reverse().find((renewal) => renewal.status === "paid");
  const theirs = sub.sharedWith.reduce((sum, share) => sum + share.amountMinor, 0);
  return {
    id: sub._id.toString(),
    name: sub.name,
    amountMinor: sub.amountMinor,
    currency: sub.currency,
    every: sub.every,
    unit: sub.unit,
    frequencyLabel: frequencyLabel(frequency),
    frequencyPreset: frequencyPreset(frequency),
    monthlyMinor: monthlyEquivalentMinor(sub.amountMinor, frequency),
    yearlyMinor: yearlyEquivalentMinor(sub.amountMinor, frequency),
    nextRenewalOn: sub.nextRenewalOn,
    daysToRenewal: daysBetween(today, sub.nextRenewalOn),
    startedOn: sub.startedOn,
    trialEndsOn: sub.trialEndsOn ?? null,
    payMethod: sub.payMethod ?? null,
    accountId: sub.accountId?.toString() ?? null,
    account: account
      ? {
          id: account._id.toString(),
          bankName: account.bankName,
          last4: account.last4 ?? null,
          nickname: account.nickname ?? null,
          accountType: account.accountType,
        }
      : null,
    categoryId: sub.categoryId?.toString() ?? null,
    categoryName: sub.categoryId ? (lookups.categories.get(sub.categoryId.toString()) ?? null) : null,
    notes: sub.notes ?? null,
    status: sub.status,
    pausedOn: sub.pausedOn ?? null,
    cancelledOn: sub.cancelledOn ?? null,
    priceHistory: sub.priceHistory,
    sharedWith: sub.sharedWith.map((share) => ({ contactId: share.contactId.toString(), amountMinor: share.amountMinor })),
    myShareMinor: Math.max(0, sub.amountMinor - theirs),
    remindDaysBefore: sub.remindDaysBefore,
    renewals: sub.renewals,
    lastPaid: paid ? { on: paid.paidOn ?? paid.dueOn, amountMinor: paid.amountMinor ?? sub.amountMinor } : null,
    alerts: alertsFor(sub, today),
  };
}

export async function lookupsFor(userId: Types.ObjectId, subs: SubscriptionDoc[]) {
  const accountIds = subs.map((sub) => sub.accountId).filter(Boolean);
  const categoryIds = subs.map((sub) => sub.categoryId).filter(Boolean);
  const [accounts, categories] = await Promise.all([
    Account.find({ userId, _id: { $in: accountIds } }),
    Category.find({ _id: { $in: categoryIds } }).select("name").lean(),
  ]);
  return {
    accounts: new Map(accounts.map((account) => [account._id.toString(), account as AccountDoc])),
    categories: new Map(categories.map((category) => [category._id.toString(), category.name])),
  };
}

/**
 * The renewals a subscription has, or will have, between two days: the
 * settled ones from its history, the rest from its schedule.
 */
export function renewalsIn(sub: SubscriptionDoc, from: string, to: string): { on: string; status: SubscriptionRenewal["status"] | "upcoming"; amountMinor: number }[] {
  const out: { on: string; status: SubscriptionRenewal["status"] | "upcoming"; amountMinor: number }[] = [];
  for (const renewal of sub.renewals) {
    if (renewal.dueOn >= from && renewal.dueOn <= to) {
      out.push({ on: renewal.dueOn, status: renewal.status, amountMinor: renewal.amountMinor ?? sub.amountMinor });
    }
  }
  if (isLive(sub)) {
    const start = from > sub.nextRenewalOn ? from : sub.nextRenewalOn;
    for (const day of renewalsBetween(sub.anchorOn, frequencyOf(sub), start, to)) {
      if (day >= sub.nextRenewalOn && !sub.renewals.some((renewal) => renewal.dueOn === day)) {
        out.push({ on: day, status: "upcoming", amountMinor: sub.amountMinor });
      }
    }
  }
  return out.sort((a, b) => a.on.localeCompare(b.on));
}

export interface SubscriptionTotals {
  activeCount: number;
  monthlyMinor: number;
  yearlyMinor: number;
  month: { key: string; from: string; to: string; label: string };
  /// What renews inside the user's current month: paid already, and still to come.
  dueThisMonthMinor: number;
  dueThisMonthCount: number;
  paidThisMonthMinor: number;
  upcomingThisMonthMinor: number;
  alertCount: number;
}

export async function totalsFor(userId: Types.ObjectId, subs: SubscriptionDoc[], now = new Date()): Promise<SubscriptionTotals> {
  const today = todayKey(now);
  const months = await userMonths(userId, now, 1);
  const month = months.recent[0];
  const live = subs.filter(isLive);

  let dueThisMonthMinor = 0;
  let dueThisMonthCount = 0;
  let paidThisMonthMinor = 0;
  let upcomingThisMonthMinor = 0;
  for (const sub of live) {
    for (const renewal of renewalsIn(sub, month.from, month.to)) {
      if (renewal.status === "skipped") continue;
      dueThisMonthMinor += renewal.amountMinor;
      dueThisMonthCount += 1;
      if (renewal.status === "paid") paidThisMonthMinor += renewal.amountMinor;
      else upcomingThisMonthMinor += renewal.amountMinor;
    }
  }
  return {
    activeCount: live.length,
    monthlyMinor: live.reduce((sum, sub) => sum + monthlyEquivalentMinor(sub.amountMinor, frequencyOf(sub)), 0),
    yearlyMinor: live.reduce((sum, sub) => sum + yearlyEquivalentMinor(sub.amountMinor, frequencyOf(sub)), 0),
    month: { key: month.key, from: month.from, to: month.to, label: monthLabel(month, months.bySalary) },
    dueThisMonthMinor,
    dueThisMonthCount,
    paidThisMonthMinor,
    upcomingThisMonthMinor,
    alertCount: live.reduce((sum, sub) => sum + alertsFor(sub, today).length, 0),
  };
}

/**
 * Renewals still to go out in a month, by the category they will land in
 * ("none" where that is not known), for the budget's pace: every upcoming
 * one, and the missed ones the user may yet be charged for.
 */
export async function subscriptionsStillDue(userId: Types.ObjectId, month: Pick<UserMonth, "from" | "to">): Promise<Map<string, number>> {
  const due = new Map<string, number>();
  const subs = await Subscription.find({ userId, status: { $in: ["active", "trial"] } }).lean();
  for (const sub of subs) {
    for (const renewal of renewalsIn(sub as SubscriptionDoc, month.from, month.to)) {
      if (renewal.status !== "upcoming" && renewal.status !== "missed") continue;
      const key = sub.categoryId?.toString() ?? "none";
      due.set(key, (due.get(key) ?? 0) + renewal.amountMinor);
    }
  }
  return due;
}
