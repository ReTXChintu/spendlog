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

const realFetch = globalThis.fetch;

/** What the stubbed Gemini was sent, and what it should say next. */
let geminiRequests: { url: string; body: any }[] = [];
let geminiReplies: ((body: any) => { status: number; json: unknown })[] = [];

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_ai_test"));

  const [{ app }, auth, loaded, loadedTools] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./ai.tools"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  tools = loadedTools;

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
