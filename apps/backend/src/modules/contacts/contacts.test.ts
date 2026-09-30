import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "contacts-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_contacts_test"));
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
let userCount = 0;

beforeEach(async () => {
  await Promise.all([models.Contact.deleteMany({}), models.Transaction.deleteMany({}), models.User.deleteMany({})]);
  const email = `c${(userCount += 1)}@example.com`;
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

async function person(name: string, phone?: string) {
  return json<{ id: string; existing?: boolean }>(
    await call("/contacts", { method: "POST", body: JSON.stringify({ name, phone }) })
  );
}

async function transaction(type: "DEBIT" | "CREDIT", amountMinor: number, extra: Record<string, unknown> = {}) {
  const created = await models.Transaction.create({
    userId,
    type,
    amountMinor,
    source: "MANUAL",
    occurredAt: new Date(),
    ...extra,
  });
  return created._id.toString();
}

function patch(id: string, body: Record<string, unknown>) {
  return call(`/transactions/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

interface Listed {
  owedToYouMinor: number;
  youOweMinor: number;
  contacts: { id: string; name: string; balanceMinor: number; givenMinor: number; returnedMinor: number }[];
}

describe("people and what they owe", () => {
  it("finds the same person again by number, however it was written", async () => {
    const first = await person("Rahul", "+91 98765 43210");
    const again = await person("Rahul K", "098765-43210");
    assert.equal(again.id, first.id);
    assert.equal(again.existing, true);
  });

  it("owes what was lent, less what came back", async () => {
    const rahul = await person("Rahul");

    // Lent 5,000 outright: all of it his.
    const lent = await transaction("DEBIT", 5_000_00);
    assert.equal(
      (await patch(lent, { split: { myShareMinor: 0 }, people: [{ contactId: rahul.id, amountMinor: 5_000_00 }] })).status,
      200
    );
    // Dinner of 1,200, 400 of it his.
    const dinner = await transaction("DEBIT", 1_200_00);
    await patch(dinner, {
      split: { myShareMinor: 800_00 },
      people: [{ contactId: rahul.id, amountMinor: 400_00 }],
    });
    // He sends 3,000 back.
    const back = await transaction("CREDIT", 3_000_00);
    await patch(back, { isSettlement: true, people: [{ contactId: rahul.id, amountMinor: 3_000_00 }] });

    const listed = await json<Listed>(await call("/contacts"));
    assert.equal(listed.contacts[0].balanceMinor, 2_400_00);
    assert.equal(listed.contacts[0].givenMinor, 5_400_00);
    assert.equal(listed.contacts[0].returnedMinor, 3_000_00);
    assert.equal(listed.owedToYouMinor, 2_400_00);

    const detail = await json<{ balanceMinor: number; history: { amountMinor: number }[] }>(
      await call(`/contacts/${rahul.id}`)
    );
    assert.equal(detail.history.length, 3);
    assert.deepEqual(
      detail.history.map((row) => row.amountMinor).sort((a, b) => a - b),
      [-3_000_00, 400_00, 5_000_00]
    );
  });

  it("splits one bill between several people", async () => {
    const a = await person("Asha");
    const b = await person("Bala");
    const rent = await transaction("DEBIT", 11_500_00);
    const response = await patch(rent, {
      split: { myShareMinor: 3_500_00 },
      people: [
        { contactId: a.id, amountMinor: 4_000_00 },
        { contactId: b.id, amountMinor: 4_000_00 },
      ],
    });
    assert.equal(response.status, 200);

    const listed = await json<Listed>(await call("/contacts"));
    assert.equal(listed.owedToYouMinor, 8_000_00);
  });

  it("refuses more across people than was not the user's own", async () => {
    const rahul = await person("Rahul");
    const dinner = await transaction("DEBIT", 1_200_00);
    const response = await patch(dinner, {
      split: { myShareMinor: 800_00 },
      people: [{ contactId: rahul.id, amountMinor: 500_00 }],
    });
    assert.equal(response.status, 400);
  });

  it("refuses people on a plain payment that nobody else had a part in", async () => {
    const rahul = await person("Rahul");
    const coffee = await transaction("DEBIT", 200_00);
    const response = await patch(coffee, { people: [{ contactId: rahul.id, amountMinor: 200_00 }] });
    assert.equal(response.status, 400);
    assert.match((await json<{ error: string }>(response)).error, /split/);
  });

  it("drops the people when the split is taken off", async () => {
    const rahul = await person("Rahul");
    const lent = await transaction("DEBIT", 1_000_00);
    await patch(lent, { split: { myShareMinor: 0 }, people: [{ contactId: rahul.id, amountMinor: 1_000_00 }] });
    await patch(lent, { split: null });

    const stored = await models.Transaction.findById(lent).orFail();
    assert.equal(stored.people.length, 0);
  });

  it("goes negative when it's the user who owes", async () => {
    const rahul = await person("Rahul");
    // Rahul paid for the user; the user pays him back.
    const repaid = await transaction("DEBIT", 700_00);
    await patch(repaid, { isSettlement: true, people: [{ contactId: rahul.id, amountMinor: 700_00 }] });
    const back = await transaction("CREDIT", 1_000_00);
    await patch(back, { isSettlement: true, people: [{ contactId: rahul.id, amountMinor: 1_000_00 }] });

    const listed = await json<Listed>(await call("/contacts"));
    assert.equal(listed.contacts[0].balanceMinor, -300_00);
    assert.equal(listed.youOweMinor, 300_00);
  });

  it("takes a deleted person off their transactions and leaves the rest alone", async () => {
    const rahul = await person("Rahul");
    const lent = await transaction("DEBIT", 1_000_00);
    await patch(lent, { split: { myShareMinor: 0 }, people: [{ contactId: rahul.id, amountMinor: 1_000_00 }] });

    assert.equal((await call(`/contacts/${rahul.id}`, { method: "DELETE" })).status, 204);
    const stored = await models.Transaction.findById(lent).orFail();
    assert.equal(stored.people.length, 0);
    assert.equal(stored.split?.myShareMinor, 0, "still a split");
  });

  it("will not put someone else's contact on a transaction", async () => {
    const rahul = await person("Rahul");
    const strangerEmail = "stranger@example.com";
    const stranger = await models.User.create({ email: strangerEmail });
    token = signToken({ id: stranger._id.toString(), email: strangerEmail });
    userId = stranger._id;

    const lent = await transaction("DEBIT", 1_000_00);
    const response = await patch(lent, {
      split: { myShareMinor: 0 },
      people: [{ contactId: rahul.id, amountMinor: 1_000_00 }],
    });
    assert.equal(response.status, 400);
    assert.equal((await call(`/contacts/${rahul.id}`)).status, 404);
  });
});
