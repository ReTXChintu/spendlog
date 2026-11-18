import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { commitmentSplit } from "./budget.commitmentShares";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "commitment-shares-secret";

/**
 * Rent of ₹11,500, three flatmates paying back ₹4,000, ₹4,000 and ₹3,000:
 * ₹500 of it is the user's. The payment splits that way, the fixed cost is
 * met by that part, and their money back is put towards it month by month.
 */
describe("splitting a payment by its fixed cost's people", () => {
  const ids = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
  const rent = {
    name: "Rent",
    shares: [
      { contactId: ids[0], amountMinor: 4000_00 },
      { contactId: ids[1], amountMinor: 4000_00 },
      { contactId: ids[2], amountMinor: 3000_00 },
    ],
  };

  it("splits the whole amount exactly as saved", () => {
    const { split, people } = commitmentSplit(rent, 11_500_00, 11_500_00);
    assert.equal(split.myShareMinor, 500_00);
    assert.equal(split.groupLabel, "Rent");
    assert.deepEqual(people.map((p) => p.amountMinor), [4000_00, 4000_00, 3000_00]);
  });

  it("keeps the proportions on a different amount, the user's part taking the leftover", () => {
    const { split, people } = commitmentSplit(rent, 11_500_00, 5750_00);
    assert.deepEqual(people.map((p) => p.amountMinor), [2000_00, 2000_00, 1500_00]);
    assert.equal(split.myShareMinor, 250_00);
  });
});

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let ingest: typeof import("../../parsing/ingest");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_commitment_shares_test"));
  const [{ app }, auth, loaded, loadedIngest] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../../parsing/ingest"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  ingest = loadedIngest;
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
    models.User.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.Contact.deleteMany({}),
    models.FixedCommitment.deleteMany({}),
    models.Account.deleteMany({}),
  ]);
});

let userCount = 0;
type Json = Record<string, any>;

