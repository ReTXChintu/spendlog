import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "card-available-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let status: typeof import("./cards.status");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_card_available_test"));

  const [{ app }, auth, loadedModels, loadedStatus] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./cards.status"),
  ]);
  signToken = auth.signSessionToken;
  models = loadedModels;
  status = loadedStatus;

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
let bankId: Types.ObjectId;
let userCount = 0;

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.CardStatement.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
  ]);
  const email = `a${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, salaryDay: 1 });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  bankId = (await models.Account.create({ userId, bankName: "HDFC Bank", last4: "4821", accountType: "BANK" }))._id;
});

/** An IST calendar day, as an instant at noon so no boundary is grazed. */
function on(day: string, time = "12:00:00"): Date {
  return new Date(`${day}T${time}+05:30`);
}

const TODAY = on("2026-10-10");

function card(fields: Record<string, unknown>) {
  return models.Account.create({ userId, bankName: "HDFC", accountType: "CARD", ...fields });
}

function charge(accountId: Types.ObjectId, day: string, rupees: number, extra: Record<string, unknown> = {}) {
  return models.Transaction.create({
    userId,
    accountId,
    type: "DEBIT",
    amountMinor: rupees * 100,
    occurredAt: on(day),
    source: "MANUAL",
    ...extra,
  });
}

function refund(accountId: Types.ObjectId, day: string, rupees: number) {
  return charge(accountId, day, rupees, { type: "CREDIT" });
}

/** A bill paid from the bank account, marked as paying the card. */
function pay(cardId: Types.ObjectId, day: string, rupees: number, extra: Record<string, unknown> = {}) {
  return charge(bankId, day, rupees, { cardPaymentFor: cardId, ...extra });
}

async function statusOf(accountId: Types.ObjectId, now = TODAY) {
  const all = await status.cardStatuses(userId, now);
  return all.find((row) => row.accountId === accountId.toString())!;
}

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

function patch(id: Types.ObjectId | string, body: Record<string, unknown>) {
  return call(`/accounts/${id.toString()}`, { method: "PATCH", body: JSON.stringify(body) });
}

describe("a limit left, typed in off the bank's app", () => {
  it("carries the figure forward: purchases take away, refunds and bill payments give back", async () => {
    const hdfc = await card({ last4: "1111", statementDay: 1, creditLimitMinor: 100_000_00 });
    await charge(hdfc._id, "2026-10-04", 9000); // before the figure: already in it

    const res = await patch(hdfc._id, { availableLimitMinor: 40_000_00, availableLimitAt: on("2026-10-05").toISOString() });
    assert.equal(res.status, 200);

    await charge(hdfc._id, "2026-10-06", 2000);
    await refund(hdfc._id, "2026-10-07", 500);
    await pay(hdfc._id, "2026-10-08", 1000);

    const row = await statusOf(hdfc._id);
    assert.equal(row.availableSource, "you");
    assert.equal(row.availableAsOf?.getTime(), on("2026-10-05").getTime());
    assert.equal(row.availableLimitAnchorMinor, 40_000_00);
    assert.equal(row.chargedSinceAnchorMinor, 1500_00);
    assert.equal(row.paidSinceAnchorMinor, 1000_00);
    assert.equal(row.availableMinor, 39_500_00);
    // What is owed is the limit less what the bank says is left - counting
    // the purchases SpendLog never saw - and it is no longer an estimate.
    assert.equal(row.outstandingMinor, 60_500_00);
    assert.equal(row.usedMinor, 60_500_00);
    assert.equal(row.outstandingIsEstimate, false);
    // 60.5% of the limit.
    assert.equal(row.state, "ok");
  });

  it("is as of now when no moment is given", async () => {
    const hdfc = await card({ last4: "1112", statementDay: 1, creditLimitMinor: 100_000_00 });
    const before = Date.now();
    assert.equal((await patch(hdfc._id, { availableLimitMinor: 20_000_00 })).status, 200);

    const saved = await models.Account.findById(hdfc._id);
    assert.equal(saved?.availableLimitMinor, 20_000_00);
    assert.ok(saved!.availableLimitAt!.getTime() >= before);
  });

  it("can be cleared, and then the card is added up from its rows again", async () => {
    const hdfc = await card({ last4: "1113", statementDay: 1, creditLimitMinor: 100_000_00 });
    await charge(hdfc._id, "2026-10-06", 3000);
    await patch(hdfc._id, { availableLimitMinor: 10_000_00, availableLimitAt: on("2026-10-05").toISOString() });
    assert.equal((await statusOf(hdfc._id)).availableMinor, 7000_00);

    assert.equal((await patch(hdfc._id, { availableLimitMinor: null })).status, 200);
    const saved = await models.Account.findById(hdfc._id);
    assert.equal(saved?.availableLimitMinor, null);
    assert.equal(saved?.availableLimitAt, null);

    const row = await statusOf(hdfc._id);
    assert.equal(row.availableSource, "computed");
    assert.equal(row.availableAsOf, null);
    assert.equal(row.availableMinor, 97_000_00);
  });

  it("is refused on anything but a credit card, though clearing is harmless", async () => {
    const refused = await patch(bankId, { availableLimitMinor: 5000_00 });
    assert.equal(refused.status, 400);
    assert.match(((await refused.json()) as { error: string }).error, /credit card/);
    assert.equal((await patch(bankId, { availableLimitMinor: null })).status, 200);

    const created = await call("/accounts", {
      method: "POST",
      body: JSON.stringify({ bankName: "SBI", accountType: "BANK", availableLimitMinor: 100 }),
    });
    assert.equal(created.status, 400);
  });

  it("needs no credit limit: it is what is left, with nothing to measure it against", async () => {
    const bare = await card({ last4: "2222", statementDay: 1 });
    await charge(bare._id, "2026-10-02", 4000);
    await patch(bare._id, { availableLimitMinor: 20_000_00, availableLimitAt: on("2026-10-05").toISOString() });
    await charge(bare._id, "2026-10-06", 1000);

    const row = await statusOf(bare._id);
    assert.equal(row.availableMinor, 19_000_00);
    assert.equal(row.creditLimitMinor, null);
    assert.equal(row.state, "unset");
    // What is owed is still added up from the card's own rows.
    assert.equal(row.outstandingMinor, 5000_00);
  });

  it("needs no billing cycle either", async () => {
    const bare = await card({ last4: "3333", creditLimitMinor: 50_000_00 });
    await patch(bare._id, { availableLimitMinor: 30_000_00, availableLimitAt: on("2026-10-05").toISOString() });
    await charge(bare._id, "2026-10-06", 2500);

    const row = await statusOf(bare._id);
    assert.equal(row.cycleKnown, false);
    assert.equal(row.availableMinor, 27_500_00);
    assert.equal(row.outstandingMinor, 22_500_00);
    assert.equal(row.state, "ok");
  });

  it("never goes below nothing", async () => {
    const hdfc = await card({ last4: "4444", statementDay: 1, creditLimitMinor: 10_000_00 });
    await patch(hdfc._id, { availableLimitMinor: 1000_00, availableLimitAt: on("2026-10-05").toISOString() });
    await charge(hdfc._id, "2026-10-06", 3000);

    const row = await statusOf(hdfc._id);
    assert.equal(row.availableMinor, 0);
    assert.equal(row.outstandingMinor, 10_000_00);
    assert.equal(row.state, "over");
  });
});

describe("the bank's own Avl Lmt", () => {
  it("takes over from an older typed figure, and its own payment is not counted twice", async () => {
    const hdfc = await card({ last4: "5555", statementDay: 1, creditLimitMinor: 100_000_00 });
    await patch(hdfc._id, { availableLimitMinor: 40_000_00, availableLimitAt: on("2026-10-03").toISOString() });

    // The message for this purchase said 30,000 was left after it.
    await charge(hdfc._id, "2026-10-06", 1500, { statedAvailableLimitMinor: 30_000_00 });
    await charge(hdfc._id, "2026-10-07", 700);

    const row = await statusOf(hdfc._id);
    assert.equal(row.availableSource, "sms");
    assert.equal(row.availableAsOf?.getTime(), on("2026-10-06").getTime());
    assert.equal(row.availableLimitAnchorMinor, 30_000_00);
    assert.equal(row.chargedSinceAnchorMinor, 700_00);
    assert.equal(row.availableMinor, 29_300_00);
  });

  it("gives way to a figure typed in after it", async () => {
    const hdfc = await card({ last4: "6666", statementDay: 1, creditLimitMinor: 100_000_00 });
    await charge(hdfc._id, "2026-10-04", 500, { statedAvailableLimitMinor: 30_000_00 });
    await patch(hdfc._id, { availableLimitMinor: 45_000_00, availableLimitAt: on("2026-10-06").toISOString() });
    await charge(hdfc._id, "2026-10-08", 1000);

    const row = await statusOf(hdfc._id);
    assert.equal(row.availableSource, "you");
    assert.equal(row.availableMinor, 44_000_00);
  });

  it("counts a bill payment the card acknowledged once - not again through its bank side", async () => {
    const hdfc = await card({ last4: "7777", statementDay: 1, creditLimitMinor: 100_000_00 });
    // The bank account's debit and the card's "payment received", paired.
    const debit = await pay(hdfc._id, "2026-10-06", 5000);
    const received = await charge(hdfc._id, "2026-10-06", 5000, {
      type: "CREDIT",
      isTransfer: true,
      transferPairId: debit._id,
      statedAvailableLimitMinor: 50_000_00,
    });
    await models.Transaction.updateOne({ _id: debit._id }, { $set: { transferPairId: received._id } });
    await charge(hdfc._id, "2026-10-08", 200);

    const row = await statusOf(hdfc._id);
    assert.equal(row.availableSource, "sms");
    assert.equal(row.paidSinceAnchorMinor, 0);
    assert.equal(row.availableMinor, 49_800_00);
  });
});

describe("a limit shared by two cards", () => {
  it("keeps one figure, on the holder, and both cards show the pot", async () => {
    const main = await card({ nickname: "Main", last4: "8881", statementDay: 1, creditLimitMinor: 100_000_00 });
    const addOn = await card({ nickname: "Add-on", last4: "8882", statementDay: 15, sharesLimitWith: main._id });

    // Set from the add-on card: it lands on the holder.
    const res = await patch(addOn._id, { availableLimitMinor: 70_000_00, availableLimitAt: on("2026-10-05").toISOString() });
    assert.equal(res.status, 200);
    const [savedMain, savedAddOn] = await Promise.all([
      models.Account.findById(main._id),
      models.Account.findById(addOn._id),
    ]);
    assert.equal(savedMain?.availableLimitMinor, 70_000_00);
    assert.equal(savedAddOn?.availableLimitMinor, null);

    await charge(main._id, "2026-10-06", 1000);
    await charge(addOn._id, "2026-10-07", 2000);

    const [m, a] = [await statusOf(main._id), await statusOf(addOn._id)];
    for (const row of [m, a]) {
      assert.equal(row.availableSource, "you");
      assert.equal(row.availableMinor, 67_000_00);
      assert.equal(row.groupUsedMinor, 33_000_00);
    }
    // Each card's own figure is still its own rows, since the bank's is the pot's.
    assert.equal(a.outstandingMinor, 2000_00);
  });

  it("reads the bank's Avl Lmt off either card's message", async () => {
    const main = await card({ nickname: "Main", last4: "9991", statementDay: 1, creditLimitMinor: 100_000_00 });
    const addOn = await card({ nickname: "Add-on", last4: "9992", statementDay: 1, sharesLimitWith: main._id });
    await charge(addOn._id, "2026-10-06", 1000, { statedAvailableLimitMinor: 60_000_00 });
    await charge(main._id, "2026-10-07", 500);

    for (const id of [main._id, addOn._id]) {
      const row = await statusOf(id);
      assert.equal(row.availableSource, "sms");
      assert.equal(row.availableMinor, 59_500_00);
    }
  });
});

describe("the payloads", () => {
  it("say where the figure comes from on the dashboard and the accounts page", async () => {
    const hdfc = await card({ last4: "1212", statementDay: 1, creditLimitMinor: 100_000_00 });
    await patch(hdfc._id, { availableLimitMinor: 40_000_00, availableLimitAt: on("2026-10-05").toISOString() });

    const dashboard = (await (await call("/dashboard")).json()) as { wallet: { cards: Record<string, unknown>[] } };
    assert.equal(dashboard.wallet.cards[0].availableSource, "you");
    assert.ok(dashboard.wallet.cards[0].availableAsOf);

    const overview = (await (await call("/accounts/overview")).json()) as {
      id: string;
      cycle: Record<string, unknown> | null;
    }[];
    const panel = overview.find((account) => account.id === hdfc.id)!;
    assert.equal(panel.cycle!.availableSource, "you");
    assert.equal(panel.cycle!.availableLimitAnchorMinor, 40_000_00);
    assert.equal(typeof panel.cycle!.chargedSinceAnchorMinor, "number");
  });
});
