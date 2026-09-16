import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { VisionProvider } from "./perks.vision";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "perk-extract-secret";

let mongod: MongoMemoryServer;
let models: typeof import("../../models");
let extractPerk: typeof import("./perks.extract").extractPerk;
let parseModelJson: typeof import("./perks.extract").parseModelJson;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_perk_extract_test"));

  const [loaded, extract] = await Promise.all([import("../../models"), import("./perks.extract")]);
  models = loaded;
  extractPerk = extract.extractPerk;
  parseModelJson = extract.parseModelJson;
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

let userId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([models.Account.deleteMany({}), models.User.deleteMany({})]);
  const user = await models.User.create({ email: `p${(userCount += 1)}@example.com` });
  userId = user._id;
});

/** A model that says whatever the test needs it to say. */
function saying(answer: string): VisionProvider {
  return { name: "test-model", describe: async () => answer };
}

async function read(answer: string) {
  return extractPerk({
    userId,
    image: Buffer.from("not really a picture"),
    mimeType: "image/png",
    provider: saying(answer),
  });
}

describe("reading a coupon off a picture", () => {
  it("turns rupees into minor units", async () => {
    const draft = await read(
      JSON.stringify({
        kind: "COUPON",
        title: "Flat ₹200 off",
        merchants: ["Zomato"],
        flatAmount: 200,
        minSpend: 499,
        code: "EAT200",
        expiresOn: "2026-12-31",
      })
    );

    assert.equal(draft.flatMinor, 20000);
    assert.equal(draft.minSpendMinor, 49900);
  });

  it("keeps a percentage and its cap as one discount, not two", async () => {
    // The most common way this goes wrong: "20% off up to ₹150" read as a
    // 20% discount AND a flat ₹150 one, which would make the perk look
    // worth far more than it is.
    const draft = await read(
      JSON.stringify({
        kind: "COUPON",
        title: "20% off",
        percent: 20,
        maxDiscount: 150,
        flatAmount: 150,
        code: "SAVE20",
      })
    );

    assert.equal(draft.percent, 20);
    assert.equal(draft.maxDiscountMinor, 15000);
    assert.equal(draft.flatMinor, null, "the cap is not a second discount");
  });

  it("lowercases the merchants, because that is how they are matched", async () => {
    const draft = await read(JSON.stringify({ merchants: ["Blue Tokai", "ZEPTO", "  "] }));
    assert.deepEqual(draft.merchants, ["blue tokai", "zepto"]);
  });

  it("files an offer against the card it names", async () => {
    const card = await models.Account.create({
      userId,
      bankName: "ICICI Bank",
      nickname: "Amazon Pay ICICI",
      last4: "1377",
      accountType: "CARD",
    });

    const draft = await read(
      JSON.stringify({ kind: "CARD_OFFER", title: "5% back", card: "ICICI Amazon Pay" })
    );

    assert.equal(draft.accountId, card._id.toString());
    assert.equal(draft.kind, "CARD_OFFER");
  });

  it("will not file it against a card that is merely from the same bank", async () => {
    // Every word has to land. An offer on an HDFC Regalia is not an offer
    // on your other HDFC card, and filing it there would send you to a
    // till with the wrong one out.
    await models.Account.create({
      userId,
      bankName: "HDFC Bank",
      nickname: "HDFC Millennia",
      last4: "4821",
      accountType: "CARD",
    });

    const draft = await read(JSON.stringify({ kind: "CARD_OFFER", card: "HDFC Regalia" }));

    assert.equal(draft.accountId, null);
    assert.equal(draft.cardNamed, "HDFC Regalia", "still says what it read, so the screen can too");
  });

  it("is a coupon when it names no card, whatever it called itself", async () => {
    const draft = await read(JSON.stringify({ kind: "CARD_OFFER", title: "10% off", percent: 10 }));
    assert.equal(draft.kind, "COUPON", "the card is the whole difference between the two");
  });

  it("says which fields it could not find", async () => {
    const draft = await read(JSON.stringify({ title: "Something at Zepto", merchants: ["zepto"] }));

    assert.deepEqual(draft.missing.sort(), ["code", "discount", "expiresOn"]);
  });

  it("refuses a date it cannot be sure of", async () => {
    for (const bad of ["31/12/2026", "December 2026", "soon", "", null, 20261231]) {
      const draft = await read(JSON.stringify({ expiresOn: bad }));
      assert.equal(draft.expiresOn, null, String(bad));
    }

    assert.equal((await read(JSON.stringify({ expiresOn: "2026-12-31" }))).expiresOn, "2026-12-31");
  });

  it("ignores a percentage that is not one", async () => {
    for (const bad of [0, -5, 120, "twenty", null]) {
      assert.equal((await read(JSON.stringify({ percent: bad }))).percent, null, String(bad));
    }
  });

  it("gives up on an answer with no JSON in it", async () => {
    await assert.rejects(
      read("I am sorry, I cannot read this image."),
      /did not answer with JSON/
    );
  });
});

describe("finding the JSON in what a model actually says", () => {
  it("reads a bare object", () => {
    assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  });

  it("reads one inside a markdown fence", () => {
    // A small model does this however firmly it is asked not to, and
    // throwing away forty seconds of work over a fence would be a waste.
    assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  it("reads one after a sentence", () => {
    assert.deepEqual(parseModelJson('Here is the coupon:\n{"a":1}\nHope that helps.'), { a: 1 });
  });

  it("keeps nested objects whole", () => {
    assert.deepEqual(parseModelJson('{"a":{"b":2},"c":3}'), { a: { b: 2 }, c: 3 });
  });

  it("is not fooled by a brace inside a string", () => {
    assert.deepEqual(parseModelJson('{"code":"SAVE}20"}'), { code: "SAVE}20" });
    assert.deepEqual(parseModelJson('{"code":"SAVE\\"}\\"20"}'), { code: 'SAVE"}"20' });
  });

  it("gives back nothing rather than half an object", () => {
    assert.equal(parseModelJson('{"a":1'), null);
    assert.equal(parseModelJson("no json here at all"), null);
    assert.equal(parseModelJson('{"a": oops}'), null);
  });
});
