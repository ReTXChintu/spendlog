import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "family-secret";
// Empty rather than deleted: dotenv refills missing keys from a developer's
// .env when the app loads, but leaves keys that already exist alone.
process.env.FIREBASE_SERVICE_ACCOUNT_FILE = "";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_family_test"));
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

let ownerToken: string;
let ownerId: Types.ObjectId;
let pocketId: string;
let otherPocketId: string;
let mainAccountId: string;
let count = 0;

beforeEach(async () => {
  await Promise.all([
    models.User.deleteMany({}),
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.MerchantPreset.deleteMany({}),
  ]);
  const email = `owner${(count += 1)}@example.com`;
  const owner = await models.User.create({ email, name: "Parent", salaryDay: 1 });
  ownerId = owner._id;
  ownerToken = signToken({ id: owner._id.toString(), email });

  const pocket = await models.Account.create({
    userId: ownerId,
    bankName: "Rahul wallet",
    accountType: "BANK",
    pocketMoney: { holder: "Rahul", limitMinor: 2000_00, renewDay: 1 },
  });
  const other = await models.Account.create({
    userId: ownerId,
    bankName: "Priya wallet",
    accountType: "BANK",
    pocketMoney: { holder: "Priya", limitMinor: 1500_00, renewDay: 1 },
  });
  const main = await models.Account.create({ userId: ownerId, bankName: "HDFC", accountType: "BANK" });
  pocketId = pocket.id;
  otherPocketId = other.id;
  mainAccountId = main.id;
});

