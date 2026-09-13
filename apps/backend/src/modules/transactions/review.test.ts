import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "review-test-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_review_test"));

  const [{ app }, auth, loaded] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([models.Transaction.deleteMany({}), models.User.deleteMany({})]);
});

let userCount = 0;

async function makeUser() {
  const email = `u${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

function call(path: string, token: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

type Review = { day: string; total: number; uncategorized: number };

/** Noon IST on the given day, safely inside it. */
function noon(day: string): Date {
  return new Date(`${day}T12:00:00+05:30`);
}

async function record(
  userId: Types.ObjectId,
  day: string,
  overrides: Record<string, unknown> = {}
) {
  return models.Transaction.create({
    userId,
    amountMinor: 50000,
    currency: "INR",
    type: "DEBIT",
    source: "SMS",
    occurredAt: noon(day),
    ...overrides,
  });
}

describe("what still needs a human", () => {
  it("counts the uncategorized ones on a day", async () => {
    const user = await makeUser();
    const category = await models.Category.create({ name: "Food", isSystem: true });

    await record(user.id, "2026-09-10");
    await record(user.id, "2026-09-10");
    await record(user.id, "2026-09-10", { categoryId: category._id });

    const review = await json<Review>(await call("/transactions/review?day=2026-09-10", user.token));
    assert.equal(review.total, 3);
    assert.equal(review.uncategorized, 2);
  });

  it("says nothing needs doing when everything is filed", async () => {
    const user = await makeUser();
    const category = await models.Category.create({ name: "Food", isSystem: true });
    await record(user.id, "2026-09-10", { categoryId: category._id });

    const review = await json<Review>(await call("/transactions/review?day=2026-09-10", user.token));
    assert.equal(review.uncategorized, 0);
  });

  it("does not nag about a transfer, which has nothing to categorise", async () => {
    const user = await makeUser();
    await record(user.id, "2026-09-10", { isTransfer: true });

    const review = await json<Review>(await call("/transactions/review?day=2026-09-10", user.token));
    assert.equal(review.total, 1);
    assert.equal(review.uncategorized, 0);
  });

  it("keeps to the IST day, not the UTC one", async () => {
    // 1am IST on the 11th is still the 10th in UTC. Counting by UTC would
    // nag about the wrong day, half an hour after midnight.
    const user = await makeUser();
    await models.Transaction.create({
      userId: user.id,
      amountMinor: 50000,
      currency: "INR",
      type: "DEBIT",
      source: "SMS",
      occurredAt: new Date("2026-09-10T19:30:00Z"),
    });

    const tenth = await json<Review>(await call("/transactions/review?day=2026-09-10", user.token));
    const eleventh = await json<Review>(await call("/transactions/review?day=2026-09-11", user.token));

    assert.equal(tenth.total, 0);
    assert.equal(eleventh.total, 1);
  });

  it("defaults to yesterday", async () => {
    const user = await makeUser();
    const review = await json<Review>(await call("/transactions/review", user.token));

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000 + (5 * 60 + 30) * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    assert.equal(review.day, yesterday);
  });

  it("counts nobody else's day", async () => {
    const [user, other] = await Promise.all([makeUser(), makeUser()]);
    await record(other.id, "2026-09-10");

    const review = await json<Review>(await call("/transactions/review?day=2026-09-10", user.token));
    assert.equal(review.total, 0);
  });
});
