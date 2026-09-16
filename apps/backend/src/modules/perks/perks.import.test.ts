import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "perk-import-secret";

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let createImport: typeof import("./perks.import").createImport;
let runImport: typeof import("./perks.import").runImport;
let failStalledImports: typeof import("./perks.import").failStalledImports;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_perk_import_test"));

  const [loaded, mod] = await Promise.all([
    import("../../models"),
    import("./perks.import"),
  ]);
  models = loaded;
  createImport = mod.createImport;
  runImport = mod.runImport;
  failStalledImports = mod.failStalledImports;
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let userId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Perk.deleteMany({}),
    models.PerkImport.deleteMany({}),
    models.User.deleteMany({}),
  ]);
  const user = await models.User.create({
    email: `i${(userCount += 1)}@example.com`,
  });
  userId = user._id;
});

/** Stands in for the model, answering differently for each picture. */
function modelSaying(
  answers: string[],
): import("./perks.vision").VisionProvider {
  let index = 0;

  return {
    name: "test-model",
    describe: async () => {
      const answer = answers[index] ?? answers[answers.length - 1];
      index += 1;
      if (answer === "THROW")
        throw new Error("That picture could not be read.");
      return answer;
    },
  };
}

function pictures(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    fileName: `coupon-${index}.jpg`,
    bytes: Buffer.from(`picture ${index}`),
  }));
}

const coupon = (code: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "COUPON",
    title: `Off at Zomato`,
    merchants: ["zomato"],
    percent: 20,
    code,
    ...extra,
  });

describe("reading a pile of screenshots", () => {
  it("turns every one into a perk", async () => {
    const model = modelSaying([coupon("A1"), coupon("B2"), coupon("C3")]);
    const job = await createImport(userId, pictures(3));
    await runImport(job._id, model);

    const perks = await models.Perk.find({ userId }).sort({ code: 1 });
    assert.deepEqual(
      perks.map((perk) => perk.code),
      ["A1", "B2", "C3"],
    );
  });

  it("marks them as nobody having looked yet", async () => {
    const model = modelSaying([coupon("A1")]);
    const job = await createImport(userId, pictures(1));
    await runImport(job._id, model);

    const perk = await models.Perk.findOne({ userId }).orFail();
    assert.equal(
      perk.needsReview,
      true,
      "a real perk, and one whose figures a machine read",
    );
    assert.equal(
      perk.isActive,
      true,
      "it counts meanwhile - it shows, and it answers a lookup",
    );
  });

  it("does not store the same coupon twice", async () => {
    // The ordinary way a batch goes wrong: a folder picked twice, or two
    // selections that overlap. Twenty coupons becoming forty is worse than
    // missing one.
    const model = modelSaying([coupon("SAVE20"), coupon("SAVE20")]);
    const job = await createImport(userId, pictures(2));
    await runImport(job._id, model);

    assert.equal(await models.Perk.countDocuments({ userId }), 1);

    const done = await models.PerkImport.findById(job._id).orFail();
    assert.equal(done.items.filter((item) => item.perkId).length, 1);
    assert.equal(
      done.items.filter((item) => item.status === "DONE" && !item.perkId)
        .length,
      1,
      "the second is done rather than failed - there was nothing wrong with it",
    );
  });

  it("carries on past one it cannot read", async () => {
    const model = modelSaying([coupon("A1"), "THROW", coupon("C3")]);
    const job = await createImport(userId, pictures(3));
    await runImport(job._id, model);

    assert.equal(
      await models.Perk.countDocuments({ userId }),
      2,
      "the other two still landed",
    );

    const done = await models.PerkImport.findById(job._id).orFail();
    assert.equal(done.status, "DONE");

    const failed = done.items.filter((item) => item.status === "FAILED");
    assert.equal(failed.length, 1);
    assert.equal(
      failed[0].fileName,
      "coupon-1.jpg",
      "and says which picture it was",
    );
  });

  it("names a coupon that arrived without a name", async () => {
    const model = modelSaying([
      JSON.stringify({
        kind: "COUPON",
        code: "NAMELESS",
        merchants: ["zepto"],
        percent: 10,
      }),
    ]);
    const job = await createImport(userId, pictures(1));
    await runImport(job._id, model);

    const perk = await models.Perk.findOne({ userId }).orFail();
    assert.equal(perk.title, "NAMELESS", "its code beats refusing to store it");
  });

  it("writes down what it could not read, where it will be seen", async () => {
    const model = modelSaying([
      JSON.stringify({
        kind: "CARD_OFFER",
        title: "5% back",
        percent: 5,
        card: "HDFC Regalia",
      }),
    ]);
    const job = await createImport(userId, pictures(1));
    await runImport(job._id, model);

    const perk = await models.Perk.findOne({ userId }).orFail();
    assert.match(
      perk.notes ?? "",
      /HDFC Regalia, which is not one of your cards/,
    );
    assert.match(perk.notes ?? "", /Could not read:/);
  });

  it("gives up on the whole job when there is no model at all", async () => {
    const job = await createImport(userId, pictures(2));
    await runImport(job._id, null);

    const done = await models.PerkImport.findById(job._id).orFail();
    assert.equal(done.status, "FAILED");
    assert.match(done.problem ?? "", /No vision model/);
    assert.equal(await models.Perk.countDocuments({ userId }), 0);
  });
});

describe("a job the server restarted on top of", () => {
  it("is failed rather than left running for ever", async () => {
    // Its pictures were in a temporary directory a reboot may have
    // emptied, and a client would poll a RUNNING job until it gave up.
    const job = await createImport(userId, pictures(2));
    job.status = "RUNNING";
    job.items[0].status = "DONE";
    job.items[1].status = "RUNNING";
    await job.save();

    await failStalledImports();

    const after = await models.PerkImport.findById(job._id).orFail();
    assert.equal(after.status, "FAILED");
    assert.match(after.problem ?? "", /restarted/);
    assert.equal(after.items[0].status, "DONE", "what finished, finished");
    assert.equal(after.items[1].status, "FAILED");
  });
});
