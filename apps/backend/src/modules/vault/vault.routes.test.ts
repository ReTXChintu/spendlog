import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "vault-secret";
process.env.STATEMENT_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_vault_test"));

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

let token: string;
let userId: Types.ObjectId;
let accountId: Types.ObjectId;

let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.CardVault.deleteMany({}),
    models.Account.deleteMany({}),
    models.User.deleteMany({}),
  ]);

  const email = `v${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });

  const account = await models.Account.create({
    userId,
    bankName: "Example Bank",
    last4: null,
    accountType: "CARD",
  });
  accountId = account._id;
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

const body = (value: unknown) => ({ body: JSON.stringify(value) });

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

type Err = { error: string };

const CARD = {
  number: "5252 2525 2525 6623",
  expiry: "08/29",
  nameOnCard: "BISWAJIT PANDA",
  note: "The one for groceries",
};

async function setPin(pin = "4321") {
  const response = await call("/vault/pin", { method: "PUT", ...body({ pin }) });
  assert.equal(response.status, 200);
}

async function store(pin = "4321") {
  return call(`/vault/cards/${accountId}`, { method: "PUT", ...body({ pin, ...CARD }) });
}

describe("the card vault", () => {
  it("will not store anything until a PIN is set", async () => {
    const response = await store();
    assert.equal(response.status, 400);
    assert.match((await json<Err>(response)).error, /Set a PIN/);
  });

  it("insists a PIN is four to six digits", async () => {
    for (const pin of ["123", "1234567", "abcd", "12 34"]) {
      const response = await call("/vault/pin", { method: "PUT", ...body({ pin }) });
      assert.equal(response.status, 400, pin);
    }
  });

  it("gives the details back to the right PIN, and only in the clear then", async () => {
    await setPin();
    assert.equal((await store()).status, 200);

    const response = await call(`/vault/cards/${accountId}/reveal`, {
      method: "POST",
      ...body({ pin: "4321" }),
    });
    assert.equal(response.status, 200);

    const revealed = await json<Record<string, string>>(response);
    // Stored with the spacing typed and given back as digits.
    assert.equal(revealed.number, "5252252525256623");
    assert.equal(revealed.expiry, "08/29");
    assert.equal(revealed.nameOnCard, "BISWAJIT PANDA");
    assert.equal(revealed.note, "The one for groceries");
  });

  it("keeps nothing readable in the database", async () => {
    await setPin();
    await store();

    const raw = await mongoose.connection.collection("cardvaults").findOne({ userId });
    assert.ok(raw);
    assert.ok(!JSON.stringify(raw).includes("5252252525256623"), "the number is not in there");
    assert.ok(!JSON.stringify(raw).includes("BISWAJIT"), "nor the name");
    assert.equal(raw.last4, "6623", "only the last four, which the account shows anyway");
  });

  it("never lists anything but the last four", async () => {
    await setPin();
    await store();

    const listed = await json<Record<string, unknown>[]>(await call("/vault/cards"));
    assert.deepEqual(Object.keys(listed[0]).sort(), ["accountId", "last4", "updatedAt"]);
  });

  it("refuses a CVV rather than quietly dropping it", async () => {
    await setPin();
    const response = await call(`/vault/cards/${accountId}`, {
      method: "PUT",
      ...body({ pin: "4321", ...CARD, cvv: "123" }),
    });

    assert.equal(response.status, 400);
    assert.match((await json<Err>(response)).error, /does not store a CVV/);
  });

  it("turns away a wrong PIN, and says how many tries are left", async () => {
    await setPin();
    await store();

    const response = await call(`/vault/cards/${accountId}/reveal`, {
      method: "POST",
      ...body({ pin: "0000" }),
    });
    assert.equal(response.status, 403);
    assert.match((await json<Err>(response)).error, /4 attempts left/);
  });

  it("stops accepting any PIN after five wrong ones", async () => {
    await setPin();
    await store();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await call(`/vault/cards/${accountId}/reveal`, { method: "POST", ...body({ pin: "0000" }) });
    }

    // Including the right one. That is the point of a lockout.
    const response = await call(`/vault/cards/${accountId}/reveal`, {
      method: "POST",
      ...body({ pin: "4321" }),
    });
    assert.equal(response.status, 429);
    assert.match((await json<Err>(response)).error, /Too many wrong PINs/);
  });

  it("forgets the wrong answers as soon as one is right", async () => {
    await setPin();
    await store();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await call(`/vault/cards/${accountId}/reveal`, { method: "POST", ...body({ pin: "0000" }) });
    }
    assert.equal(
      (await call(`/vault/cards/${accountId}/reveal`, { method: "POST", ...body({ pin: "4321" }) }))
        .status,
      200
    );

    const status = await json<{ attemptsLeft: number }>(await call("/vault"));
    assert.equal(status.attemptsLeft, 5);
  });

  it("needs the current PIN to change one", async () => {
    await setPin();

    const wrong = await call("/vault/pin", { method: "PUT", ...body({ pin: "1111", currentPin: "9999" }) });
    assert.equal(wrong.status, 403);

    const right = await call("/vault/pin", { method: "PUT", ...body({ pin: "1111", currentPin: "4321" }) });
    assert.equal(right.status, 200);
  });

  it("says plainly that resetting the PIN takes the details with it", async () => {
    await setPin();
    await store();

    const unconfirmed = await call("/vault/pin", { method: "DELETE", ...body({}) });
    assert.equal(unconfirmed.status, 400);
    assert.equal(await models.CardVault.countDocuments({ userId }), 1, "and did nothing");

    const done = await call("/vault/pin", {
      method: "DELETE",
      ...body({ confirm: "forget my card details" }),
    });
    assert.equal(done.status, 200);
    assert.equal((await json<{ detailsDeleted: number }>(done)).detailsDeleted, 1);
    assert.equal(await models.CardVault.countDocuments({ userId }), 0);
  });

  it("teaches the account its own last four", async () => {
    await setPin();
    await store();

    const account = await models.Account.findById(accountId);
    assert.equal(account?.last4, "6623", "a card added by hand often has none until this");
  });

  it("never returns the PIN hash with the user", async () => {
    await setPin();

    const user = await models.User.findById(userId);
    const serialised = JSON.parse(JSON.stringify(user));

    assert.equal(serialised.vaultPin, undefined);
    assert.equal(serialised.hasVaultPin, true);
  });

  it("shows one person nothing of another's", async () => {
    await setPin();
    await store();

    const stranger = await models.User.create({ email: "stranger@example.com" });
    token = signToken({ id: stranger._id.toString(), email: "stranger@example.com" });

    const listed = await json<unknown[]>(await call("/vault/cards"));
    assert.deepEqual(listed, []);

    // Even knowing the account id, and even with a PIN of their own.
    await call("/vault/pin", { method: "PUT", ...body({ pin: "4321" }) });
    const response = await call(`/vault/cards/${accountId}/reveal`, {
      method: "POST",
      ...body({ pin: "4321" }),
    });
    assert.equal(response.status, 404);
  });
});