async function makeUser() {
  const email = `cs${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  return { id: user._id, token: signToken({ id: user._id.toString(), email }) };
}

async function call(path: string, token: string, init: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Json };
}

/** A user with three flatmates and rent they pay back for. */
async function flat() {
  const user = await makeUser();
  const [chirayu, harshang, sapan] = await Promise.all(
    ["Chirayu", "Harshang", "Sapan"].map(async (name) => (await call("/contacts", user.token, { body: { name } })).body)
  );
  const rent = await call("/budget/commitments", user.token, {
    body: {
      name: "Rent",
      amountMinor: 11_500_00,
      dayOfMonth: 22,
      kind: "RENT",
      merchant: "PALIVAL BHAV",
      shares: [
        { contactId: chirayu.id, amountMinor: 4000_00 },
        { contactId: harshang.id, amountMinor: 4000_00 },
        { contactId: sapan.id, amountMinor: 3000_00 },
      ],
    },
  });
  assert.equal(rent.status, 201, JSON.stringify(rent.body));
  return { user, chirayu, harshang, sapan, rent: rent.body };
}

const rentSms = "Debited Rs 11500.00 from a/c X5130 via UPI to PALIVAL BHAV. Ref 666106275460. -Federal Bank";

describe("a fixed cost others pay back for", () => {
  it("is refused people who pay back more than it comes to, or someone who isn't a contact", async () => {
    const user = await makeUser();
    const friend = (await call("/contacts", user.token, { body: { name: "Friend" } })).body;
    const tooMuch = await call("/budget/commitments", user.token, {
      body: { name: "Rent", amountMinor: 1000_00, dayOfMonth: 1, shares: [{ contactId: friend.id, amountMinor: 1500_00 }] },
    });
    assert.equal(tooMuch.status, 400);
    const stranger = await call("/budget/commitments", user.token, {
      body: { name: "Rent", amountMinor: 1000_00, dayOfMonth: 1, shares: [{ contactId: new Types.ObjectId().toString(), amountMinor: 100_00 }] },
    });
    assert.equal(stranger.status, 400);
  });

  it("costs the user only their own part", async () => {
    const { user } = await flat();
    const [listed] = (await call("/budget/commitments", user.token)).body as unknown as Json[];
    assert.equal(listed.thisPeriodAmountMinor, 500_00);
    assert.equal(listed.fullAmountMinor, 11_500_00);
    assert.deepEqual(listed.shareStatus.map((s: Json) => [s.name, s.amountMinor, s.paidMinor]), [
      ["Chirayu", 4000_00, 0],
      ["Harshang", 4000_00, 0],
      ["Sapan", 3000_00, 0],
    ]);
  });

  it("links the month's payment to it as it arrives, and splits it", async () => {
    const { user, chirayu, rent } = await flat();
    const result = await ingest.ingestRawMessage({ userId: user.id, rawText: rentSms, source: "SMS", sourceRef: "m1", receivedAt: new Date() });
    assert.equal(result.status, "created");

    const row = await models.Transaction.findById((result as { transaction: { _id: Types.ObjectId } }).transaction._id).lean();
    assert.equal(String(row!.commitmentId), rent.id);
    assert.equal(row!.split?.myShareMinor, 500_00);
    assert.equal(row!.split?.groupLabel, "Rent");
    assert.equal(row!.countedAmountMinor, 500_00);
    assert.equal(row!.people.length, 3);

    const owed = (await call("/contacts", user.token)).body;
    const list = Array.isArray(owed) ? owed : owed.contacts;
    assert.equal(list.find((c: Json) => c.id === chirayu.id).balanceMinor, 4000_00);

    // A second payment the same month is left alone.
    const again = await ingest.ingestRawMessage({
      userId: user.id,
      rawText: rentSms.replace("666106275460", "666106275461"),
      source: "SMS",
      sourceRef: "m2",
      receivedAt: new Date(),
    });
    const second = await models.Transaction.findById((again as { transaction: { _id: Types.ObjectId } }).transaction._id).lean();
    assert.equal(second!.commitmentId, null);
  });

  it("leaves a payment of another amount, or to another payee, alone", async () => {
    const { user } = await flat();
    for (const text of [rentSms.replace("11500.00", "11000.00"), rentSms.replace("PALIVAL BHAV", "SOMEONE ELSE")]) {
      const result = await ingest.ingestRawMessage({ userId: user.id, rawText: text, source: "SMS", sourceRef: text, receivedAt: new Date() });
      const row = await models.Transaction.findById((result as { transaction: { _id: Types.ObjectId } }).transaction._id).lean();
      assert.equal(row!.commitmentId, null);
      assert.equal(row!.split, null);
    }
  });

  it("splits a payment picked as the fixed cost by hand", async () => {
    const { user, rent } = await flat();
    const created = await call("/transactions", user.token, {
      body: { type: "DEBIT", amountMinor: 11_500_00, occurredAt: new Date().toISOString(), source: "MANUAL", commitmentId: rent.id },
    });
    assert.equal(created.status, 201);
    const row = await models.Transaction.findById(created.body.id).lean();
    assert.equal(row!.split?.myShareMinor, 500_00);
  });

  it("puts money back towards it by purpose, and says whose part is in", async () => {
    const { user, chirayu, harshang, rent } = await flat();
    const [listed] = (await call("/budget/commitments", user.token)).body as unknown as Json[];
    const periodKey = listed.periodKey;

    // ₹6,000 from Chirayu: ₹4,000 rent, the rest earlier splits.
    const back = await call("/transactions", user.token, {
      body: {
        type: "CREDIT",
        amountMinor: 6000_00,
        occurredAt: new Date().toISOString(),
        source: "MANUAL",
        isSettlement: true,
        people: [{ contactId: chirayu.id, amountMinor: 6000_00 }],
        towards: [{ commitmentId: rent.id, contactId: chirayu.id, periodKey, amountMinor: 4000_00 }],
      },
    });
    assert.equal(back.status, 201, JSON.stringify(back.body));

    const [after] = (await call("/budget/commitments", user.token)).body as unknown as Json[];
    assert.deepEqual(after.shareStatus.map((s: Json) => [s.name, s.paidMinor]), [
      ["Chirayu", 4000_00],
      ["Harshang", 0],
      ["Sapan", 0],
    ]);

    // More towards it than came from them, or from someone not on it: refused.
    const tooMuch = await call(`/transactions/${back.body.id}`, user.token, {
      method: "PATCH",
      body: { towards: [{ commitmentId: rent.id, contactId: chirayu.id, periodKey, amountMinor: 7000_00 }] },
    });
    assert.equal(tooMuch.status, 400);
    const notTheirs = await call(`/transactions/${back.body.id}`, user.token, {
      method: "PATCH",
      body: { towards: [{ commitmentId: rent.id, contactId: harshang.id, periodKey, amountMinor: 100_00 }] },
    });
    assert.equal(notTheirs.status, 400);

    // No longer from anyone: nothing to put towards.
    await call(`/transactions/${back.body.id}`, user.token, { method: "PATCH", body: { isSettlement: false, people: [] } });
    assert.deepEqual((await models.Transaction.findById(back.body.id).lean())!.towards, []);
  });
});

/**
 * Pay on the 15th, and everything below paid on the 13th - two days
 * before the month it is really for - then sent on to it with "Counts next
 * month". The rent, Mama's monthly payment and the flatmates' money back
 * all have to land in that month, not the one that was ending.
 */
describe("paying before the month it is for", () => {
  const DAY = 24 * 60 * 60 * 1000;
  let period: typeof import("./budget.period");
  before(async () => {
    period = await import("./budget.period");
  });

  async function paidOnThe15th() {
    const setup = await flat();
    await models.User.updateOne({ _id: setup.user.id }, { $set: { salaryDay: 15, salaryAmountMinor: 100_000_00 } });
    const current = period.budgetPeriodFor(15, new Date());
    // The 13th: the old month's, two days before this one opened.
    const early = new Date(current.start.getTime() - 2 * DAY + 12 * 60 * 60 * 1000);
    const previous = period.budgetPeriodFor(15, early);
    return { ...setup, current, previous, early, thisMonth: period.monthKeyOf(current) };
  }

  it("ticks a fixed cost off in the month a payment was sent to", async () => {
    const { user, early, thisMonth } = await paidOnThe15th();
    const mama = await call("/budget/commitments", user.token, {
      body: { name: "Mama", amountMinor: 5000_00, dayOfMonth: 20 },
    });
    assert.equal(mama.status, 201, JSON.stringify(mama.body));
    const paid = await call("/transactions", user.token, {
      body: {
        type: "DEBIT",
        amountMinor: 5000_00,
        occurredAt: early.toISOString(),
        source: "MANUAL",
        commitmentId: mama.body.id,
        countInMonth: thisMonth,
      },
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));

    const pace = (await call("/budget/pace", user.token)).body;
    const listed = (pace.commitments as Json[]).find((c) => c.id === mama.body.id)!;
    assert.equal(listed.isPaid, true, "Mama reads as paid this month");
    assert.equal(listed.shortfallMinor, 0);
    // And it is this month's spending, not the old one's.
    assert.ok(pace.spentMinor >= 5000_00, `spent ${pace.spentMinor}`);

    // Left on its own day, it would have been last month's.
    await call(`/transactions/${paid.body.id}`, user.token, { method: "PATCH", body: { countInMonth: null } });
    const after = (await call("/budget/pace", user.token)).body;
    assert.equal((after.commitments as Json[]).find((c) => c.id === mama.body.id)!.isPaid, false);
  });

  it("puts a flatmate's rent on the month it was sent to, whatever period the editor said", async () => {
    const { user, harshang, rent, early, previous, current, thisMonth } = await paidOnThe15th();
    const back = await call("/transactions", user.token, {
      body: {
        type: "CREDIT",
        amountMinor: 4000_00,
        occurredAt: early.toISOString(),
        source: "MANUAL",
        isSettlement: true,
        countInMonth: thisMonth,
        people: [{ contactId: harshang.id, amountMinor: 4000_00 }],
        // What an editor opened on the 13th sent: the month that was ending.
        towards: [{ commitmentId: rent.id, contactId: harshang.id, periodKey: previous.key, amountMinor: 4000_00 }],
      },
    });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    const row = await models.Transaction.findById(back.body.id).lean();
    assert.equal(row!.towards[0].periodKey, current.key);

    const [listed] = (await call("/budget/commitments", user.token)).body as unknown as Json[];
    const theirs = (listed.shareStatus as Json[]).find((s) => s.contactId === harshang.id)!;
    assert.equal(theirs.paidMinor, 4000_00, "Harshang's rent is in this month");
  });

  it("moves rows saved before this onto the month they were sent to", async () => {
    const { user, harshang, rent, early, previous, current, thisMonth } = await paidOnThe15th();
    // Written straight to the database, the way the old route left it.
    const row = await models.Transaction.create({
      userId: user.id,
      type: "CREDIT",
      amountMinor: 4000_00,
      currency: "INR",
      occurredAt: early,
      source: "MANUAL",
      isSettlement: true,
      countInMonth: thisMonth,
      people: [{ contactId: harshang.id, amountMinor: 4000_00 }],
      towards: [{ commitmentId: rent.id, contactId: harshang.id, periodKey: previous.key, amountMinor: 4000_00 }],
    });
    const { runTowardsFollowMonthBackfill } = await import("./budget.commitmentShares");
    await models.User.updateOne({ _id: user.id }, { $unset: { "backfills.towardsFollowMonth": 1 } });
    await runTowardsFollowMonthBackfill();
    assert.equal((await models.Transaction.findById(row._id).lean())!.towards[0].periodKey, current.key);
    // Twice is the same as once.
    await models.User.updateOne({ _id: user.id }, { $unset: { "backfills.towardsFollowMonth": 1 } });
    await runTowardsFollowMonthBackfill();
    assert.equal((await models.Transaction.findById(row._id).lean())!.towards[0].periodKey, current.key);
  });
});

/**
 * Chirayu sends 4,960 before the rent goes out: 4,000 of it his rent,
 * 960 squaring something kept in Splitwise. Neither part is owed back to
 * him - one is early, the other belongs to another app.
 */
describe("money back that isn't owed back", () => {
  async function chirayuPaysEarly() {
    const setup = await flat();
    const [listed] = (await call("/budget/commitments", setup.user.token)).body as unknown as Json[];
    const back = await call("/transactions", setup.user.token, {
      body: {
        type: "CREDIT",
        amountMinor: 4960_00,
        occurredAt: new Date().toISOString(),
        source: "MANUAL",
        isSettlement: true,
        people: [{ contactId: setup.chirayu.id, amountMinor: 4960_00, elsewhereMinor: 960_00 }],
        towards: [{ commitmentId: setup.rent.id, contactId: setup.chirayu.id, periodKey: listed.periodKey, amountMinor: 4000_00 }],
      },
    });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    return { ...setup, back: back.body, periodKey: listed.periodKey as string };
  }

  async function person(token: string, id: string): Promise<Json> {
    const owed = (await call("/contacts", token)).body;
    const list = Array.isArray(owed) ? owed : owed.contacts;
    return list.find((c: Json) => c.id === id);
  }

  it("owes him nothing before the rent goes out, and says it came early", async () => {
    const { user, chirayu } = await chirayuPaysEarly();
    const him = await person(user.token, chirayu.id);
    assert.equal(him.balanceMinor, 0, "not: you owe Chirayu 4,960");
    assert.equal(him.aheadMinor, 4000_00);

    // The pooled figure agrees with the People screen.
    const pool = (await call("/analytics/owed", user.token)).body;
    assert.equal(pool.balanceMinor, 0);
  });

  it("still owes him nothing once the rent goes out and is split", async () => {
    const { user, chirayu, harshang } = await chirayuPaysEarly();
    const result = await ingest.ingestRawMessage({ userId: user.id, rawText: rentSms, source: "SMS", sourceRef: "r1", receivedAt: new Date() });
    assert.equal(result.status, "created");

    const him = await person(user.token, chirayu.id);
    assert.equal(him.balanceMinor, 0);
    assert.ok(!him.aheadMinor, "no longer early: the rent is out");
    // Harshang hasn't sent his yet.
    assert.equal((await person(user.token, harshang.id)).balanceMinor, 4000_00);

    // His history moves the balance by his part here, not Splitwise's.
    const page = (await call(`/contacts/${chirayu.id}`, user.token)).body;
    const credit = (page.history as Json[]).find((entry) => entry.amountMinor < 0)!;
    assert.equal(credit.amountMinor, -4000_00);
  });

  it("refuses more put down to Splitwise than came from him, or rent and Splitwise together past it", async () => {
    const { user, chirayu, rent, back, periodKey } = await chirayuPaysEarly();
    const tooMuch = await call(`/transactions/${back.id}`, user.token, {
      method: "PATCH",
      body: { people: [{ contactId: chirayu.id, amountMinor: 4960_00, elsewhereMinor: 5000_00 }] },
    });
    assert.equal(tooMuch.status, 400, JSON.stringify(tooMuch.body));

    const together = await call(`/transactions/${back.id}`, user.token, {
      method: "PATCH",
      body: {
        people: [{ contactId: chirayu.id, amountMinor: 4960_00, elsewhereMinor: 1500_00 }],
        towards: [{ commitmentId: rent.id, contactId: chirayu.id, periodKey, amountMinor: 4000_00 }],
      },
    });
    assert.equal(together.status, 400, JSON.stringify(together.body));
    assert.match(together.body.error, /Splitwise/);
  });
});
