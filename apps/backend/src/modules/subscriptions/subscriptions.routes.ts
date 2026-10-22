import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import {
  Account,
  Contact,
  SUBSCRIPTION_PAY_METHODS,
  Subscription,
  SubscriptionDoc,
  Transaction,
  User,
} from "../../models";
import { istDayEnd, istDayKey, istDayStart, istMonthEnd, istMonthStart } from "../../time";
import { SUBSCRIPTION_UNITS, addDays, firstRenewalFrom, todayKey } from "./subscriptions.schedule";
import {
  GRACE_DAYS_AFTER,
  Sub,
  adoptHistory,
  detectSubscriptions,
  frequencyOf,
  isLive,
  linkCharge,
  lookupsFor,
  merchantKey,
  reconcileSubscription,
  reconcileUser,
  renewalsIn,
  settleRenewal,
  toView,
  totalsFor,
} from "./subscriptions.service";

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const shareSchema = z.object({ contactId: z.string().regex(OBJECT_ID), amountMinor: z.number().int().positive() });

const subscriptionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().min(1).max(8).optional(),
  every: z.number().int().min(1).max(366),
  unit: z.enum(SUBSCRIPTION_UNITS),
  nextRenewalOn: z.string().regex(DAY),
  startedOn: z.string().regex(DAY).nullable().optional(),
  trialEndsOn: z.string().regex(DAY).nullable().optional(),
  payMethod: z.enum(SUBSCRIPTION_PAY_METHODS).nullable().optional(),
  accountId: z.string().regex(OBJECT_ID).nullable().optional(),
  categoryId: z.string().regex(OBJECT_ID).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  sharedWith: z.array(shareSchema).max(20).optional(),
  remindDaysBefore: z.number().int().min(0).max(30).optional(),
  // From a detected subscription: the merchant as the bank spells it, so
  // its past charges are taken in as history.
  merchantKeys: z.array(z.string().max(80)).max(10).optional(),
});

/** The owner's own things only: an account or contact id that is not theirs is refused. */
async function checkRefs(
  userId: Types.ObjectId,
  body: { accountId?: string | null; sharedWith?: { contactId: string }[]; amountMinor?: number }
): Promise<string | null> {
  if (body.accountId && !(await Account.exists({ _id: body.accountId, userId }))) return "Unknown account";
  if (body.sharedWith && body.sharedWith.length > 0) {
    const ids = body.sharedWith.map((share) => share.contactId);
    if (new Set(ids).size !== ids.length) return "The same person is on it twice.";
    const found = await Contact.countDocuments({ userId, _id: { $in: ids } });
    if (found !== ids.length) return "Everyone it's shared with has to be one of your people.";
  }
  return null;
}

async function viewsFor(userId: Types.ObjectId, subs: SubscriptionDoc[], now: Date) {
  const today = todayKey(now);
  const lookups = await lookupsFor(userId, subs);
  return subs.map((sub) => toView(sub, today, lookups));
}

async function oneView(userId: Types.ObjectId, sub: SubscriptionDoc, now = new Date()) {
  return (await viewsFor(userId, [sub], now))[0];
}

const liveFirst = (a: SubscriptionDoc, b: SubscriptionDoc) =>
  Number(isLive(b)) - Number(isLive(a)) || a.nextRenewalOn.localeCompare(b.nextRenewalOn) || a.name.localeCompare(b.name);

// GET /subscriptions - everything, brought up to date against the ledger
// first: each one with what is worked out from it, the totals, and the
// repeating charges that look like subscriptions nobody is tracking.
subscriptionsRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const now = new Date();
  const subs = (await reconcileUser(userId, now)).sort(liveFirst);
  const [items, totals, suggestions] = await Promise.all([
    viewsFor(userId, subs, now),
    totalsFor(userId, subs, now),
    detectSubscriptions(userId, todayKey(now)),
  ]);
  res.json({ items, totals, suggestions });
});

// GET /subscriptions/summary - the totals alone, for the budget screen
// and the dashboard: cheap, and nothing is detected.
subscriptionsRouter.get("/summary", async (req, res) => {
  const userId = currentUserId(req);
  const now = new Date();
  const subs = await reconcileUser(userId, now);
  res.json(await totalsFor(userId, subs, now));
});

