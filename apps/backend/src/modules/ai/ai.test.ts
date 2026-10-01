import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "ai-routes-secret";
process.env.STATEMENT_ENCRYPTION_KEY = "a".repeat(64);

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let tools: typeof import("./ai.tools");
let periods: typeof import("../budget/budget.months");
let gemini: typeof import("./ai.gemini");

const realFetch = globalThis.fetch;

/** What the stubbed Gemini was sent, and what it should say next. */
let geminiRequests: { url: string; body: any }[] = [];
let geminiReplies: ((body: any) => { status: number; json: unknown })[] = [];

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_ai_test"));

  const [{ app }, auth, loaded, loadedTools, loadedPeriods, loadedGemini] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./ai.tools"),
    import("../budget/budget.months"),
    import("./ai.gemini"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  tools = loadedTools;
  periods = loadedPeriods;
  gemini = loadedGemini;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // Gemini is stubbed; everything else - the test's own calls to the app -
  // goes through for real.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) return realFetch(input, init);

    const body = init?.body ? JSON.parse(String(init.body)) : null;
    geminiRequests.push({ url, body });
    const reply = geminiReplies.shift();
    assert.ok(reply, `unexpected Gemini call to ${url}`);
    const { status, json } = reply(body);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  geminiRequests = [];
  geminiReplies = [];
  await Promise.all([
    models.Transaction.deleteMany({}),
    models.Category.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser() {
  const email = `ai${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

function call(path: string, token: string, init?: RequestInit) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function spend(userId: Types.ObjectId, rupees: number, day: string, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    type: "DEBIT",
    amountMinor: rupees * 100,
    currency: "INR",
    source: "MANUAL",
    occurredAt: new Date(`${day}T12:00:00+05:30`),
    ...extra,
  });
}

const modelsList = () => ({
  status: 200,
  json: { models: [{ name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] }] },
});

describe("the assistant's lookups", () => {
  it("totals a category by name, forgiving case and part-names", async () => {
    const user = await makeUser();
    const food = await models.Category.create({ name: "Food & Dining" });
    const travel = await models.Category.create({ name: "Travel" });
    await spend(user.id, 450, "2026-09-03", { categoryId: food._id, merchant: "Swiggy" });
    await spend(user.id, 300, "2026-09-10", { categoryId: food._id, merchant: "Zomato" });
    await spend(user.id, 5000, "2026-09-11", { categoryId: travel._id });

    const result = await tools.runTool(user.id, "spending_summary", {
      from: "2026-09-01",
      to: "2026-09-30",
      categories: ["food"],
      groupBy: "merchant",
    });

    assert.equal(result.totalRupees, 750);
    assert.equal(result.transactionCount, 2);
    assert.deepEqual(
      (result.groups as { name: string }[]).map((group) => group.name),
      ["Swiggy", "Zomato"]
    );
  });

  it("says which category names matched nothing, rather than quietly dropping them", async () => {
    const user = await makeUser();
    const result = await tools.runTool(user.id, "spending_summary", {
      from: "2026-09-01",
      to: "2026-09-30",
      categories: ["Yachts"],
    });
    assert.deepEqual(result.unmatchedCategories, ["Yachts"]);
  });

  it("counts only what really counts - no transfers", async () => {
    const user = await makeUser();
    await spend(user.id, 200, "2026-09-05");
    await spend(user.id, 50_000, "2026-09-05", { isTransfer: true });

    const result = await tools.runTool(user.id, "spending_summary", { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(result.totalRupees, 200);
  });

  it("never shows another user's money", async () => {
    const user = await makeUser();
    const stranger = await makeUser();
    await spend(stranger.id, 999, "2026-09-05");

    const result = await tools.runTool(user.id, "find_transactions", { from: "2026-09-01", to: "2026-09-30" });
    assert.equal(result.matching, 0);
  });

  it("treats a search term as text, not a pattern", async () => {
    const user = await makeUser();
    await spend(user.id, 100, "2026-09-05", { merchant: "A+B Stores" });
    await spend(user.id, 100, "2026-09-05", { merchant: "AAB Stores" });

    const result = await tools.runTool(user.id, "find_transactions", {
      from: "2026-09-01",
      to: "2026-09-30",
      text: "A+B",
    });
    assert.equal(result.matching, 1);
  });

  it("answers an unknown function with an error rather than throwing", async () => {
    const user = await makeUser();
    const result = await tools.runTool(user.id, "drop_database", {});
    assert.ok(result.error);
  });
});

describe("the assistant's months", () => {
  const now = new Date("2026-09-19T12:00:00+05:30");

  it("runs salary day to salary day for someone with a pay day", async () => {
    const user = await makeUser();
    await models.User.updateOne({ _id: user.id }, { salaryDay: 15 });

    const { bySalary, recent } = await periods.userMonths(user.id, now);
    assert.equal(bySalary, true);
    assert.deepEqual([recent[0].from, recent[0].to], ["2026-09-15", "2026-10-14"]);
    assert.deepEqual([recent[1].from, recent[1].to], ["2026-08-15", "2026-09-14"]);
    assert.deepEqual([recent[2].from, recent[2].to], ["2026-07-15", "2026-08-14"]);
  });

  it("opens this month on the day pay actually landed", async () => {
    const user = await makeUser();
    await models.User.updateOne({ _id: user.id }, { salaryDay: 15 });
    await models.Transaction.create({
      userId: user.id,
      type: "CREDIT",
      amountMinor: 80_000_00,
      currency: "INR",
      source: "MANUAL",
      isSalary: true,
      occurredAt: new Date("2026-09-13T10:00:00+05:30"),
    });

    const { recent } = await periods.userMonths(user.id, now);
    assert.equal(recent[0].from, "2026-09-13");
    assert.deepEqual([recent[1].from, recent[1].to], ["2026-08-15", "2026-09-12"], "no gap, no overlap");
  });

  it("falls back to calendar months with no pay day", async () => {
    const user = await makeUser();
    const { bySalary, recent } = await periods.userMonths(user.id, now);
    assert.equal(bySalary, false);
    assert.deepEqual([recent[0].from, recent[0].to], ["2026-09-01", "2026-09-30"]);
    assert.deepEqual([recent[1].from, recent[1].to], ["2026-08-01", "2026-08-31"]);
  });

  it("breaks totals down by the user's own months", async () => {
    const user = await makeUser();
    await models.User.updateOne({ _id: user.id }, { salaryDay: 15 });
    await spend(user.id, 100, "2026-08-20"); // August's period
    await spend(user.id, 200, "2026-09-10"); // still August's period
    await spend(user.id, 400, "2026-09-16"); // September's

    const result = await tools.runTool(
      user.id,
      "spending_summary",
      { from: "2026-08-15", to: "2026-09-19", groupBy: "period" },
      await periods.userMonths(user.id, now)
    );
    assert.deepEqual(result.groups, [
      { name: "2026-08-15 to 2026-09-14", totalRupees: 300, count: 2 },
      { name: "2026-09-15 to 2026-10-14", totalRupees: 400, count: 1 },
    ]);
  });

  it("tells the model the dates of this month and last", async () => {
    const user = await makeUser();
    await models.User.updateOne({ _id: user.id }, { salaryDay: 15 });
    const text = gemini.monthsInstruction(await periods.userMonths(user.id, now)).join("\n");
    assert.match(text, /This month: 2026-09-15 to 2026-10-14/);
    assert.match(text, /Last month: 2026-08-15 to 2026-09-14/);
  });
});

describe("the assistant's settings", () => {
  it("checks a key with Gemini before keeping it, and never sends it back", async () => {
    const user = await makeUser();
    geminiReplies.push(modelsList);

    const key = "AIzaSyTESTKEY1234567890abcd";
    const response = await call("/ai/settings", user.token, { method: "PUT", body: JSON.stringify({ apiKey: key }) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { hasKey: boolean; keyHint: string };
    assert.equal(body.hasKey, true);
    assert.equal(body.keyHint, "abcd");
    assert.ok(!JSON.stringify(body).includes(key));

    const stored = await models.User.findById(user.id).orFail();
    assert.ok(stored.geminiApiKeyEnc && !stored.geminiApiKeyEnc.includes(key), "stored encrypted");
    assert.ok(!JSON.stringify(stored.toJSON()).includes(stored.geminiApiKeyEnc!));
  });

  it("refuses a key Gemini rejects", async () => {
    const user = await makeUser();
    geminiReplies.push(() => ({ status: 400, json: { error: { message: "API key not valid." } } }));

    const response = await call("/ai/settings", user.token, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "AIzaSyWRONGKEY000000000000" }),
    });
    assert.equal(response.status, 400);
    assert.equal((await models.User.findById(user.id).orFail()).geminiApiKeyEnc, null);
  });
});

describe("asking a question", () => {
  async function userWithKey() {
    const user = await makeUser();
    geminiReplies.push(modelsList);
    await call("/ai/settings", user.token, {
      method: "PUT",
      body: JSON.stringify({ apiKey: "AIzaSyTESTKEY1234567890abcd" }),
    });
    geminiRequests = [];
    return user;
  }

  it("needs a key first", async () => {
    const user = await makeUser();
    const response = await call("/ai/ask", user.token, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", text: "How much did I spend?" }] }),
    });
    assert.equal(response.status, 409);
  });

  it("runs the lookup the model asks for, then returns its answer", async () => {
    const user = await userWithKey();
    await spend(user.id, 1200, "2026-09-05");

    geminiReplies.push(() => ({
      status: 200,
      json: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: { name: "spending_summary", args: { from: "2026-09-01", to: "2026-09-30" } },
                  thoughtSignature: "sig-123",
                },
              ],
            },
          },
        ],
      },
    }));
    geminiReplies.push((body) => {
      const last = body.contents[body.contents.length - 1];
      const total = last.parts[0].functionResponse.response.totalRupees;
      return {
        status: 200,
        json: { candidates: [{ content: { role: "model", parts: [{ text: `You spent ₹${total}.` }] } }] },
      };
    });

    const response = await call("/ai/ask", user.token, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", text: "How much did I spend this month?" }] }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { answer: string; lookups: string[] };
    assert.equal(body.answer, "You spent ₹1200.");
    assert.deepEqual(body.lookups, ["spending_summary"]);

    // The key goes in a header, never the URL, and the model's own turn is
    // sent back with its signature intact.
    assert.ok(geminiRequests.every((request) => !request.url.includes("AIza")));
    const second = geminiRequests[1].body.contents;
    assert.equal(second[1].parts[0].thoughtSignature, "sig-123");
  });

  it("falls back to the next default model when the first isn't available", async () => {
    const user = await userWithKey();
    geminiReplies.push(() => ({ status: 404, json: { error: { message: "not found" } } }));
    geminiReplies.push(() => ({
      status: 200,
      json: { candidates: [{ content: { role: "model", parts: [{ text: "Hello." }] } }] },
    }));

    const response = await call("/ai/ask", user.token, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", text: "Hi" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { model: string }).model, "gemini-2.5-flash");
  });

  it("passes a quota error on in words", async () => {
    const user = await userWithKey();
    geminiReplies.push(() => ({ status: 429, json: {} }));

    const response = await call("/ai/ask", user.token, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", text: "Hi" }] }),
    });
    assert.equal(response.status, 429);
    assert.match(((await response.json()) as { error: string }).error, /quota/);
  });
});
