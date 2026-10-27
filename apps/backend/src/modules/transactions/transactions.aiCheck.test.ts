import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { CheckRow, checkPrompt, readFlags } from "./transactions.aiCheck";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "ai-check-secret";
process.env.STATEMENT_ENCRYPTION_KEY = "a".repeat(64);

const row = (id: string, extra: Partial<CheckRow> = {}): CheckRow => ({
  id,
  occurredAt: new Date("2026-10-16T10:39:00+05:30"),
  type: "DEBIT",
  amountMinor: 300000,
  merchant: "Meesho",
  account: null,
  text: "Get a personal loan of Rs. 3,000 on Meesho sent directly to your bank account. Check your offer now",
  ...extra,
});

describe("reading the model's answer", () => {
  const rows = [row("a"), row("b"), row("c")];

  it("turns a flag on a numbered row into a flag on that row", () => {
    assert.deepEqual(readFlags(rows, { flags: [{ row: 1, kind: "NOT_A_TRANSACTION", reason: "  It's a loan advert. " }] }), [
      { id: "a", kind: "NOT_A_TRANSACTION", reason: "It's a loan advert.", duplicateOf: null },
    ]);
  });

  it("drops what names no row, an unknown kind, or no reason", () => {
    const flags = readFlags(rows, {
      flags: [
        { row: 0, kind: "NOT_A_TRANSACTION", reason: "x" },
        { row: 9, kind: "NOT_A_TRANSACTION", reason: "x" },
        { row: 1.5, kind: "NOT_A_TRANSACTION", reason: "x" },
        { row: 2, kind: "LOOKS_ODD", reason: "x" },
        { row: 3, kind: "WRONG_AMOUNT", reason: "   " },
      ],
    });
    assert.deepEqual(flags, []);
  });

  it("keeps a duplicate only when it names another row in the batch", () => {
    const flags = readFlags(rows, {
      flags: [
        { row: 2, kind: "DUPLICATE", reason: "Same payment as row 1.", duplicateOfRow: 1 },
        { row: 3, kind: "DUPLICATE", reason: "Repeats itself.", duplicateOfRow: 3 },
        { row: 1, kind: "DUPLICATE", reason: "No other row.", duplicateOfRow: null },
      ],
    });
    assert.deepEqual(flags, [{ id: "b", kind: "DUPLICATE", reason: "Same payment as row 1.", duplicateOf: "a" }]);
  });

  it("flags a row once, however often it is named", () => {
    const flags = readFlags(rows, {
      flags: [
        { row: 1, kind: "NOT_A_TRANSACTION", reason: "Advert." },
        { row: 1, kind: "WRONG_AMOUNT", reason: "Amount." },
      ],
    });
    assert.equal(flags.length, 1);
    assert.equal(flags[0].kind, "NOT_A_TRANSACTION");
  });

  it("survives no answer at all", () => {
    assert.deepEqual(readFlags(rows, null), []);
    assert.deepEqual(readFlags(rows, {}), []);
  });

  it("numbers the rows from 1 and gives the model the message, on one line each", () => {
    const prompt = checkPrompt([row("a", { text: "line one\n  line two" }), row("b", { amountMinor: 1234 })]);
    const lines = prompt.split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].row, 1);
    assert.equal(lines[0].message, "line one line two");
    assert.equal(lines[1].amount, "12.34");
  });
});

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let check: typeof import("./transactions.aiCheck");
let encrypt: (plain: string) => string;

const realFetch = globalThis.fetch;
let geminiRequests: { url: string; body: any }[] = [];
let geminiReplies: ((body: any) => unknown)[] = [];

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_ai_check_test"));
  const [{ app }, auth, loaded, loadedCheck, crypto] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./transactions.aiCheck"),
    import("../statements/statements.crypto"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  check = loadedCheck;
  encrypt = crypto.encryptPassword;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://generativelanguage.googleapis.com/")) return realFetch(input, init);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    geminiRequests.push({ url, body });
    const reply = geminiReplies.shift();
    assert.ok(reply, `unexpected Gemini call to ${url}`);
    const json = { candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(reply(body)) }] } }] };
    return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
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
  await Promise.all([models.Transaction.deleteMany({}), models.User.deleteMany({}), models.JobRun.deleteMany({})]);
});

let userCount = 0;