// GET /subscriptions/calendar?month=YYYY-MM - every renewal in a calendar
// month, settled or still to come, for the calendar view.
subscriptionsRouter.get("/calendar", async (req, res) => {
  const month = typeof req.query.month === "string" && MONTH.test(req.query.month) ? req.query.month : todayKey(new Date()).slice(0, 7);
  const userId = currentUserId(req);
  const subs = await reconcileUser(userId, new Date());
  const from = istDayKey(istMonthStart(month));
  const to = istDayKey(new Date(istMonthEnd(month).getTime() - 1));
  const days = subs
    .flatMap((sub) =>
      renewalsIn(sub, from, to).map((renewal) => ({
        on: renewal.on,
        status: renewal.status,
        amountMinor: renewal.amountMinor,
        subscriptionId: sub._id.toString(),
        name: sub.name,
      }))
    )
    .sort((a, b) => a.on.localeCompare(b.on) || a.name.localeCompare(b.name));
  res.json({ month, from, to, renewals: days });
});

// POST /subscriptions
subscriptionsRouter.post("/", async (req, res) => {
  const parsed = subscriptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = currentUserId(req);
  const problem = await checkRefs(userId, parsed.data);
  if (problem) return res.status(400).json({ error: problem });

  const today = todayKey(new Date());
  const { merchantKeys, startedOn, ...fields } = parsed.data;
  const started = startedOn ?? (parsed.data.nextRenewalOn < today ? parsed.data.nextRenewalOn : today);
  const sub = await Subscription.create({
    userId,
    ...fields,
    startedOn: started,
    anchorOn: parsed.data.nextRenewalOn,
    status: parsed.data.trialEndsOn && parsed.data.trialEndsOn >= today ? "trial" : "active",
    priceHistory: [{ amountMinor: parsed.data.amountMinor, fromOn: started }],
    merchantKeys: (merchantKeys ?? []).map(merchantKey).filter((key) => key.length >= 3),
  });
  // Tracked after the fact: the charges already in the ledger are its history.
  if ((merchantKeys ?? []).length > 0) await adoptHistory(sub, today);
  await reconcileSubscription(sub, today);
  res.status(201).json(await oneView(userId, sub));
});

async function ownSub(req: Parameters<typeof currentUserId>[0]): Promise<Sub | null> {
  return Subscription.findOne({ _id: req.params.id, userId: currentUserId(req) });
}

// PATCH /subscriptions/:id - any of the fields. A new amount is a price
// change from today (the old one stays in the history); a new next
// renewal or frequency re-anchors the schedule there.
subscriptionsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = subscriptionSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const userId = currentUserId(req);
  const sub = await ownSub(req);
  if (!sub) return res.status(404).json({ error: "Not found" });
  const problem = await checkRefs(userId, parsed.data);
  if (problem) return res.status(400).json({ error: problem });

  const today = todayKey(new Date());
  const { merchantKeys, amountMinor, nextRenewalOn, every, unit, ...fields } = parsed.data;
  if (amountMinor !== undefined && amountMinor !== sub.amountMinor) {
    sub.amountMinor = amountMinor;
    sub.priceHistory.push({ amountMinor, fromOn: today });
  }
  const reschedule =
    (nextRenewalOn !== undefined && nextRenewalOn !== sub.nextRenewalOn) ||
    (every !== undefined && every !== sub.every) ||
    (unit !== undefined && unit !== sub.unit);
  if (every !== undefined) sub.every = every;
  if (unit !== undefined) sub.unit = unit;
  if (reschedule) {
    sub.nextRenewalOn = nextRenewalOn ?? firstRenewalFrom(sub.anchorOn, frequencyOf(sub), today);
    sub.anchorOn = sub.nextRenewalOn;
  }
  if (merchantKeys !== undefined) sub.merchantKeys = merchantKeys.map(merchantKey).filter((key) => key.length >= 3);
  sub.set(fields);
  if (fields.trialEndsOn === null && sub.status === "trial") sub.status = "active";
  await sub.save();
  await reconcileSubscription(sub, today);
  res.json(await oneView(userId, sub));
});

subscriptionsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const sub = await ownSub(req);
  if (!sub) return res.status(404).json({ error: "Not found" });
  // The payments it was matched to stay as payments; they just stop
  // saying which subscription they renewed.
  await Transaction.updateMany({ subscriptionId: sub._id }, { $set: { subscriptionId: null } });
  await sub.deleteOne();
  res.status(204).end();
});

const resumeSchema = z.object({ nextRenewalOn: z.string().regex(DAY).optional() });

// POST /subscriptions/:id/pause, /resume, /cancel - the schedule stands
// still while paused or cancelled; resuming (or taking a cancelled one up
// again) starts it from a next renewal, today's or the one given.
for (const action of ["pause", "resume", "cancel"] as const) {
  subscriptionsRouter.post(`/:id/${action}`, validObjectIdParam("id"), async (req, res) => {
    const parsed = resumeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const sub = await ownSub(req);
    if (!sub) return res.status(404).json({ error: "Not found" });
    const today = todayKey(new Date());

    if (action === "pause") {
      if (!isLive(sub)) return res.status(400).json({ error: "Only a running subscription can be paused." });
      sub.status = "paused";
      sub.pausedOn = today;
    } else if (action === "cancel") {
      if (sub.status === "cancelled") return res.status(400).json({ error: "It is already cancelled." });
      sub.status = "cancelled";
      sub.cancelledOn = today;
      sub.pausedOn = null;
    } else {
      if (isLive(sub)) return res.status(400).json({ error: "It is already running." });
      sub.nextRenewalOn = parsed.data.nextRenewalOn ?? firstRenewalFrom(sub.anchorOn, frequencyOf(sub), today);
      sub.anchorOn = sub.nextRenewalOn;
      sub.status = "active";
      sub.pausedOn = null;
      sub.cancelledOn = null;
    }
    await sub.save();
    await reconcileSubscription(sub, today);
    res.json(await oneView(currentUserId(req), sub));
  });
}

const paidSchema = z.object({
  // The payment that renewed it, or none for one paid in cash or never seen.
  transactionId: z.string().regex(OBJECT_ID).nullable().optional(),
  amountMinor: z.number().int().nonnegative().optional(),
});

function validRenewalDay(req: Parameters<typeof currentUserId>[0]): string | null {
  const day = req.params.on;
  return DAY.test(day) ? day : null;
}

// POST /subscriptions/:id/renewals/:on/paid - a renewal settled by hand:
// linked to a payment, or marked paid without one.
subscriptionsRouter.post("/:id/renewals/:on/paid", validObjectIdParam("id"), async (req, res) => {
  const parsed = paidSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const on = validRenewalDay(req);
  if (!on) return res.status(400).json({ error: "A renewal day is YYYY-MM-DD." });
  const userId = currentUserId(req);
  const sub = await ownSub(req);
  if (!sub) return res.status(404).json({ error: "Not found" });

  if (parsed.data.transactionId) {
    const row = await Transaction.findOne({ _id: parsed.data.transactionId, userId, type: "DEBIT" });
    if (!row) return res.status(404).json({ error: "Payment not found" });
    if (row.subscriptionId && !row.subscriptionId.equals(sub._id)) {
      return res.status(400).json({ error: "That payment already renewed another subscription." });
    }
    // Anything that renewal was linked to before lets go of it.
    const before = sub.renewals.find((renewal) => renewal.dueOn === on);
    if (before?.transactionId && !before.transactionId.equals(row._id)) {
      await Transaction.updateOne({ _id: before.transactionId }, { $set: { subscriptionId: null } });
    }
    await linkCharge(sub, row, on);
  } else {
    settleRenewal(sub, on, { status: "paid", transactionId: null, amountMinor: parsed.data.amountMinor ?? sub.amountMinor, paidOn: on });
  }
  if (sub.nextRenewalOn === on) await advancePast(sub, on);
  await sub.save();
  await reconcileSubscription(sub, todayKey(new Date()));
  res.json(await oneView(userId, sub));
});