function call(path: string, token: string | null, init?: RequestInit & { mobile?: boolean }) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      ...(init?.mobile ? { "x-spendlog-client": "mobile" } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function makeKid(accountIds = [pocketId]) {
  const response = await call("/family/kids", ownerToken, {
    method: "POST",
    body: JSON.stringify({ name: "Rahul", email: "rahul@example.com", password: "secret123", accountIds }),
  });
  assert.equal(response.status, 201);
  return json<{ id: string }>(response);
}

async function kidLogin(password = "secret123") {
  const response = await call("/kid/login", null, {
    method: "POST",
    mobile: true,
    body: JSON.stringify({ email: "rahul@example.com", password }),
  });
  return response;
}

async function kidToken() {
  const response = await kidLogin();
  assert.equal(response.status, 200);
  return (await json<{ token: string }>(response)).token;
}

describe("making a kid's login", () => {
  it("only gives a kid pocket money accounts, each to one kid", async () => {
    const notPocket = await call("/family/kids", ownerToken, {
      method: "POST",
      body: JSON.stringify({ name: "R", email: "r1@example.com", password: "secret123", accountIds: [mainAccountId] }),
    });
    assert.equal(notPocket.status, 400);

    await makeKid();
    const twice = await call("/family/kids", ownerToken, {
      method: "POST",
      body: JSON.stringify({ name: "P", email: "p@example.com", password: "secret123", accountIds: [pocketId] }),
    });
    assert.equal(twice.status, 400);
  });

  it("refuses an email already on SpendLog", async () => {
    const response = await call("/family/kids", ownerToken, {
      method: "POST",
      body: JSON.stringify({ name: "R", email: `owner${count}@example.com`, password: "secret123" }),
    });
    assert.equal(response.status, 409);
  });

  it("never returns the password hash", async () => {
    await makeKid();
    const list = await (await call("/family/kids", ownerToken)).text();
    assert.ok(!list.includes("passwordHash") && !list.includes("passwordSalt"));
  });
});

describe("a kid signing in", () => {
  it("works from the phone app and is refused anywhere else", async () => {
    await makeKid();
    assert.equal((await kidLogin()).status, 200);
    const web = await call("/kid/login", null, {
      method: "POST",
      body: JSON.stringify({ email: "rahul@example.com", password: "secret123" }),
    });
    assert.equal(web.status, 403);
  });

  it("locks for a while after five wrong passwords", async () => {
    await makeKid();
    for (let i = 0; i < 5; i += 1) assert.equal((await kidLogin("wrong-one")).status, 401);
    assert.equal((await kidLogin()).status, 429);
  });

  it("is signed out by a password reset", async () => {
    const kid = await makeKid();
    const token = await kidToken();
    assert.equal((await call("/kid/me", token)).status, 200);

    await call(`/family/kids/${kid.id}`, ownerToken, { method: "PATCH", body: JSON.stringify({ password: "newpass99" }) });
    assert.equal((await call("/kid/me", token)).status, 401);
    assert.equal((await kidLogin("newpass99")).status, 200);
  });
});

describe("what a kid can reach", () => {
  it("is refused by every owner route", async () => {
    await makeKid();
    const token = await kidToken();
    for (const path of ["/transactions/by-day", "/dashboard", "/accounts", "/auth/me", "/family/kids", "/contacts"]) {
      assert.equal((await call(path, token)).status, 403, path);
    }
  });

  it("sees only their own accounts' transactions", async () => {
    await makeKid();
    const token = await kidToken();
    const tx = (accountId: string, amount: number) =>
      models.Transaction.create({
        userId: ownerId,
        accountId: new Types.ObjectId(accountId),
        type: "DEBIT",
        amountMinor: amount,
        source: "SMS",
        occurredAt: new Date(),
      });
    await tx(pocketId, 120_00);
    await tx(otherPocketId, 999_00);
    await tx(mainAccountId, 5000_00);

    const body = await json<{ days: { transactions: { amountMinor: number }[] }[] }>(
      await call("/kid/transactions", token)
    );
    assert.deepEqual(body.days.flatMap((day) => day.transactions.map((t) => t.amountMinor)), [120_00]);

    assert.equal((await call(`/kid/transactions?accountId=${otherPocketId}`, token)).status, 404);
    const me = await json<{ accounts: { id: string; pocket: { spentMinor: number } }[] }>(await call("/kid/me", token));
    assert.deepEqual(me.accounts.map((account) => account.id), [pocketId]);
    assert.equal(me.accounts[0].pocket.spentMinor, 120_00);
  });

  it("adds and edits on their own account, marked as theirs; cannot touch another's", async () => {
    await makeKid();
    const token = await kidToken();

    const added = await call("/kid/transactions", token, {
      method: "POST",
      body: JSON.stringify({ accountId: pocketId, amountMinor: 50_00, merchant: "Canteen", occurredAt: new Date().toISOString() }),
    });
    assert.equal(added.status, 201);
    const row = await json<{ id: string; byKidName: string }>(added);
    assert.equal(row.byKidName, "Rahul");
    const stored = await models.Transaction.findById(row.id).orFail();
    assert.equal(stored.userId.toString(), ownerId.toString(), "the parent's money");

    const edited = await call(`/kid/transactions/${row.id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ amountMinor: 60_00 }),
    });
    assert.equal(edited.status, 200);

    const foreign = await models.Transaction.create({
      userId: ownerId,
      accountId: new Types.ObjectId(mainAccountId),
      type: "DEBIT",
      amountMinor: 100_00,
      source: "SMS",
      occurredAt: new Date(),
    });
    const tryForeign = await call(`/kid/transactions/${foreign.id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ amountMinor: 1_00 }),
    });
    assert.equal(tryForeign.status, 404);

    const toForeignAccount = await call("/kid/transactions", token, {
      method: "POST",
      body: JSON.stringify({ accountId: mainAccountId, amountMinor: 10_00, occurredAt: new Date().toISOString() }),
    });
    assert.equal(toForeignAccount.status, 400);
  });

  it("keeps their own shortcuts apart from the parent's", async () => {
    await makeKid();
    const token = await kidToken();
    await models.MerchantPreset.create({ userId: ownerId, merchant: "Parent's shop", useCount: 0 });
    await call("/kid/presets", token, { method: "POST", body: JSON.stringify({ merchant: "Canteen" }) });

    const presets = await json<{ merchant: string }[]>(await call("/kid/presets", token));
    assert.deepEqual(presets.map((preset) => preset.merchant), ["Canteen"]);
  });

  it("changes their own password and keeps this phone signed in", async () => {
    await makeKid();
    const token = await kidToken();
    const response = await call("/kid/password", token, {
      method: "POST",
      body: JSON.stringify({ currentPassword: "secret123", newPassword: "mine-now" }),
    });
    assert.equal(response.status, 200);
    const fresh = (await json<{ token: string }>(response)).token;
    assert.equal((await call("/kid/me", token)).status, 401, "the old session ends");
    assert.equal((await call("/kid/me", fresh)).status, 200);
  });

  it("says when the parent's phone can't be woken yet", async () => {
    await makeKid();
    const token = await kidToken();
    const result = await json<{ pinged: boolean; reason: string }>(
      await call("/kid/refresh", token, { method: "POST" })
    );
    assert.deepEqual(result, { pinged: false, reason: "not-configured" });
  });
});