async function makeUser(withKey = true) {
  const email = `check${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ...(withKey ? { geminiApiKeyEnc: encrypt("AIza-test-key-123") } : {}) });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

function call(path: string, token: string, init?: RequestInit) {
  return realFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function fromSms(userId: Types.ObjectId, rupees: number, text: string, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    type: "DEBIT",
    amountMinor: rupees * 100,
    currency: "INR",
    source: "SMS",
    rawText: text,
    occurredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    ...extra,
  });
}

/** The rows the model was shown in the last request, by message. */
const shownMessages = () =>
  String(geminiRequests.at(-1)!.body.contents[0].parts[0].text)
    .split("\n")
    .map((line) => JSON.parse(line).message);

describe("the AI check", () => {
  it("flags what the model says was read wrong, and reads every row once", async () => {
    const user = await makeUser();
    const advert = await fromSms(user.id, 3000, "Get a personal loan of Rs. 3,000 on Meesho sent directly to your bank account.");
    const real = await fromSms(user.id, 250, "Rs 250.00 debited from a/c XX5130 to SWIGGY. Ref 123456789012.");
    geminiReplies.push(() => ({ flags: [{ row: 1, kind: "NOT_A_TRANSACTION", reason: "This is a loan advert, not a payment." }] }));

    const response = await call("/transactions/check", user.token, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { checked: 2, flagged: 1 });

    const flagged = (await (await call("/transactions/flagged", user.token)).json()) as any[];
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].id, advert._id.toString());
    assert.equal(flagged[0].aiFlag.kind, "NOT_A_TRANSACTION");
    assert.equal(flagged[0].aiFlag.reason, "This is a loan advert, not a payment.");
    assert.ok((await models.Transaction.findById(real._id))!.aiCheckedAt);

    // Nothing new: no second question.
    assert.deepEqual(await (await call("/transactions/check", user.token, { method: "POST" })).json(), { checked: 0, flagged: 0 });
    assert.equal(geminiRequests.length, 1);
  });

  it("leaves out rows typed in by hand and rows older than the lookback", async () => {
    const user = await makeUser();
    await fromSms(user.id, 100, "manual", { source: "MANUAL" });
    await fromSms(user.id, 100, "old", {
      occurredAt: new Date(Date.now() - (check.AI_CHECK_LOOKBACK_DAYS + 1) * 24 * 60 * 60 * 1000),
    });
    await fromSms(user.id, 100, "Rs 100 debited from a/c XX5130.");
    geminiReplies.push(() => ({ flags: [] }));

    await call("/transactions/check", user.token, { method: "POST" });
    assert.deepEqual(shownMessages(), ["Rs 100 debited from a/c XX5130."]);
  });

  it("never flags a row someone already said was right, or corrected", async () => {
    const user = await makeUser();
    await fromSms(user.id, 100, "said right", { aiFlagDismissedAt: new Date() });
    await fromSms(user.id, 100, "corrected", { editedAt: new Date() });
    geminiReplies.push(() => ({
      flags: [
        { row: 1, kind: "NOT_A_TRANSACTION", reason: "x" },
        { row: 2, kind: "WRONG_AMOUNT", reason: "y" },
      ],
    }));

    assert.deepEqual(await (await call("/transactions/check", user.token, { method: "POST" })).json(), { checked: 2, flagged: 0 });
  });

  it("takes the flag off for good when the user says it's right", async () => {
    const user = await makeUser();
    const tx = await fromSms(user.id, 100, "Rs 100 debited.", {
      aiFlag: { kind: "WRONG_AMOUNT", reason: "x", flaggedAt: new Date() },
    });

    assert.equal((await call(`/transactions/${tx._id}/flag/dismiss`, user.token, { method: "POST" })).status, 204);
    const after = await models.Transaction.findById(tx._id);
    assert.equal(after!.aiFlag, null);
    assert.ok(after!.aiFlagDismissedAt);
    assert.deepEqual(await (await call("/transactions/flagged", user.token)).json(), []);
  });

  it("takes the flag off when the entry is edited by hand", async () => {
    const user = await makeUser();
    const tx = await fromSms(user.id, 3000, "Rs 300 debited.", {
      aiFlag: { kind: "WRONG_AMOUNT", reason: "The message says Rs 300.", flaggedAt: new Date() },
    });

    const response = await call(`/transactions/${tx._id}`, user.token, {
      method: "PATCH",
      body: JSON.stringify({ amountMinor: 30000 }),
    });
    assert.equal(response.status, 200);
    assert.equal((await models.Transaction.findById(tx._id))!.aiFlag, null);
  });

  it("says a key is needed when there is none", async () => {
    const user = await makeUser(false);
    const response = await call("/transactions/check", user.token, { method: "POST" });
    assert.equal(response.status, 409);
    assert.equal(geminiRequests.length, 0);
  });

  it("checks everyone with a key once a morning, and only once", async () => {
    const withKey = await makeUser();
    await makeUser(false);
    const morning = new Date("2026-10-28T08:00:00+05:30");
    await fromSms(withKey.id, 3000, "Get a personal loan of Rs. 3,000.", { occurredAt: new Date("2026-10-27T12:00:00+05:30") });
    geminiReplies.push(() => ({ flags: [{ row: 1, kind: "NOT_A_TRANSACTION", reason: "Advert." }] }));

    assert.deepEqual(await check.runAiEntryChecks(morning), { ran: true, users: 1, flagged: 1 });
    assert.deepEqual(await check.runAiEntryChecks(new Date("2026-10-28T09:00:00+05:30")), { ran: false, users: 0, flagged: 0 });
    assert.equal(geminiRequests.length, 1);
  });
});
