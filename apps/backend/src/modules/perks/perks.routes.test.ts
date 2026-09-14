import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "perks-test-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_perks_test"));

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
    models.Perk.deleteMany({}),
    models.Account.deleteMany({}),
    models.User.deleteMany({}),
    models.Transaction.deleteMany({}),
  ]);
});

let userCount = 0;

async function makeUser() {
  const email = `p${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

function call(path: string, token: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function makeCard(userId: Types.ObjectId, over: Record<string, unknown> = {}) {
  return models.Account.create({
    userId,
    bankName: "Example Bank",
    last4: String(1000 + userCount),
    accountType: "CARD",
    statementDay: 17,
    dueDay: 7,
    ...over,
  });
}

type Lookup = {
  query: string;
  verdict: string;
  matches: { id: string; title: string; kind: string; reach: string; card: { name: string } | null }[];
  floatAlternative: { name: string; floatDays: number } | null;
};

describe("keeping perks", () => {
  it("stores a coupon", async () => {
    const user = await makeUser();
    const response = await call("/perks", user.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "COUPON",
        title: "20% off",
        merchants: ["Gucci"],
        percent: 20,
        code: "GUCCI20",
        expiresOn: "2026-12-31",
      }),
    });

    assert.equal(response.status, 201);
    const perk = await json<{ id: string; merchants: string[] }>(response);
    // Folded once on the way in rather than at every comparison.
    assert.deepEqual(perk.merchants, ["gucci"]);
  });

  it("insists a card offer says which card", async () => {
    const user = await makeUser();
    const response = await call("/perks", user.token, {
      method: "POST",
      body: JSON.stringify({ kind: "CARD_OFFER", title: "5% back", percent: 5 }),
    });

    assert.equal(response.status, 400);
    assert.match((await json<{ error: string }>(response)).error, /which card/);
  });

  it("insists a perk is worth something", async () => {
    const user = await makeUser();
    const response = await call("/perks", user.token, {
      method: "POST",
      body: JSON.stringify({ kind: "COUPON", title: "Mystery", merchants: ["Zara"] }),
    });

    assert.equal(response.status, 400);
    assert.match((await json<{ error: string }>(response)).error, /what it is worth/);
  });

  it("refuses a perk against someone else's card", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const card = await makeCard(owner.id);

    const response = await call("/perks", stranger.token, {
      method: "POST",
      body: JSON.stringify({
        kind: "CARD_OFFER",
        title: "5% back",
        percent: 5,
        accountId: card._id.toString(),
      }),
    });
    assert.equal(response.status, 404);
  });

  it("marks a coupon used without throwing it away", async () => {
    // It is evidence of what a purchase actually cost.
    const user = await makeUser();
    const created = await json<{ id: string }>(
      await call("/perks", user.token, {
        method: "POST",
        body: JSON.stringify({ kind: "COUPON", title: "₹500 off", merchants: ["Zara"], flatMinor: 50000 }),
      })
    );

    const used = await json<{ usedAt: string | null }>(
      await call(`/perks/${created.id}/used`, user.token, { method: "POST" })
    );
    assert.ok(used.usedAt);

    const back = await json<{ usedAt: string | null }>(
      await call(`/perks/${created.id}/used`, user.token, {
        method: "POST",
        body: JSON.stringify({ used: false }),
      })
    );
    assert.equal(back.usedAt, null);
  });

  it("keeps one person's perks away from another's", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    await models.Perk.create({
      userId: owner.id,
      kind: "COUPON",
      title: "20% off",
      merchants: ["gucci"],
      percent: 20,
    });

    assert.deepEqual(await json<unknown[]>(await call("/perks", stranger.token)), []);
    const lookup = await json<Lookup>(await call("/perks/lookup?q=gucci", stranger.token));
    assert.equal(lookup.matches.length, 0);
  });
});

describe("asking what I have here", () => {
  it("answers the way a person asks", async () => {
    const user = await makeUser();
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "20% off",
      merchants: ["gucci"],
      percent: 20,
      code: "GUCCI20",
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=I%27m%20at%20Gucci", user.token));
    assert.equal(lookup.query, "gucci");
    assert.equal(lookup.matches.length, 1);
    assert.match(lookup.verdict, /1 coupon at gucci/);
  });

  it("leads with the offer and names the float card underneath", async () => {
    // Settled: money back is certain, float is timing. Both in view.
    const user = await makeUser();
    // Different due days as well as statement days, so the two genuinely
    // differ on float rather than landing on the same date by accident.
    const offerCard = await makeCard(user.id, {
      nickname: "Tata Neu",
      statementDay: 4,
      dueDay: 7,
      last4: "1111",
    });
    await makeCard(user.id, { nickname: "Amazon Pay", statementDay: 28, dueDay: 20, last4: "2222" });

    await models.Perk.create({
      userId: user.id,
      kind: "CARD_OFFER",
      title: "5% back",
      merchants: ["croma"],
      percent: 5,
      accountId: offerCard._id,
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=Croma", user.token));
    assert.equal(lookup.matches[0].card?.name, "Tata Neu");
    assert.match(lookup.verdict, /Best: 5% back on Tata Neu/);
    assert.ok(lookup.floatAlternative, "the other card is still worth naming");
  });

  it("does not name the float card twice when it is the same one", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id, { nickname: "Only Card", statementDay: 17 });
    await models.Perk.create({
      userId: user.id,
      kind: "CARD_OFFER",
      title: "5% back",
      merchants: ["croma"],
      percent: 5,
      accountId: card._id,
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=Croma", user.token));
    assert.equal(lookup.floatAlternative, null, "two pieces of advice naming one card reads as noise");
  });

  it("still suggests a card when there is no offer at all", async () => {
    const user = await makeUser();
    await makeCard(user.id, { nickname: "Amazon Pay", statementDay: 28 });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=Gucci", user.token));
    assert.equal(lookup.matches.length, 0);
    assert.match(lookup.verdict, /Nothing saved at gucci/);
    assert.match(lookup.verdict, /longest to pay/);
  });

  it("never offers something that cannot be used", async () => {
    const user = await makeUser();
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "Expired",
      merchants: ["gucci"],
      percent: 20,
      expiresOn: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "Spent",
      merchants: ["gucci"],
      percent: 20,
      usedAt: new Date(),
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=gucci", user.token));
    assert.equal(lookup.matches.length, 0, "being sent to hand over a dead code is the worst answer here");
  });

  it("puts the coupon for this shop above a standing offer for everything", async () => {
    const user = await makeUser();
    const card = await makeCard(user.id);
    await models.Perk.create({
      userId: user.id,
      kind: "CARD_OFFER",
      title: "2% on everything",
      merchants: [],
      percent: 2,
      accountId: card._id,
    });
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "20% off",
      merchants: ["gucci"],
      percent: 20,
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=gucci", user.token));
    assert.deepEqual(
      lookup.matches.map((match) => match.reach),
      ["MERCHANT", "ANYWHERE"]
    );
  });

  it("turns a percentage into a figure once there is an amount", async () => {
    const user = await makeUser();
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "5% off",
      merchants: ["croma"],
      percent: 5,
      maxDiscountMinor: 50000,
    });

    const without = await json<{ matches: { valueMinor: number | null }[] }>(
      await call("/perks/lookup?q=croma", user.token)
    );
    assert.equal(without.matches[0].valueMinor, null, "nothing to apply it to yet");

    const with90k = await json<{ matches: { valueMinor: number | null }[] }>(
      await call("/perks/lookup?q=croma&amountMinor=900000", user.token)
    );
    assert.equal(with90k.matches[0].valueMinor, 45000);
  });

  it("finds a coupon saved in the plural", async () => {
    // Reported: a coupon added for flights, searched for as "flight".
    const user = await makeUser();
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "15% off",
      merchants: ["flights"],
      percent: 15,
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=flight", user.token));
    assert.equal(lookup.matches.length, 1);
  });

  it("finds a coupon by one word of a longer saved name", async () => {
    const user = await makeUser();
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "15% off",
      merchants: ["makemytrip flights"],
      percent: 15,
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=flight", user.token));
    assert.equal(lookup.matches.length, 1);
  });

  it("survives what autocorrect does to a brand it has never heard of", async () => {
    // Reported: typing "wrogn" is corrected to "wrong" on the way in.
    const user = await makeUser();
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "₹500 off",
      merchants: ["wrogn"],
      flatMinor: 50000,
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=wrong", user.token));
    assert.equal(lookup.matches.length, 1);
  });

  it("answers with the shop that was named before one that shares a word", async () => {
    const user = await makeUser();
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "Loose",
      merchants: ["blue tokai coffee"],
      percent: 5,
    });
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "Square",
      merchants: ["coffee"],
      percent: 5,
    });

    const lookup = await json<Lookup>(await call("/perks/lookup?q=coffee", user.token));
    assert.deepEqual(lookup.matches.map((match) => match.title), ["Square", "Loose"]);
  });

  it("wants something to look for", async () => {
    const user = await makeUser();
    assert.equal((await call("/perks/lookup", user.token)).status, 400);
  });

  it("turns nobody away without a token", async () => {
    assert.equal((await fetch(`${baseUrl}/perks`)).status, 401);
  });
});

describe("the dashboard", () => {
  it("draws the whole landing screen in one request", async () => {
    const user = await makeUser();
    await makeCard(user.id, { nickname: "Amazon Pay", cardNetwork: "rupay", statementDay: 28 });

    const body = await json<{
      today: string;
      picks: { best: { name: string } | null; byNetwork: { network: string }[] };
      needsCategory: { yesterday: number; month: number };
      monthSoFar: { spentMinor: number };
      expiringPerks: unknown[];
    }>(await call("/dashboard", user.token));

    assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.picks.best?.name, "Amazon Pay");
    assert.deepEqual(body.picks.byNetwork.map((row) => row.network), ["RUPAY"]);
    assert.deepEqual(body.needsCategory, { yesterday: 0, month: 0 });
    assert.equal(body.monthSoFar.spentMinor, 0);
    assert.deepEqual(body.expiringPerks, []);
  });

  it("names the best card on each network", async () => {
    const user = await makeUser();
    // Later statement day means longer before a payment has to be paid for.
    await makeCard(user.id, { nickname: "ICICI RuPay", cardNetwork: "RuPay", statementDay: 28, last4: "1111" });
    await makeCard(user.id, { nickname: "HDFC Visa", cardNetwork: "visa", statementDay: 3, last4: "2222" });
    await makeCard(user.id, { nickname: "Old RuPay", cardNetwork: "RUPAY", statementDay: 2, last4: "3333" });

    const picks = await json<{
      best: { name: string };
      byNetwork: { network: string; card: { name: string } }[];
    }>(await call("/cards/pick", user.token));

    const byNetwork = Object.fromEntries(picks.byNetwork.map((row) => [row.network, row.card.name]));
    assert.equal(byNetwork.RUPAY, "ICICI RuPay", "the better of the two RuPay cards");
    assert.equal(byNetwork.VISA, "HDFC Visa");
    assert.equal(picks.best.name, "ICICI RuPay");
  });

  it("shows a coupon about to lapse", async () => {
    const user = await makeUser();
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "20% off",
      merchants: ["gucci"],
      percent: 20,
      expiresOn: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    });
    await models.Perk.create({
      userId: user.id,
      kind: "COUPON",
      title: "Months away",
      merchants: ["zara"],
      percent: 10,
      expiresOn: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });

    const body = await json<{ expiringPerks: { title: string; daysLeft: number }[] }>(
      await call("/dashboard", user.token)
    );
    assert.equal(body.expiringPerks.length, 1, "only what is close enough to act on");
    assert.equal(body.expiringPerks[0].title, "20% off");
    assert.equal(body.expiringPerks[0].daysLeft, 3);
  });

  it("counts what people owe the user, not the other way round", async () => {
    // A bill paid whole for three, then one of them paying their share
    // back. This read as money the user *owed* while the lent side summed
    // a field that was never on the schema.
    const user = await makeUser();
    await models.Transaction.create({
      userId: user.id,
      amountMinor: 1200000,
      type: "DEBIT",
      source: "MANUAL",
      occurredAt: new Date(),
      split: { myShareMinor: 400000 },
    });
    await models.Transaction.create({
      userId: user.id,
      amountMinor: 400000,
      type: "CREDIT",
      source: "MANUAL",
      occurredAt: new Date(),
      isSettlement: true,
    });

    const body = await json<{ owed: { balanceMinor: number } }>(await call("/dashboard", user.token));
    // 8,000 lent, 4,000 of it back: 4,000 still owed to the user.
    assert.equal(body.owed.balanceMinor, 400000);
  });

  it("turns nobody away without a token", async () => {
    assert.equal((await fetch(`${baseUrl}/dashboard`)).status, 401);
  });
});
