import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "reconnect-secret";

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let gmail: typeof import("./gmail.service");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_reconnect_test"));
  [models, gmail] = await Promise.all([import("../../models"), import("./gmail.service")]);
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Promise.all([models.EmailConnection.deleteMany({}), models.User.deleteMany({})]);
});

/** What google-auth-library throws when the refresh token is dead. */
const revoked = () => Object.assign(new Error("invalid_grant"), { response: { data: { error: "invalid_grant" } } });

async function connection() {
  const user = await models.User.create({ email: "g@example.com" });
  return models.EmailConnection.create({
    userId: user._id,
    email: "g@example.com",
    accessToken: "old",
    refreshToken: "dead",
  });
}

describe("a Gmail sign-in Google no longer accepts", () => {
  it("is flagged on the connection and reported as needing a reconnect", async () => {
    const saved = await connection();

    await assert.rejects(
      gmail.withGmail(saved, async () => {
        throw revoked();
      }),
      (error: unknown) => error instanceof gmail.GmailNeedsReconnectError && /Reconnect it in Settings/.test(error.message)
    );

    const stored = await models.EmailConnection.findById(saved._id).orFail();
    assert.equal(stored.needsReconnect, true);
  });

  it("passes any other failure through untouched", async () => {
    const saved = await connection();
    await assert.rejects(
      gmail.withGmail(saved, async () => {
        throw new Error("network down");
      }),
      /network down/
    );
    assert.equal((await models.EmailConnection.findById(saved._id).orFail()).needsReconnect, false);
  });

  it("is cleared by reconnecting", async () => {
    const saved = await connection();
    await models.EmailConnection.updateOne({ _id: saved._id }, { needsReconnect: true });

    await gmail.saveConnection({
      userId: saved.userId,
      email: saved.email,
      accessToken: "new",
      refreshToken: "fresh",
      expiryDate: null,
    });

    assert.equal((await models.EmailConnection.findById(saved._id).orFail()).needsReconnect, false);
  });

  it("is cleared by the next sync that works", async () => {
    const saved = await connection();
    await models.EmailConnection.updateOne({ _id: saved._id }, { needsReconnect: true });

    assert.equal(await gmail.withGmail(saved, async () => "fine"), "fine");
    assert.equal((await models.EmailConnection.findById(saved._id).orFail()).needsReconnect, false);
  });
});
