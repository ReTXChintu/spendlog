import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "lending-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let backfill: typeof import("./contacts.backfill");
let peopleCategory: Types.ObjectId;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_lending_test"));
  const [{ app }, auth, loaded, loadedBackfill, system] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("./contacts.backfill"),
    import("../categories/categories.system"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  backfill = loadedBackfill;
  peopleCategory = (await system.peopleCategoryId())!;
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
let userCount = 0;

beforeEach(async () => {
  await Promise.all([models.Contact.deleteMany({}), models.Transaction.deleteMany({}), models.User.deleteMany({})]);
  const email = `l${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function person(name: string, openingBalanceMinor?: number) {
  return json<{ id: string }>(
    await call("/contacts", { method: "POST", body: JSON.stringify({ name, openingBalanceMinor }) })
  );
}

/** What the transaction editor sends for a plain row - kind left on Normal. */
async function add(type: "DEBIT" | "CREDIT", amountMinor: number, extra: Record<string, unknown> = {}) {
  const response = await call("/transactions", {
    method: "POST",
    body: JSON.stringify({ type, amountMinor, occurredAt: new Date().toISOString(), ...extra }),
  });
  assert.equal(response.status, 201);
  return json<{ id: string; countedAmountMinor: number }>(response);
}

async function balanceOf(contactId: string) {
  const listed = await json<{ contacts: { id: string; balanceMinor: number }[] }>(await call("/contacts"));
  return listed.contacts.find((contact) => contact.id === contactId)!.balanceMinor;
}

describe("money lent never counts", () => {
  it("reads a person's name filed under Lent & borrowed as money lent to them", async () => {
    const rahul = await person("Rahul");
    await add("DEBIT", 500_00, { merchant: "Swiggy" }); // real spending
    const lent = await add("DEBIT", 5_000_00, { merchant: " rahul ", categoryId: peopleCategory.toString() });

    assert.equal(lent.countedAmountMinor, 0);
    const stored = await models.Transaction.findById(lent.id).orFail();
    assert.equal(stored.split?.myShareMinor, 0);
    assert.deepEqual(
      stored.people.map((share) => [share.contactId.toString(), share.amountMinor]),
      [[rahul.id, 5_000_00]]
    );
    assert.equal(stored.countedReason, "SPLIT");

    const budget = await json<{ spentMinor: number }>(await call("/budget/monthly"));
    assert.equal(budget.spentMinor, 500_00);
    const summary = await json<{ totalSpendMinor: number }>(await call("/analytics/summary"));
    assert.equal(summary.totalSpendMinor, 500_00);
    assert.equal(await balanceOf(rahul.id), 5_000_00);
  });

  it("reads money back from them as paid back, not income", async () => {
    const rahul = await person("Rahul");
    await add("DEBIT", 5_000_00, { merchant: "Rahul", categoryId: peopleCategory.toString() });
    const back = await add("CREDIT", 2_000_00, { merchant: "Rahul", categoryId: peopleCategory.toString() });

    assert.equal(back.countedAmountMinor, 0);
    const stored = await models.Transaction.findById(back.id).orFail();
    assert.equal(stored.isSettlement, true);
    const summary = await json<{ totalIncomeMinor: number }>(await call("/analytics/summary"));
    assert.equal(summary.totalIncomeMinor, 0);
    assert.equal(await balanceOf(rahul.id), 3_000_00);
  });

  it("still counts nothing when the merchant names nobody, or two people", async () => {
    await person("Asha");
    await person("asha");
    const lent = await add("DEBIT", 1_000_00, { merchant: "Asha", categoryId: peopleCategory.toString() });
    const stored = await models.Transaction.findById(lent.id).orFail();
    assert.equal(stored.countedAmountMinor, 0);
    assert.equal(stored.people.length, 0, "not guessed between two Ashas");
  });

  it("applies when a plain row is moved into the category later", async () => {
    const rahul = await person("Rahul");
    const row = await add("DEBIT", 800_00, { merchant: "Rahul" });
    assert.equal(row.countedAmountMinor, 800_00);

    const response = await call(`/transactions/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ categoryId: peopleCategory.toString(), split: null, isSettlement: false }),
    });
    assert.equal(response.status, 200);
    assert.equal((await json<{ countedAmountMinor: number }>(response)).countedAmountMinor, 0);
    assert.equal(await balanceOf(rahul.id), 800_00);
  });

  it("leaves rows that already say what they are alone", async () => {
    const moved = await add("DEBIT", 9_000_00, { categoryId: peopleCategory.toString(), isTransfer: true });
    const stored = await models.Transaction.findById(moved.id).orFail();
    assert.equal(stored.split, null);
    assert.equal(stored.countedReason, "TRANSFER");

    const split = await add("DEBIT", 1_200_00, {
      categoryId: peopleCategory.toString(),
      split: { myShareMinor: 800_00 },
    });
    assert.equal(split.countedAmountMinor, 800_00, "a split keeps the user's own share");
  });
});

