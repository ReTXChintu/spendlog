import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "drift-secret";
process.env.FIREBASE_SERVICE_ACCOUNT_FILE = "";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let drift: typeof import("./accounts.drift");
let push: typeof import("../family/family.push");

const realFetch = globalThis.fetch;
/** Every message handed to Firebase. */
let pushed: { url: string; body: any }[] = [];

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_drift_test"));

  const [{ app }, auth, loaded, loadedDrift, loadedPush] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./accounts.drift"),
    import("../family/family.push"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  drift = loadedDrift;
  push = loadedPush;

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // Firebase is stubbed; the test's own calls to the app go through for real.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("https://fcm.googleapis.com/")) return realFetch(input, init);
    pushed.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
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

let token: string;
let userId: Types.ObjectId;
let bankId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  pushed = [];
  push.useFirebaseForTests(null);
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.BalanceAlert.deleteMany({}),
    models.BalanceCheckpoint.deleteMany({}),
    models.JobRun.deleteMany({}),
  ]);
  const email = `d${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ledgerFrom: "2026-01" });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  const bank = await models.Account.create({
    userId,
    bankName: "HDFC Bank",
    last4: "8342",
    accountType: "BANK",
    openingBalanceMinor: 10_000_00,
    openingBalanceAt: new Date("2026-10-01T00:00:00+05:30"),
  });
  bankId = bank._id;
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** A row the bank's figure disagrees with by ₹3,000. */
async function driftingRow(occurredAt = "2026-10-12T10:00:00+05:30", statedBalanceMinor = 6_800_00) {
  return models.Transaction.create({
    userId,
    accountId: bankId,
    type: "DEBIT",
    amountMinor: 200_00,
    merchant: "swiggy@icici",
    source: "SMS",
    statedBalanceMinor,
    occurredAt: new Date(occurredAt),
  });
}

// A quarter to eleven at night, IST, on the 15th: tonight's check is due.
const TONIGHT = new Date("2026-10-15T22:45:00+05:30");

describe("the nightly drift check", () => {
  it("records one alert per drift, and not the same one twice", async () => {
    await driftingRow();

    const first = await drift.checkDriftForUser(userId);
    assert.equal(first.length, 1);
    assert.equal(first[0].driftMinor, -3_000_00);
    assert.equal(first[0].statedMinor, 6_800_00);
    assert.equal(first[0].expectedMinor, 9_800_00);

    assert.equal((await drift.checkDriftForUser(userId)).length, 0, "the same gap at the same figure is one problem");
    assert.equal(await models.BalanceAlert.countDocuments({ userId }), 1);
  });

  it("alerts again when the bank gives a new figure with a different gap", async () => {
    await driftingRow();
    await drift.checkDriftForUser(userId);
    await driftingRow("2026-10-13T10:00:00+05:30", 7_600_00); // now ₹2,000 off
    const next = await drift.checkDriftForUser(userId);
    assert.equal(next.length, 1);
    assert.equal(next[0].driftMinor, -2_000_00);
  });

  it("lets a few rupees of rounding pass", async () => {
    await driftingRow("2026-10-12T10:00:00+05:30", 9_796_00);
    assert.equal((await drift.checkDriftForUser(userId)).length, 0);
  });

  it("runs once a night however often it is asked", async () => {
    await driftingRow();
    const run = await drift.runNightlyDriftCheck(TONIGHT);
    assert.deepEqual(run, { ran: true, users: 1, alerts: 1, missingCredits: 0 });

    const again = await drift.runNightlyDriftCheck(new Date(TONIGHT.getTime() + 30 * 60 * 1000));
    assert.equal(again.ran, false);

    // Tomorrow night it is due again - and finds nothing new to say.
    const tomorrow = await drift.runNightlyDriftCheck(new Date(TONIGHT.getTime() + 24 * 60 * 60 * 1000));
    assert.deepEqual(tomorrow, { ran: true, users: 1, alerts: 0, missingCredits: 0 });
  });

  it("is due after half past ten at night, IST", () => {
    assert.equal(drift.lastDriftMoment(TONIGHT).toISOString(), "2026-10-15T17:00:00.000Z");
    assert.equal(drift.lastDriftMoment(new Date("2026-10-15T22:15:00+05:30")).toISOString(), "2026-10-14T17:00:00.000Z");
  });

  it("pushes a visible notification to the owner's phones", async () => {
    await driftingRow();
    await models.User.updateOne({ _id: userId }, { $set: { fcmTokens: [{ token: "phone-1", updatedAt: new Date() }] } });
    push.useFirebaseForTests({ projectId: "spendlog-test", accessToken: "token-1" });

    await drift.runNightlyDriftCheck(TONIGHT);

    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].url, "https://fcm.googleapis.com/v1/projects/spendlog-test/messages:send");
    const message = pushed[0].body.message;
    assert.equal(message.token, "phone-1");
    assert.equal(message.notification.title, "HDFC Bank ••8342 is ₹3,000 off since 12 Oct");
    assert.match(message.notification.body, /bank shows ₹6,800; SpendLog expected ₹9,800/);
    assert.equal(message.data.type, "BALANCE_DRIFT");
    assert.equal(message.data.accountId, bankId.toString());
  });

  it("records the alert without a notification when push is not configured", async () => {
    await driftingRow();
    await models.User.updateOne({ _id: userId }, { $set: { fcmTokens: [{ token: "phone-1", updatedAt: new Date() }] } });
    const run = await drift.runNightlyDriftCheck(TONIGHT);
    assert.equal(run.alerts, 1);
    assert.equal(pushed.length, 0);
  });

  it("leaves a kid's login out", async () => {
    const kid = await models.User.create({ email: "kid@example.com", role: "KID", parentId: userId });
    await driftingRow();
    const run = await drift.runNightlyDriftCheck(TONIGHT);
    assert.equal(run.users, 1);
    assert.equal(await models.BalanceAlert.countDocuments({ userId: kid._id }), 0);
  });
});

describe("drift alerts on the screens", () => {
  it("are listed until seen, and show in the to-dos and on the tile", async () => {
    await driftingRow();
    await drift.checkDriftForUser(userId);

    const alerts = await json(await call("/accounts/alerts"));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].title, "HDFC Bank ••8342 is ₹3,000 off since 12 Oct");
    assert.equal(alerts[0].accountId, bankId.toString());
    assert.deepEqual(alerts[0].account, { name: "HDFC Bank", bankName: "HDFC Bank", last4: "8342" });
    assert.equal(alerts[0].driftMinor, -3_000_00);

    const dashboard = await json(await call("/dashboard"));
    const todo = dashboard.todos.find((item: { kind: string }) => item.kind === "balance_alert");
    assert.equal(todo.alertId, alerts[0].id);
    assert.equal(todo.title, alerts[0].title);
    assert.deepEqual(dashboard.wallet.banks[0].drift, { minor: -3_000_00, since: "2026-10-12T04:30:00.000Z" });
    assert.deepEqual(dashboard.money.accounts[0].drift, { minor: -3_000_00, since: "2026-10-12T04:30:00.000Z" });

    const overview = await json(await call("/accounts/overview"));
    assert.equal(overview.find((row: { id: string }) => row.id === bankId.toString()).balance.drift.minor, -3_000_00);

    const seen = await call(`/accounts/alerts/${alerts[0].id}/seen`, { method: "POST" });
    assert.equal(seen.status, 200);
    assert.ok((await json(seen)).seenAt);
    assert.deepEqual(await json(await call("/accounts/alerts")), []);
    const later = await json(await call("/dashboard"));
    assert.ok(!later.todos.some((item: { kind: string }) => item.kind === "balance_alert"));
    // Seen is not forgotten: the same gap does not come back tomorrow.
    assert.equal((await drift.checkDriftForUser(userId)).length, 0);
  });

  it("shows no drift on an account the bank agrees with", async () => {
    await driftingRow("2026-10-12T10:00:00+05:30", 9_800_00);
    const dashboard = await json(await call("/dashboard"));
    assert.equal(dashboard.wallet.banks[0].drift, null);
  });
});
