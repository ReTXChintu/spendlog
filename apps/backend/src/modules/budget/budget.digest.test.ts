import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "digest-test-secret";

/**
 * The month that just closed, said once in a notification the morning
 * after pay day.
 */
let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let digest: typeof import("./budget.digest");
let push: typeof import("../family/family.push");
let time: typeof import("../../time");

const realFetch = globalThis.fetch;
const pushed: { body: Record<string, any> }[] = [];

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_digest_test"));
  [models, digest, push, time] = await Promise.all([
    import("../../models"),
    import("./budget.digest"),
    import("../family/family.push"),
    import("../../time"),
  ]);
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
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.Category.deleteMany({}),
    models.MonthlyDigest.deleteMany({}),
    models.JobRun.deleteMany({}),
  ]);
  pushed.length = 0;
});

let count = 0;
async function makeUser(extra: Record<string, unknown> = {}) {
  const user = await models.User.create({
    email: `d${(count += 1)}@example.com`,
    name: "Biswajit",
    fcmTokens: [{ token: `phone-${count}`, updatedAt: new Date() }],
    ...extra,
  });
  return user._id;
}

/** 9:30 in the morning, IST, on a day. */
const morning = (day: string) => new Date(time.istDayStart(day).getTime() + 9.5 * 60 * 60 * 1000);
const noon = (day: string) => new Date(time.istDayStart(day).getTime() + 12 * 60 * 60 * 1000);

async function spent(userId: Types.ObjectId, day: string, amountMinor: number, categoryId?: Types.ObjectId) {
  return models.Transaction.create({ userId, type: "DEBIT", source: "SMS", amountMinor, categoryId: categoryId ?? null, occurredAt: noon(day) });
}

describe("the morning-after digest", () => {
  it("sums the month, names the biggest category and the savings moved, the day after pay day, once", async () => {
    // Paid on the 15th: the month that closed is 15 Sep - 14 Oct, owed on 16 Oct.
    const userId = await makeUser({
      salaryDay: 15,
      monthlyBudgetHistory: [{ fromMonthKey: "2026-09", amountMinor: 50000_00, categoryLimits: [] }],
    });
    const food = await models.Category.create({ userId, name: "Food" });
    const travel = await models.Category.create({ userId, name: "Travel" });
    await spent(userId, "2026-09-20", 12400_00, food._id);
    await spent(userId, "2026-10-02", 9000_00, travel._id);
    await spent(userId, "2026-10-10", 8000_00);
    // Not this month's.
    await spent(userId, "2026-10-15", 5000_00, food._id);

    assert.equal(await digest.digestDue(userId, morning("2026-10-15")), null, "pay day itself: the month closes tonight");
    assert.equal(await digest.digestDue(userId, morning("2026-10-16")), "2026-09");

    const result = await digest.sendMonthlyDigest(userId, morning("2026-10-16"));
    assert.equal(result.sent, true);
    assert.equal(pushed.length, 1);
    const message = pushed[0].body.message;
    assert.equal(message.notification.title, "15 Sept – 14 Oct 2026: ₹29,400 spent");
    assert.equal(message.notification.body, "59% of your ₹50,000 budget · Biggest: Food ₹12,400 · ₹20,600 moved to savings");
    assert.deepEqual(message.data, { type: "MONTHLY_DIGEST", monthKey: "2026-09" });

    // Once.
    assert.deepEqual(await digest.sendMonthlyDigest(userId, morning("2026-10-17")), { sent: false, reason: "not-due" });
    assert.equal(pushed.length, 1);
    assert.equal(await models.MonthlyDigest.countDocuments({ userId, monthKey: "2026-09" }), 1);
  });

  it("is owed for a week after pay day and then dropped; a calendar month's the day after the 1st", async () => {
    const calendar = await makeUser();
    await spent(calendar, "2026-09-10", 1000_00);
    assert.equal(await digest.digestDue(calendar, morning("2026-10-01")), null);
    assert.equal(await digest.digestDue(calendar, morning("2026-10-02")), "2026-09");
    assert.equal(await digest.digestDue(calendar, morning("2026-10-09")), "2026-09", "still within the week");
    assert.equal(await digest.digestDue(calendar, morning("2026-10-10")), null, "old news");

    // Without a budget: no percentage, and the month's categories still named.
    const result = await digest.sendMonthlyDigest(calendar, morning("2026-10-02"));
    assert.equal(result.sent, true);
    assert.equal(pushed[0].body.message.notification.title, "September 2026: ₹1,000 spent");
    assert.equal(pushed[0].body.message.notification.body, "Biggest: Uncategorised ₹1,000");
  });

  it("says when a month went over, and passes over a month with nothing in it", async () => {
    const over = {
      month: { label: "October 2026" },
      configured: true,
      budgetMinor: 10000_00,
      spentMinor: 12500_00,
      leftMinor: -2500_00,
      isOver: true,
      categories: [{ name: "Food", spentMinor: 7000_00 }],
      unassigned: { categories: [{ name: "Shopping", spentMinor: 5500_00 }] },
    };
    assert.deepEqual(digest.digestText(over as never, -2500_00), {
      title: "October 2026: ₹12,500 spent",
      body: "125% of your ₹10,000 budget, ₹2,500 over · Biggest: Food ₹7,000 · ₹2,500 taken from savings",
    });

    const empty = await makeUser();
    const result = await digest.sendMonthlyDigest(empty, morning("2026-10-02"));
    assert.deepEqual(result, { sent: false, reason: "nothing-to-say", monthKey: "2026-09" });
    assert.equal(pushed.length, 0);
    assert.equal(await digest.digestDue(empty, morning("2026-10-03")), null, "passed over, not asked again");
  });

  it("runs once a morning for everyone with a phone", async () => {
    const a = await makeUser();
    await spent(a, "2026-09-10", 1000_00);
    const b = await makeUser({ salaryDay: 20 });
    await spent(b, "2026-09-25", 1000_00);
    await makeUser({ fcmTokens: [] });

    const first = await digest.runMonthlyDigests(morning("2026-10-02"));
    assert.deepEqual(first, { ran: true, users: 2, sent: 1 }, "only the calendar month's is owed on the 2nd");
    assert.deepEqual(await digest.runMonthlyDigests(morning("2026-10-02")), { ran: false, users: 0, sent: 0 });
    const later = await digest.runMonthlyDigests(morning("2026-10-21"));
    assert.deepEqual(later, { ran: true, users: 2, sent: 1 }, "the 20th's month closed last night");
    assert.equal(pushed.length, 2);
  });
});
