import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "subscriptions-test-secret";

/**
 * Subscriptions: tracked, matched to the charge that renews them, flagged
 * when the charge never comes or comes at a new price, found among
 * repeating payments, counted as fixed costs of the month, and said in
 * time on the phone.
 */
let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let service: typeof import("./subscriptions.service");
let notify: typeof import("./subscriptions.notify");
let schedule: typeof import("./subscriptions.schedule");
let daily: typeof import("../../jobs/daily");
let push: typeof import("../family/family.push");
let time: typeof import("../../time");

const realFetch = globalThis.fetch;
const pushed: { body: Record<string, any> }[] = [];

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_subscriptions_test"));
  const [{ app }, auth, loadedModels, loadedService, loadedNotify, loadedSchedule, loadedDaily, loadedPush, loadedTime] =
    await Promise.all([
      import("../../app"),
      import("../../middleware/auth"),
      import("../../models"),
      import("./subscriptions.service"),
      import("./subscriptions.notify"),
      import("./subscriptions.schedule"),
      import("../../jobs/daily"),
      import("../family/family.push"),
      import("../../time"),
    ]);
  signToken = auth.signSessionToken;
  models = loadedModels;
  service = loadedService;
  notify = loadedNotify;
  schedule = loadedSchedule;
  daily = loadedDaily;
  push = loadedPush;
  time = loadedTime;
  await models.Transaction.init();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  push.useFirebaseForTests({ projectId: "test-project", accessToken: "token" });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://fcm.googleapis.com/")) return realFetch(input, init);
    pushed.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ name: "projects/test/messages/1" }), { status: 200 });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  push.useFirebaseForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

let userId: Types.ObjectId;
let token: string;
let count = 0;

beforeEach(async () => {
  await Promise.all([
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.Account.deleteMany({}),
    models.Category.deleteMany({}),
    models.Contact.deleteMany({}),
    models.Subscription.deleteMany({}),
    models.JobRun.deleteMany({}),
  ]);
  pushed.length = 0;
  const email = `sub${(count += 1)}@example.com`;
  const user = await models.User.create({ email, name: "Biswajit", fcmTokens: [{ token: "phone-1", updatedAt: new Date() }] });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
});

type Json = Record<string, any>;

async function call(path: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Json };
}

const today = () => schedule.todayKey(new Date());
const day = (offset: number) => schedule.addDays(today(), offset);
/** Noon IST on a day: no boundary grazed. */
const at = (dayKey: string) => new Date(time.istDayStart(dayKey).getTime() + 12 * 60 * 60 * 1000);

async function charge(fields: Json) {
  return models.Transaction.create({
    userId,
    type: "DEBIT",
    source: "SMS",
    currency: "INR",
    ...fields,
    occurredAt: fields.occurredAt ?? at(today()),
  });
}