describe("the Lent & borrowed backfill", () => {
  /** Straight into the collection, as rows were saved before the hooks knew. */
  async function oldRow(type: "DEBIT" | "CREDIT", amountMinor: number, merchant: string, extra = {}) {
    const _id = new Types.ObjectId();
    await models.Transaction.collection.insertOne({
      _id,
      userId,
      type,
      amountMinor,
      merchant,
      categoryId: peopleCategory,
      source: "SMS",
      occurredAt: new Date(),
      people: [],
      split: null,
      isSettlement: false,
      isTransfer: false,
      refundOf: [],
      countedAmountMinor: amountMinor,
      countedReason: "FULL",
      ...extra,
    });
    return _id;
  }

  it("converts the old rows once, and changes nothing the second time", async () => {
    const rahul = await person("Rahul");
    const lent = await oldRow("DEBIT", 4_000_00, "RAHUL");
    const back = await oldRow("CREDIT", 1_000_00, "Rahul");
    const stranger = await oldRow("DEBIT", 700_00, "UPI/9876@ybl");
    const transfer = await oldRow("DEBIT", 300_00, "Rahul", { isTransfer: true, countedAmountMinor: 0 });

    assert.equal(await backfill.backfillLending(userId), 3);

    const [lentRow, backRow, strangerRow, transferRow] = await Promise.all(
      [lent, back, stranger, transfer].map((id) => models.Transaction.findById(id).lean().orFail())
    );
    assert.equal(lentRow.split?.myShareMinor, 0);
    assert.equal(lentRow.countedAmountMinor, 0);
    assert.equal(lentRow.people[0].contactId.toString(), rahul.id);
    assert.equal(backRow.isSettlement, true);
    assert.equal(backRow.countedAmountMinor, 0);
    assert.equal(strangerRow.countedAmountMinor, 0);
    assert.equal(strangerRow.people.length, 0);
    assert.equal(transferRow.split, null, "a transfer was already something else");
    assert.equal(await balanceOf(rahul.id), 3_000_00);

    assert.equal(await backfill.backfillLending(userId), 0);
    assert.equal(await balanceOf(rahul.id), 3_000_00);
  });

  it("does not name someone whose opening balance may already hold it", async () => {
    const ravi = await person("Ravi", 4_000_00);
    const lent = await oldRow("DEBIT", 4_000_00, "Ravi");

    await backfill.backfillLending(userId);
    const row = await models.Transaction.findById(lent).lean().orFail();
    assert.equal(row.countedAmountMinor, 0);
    assert.equal(row.people.length, 0);
    assert.equal(await balanceOf(ravi.id), 4_000_00, "not 8,000");
  });

  it("runs once per user, guarded by its version", async () => {
    await person("Rahul");
    await oldRow("DEBIT", 4_000_00, "Rahul");

    await backfill.runLendingBackfill();
    const user = await models.User.findById(userId).orFail();
    assert.equal(user.backfills?.get(backfill.LENDING_BACKFILL), backfill.LENDING_BACKFILL_VERSION);

    // A row put back the old way is not touched again: this user is done.
    const later = await oldRow("DEBIT", 100_00, "Rahul");
    await backfill.runLendingBackfill();
    const row = await models.Transaction.findById(later).lean().orFail();
    assert.equal(row.countedAmountMinor, 100_00);
  });
});