// POST /subscriptions/:id/renewals/:on/skip - this one was not charged
// (a free month, a pause the service gave).
subscriptionsRouter.post("/:id/renewals/:on/skip", validObjectIdParam("id"), async (req, res) => {
  const on = validRenewalDay(req);
  if (!on) return res.status(400).json({ error: "A renewal day is YYYY-MM-DD." });
  const sub = await ownSub(req);
  if (!sub) return res.status(404).json({ error: "Not found" });
  const before = sub.renewals.find((renewal) => renewal.dueOn === on);
  if (before?.transactionId) await Transaction.updateOne({ _id: before.transactionId }, { $set: { subscriptionId: null } });
  settleRenewal(sub, on, { status: "skipped" });
  if (sub.nextRenewalOn === on) await advancePast(sub, on);
  await sub.save();
  await reconcileSubscription(sub, todayKey(new Date()));
  res.json(await oneView(currentUserId(req), sub));
});

// DELETE /subscriptions/:id/renewals/:on - unsaid: the renewal is open
// again, and the payment it was linked to is just a payment.
subscriptionsRouter.delete("/:id/renewals/:on", validObjectIdParam("id"), async (req, res) => {
  const on = validRenewalDay(req);
  if (!on) return res.status(400).json({ error: "A renewal day is YYYY-MM-DD." });
  const sub = await ownSub(req);
  if (!sub) return res.status(404).json({ error: "Not found" });
  const before = sub.renewals.find((renewal) => renewal.dueOn === on);
  if (before?.transactionId) await Transaction.updateOne({ _id: before.transactionId }, { $set: { subscriptionId: null } });
  sub.renewals = sub.renewals.filter((renewal) => renewal.dueOn !== on) as SubscriptionDoc["renewals"];
  if (on < sub.nextRenewalOn && isLive(sub)) {
    sub.nextRenewalOn = on;
  }
  await sub.save();
  res.json(await oneView(currentUserId(req), sub));
});

async function advancePast(sub: Sub, on: string) {
  const { renewalAfter } = await import("./subscriptions.schedule");
  sub.nextRenewalOn = renewalAfter(sub.anchorOn, frequencyOf(sub), on);
}

// GET /subscriptions/:id/candidates?on=YYYY-MM-DD - payments around a
// renewal day that could be the one, likeliest first, to link by hand.
subscriptionsRouter.get("/:id/candidates", validObjectIdParam("id"), async (req, res) => {
  const sub = await ownSub(req);
  if (!sub) return res.status(404).json({ error: "Not found" });
  const on = typeof req.query.on === "string" && DAY.test(req.query.on) ? req.query.on : sub.nextRenewalOn;
  const rows = await Transaction.find({
    userId: sub.userId,
    type: "DEBIT",
    mirrorOf: null,
    offLedger: { $ne: true },
    isTransfer: false,
    cardPaymentFor: null,
    $or: [{ subscriptionId: null }, { subscriptionId: sub._id }],
    occurredAt: { $gte: istDayStart(addDays(on, -20)), $lte: istDayEnd(addDays(on, GRACE_DAYS_AFTER + 14)) },
  })
    .sort({ occurredAt: -1 })
    .limit(200)
    .populate("category")
    .populate("account");
  const score = (row: (typeof rows)[number]) =>
    (merchantKey(row.merchant).includes(merchantKey(sub.name)) && merchantKey(sub.name).length >= 3 ? 4 : 0) +
    (sub.merchantKeys.some((key) => merchantKey(row.merchant).includes(key)) ? 4 : 0) +
    (Math.abs(row.amountMinor - sub.amountMinor) <= sub.amountMinor * 0.02 ? 3 : 0) +
    (sub.accountId && row.accountId && sub.accountId.equals(row.accountId) ? 1 : 0);
  res.json([...rows].sort((a, b) => score(b) - score(a)));
});

// POST /subscriptions/suggestions/:key/dismiss - "not a subscription":
// never suggested again.
subscriptionsRouter.post("/suggestions/:key/dismiss", async (req, res) => {
  const key = merchantKey(req.params.key);
  if (key.length < 3) return res.status(400).json({ error: "Unknown suggestion" });
  await User.updateOne({ _id: currentUserId(req) }, { $addToSet: { dismissedSubscriptionKeys: key } });
  res.status(204).end();
});

subscriptionsRouter.get("/:id", validObjectIdParam("id"), async (req, res) => {
  const sub = await ownSub(req);
  if (!sub) return res.status(404).json({ error: "Not found" });
  await reconcileSubscription(sub, todayKey(new Date()));
  res.json(await oneView(currentUserId(req), sub));
});