async function track(body: Json) {
  const response = await call("/subscriptions", {
    body: { name: "Netflix", amountMinor: 649_00, every: 1, unit: "month", nextRenewalOn: today(), ...body },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

const stored = (id: string) => models.Subscription.findById(id).orFail().lean();

describe("tracking a subscription", () => {
  it("says what it costs a month and a year, and keeps its prices", async () => {
    const netflix = await track({ nextRenewalOn: day(10) });
    assert.equal(netflix.status, "active");
    assert.equal(netflix.frequencyLabel, "Monthly");
    assert.equal(netflix.frequencyPreset, "monthly");
    assert.equal(netflix.monthlyMinor, 649_00);
    assert.equal(netflix.yearlyMinor, 7788_00);
    assert.equal(netflix.daysToRenewal, 10);
    assert.deepEqual(netflix.alerts, []);
    assert.equal(netflix.priceHistory.length, 1);

    const yearly = await track({ name: "Prime", amountMinor: 1499_00, every: 1, unit: "year", nextRenewalOn: day(100) });
    assert.equal(yearly.monthlyMinor, 124_92);

    const raised = await call(`/subscriptions/${netflix.id}`, { method: "PATCH", body: { amountMinor: 799_00 } });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.equal(raised.body.amountMinor, 799_00);
    assert.deepEqual(
      raised.body.priceHistory.map((p: Json) => p.amountMinor),
      [649_00, 799_00]
    );

    const moved = await call(`/subscriptions/${netflix.id}`, { method: "PATCH", body: { nextRenewalOn: day(12) } });
    assert.equal(moved.body.nextRenewalOn, day(12));
    assert.equal((await stored(netflix.id)).anchorOn, day(12), "the schedule counts from the moved date");

    const list = (await call("/subscriptions")).body;
    assert.equal(list.items.length, 2);
    assert.equal(list.totals.activeCount, 2);
    assert.equal(list.totals.monthlyMinor, 799_00 + 124_92);

    const trial = await track({ name: "Spotify", amountMinor: 119_00, nextRenewalOn: day(7), trialEndsOn: day(6) });
    assert.equal(trial.status, "trial");
    assert.deepEqual(trial.alerts, [{ kind: "trial_ending", on: day(6), amountMinor: 119_00 }]);
  });

  it("is matched to the charge that renews it, by merchant or by amount on its account", async () => {
    const hdfc = await models.Account.create({ userId, bankName: "HDFC", accountType: "CARD", last4: "1234" });
    const sbi = await models.Account.create({ userId, bankName: "SBI", accountType: "BANK", last4: "9999" });
    const ott = await models.Category.create({ userId, name: "OTT" });

    // Netflix: the merchant says so, even at a slightly different amount.
    const netflix = await track({ nextRenewalOn: day(-2), categoryId: ott.id.toString(), accountId: hdfc.id.toString() });
    const netflixCharge = await charge({ merchant: "NETFLIX.COM", amountMinor: 649_00, accountId: hdfc._id, occurredAt: at(day(-2)) });
    // Gym: no merchant worth the name, but the exact amount on the card it is paid from.
    const gym = await track({ name: "Cult gym", amountMinor: 2000_00, nextRenewalOn: day(-1), accountId: hdfc.id.toString() });
    const gymCharge = await charge({ merchant: "POS 4471", amountMinor: 2000_00, accountId: hdfc._id, occurredAt: at(day(-1)) });
    // The same amount on another account is not it.
    await charge({ merchant: "POS 9912", amountMinor: 2000_00, accountId: sbi._id, occurredAt: at(day(-1)) });

    const list = (await call("/subscriptions")).body;
    const netflixView = list.items.find((s: Json) => s.id === netflix.id);
    assert.equal(netflixView.nextRenewalOn, schedule.renewalAt(day(-2), { every: 1, unit: "month" }, 1));
    assert.deepEqual(netflixView.lastPaid, { on: day(-2), amountMinor: 649_00 });
    assert.deepEqual(netflixView.alerts, []);
    assert.equal(netflixView.renewals[0].status, "paid");
    assert.equal(netflixView.renewals[0].transactionId, netflixCharge.id);

    const linked = await models.Transaction.findById(netflixCharge._id).orFail();
    assert.equal(String(linked.subscriptionId), netflix.id);
    assert.equal(String(linked.categoryId), ott.id.toString(), "takes the subscription's category");
    assert.equal(String((await models.Transaction.findById(gymCharge._id).orFail()).subscriptionId), gym.id);
    assert.equal(await models.Transaction.countDocuments({ subscriptionId: { $ne: null } }), 2);
    assert.deepEqual((await stored(netflix.id)).merchantKeys, ["netflixcom"]);

    // A price change is flagged when the charge differs from the price kept.
    await call(`/subscriptions/${netflix.id}`, { method: "PATCH", body: { nextRenewalOn: day(-1) } });
    const raisedCharge = await charge({ merchant: "Netflix", amountMinor: 699_00, accountId: hdfc._id, occurredAt: at(day(-1)) });
    const after = (await call(`/subscriptions/${netflix.id}`)).body;
    assert.equal(after.renewals.at(-1).dueOn, day(-1));
    assert.equal(after.renewals.at(-1).transactionId, raisedCharge.id);
    assert.deepEqual(after.alerts, [{ kind: "price", fromMinor: 649_00, toMinor: 699_00, on: day(-1) }]);
    const updated = await call(`/subscriptions/${netflix.id}`, { method: "PATCH", body: { amountMinor: 699_00 } });
    assert.deepEqual(updated.body.alerts, [], "price brought up to date: nothing to flag");
  });

  it("puts a shared plan's parts on the charge, so People knows", async () => {
    const asha = await models.Contact.create({ userId, name: "Asha" });
    const prime = await track({
      name: "Prime",
      amountMinor: 1499_00,
      every: 1,
      unit: "year",
      nextRenewalOn: day(-1),
      sharedWith: [{ contactId: asha.id.toString(), amountMinor: 500_00 }],
    });
    assert.equal(prime.myShareMinor, 999_00);
    const row = await charge({ merchant: "Amazon Prime", amountMinor: 1499_00, occurredAt: at(day(-1)) });
    await call("/subscriptions");
    const linked = await models.Transaction.findById(row._id).orFail();
    assert.equal(String(linked.subscriptionId), prime.id);
    assert.deepEqual(linked.people.map((p) => [p.contactId.toString(), p.amountMinor]), [[asha.id.toString(), 500_00]]);
    assert.equal(linked.split?.myShareMinor, 999_00);
    assert.equal(linked.countedAmountMinor, 999_00);
    assert.equal((await call("/contacts")).body.owedToYouMinor, 500_00);
  });

  it("gives up on a renewal a week past due, says so, and still takes a late charge", async () => {
    const netflix = await track({ nextRenewalOn: day(-10) });
    const view = (await call(`/subscriptions/${netflix.id}`)).body;
    assert.deepEqual(view.renewals, [{ dueOn: day(-10), status: "missed", transactionId: null, amountMinor: null, paidOn: null }]);
    assert.equal(view.nextRenewalOn, schedule.renewalAt(day(-10), { every: 1, unit: "month" }, 1));
    assert.deepEqual(view.alerts, [{ kind: "missed", dueOn: day(-10), amountMinor: 649_00 }]);

    await charge({ merchant: "Netflix", amountMinor: 649_00, occurredAt: at(day(-1)) });
    const later = (await call(`/subscriptions/${netflix.id}`)).body;
    assert.equal(later.renewals[0].status, "paid");
    assert.equal(later.renewals[0].paidOn, day(-1));
    assert.deepEqual(later.alerts, []);

    // Due two days ago, nothing yet: overdue, not missed.
    const gym = await track({ name: "Gym", amountMinor: 2000_00, nextRenewalOn: day(-2) });
    assert.deepEqual(gym.alerts, [{ kind: "overdue", dueOn: day(-2), amountMinor: 2000_00 }]);
  });

  it("can have a renewal marked paid, skipped, linked by hand, or unsaid", async () => {
    const gym = await track({ name: "Gym", amountMinor: 2000_00, nextRenewalOn: day(-2) });
    const next = schedule.renewalAt(day(-2), { every: 1, unit: "month" }, 1);

    const cash = await call(`/subscriptions/${gym.id}/renewals/${day(-2)}/paid`, { body: {} });
    assert.equal(cash.status, 200, JSON.stringify(cash.body));
    assert.equal(cash.body.nextRenewalOn, next);
    assert.deepEqual(cash.body.renewals[0], { dueOn: day(-2), status: "paid", transactionId: null, amountMinor: 2000_00, paidOn: day(-2) });

    const undone = await call(`/subscriptions/${gym.id}/renewals/${day(-2)}`, { method: "DELETE" });
    assert.equal(undone.body.nextRenewalOn, day(-2), "open again");
    assert.deepEqual(undone.body.renewals, []);

    const skipped = await call(`/subscriptions/${gym.id}/renewals/${day(-2)}/skip`, { method: "POST" });
    assert.equal(skipped.body.renewals[0].status, "skipped");
    assert.equal(skipped.body.nextRenewalOn, next);

    const row = await charge({ merchant: "Some gym", amountMinor: 1950_00, occurredAt: at(day(-5)) });
    const candidates = (await call(`/subscriptions/${gym.id}/candidates?on=${day(-2)}`)).body;
    assert.equal(candidates[0].id, row.id);
    const linked = await call(`/subscriptions/${gym.id}/renewals/${day(-2)}/paid`, { body: { transactionId: row.id } });
    assert.equal(linked.body.renewals[0].status, "paid");
    assert.equal(linked.body.renewals[0].amountMinor, 1950_00);
    assert.equal(String((await models.Transaction.findById(row._id).orFail()).subscriptionId), gym.id);
    assert.deepEqual((await stored(gym.id)).merchantKeys, ["somegym"], "the merchant is remembered for next time");

    // Deleting the subscription leaves the payment a payment.
    assert.equal((await call(`/subscriptions/${gym.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await models.Transaction.findById(row._id).orFail()).subscriptionId, null);
  });

  it("pauses, resumes and cancels, and the calendar shows what is settled and what is to come", async () => {
    const netflix = await track({ nextRenewalOn: day(3) });
    const paused = await call(`/subscriptions/${netflix.id}/pause`, { method: "POST" });
    assert.equal(paused.body.status, "paused");
    assert.equal((await call("/subscriptions")).body.totals.activeCount, 0);
    assert.equal((await call(`/subscriptions/${netflix.id}/pause`, { method: "POST" })).status, 400);

    const resumed = await call(`/subscriptions/${netflix.id}/resume`, { body: { nextRenewalOn: day(20) } });
    assert.equal(resumed.body.status, "active");
    assert.equal(resumed.body.nextRenewalOn, day(20));

    const cancelled = await call(`/subscriptions/${netflix.id}/cancel`, { method: "POST" });
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal(cancelled.body.cancelledOn, today());

    const gym = await track({ name: "Gym", amountMinor: 2000_00, nextRenewalOn: day(-2) });
    await charge({ merchant: "Gym", amountMinor: 2000_00, occurredAt: at(day(-2)) });
    const month = day(-2).slice(0, 7);
    const calendar = (await call(`/subscriptions/calendar?month=${month}`)).body;
    const gymDays = calendar.renewals.filter((r: Json) => r.subscriptionId === gym.id);
    assert.ok(gymDays.some((r: Json) => r.on === day(-2) && r.status === "paid"));
    assert.ok(gymDays.every((r: Json) => r.status !== "upcoming" || r.on >= today()));
    assert.ok(!calendar.renewals.some((r: Json) => r.subscriptionId === netflix.id), "a cancelled one has no renewals ahead");
  });
});

describe("telling subscriptions apart from other spending", () => {
  it("suggests a merchant charged every month at the same amount, until it is tracked or dismissed", async () => {
    const hdfc = await models.Account.create({ userId, bankName: "HDFC", accountType: "CARD", last4: "1234" });
    for (const offset of [-93, -62, -31]) {
      await charge({ merchant: "NETFLIX.COM", amountMinor: 649_00, accountId: hdfc._id, occurredAt: at(day(offset)) });
    }
    // Groceries every few days, at whatever they came to, are not one.
    for (const [offset, amount] of [
      [-20, 1200_00],
      [-17, 840_00],
      [-9, 1560_00],
      [-2, 990_00],
    ]) {
      await charge({ merchant: "BigBasket", amountMinor: amount, occurredAt: at(day(offset)) });
    }

    const first = (await call("/subscriptions")).body;
    assert.equal(first.suggestions.length, 1);
    const [netflix] = first.suggestions;
    assert.equal(netflix.merchant, "NETFLIX.COM");
    assert.equal(netflix.amountMinor, 649_00);
    assert.equal(netflix.unit, "month");
    assert.equal(netflix.every, 1);
    assert.equal(netflix.count, 3);
    assert.equal(netflix.accountId, hdfc.id.toString());
    assert.equal(netflix.nextOn, schedule.renewalAt(day(-31), { every: 1, unit: "month" }, 1));

    // Taken up: its past charges are its history, and it is suggested no more.
    const tracked = await track({
      name: "Netflix",
      nextRenewalOn: netflix.nextOn,
      startedOn: netflix.firstOn,
      accountId: netflix.accountId,
      merchantKeys: [netflix.key],
    });
    assert.equal(tracked.renewals.length, 3);
    assert.ok(tracked.renewals.every((r: Json) => r.status === "paid"));
    assert.equal(await models.Transaction.countDocuments({ subscriptionId: tracked.id }), 3);
    assert.equal((await call("/subscriptions")).body.suggestions.length, 0);

    // Another, dismissed.
    for (const offset of [-61, -30, 0]) await charge({ merchant: "Hotstar", amountMinor: 299_00, occurredAt: at(day(offset)) });
    assert.equal((await call("/subscriptions")).body.suggestions.length, 1);
    assert.equal((await call("/subscriptions/suggestions/hotstar/dismiss", { method: "POST" })).status, 204);
    assert.equal((await call("/subscriptions")).body.suggestions.length, 0);
  });
});

describe("subscriptions and the monthly budget", () => {
  it("counts a renewal's charge as a fixed cost and one still to come as still due", async () => {
    await call("/budget/monthly", { method: "PUT", body: { amountMinor: 30000_00 } });
    const netflix = await track({ nextRenewalOn: today() });
    await charge({ merchant: "Netflix", amountMinor: 649_00 });
    await track({ name: "Gym", amountMinor: 2000_00, nextRenewalOn: today() });
    await call("/subscriptions");

    const budget = (await call("/budget/monthly")).body;
    assert.equal(budget.spentMinor, 649_00);
    assert.equal(budget.pace.fixedPaidMinor, 649_00);
    assert.equal(budget.pace.fixedStillDueMinor, 2000_00);
    assert.equal((await stored(netflix.id)).renewals[0].status, "paid");

    const summary = (await call("/subscriptions/summary")).body;
    assert.equal(summary.dueThisMonthCount, 2);
    assert.equal(summary.paidThisMonthMinor, 649_00);
    assert.equal(summary.upcomingThisMonthMinor, 2000_00);
  });
});

describe("what the phone is told", () => {
  it("says a renewal is coming, a trial is ending and a renewal never came - each once", async () => {
    await track({ nextRenewalOn: day(2) });
    await track({ name: "Spotify", amountMinor: 119_00, nextRenewalOn: day(6), trialEndsOn: day(5), remindDaysBefore: 5 });
    await track({ name: "Gym", amountMinor: 2000_00, nextRenewalOn: day(-10) });
    await track({ name: "Prime", amountMinor: 1499_00, every: 1, unit: "year", nextRenewalOn: day(30) });

    assert.equal(await notify.notifySubscriptions(userId), 3);
    const titles = pushed.map((p) => p.body.message.notification.title).sort();
    assert.deepEqual(
      titles,
      ["Gym: no payment seen", `Netflix renews ${notifyWhen(day(2))}`, `Spotify's free trial ends ${notifyWhen(day(5))}`].sort()
    );
    assert.ok(pushed.every((p) => p.body.message.data.type === "SUBSCRIPTION"));
    assert.ok(pushed.every((p) => p.body.message.data.subscriptionId));

    pushed.length = 0;
    assert.equal(await notify.notifySubscriptions(userId), 0, "said once");
  });

  it("runs once a morning, after nine", async () => {
    await track({ nextRenewalOn: day(1) });
    const nineThirty = new Date(time.istDayStart(today()).getTime() + 9.5 * 60 * 60 * 1000);
    const first = await notify.runSubscriptionNotices(nineThirty);
    assert.deepEqual(first, { ran: true, users: 1, sent: 1 });
    assert.deepEqual(await notify.runSubscriptionNotices(new Date(nineThirty.getTime() + 60 * 60 * 1000)), { ran: false, users: 0, sent: 0 });

    const eight = new Date(time.istDayStart(day(1)).getTime() + 8 * 60 * 60 * 1000);
    assert.equal(daily.lastMomentIST(eight, 9).getTime(), nineThirty.getTime() - 30 * 60 * 1000, "nine this morning is still to come");
    const tomorrow = new Date(time.istDayStart(day(1)).getTime() + 9 * 60 * 60 * 1000);
    assert.equal((await notify.runSubscriptionNotices(tomorrow)).ran, true);
  });
});

/** How a day more than a day off is named in a notice. */
function notifyWhen(dayKey: string): string {
  const date = new Date(`${dayKey}T12:00:00+05:30`);
  return `on ${date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })}`;
}
