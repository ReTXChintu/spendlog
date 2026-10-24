import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { User } from "../../models";
import { MAX_DEVICES, collapseDuplicateTokens, distinctTokens, registerDevice } from "./family.devices";

let mongod: MongoMemoryServer;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_devices_test"));
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await User.deleteMany({});
});

const TOKEN = "fcm-token-aaaaaaaaaaaaaaaaaaaaaaaa";

async function tokensOf(id: mongoose.Types.ObjectId) {
  return (await User.findById(id).select("fcmTokens").lean())?.fcmTokens ?? [];
}

describe("a phone's push token", () => {
  it("is kept once when the app registers it twice at the same moment", async () => {
    const user = await User.create({ email: "a@example.com", name: "A" });
    await Promise.all([registerDevice(user._id, TOKEN), registerDevice(user._id, TOKEN), registerDevice(user._id, TOKEN)]);
    assert.deepEqual((await tokensOf(user._id)).map((entry) => entry.token), [TOKEN]);
  });

  it("moves to newest when registered again, and only the newest few are kept", async () => {
    const user = await User.create({ email: "b@example.com", name: "B" });
    for (let i = 0; i < MAX_DEVICES + 2; i += 1) await registerDevice(user._id, `token-${i}-xxxxxxxxxxxxxxxxxxxx`);
    await registerDevice(user._id, "token-3-xxxxxxxxxxxxxxxxxxxx");
    const tokens = (await tokensOf(user._id)).map((entry) => entry.token);
    assert.equal(tokens.length, MAX_DEVICES);
    assert.equal(tokens.at(-1), "token-3-xxxxxxxxxxxxxxxxxxxx");
    assert.equal(new Set(tokens).size, tokens.length);
  });

  it("is sent to once even if it was stored twice", () => {
    assert.deepEqual(distinctTokens([{ token: TOKEN }, { token: TOKEN }, { token: "other" }]), [TOKEN, "other"]);
    assert.deepEqual(distinctTokens(undefined), []);
  });

  it("stored twice by the old registration is collapsed to its newest copy", async () => {
    const older = new Date("2026-10-24T17:07:38.100Z");
    const newer = new Date("2026-10-24T17:07:38.102Z");
    const user = await User.create({
      email: "c@example.com",
      name: "C",
      fcmTokens: [
        { token: TOKEN, updatedAt: older },
        { token: "phone-2", updatedAt: older },
        { token: TOKEN, updatedAt: newer },
      ],
    });
    assert.equal(await collapseDuplicateTokens(user._id), 1);
    const tokens = await tokensOf(user._id);
    assert.deepEqual(tokens.map((entry) => entry.token), ["phone-2", TOKEN]);
    assert.deepEqual(new Date(tokens[1].updatedAt), newer);
    assert.equal(await collapseDuplicateTokens(user._id), 0);
  });
});
