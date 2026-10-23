import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { istMonthKey } from "../../time";
import { addMonths } from "./emi.schedule";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "emi-routes-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_emi_routes_test"));
  const [{ app }, auth, loaded] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  await models.EmiPlan.init();
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
    models.EmiPlan.deleteMany({}),
    models.EmiInstalment.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.Account.deleteMany({}),
    models.User.deleteMany({}),
  ]);
});

const DAY = 24 * 60 * 60 * 1000;
const at10 = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 10));
const TODAY = at10(new Date());
/** Tracking began 40 days ago. */
const SINCE = new Date(TODAY.getTime() - 40 * DAY);
/** The next unpaid instalment, in ten days. */
const NEXT_DUE = new Date(TODAY.getTime() + 10 * DAY);
const MONTHLY = 530000;

let userCount = 0;

async function makeUser() {
  const email = `e${(userCount += 1)}@example.com`;
  const user = await models.User.create({ email, ledgerFrom: istMonthKey(SINCE), ledgerFromAt: SINCE });
  const card = await models.Account.create({ userId: user._id, bankName: "HDFC", last4: "1234", accountType: "CARD" });
  return { id: user._id, card, token: signToken({ id: user._id.toString(), email }) };
}

function call(path: string, token: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function debit(userId: Types.ObjectId, amountMinor: number, occurredAt: Date, accountId?: Types.ObjectId) {
  return models.Transaction.create({
    userId,
    accountId: accountId ?? null,
    amountMinor,
    currency: "INR",
    type: "DEBIT",
    merchant: "EMI",
    source: "MANUAL",
    occurredAt,
  });
}

function addExisting(token: string, accountId: string, extra: Record<string, unknown> = {}) {
  return call("/emi", token, {
    method: "POST",
    body: JSON.stringify({
      accountId,
      label: "Phone",
      months: 12,
      monthlyAmountMinor: MONTHLY,
      paidCount: 5,
      nextDueDate: NEXT_DUE.toISOString(),
      ...extra,
    }),
  });
}

describe("POST /emi — an EMI that was already running", () => {
  it("lays the schedule out from what is paid and when the next falls due", async () => {
    const { id, card, token } = await makeUser();
    const res = await addExisting(token, card.id);
    assert.equal(res.status, 201);
    const plan = await json(res);
    assert.equal(plan.origin, "EXISTING");
    assert.equal(plan.sourceTransactionId, null);
    assert.equal(plan.totalPayableMinor, MONTHLY * 12);
    assert.equal(plan.principalMinor, MONTHLY * 12, "no principal given: the total stands in");
    assert.equal(new Date(plan.startDate).getTime(), addMonths(NEXT_DUE, -5).getTime(), "five back from the next one");

    const instalments = await models.EmiInstalment.find({ userId: id }).sort({ seq: 1 });
    assert.equal(instalments.length, 12);
    assert.equal(instalments[5].dueDate.getTime(), NEXT_DUE.getTime(), "the sixth is the next due");
    assert.deepEqual(
      instalments.map((i) => i.status),
      [...Array(5).fill("PAID"), ...Array(7).fill("DUE")]
    );
    assert.ok(instalments.slice(0, 5).every((i) => i.paidBeforeTracking && i.transactionId === null));
    assert.ok(instalments.slice(5).every((i) => !i.paidBeforeTracking));
    // Only what is still due is committed, so nothing paid before counts.
    assert.equal(instalments.filter((i) => i.status === "DUE" && i.paidBeforeTracking).length, 0);
  });

  it("finds the debits that arrived since tracking began, and only those", async () => {
    const { id, card, token } = await makeUser();
    const fifthDue = addMonths(NEXT_DUE, -1); // about 20 days ago: after SINCE
    const fourthDue = addMonths(NEXT_DUE, -2); // about 51 days ago: before SINCE
    const recent = await debit(id, MONTHLY + 200, new Date(fifthDue.getTime() + 2 * DAY), card._id);
    const old = await debit(id, MONTHLY, new Date(fourthDue.getTime() + 1 * DAY), card._id);

    const plan = await json(await addExisting(token, card.id));
    assert.equal(plan.matchedCount, 1);
    assert.equal(plan.paidBeforeTrackingCount, 4);

    const fifth = await models.EmiInstalment.findOne({ planId: plan.id, seq: 5 });
    assert.equal(fifth!.status, "PAID");
    assert.equal(String(fifth!.transactionId), recent.id);
    assert.equal(fifth!.paidBeforeTracking, false);
    const fourth = await models.EmiInstalment.findOne({ planId: plan.id, seq: 4 });
    assert.equal(fourth!.paidBeforeTracking, true, "before tracking began: marked, not matched");

    const matched = await models.Transaction.findById(recent._id);
    assert.equal(matched!.emiRole, "INSTALMENT");
    assert.equal(String(matched!.emiPlanId), plan.id);
    assert.equal((await models.Transaction.findById(old._id))!.emiPlanId, null);
  });

  it("prefers the plan's own card over another account's debit of the same amount", async () => {
    const { id, card, token } = await makeUser();
    const other = await models.Account.create({ userId: id, bankName: "SBI", accountType: "BANK" });
    const fifthDue = addMonths(NEXT_DUE, -1);
    await debit(id, MONTHLY, fifthDue, other._id);
    const own = await debit(id, MONTHLY, new Date(fifthDue.getTime() + 3 * DAY), card._id);

    const plan = await json(await addExisting(token, card.id));
    const fifth = await models.EmiInstalment.findOne({ planId: plan.id, seq: 5 });
    assert.equal(String(fifth!.transactionId), own.id);
  });

  it("refuses the same EMI twice unless told it is another one", async () => {
    const { card, token } = await makeUser();
    assert.equal((await addExisting(token, card.id)).status, 201);

    const again = await addExisting(token, card.id, { monthlyAmountMinor: MONTHLY + 100 });
    assert.equal(again.status, 409);
    const body = await json(again);
    assert.equal(body.code, "duplicate");
    assert.equal(body.existing.label, "Phone");

    assert.equal((await addExisting(token, card.id, { force: true })).status, 201);
    // A different amount on the same card is a different EMI.
    assert.equal((await addExisting(token, card.id, { monthlyAmountMinor: 120000 })).status, 201);
  });

  it("checks what it is given", async () => {
    const { id, card, token } = await makeUser();
    assert.equal((await addExisting(token, card.id, { paidCount: 12 })).status, 400);
    assert.equal(
      (await addExisting(token, card.id, { nextDueDate: new Date(TODAY.getTime() - 120 * DAY).toISOString() })).status,
      400
    );
    const cash = await models.Account.create({ userId: id, bankName: "Cash", accountType: "CASH" });
    assert.equal((await addExisting(token, cash.id)).status, 400);
    const stranger = await makeUser();
    assert.equal((await addExisting(token, stranger.card.id)).status, 404);
    assert.equal((await addExisting(token, card.id, { label: "" })).status, 400);
  });

  it("is listed with where it stands", async () => {
    const { card, token } = await makeUser();
    await addExisting(token, card.id);
    const [plan] = await json<Record<string, any>[]>(await call("/emi", token));
    assert.equal(plan.origin, "EXISTING");
    assert.equal(plan.paidCount, 5);
    assert.equal(plan.paidBeforeTrackingCount, 5);
    assert.equal(plan.remainingMinor, MONTHLY * 7);
    assert.equal(plan.nextDue.seq, 6);
    assert.equal(new Date(plan.nextDue.dueDate).getTime(), NEXT_DUE.getTime());
    assert.equal(new Date(plan.trackingSince).getTime(), SINCE.getTime());
    assert.equal(plan.instalments[0].paidBeforeTracking, true);
  });
});

describe("PATCH and DELETE /emi/:id", () => {
  it("puts an existing EMI's monthly figure right on what is still due", async () => {
    const { card, token } = await makeUser();
    const plan = await json(await addExisting(token, card.id));
    const res = await call(`/emi/${plan.id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ monthlyAmountMinor: 540000, label: "iPhone" }),
    });
    assert.equal(res.status, 200);
    const updated = await json(res);
    assert.equal(updated.label, "iPhone");
    assert.equal(updated.monthlyAmountMinor, 540000);
    assert.equal(updated.totalPayableMinor, MONTHLY * 5 + 540000 * 7);
    const due = await models.EmiInstalment.find({ planId: plan.id, status: "DUE" });
    assert.ok(due.every((i) => i.amountMinor === 540000));
    const paid = await models.EmiInstalment.find({ planId: plan.id, status: "PAID" });
    assert.ok(paid.every((i) => i.amountMinor === MONTHLY));
  });

  it("won't change a converted plan's amount, and leaves converting as it was", async () => {
    const { id, card, token } = await makeUser();
    const purchase = await debit(id, 6000000, new Date(TODAY.getTime() - 5 * DAY), card._id);
    const created = await call(`/emi/from/${purchase.id}`, token, {
      method: "POST",
      body: JSON.stringify({ months: 12, monthlyAmountMinor: 520000 }),
    });
    assert.equal(created.status, 201);
    const plan = await json(created);
    assert.equal(plan.origin, "CONVERTED");
    assert.equal(String(plan.sourceTransactionId), purchase.id);
    assert.equal((await models.Transaction.findById(purchase._id))!.emiRole, "PARENT");

    const res = await call(`/emi/${plan.id}`, token, { method: "PATCH", body: JSON.stringify({ monthlyAmountMinor: 1 }) });
    assert.equal(res.status, 400);
    // Converting the same purchase twice is still refused.
    const twice = await call(`/emi/from/${purchase.id}`, token, {
      method: "POST",
      body: JSON.stringify({ months: 6, monthlyAmountMinor: 1000000 }),
    });
    assert.equal(twice.status, 409);
  });

  it("several existing EMIs, none with a purchase, live side by side", async () => {
    const { card, token } = await makeUser();
    assert.equal((await addExisting(token, card.id, { monthlyAmountMinor: 100000 })).status, 201);
    assert.equal((await addExisting(token, card.id, { monthlyAmountMinor: 900000 })).status, 201);
    assert.equal(await models.EmiPlan.countDocuments({ sourceTransactionId: null }), 2);
  });

  it("deleting frees the debits it had matched and the purchase it came from", async () => {
    const { id, card, token } = await makeUser();
    const recent = await debit(id, MONTHLY, addMonths(NEXT_DUE, -1), card._id);
    const plan = await json(await addExisting(token, card.id));
    assert.equal((await models.Transaction.findById(recent._id))!.emiRole, "INSTALMENT");

    assert.equal((await call(`/emi/${plan.id}`, token, { method: "DELETE" })).status, 204);
    const freed = await models.Transaction.findById(recent._id);
    assert.equal(freed!.emiPlanId, null);
    assert.equal(freed!.emiRole, null);
    assert.equal(await models.EmiInstalment.countDocuments({ planId: plan.id }), 0);

    const purchase = await debit(id, 6000000, TODAY, card._id);
    const converted = await json(
      await call(`/emi/from/${purchase.id}`, token, { method: "POST", body: JSON.stringify({ months: 12, monthlyAmountMinor: 520000 }) })
    );
    await call(`/emi/${converted.id}`, token, { method: "DELETE" });
    const back = await models.Transaction.findById(purchase._id);
    assert.equal(back!.emiRole, null);
    assert.equal(back!.countedAmountMinor, 6000000, "the purchase counts in full again");
  });
});
