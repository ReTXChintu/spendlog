import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "presets-test-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_presets_test"));

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
  await Promise.all([
    models.MerchantPreset.deleteMany({}),
    models.Category.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser() {
  const email = `u${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, name: `User ${userCount}` });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

function call(path: string, token: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

type Preset = { id: string; merchant: string; categoryId: string | null; useCount: number };

describe("merchant presets", () => {
  it("saves a merchant with the category that goes with it", async () => {
    const user = await makeUser();
    const food = await models.Category.create({ name: "Food", isSystem: true });

    const created = await json<Preset>(
      await call("/merchant-presets", user.token, {
        method: "POST",
        body: JSON.stringify({ merchant: "Chai stall", categoryId: food._id.toString() }),
      })
    );

    assert.equal(created.merchant, "Chai stall");
    assert.equal(created.categoryId, food._id.toString());
  });

  it("saves one without a category, for the typing alone", async () => {
    const user = await makeUser();

    const response = await call("/merchant-presets", user.token, {
      method: "POST",
      body: JSON.stringify({ merchant: "Auto rickshaw" }),
    });

    assert.equal(response.status, 201);
  });

  it("updates the category rather than refusing a merchant already saved", async () => {
    // From the form this reads as "use this one from now on".
    const user = await makeUser();
    const [food, travel] = await Promise.all([
      models.Category.create({ name: "Food", isSystem: true }),
      models.Category.create({ name: "Travel", isSystem: true }),
    ]);

    const body = (categoryId: Types.ObjectId) =>
      JSON.stringify({ merchant: "Chai stall", categoryId: categoryId.toString() });

    await call("/merchant-presets", user.token, { method: "POST", body: body(food._id) });
    await call("/merchant-presets", user.token, { method: "POST", body: body(travel._id) });

    const presets = await json<Preset[]>(await call("/merchant-presets", user.token));
    assert.equal(presets.length, 1);
    assert.equal(presets[0].categoryId, travel._id.toString());
  });

  it("trims the name, so two spellings are not two presets", async () => {
    const user = await makeUser();

    for (const merchant of ["Chai stall", "  Chai stall  "]) {
      await call("/merchant-presets", user.token, {
        method: "POST",
        body: JSON.stringify({ merchant }),
      });
    }

    const presets = await json<Preset[]>(await call("/merchant-presets", user.token));
    assert.equal(presets.length, 1);
  });

  it("refuses a category that is not the user's to use", async () => {
    const [user, other] = await Promise.all([makeUser(), makeUser()]);
    const theirs = await models.Category.create({ userId: other.id, name: "Private" });

    const response = await call("/merchant-presets", user.token, {
      method: "POST",
      body: JSON.stringify({ merchant: "Chai stall", categoryId: theirs._id.toString() }),
    });

    assert.equal(response.status, 400);
  });

  it("puts the ones reached for most at the front", async () => {
    const user = await makeUser();

    for (const merchant of ["Rarely", "Often", "Sometimes"]) {
      await call("/merchant-presets", user.token, {
        method: "POST",
        body: JSON.stringify({ merchant }),
      });
    }

    const initial = await json<Preset[]>(await call("/merchant-presets", user.token));
    const often = initial.find((p) => p.merchant === "Often")!;
    const sometimes = initial.find((p) => p.merchant === "Sometimes")!;

    for (let i = 0; i < 5; i += 1) {
      await call(`/merchant-presets/${often.id}/used`, user.token, { method: "POST" });
    }
    await call(`/merchant-presets/${sometimes.id}/used`, user.token, { method: "POST" });

    const sorted = await json<Preset[]>(await call("/merchant-presets", user.token));
    assert.deepEqual(
      sorted.map((p) => p.merchant),
      ["Often", "Sometimes", "Rarely"]
    );
  });

  it("deletes one", async () => {
    const user = await makeUser();
    const created = await json<Preset>(
      await call("/merchant-presets", user.token, {
        method: "POST",
        body: JSON.stringify({ merchant: "Chai stall" }),
      })
    );

    assert.equal(
      (await call(`/merchant-presets/${created.id}`, user.token, { method: "DELETE" })).status,
      204
    );
    assert.deepEqual(await json<Preset[]>(await call("/merchant-presets", user.token)), []);
  });

  it("keeps one person's presets out of another's", async () => {
    const [user, other] = await Promise.all([makeUser(), makeUser()]);
    await call("/merchant-presets", user.token, {
      method: "POST",
      body: JSON.stringify({ merchant: "Chai stall" }),
    });

    assert.deepEqual(await json<Preset[]>(await call("/merchant-presets", other.token)), []);
  });

  it("will not let anyone delete somebody else's", async () => {
    const [user, other] = await Promise.all([makeUser(), makeUser()]);
    const created = await json<Preset>(
      await call("/merchant-presets", user.token, {
        method: "POST",
        body: JSON.stringify({ merchant: "Chai stall" }),
      })
    );

    const response = await call(`/merchant-presets/${created.id}`, other.token, {
      method: "DELETE",
    });
    assert.equal(response.status, 404);
  });

  it("lets two people each have the same merchant", async () => {
    const [user, other] = await Promise.all([makeUser(), makeUser()]);
    const body = JSON.stringify({ merchant: "Chai stall" });

    await call("/merchant-presets", user.token, { method: "POST", body });
    const second = await call("/merchant-presets", other.token, { method: "POST", body });

    assert.equal(second.status, 201, "the uniqueness is per person, not global");
  });
});
