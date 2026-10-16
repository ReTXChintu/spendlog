import assert from "node:assert/strict";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";

process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "passbook-secret";

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let signToken: (user: { id: string; email: string }) => string;
let models: typeof import("../../models");
let ingest: typeof import("../../parsing/ingest");
let backfill: typeof import("./accounts.statedBackfill");

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_passbook_test"));

  const [{ app }, auth, loaded, loadedIngest, loadedBackfill] = await Promise.all([
    import("../../app"),
    import("../../middleware/auth"),
    import("../../models"),
    import("../../parsing/ingest"),
    import("./accounts.statedBackfill"),
  ]);
  signToken = auth.signSessionToken;
  models = loaded;
  ingest = loadedIngest;
  backfill = loadedBackfill;

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
let cashId: Types.ObjectId;
let userCount = 0;

const OPENING_AT = "2026-10-01T00:00:00+05:30";

beforeEach(async () => {
  await Promise.all([
    models.Account.deleteMany({}),
    models.Transaction.deleteMany({}),
    models.User.deleteMany({}),
    models.BalanceCheckpoint.deleteMany({}),
    models.Category.deleteMany({}),
  ]);
  const email = `p${(userCount += 1)}@example.com`;
  // The messages are from October 2026; the ledger has to reach back to them.
  const user = await models.User.create({ email, ledgerFrom: "2026-01" });
  userId = user._id;
  token = signToken({ id: user._id.toString(), email });
  const bank = await models.Account.create({
    userId,
    bankName: "HDFC Bank",
    last4: "4821",
    accountType: "BANK",
    openingBalanceMinor: 10_000_00,
    openingBalanceAt: new Date(OPENING_AT),
  });
  bankId = bank._id;
  const cash = await models.Account.create({
    userId,
    bankName: "Cash",
    last4: null,
    accountType: "CASH",
    openingBalanceMinor: 500_00,
    openingBalanceAt: new Date(OPENING_AT),
  });
  cashId = cash._id;
});

function call(path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

function sms(rawText: string, receivedAt: string, source: "SMS" | "EMAIL" = "SMS", sourceRef: string | null = null) {
  return ingest.ingestRawMessage({ userId, rawText, source, sourceRef, receivedAt: new Date(receivedAt) });
}

const ZEPTO = "Rs 500.00 debited from A/c XX4821 on 02-10-26 to VPA zepto@ybl Ref 111222333. Avl Bal Rs 9,500.00 -HDFC Bank";
const RENT = "Rs 3000.00 debited for UPI txn to VPA rent@upi Ref 444555666";
const SWIGGY = "Rs 200.00 debited from A/c XX4821 on 04-10-26 to VPA swiggy@icici Ref 777888999. Avl Bal Rs 6,300.00 -HDFC Bank";

/** The three messages the passbook tests are built on: a clean row, a payment nobody can place, a row the bank disagrees at. */
async function threeMessages() {
  const zepto = await sms(ZEPTO, "2026-10-02T10:00:00+05:30");
  const rent = await sms(RENT, "2026-10-03T10:00:00+05:30");
  const swiggy = await sms(SWIGGY, "2026-10-04T10:00:00+05:30");
  return { zepto: zepto.transaction!, rent: rent.transaction!, swiggy: swiggy.transaction! };
}

async function balanceOf(accountId: Types.ObjectId) {
  const rows = await json<{ id: string; balance: { expectedMinor: number; drift: unknown } | null }[]>(await call("/accounts/overview"));
  return rows.find((row) => row.id === accountId.toString())!.balance;
}

describe("the balance an SMS states", () => {
  it("is stored on the transaction, off the original text", async () => {
    const { zepto, rent } = await threeMessages();
    assert.equal(zepto.amountMinor, 500_00, "the balance is not taken for the amount");
    assert.equal(zepto.statedBalanceMinor, 9_500_00);
    assert.ok(zepto.accountId?.equals(bankId));
    assert.equal(rent.statedBalanceMinor, null);
  });

  it("is kept from whichever message had it when two report one payment", async () => {
    const first = await sms("Rs 500.00 debited from A/c XX4821 on 02-10-26 to VPA zepto@ybl Ref 111222333 -HDFC Bank", "2026-10-02T10:00:00+05:30");
    assert.equal(first.transaction?.statedBalanceMinor, null);
    const second = await sms(ZEPTO, "2026-10-02T10:03:00+05:30", "EMAIL", "mail-1");
    assert.equal(second.status, "duplicate");
    assert.equal(second.transaction?.statedBalanceMinor, 9_500_00);
  });

  it("is a card's available limit, kept apart, on a credit card", async () => {
    const result = await sms(
      "INR 8,000.00 spent using ICICI Bank Card XX2009 on 02-Oct-26 on TITANCOMPANY. Avl Limit: INR 44,021.93.",
      "2026-10-02T10:00:00+05:30"
    );
    assert.equal(result.transaction?.statedBalanceMinor, null);
    assert.equal(result.transaction?.statedAvailableLimitMinor, 44_021_93);
  });
});

describe("a payment no account could be placed for", () => {
  it("is marked as unknown and moves no balance, while still counting as spending", async () => {
    const { rent } = await threeMessages();
    assert.equal(rent.accountId, null);
    assert.equal(rent.accountUnknown, true);
    assert.equal(rent.countedAmountMinor, 3_000_00);
    assert.equal((await balanceOf(cashId))?.expectedMinor, 500_00);
  });

  it("can be filtered for, and counted in the to-dos", async () => {
    await threeMessages();
    const listed = await json(await call("/transactions?accountUnknown=1"));
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].merchant, "rent@upi");

    const dashboard = await json(await call("/dashboard"));
    const todo = dashboard.todos.find((item: { kind: string }) => item.kind === "unknown_account");
    assert.deepEqual(todo, {
      kind: "unknown_account",
      title: "1 payment without an account",
      body: "Not counted in any balance until you say which account each was on.",
      count: 1,
      filter: { accountUnknown: "1" },
    });
  });

  it("becomes cash when the user says so, and known when given an account", async () => {
    const { rent } = await threeMessages();

    const asCash = await json(await call(`/transactions/${rent._id}`, { method: "PATCH", body: JSON.stringify({ accountUnknown: false }) }));
    assert.equal(asCash.accountUnknown, false);
    assert.equal(asCash.accountId, null);
    assert.equal((await balanceOf(cashId))?.expectedMinor, 500_00 - 3_000_00);

    const onBank = await json(await call(`/transactions/${rent._id}`, { method: "PATCH", body: JSON.stringify({ accountId: bankId.toString(), accountUnknown: true }) }));
    assert.equal(onBank.accountUnknown, false, "an account named is an account known, whatever else the body says");
    assert.equal((await balanceOf(cashId))?.expectedMinor, 500_00);
    assert.equal((await balanceOf(bankId))?.expectedMinor, 10_000_00 - 500_00 - 3_000_00 - 200_00);
  });

  it("stays cash when typed in by hand with no account", async () => {
    const created = await json(
      await call("/transactions", {
        method: "POST",
        body: JSON.stringify({ amountMinor: 100_00, type: "DEBIT", occurredAt: "2026-10-05T10:00:00+05:30", merchant: "Chai" }),
      })
    );
    assert.equal(created.accountUnknown, false);
    assert.equal((await balanceOf(cashId))?.expectedMinor, 400_00);
  });
});

describe("the passbook", () => {
  it("runs newest first, from the opening row, with the bank's figure beside the app's", async () => {
    const { zepto, swiggy } = await threeMessages();
    const page = await json(await call(`/accounts/${bankId}/passbook`));

    assert.deepEqual(page.account, {
      id: bankId.toString(),
      name: "HDFC Bank",
      bankName: "HDFC Bank",
      last4: "4821",
      accountType: "BANK",
      isSavings: false,
      noCreditAlerts: false,
      canUndoFreshStart: false,
    });
    assert.equal(page.openingMinor, 10_000_00);
    assert.equal(page.expectedNowMinor, 9_300_00);
    assert.deepEqual(
      page.rows.map((row: any) => [row.kind, row.transactionId, row.type, row.amountMinor, row.runningMinor, row.statedMinor, row.driftMinor]),
      [
        ["txn", swiggy._id.toString(), "DEBIT", 200_00, 9_300_00, 6_300_00, -3_000_00],
        ["txn", zepto._id.toString(), "DEBIT", 500_00, 9_500_00, 9_500_00, 0],
        ["opening", null, null, null, 10_000_00, 10_000_00, 0],
      ]
    );
    assert.equal(page.rows[0].merchant, "swiggy@icici");
    assert.equal(page.rows[0].countedReason, "FULL");
    assert.equal(page.rows[0].accountUnknown, false);
    assert.equal(page.lastStated.minor, 6_300_00);
    assert.equal(page.lastStated.driftMinor, -3_000_00);
    assert.equal(page.firstDrift.transactionId, swiggy._id.toString());
    assert.equal(page.firstDrift.driftMinor, -3_000_00);
    assert.equal(page.nextBefore, null);
  });

  it("pages back into the past by cursor, and finds the first drift over the whole history", async () => {
    const { swiggy } = await threeMessages();
    const first = await json(await call(`/accounts/${bankId}/passbook?limit=1`));
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].transactionId, swiggy._id.toString());
    assert.equal(first.nextBefore, 2);
    assert.equal(first.total, 3);
    assert.equal(first.firstDrift.transactionId, swiggy._id.toString());

    const second = await json(await call(`/accounts/${bankId}/passbook?limit=1&before=${first.nextBefore}`));
    assert.equal(second.rows[0].kind, "txn");
    assert.equal(second.rows[0].seq, 1);
    assert.equal(second.nextBefore, 1);

    const last = await json(await call(`/accounts/${bankId}/passbook?limit=5&before=${second.nextBefore}`));
    assert.deepEqual(last.rows.map((row: any) => row.kind), ["opening"]);
    assert.equal(last.nextBefore, null);
  });

  it("is not for a credit card, a debit card or an account with no starting balance", async () => {
    const card = await models.Account.create({ userId, bankName: "HDFC Bank", last4: "1377", accountType: "CARD" });
    assert.equal((await call(`/accounts/${card._id}/passbook`)).status, 400);

    const debit = await models.Account.create({ userId, bankName: "HDFC Debit", last4: "2222", accountType: "DEBIT", linkedAccountId: bankId });
    const response = await call(`/accounts/${debit._id}/passbook`);
    assert.equal(response.status, 400);
    assert.equal((await json(response)).accountId, bankId.toString(), "points at the bank account instead");

    const untracked = await models.Account.create({ userId, bankName: "SBI", last4: "9999", accountType: "BANK" });
    assert.equal((await call(`/accounts/${untracked._id}/passbook`)).status, 400);
  });

  it("includes checkpoints and adjustments in the sequence", async () => {
    await threeMessages();
    const checkpoint = await json(
      await call(`/accounts/${bankId}/checkpoints`, {
        method: "POST",
        body: JSON.stringify({ balanceMinor: 6_250_00, on: "2026-10-05T20:00:00+05:30", note: "bank app" }),
      })
    );
    assert.equal(checkpoint.source, "MANUAL");

    await call(`/accounts/${bankId}/reconcile/adjust`, {
      method: "POST",
      body: JSON.stringify({ balanceMinor: 6_250_00, on: "2026-10-06T09:00:00+05:30" }),
    });

    const page = await json(await call(`/accounts/${bankId}/passbook`));
    assert.deepEqual(
      page.rows.map((row: any) => [row.kind, row.runningMinor, row.statedMinor, row.driftMinor]),
      [
        // Typed in when adjusting: the bank's word for that moment.
        ["checkpoint", 6_250_00, 6_250_00, 0],
        ["adjustment", 6_250_00, null, null],
        ["checkpoint", 9_300_00, 6_250_00, -3_050_00],
        ["txn", 9_300_00, 6_300_00, -3_000_00],
        ["txn", 9_500_00, 9_500_00, 0],
        ["opening", 10_000_00, 10_000_00, 0],
      ]
    );
    assert.equal(page.rows[2].checkpointId, checkpoint.id);
    assert.equal(page.rows[2].note, "bank app");
    assert.equal(page.rows[1].needsExplanation, true);
    assert.equal(page.rows[1].merchant, "Unexplained difference");

    const listed = await json(await call(`/accounts/${bankId}/checkpoints`));
    assert.equal(listed.length, 2);
    assert.equal((await call(`/accounts/${bankId}/checkpoints/${checkpoint.id}`, { method: "DELETE" })).status, 204);
    assert.equal((await json(await call(`/accounts/${bankId}/checkpoints`))).length, 1);
  });
});

describe("reconciling", () => {
  it("says how far off the account is, where it went wrong, and what could explain it", async () => {
    const { rent, swiggy } = await threeMessages();
    const result = await json(await call(`/accounts/${bankId}/reconcile`));

    assert.equal(result.expectedMinor, 9_300_00);
    assert.equal(result.differenceMinor, -3_000_00);
    assert.equal(result.lastStated.transactionId, swiggy._id.toString());
    assert.equal(result.firstDrift.transactionId, swiggy._id.toString());

    const unknown = result.suspects[0];
    assert.equal(unknown.kind, "unknown_account");
    assert.deepEqual(unknown.transactionIds, [rent._id.toString()]);
    assert.equal(unknown.amountMinor, 3_000_00);
    assert.deepEqual(unknown.fix, {
      method: "PATCH",
      path: `/transactions/${rent._id}`,
      body: { accountId: bankId.toString() },
      label: "It was on this account",
    });
    assert.equal(unknown.score, undefined, "the score is for ordering, not for showing");

    const days = result.suspects.find((suspect: { kind: string }) => suspect.kind === "missing_days");
    assert.ok(days, "the span between the clean figure and the first drift is named");
    assert.equal(days.amountMinor, 3_000_00);
    assert.match(days.explanation, /between 2 Oct and 4 Oct/);

    // Applying the fix closes the gap.
    await call(unknown.fix.path, { method: unknown.fix.method, body: JSON.stringify(unknown.fix.body) });
    const after = await json(await call(`/accounts/${bankId}/reconcile`));
    assert.equal(after.differenceMinor, 0);
    assert.equal(after.firstDrift, null);
  });

  it("finds a payment filed twice and offers to merge it", async () => {
    await threeMessages();
    // Reported again by a message dedup did not pair: the row had already
    // been given its account and the second named none.
    const again = await models.Transaction.create({
      userId,
      accountId: bankId,
      type: "DEBIT",
      amountMinor: 200_00,
      merchant: "swiggy@icici",
      source: "EMAIL",
      sourceRef: "mail-swiggy",
      occurredAt: new Date("2026-10-04T10:04:00+05:30"),
    });
    const result = await json(await call(`/accounts/${bankId}/reconcile`));
    const duplicate = result.suspects.find((suspect: { kind: string }) => suspect.kind === "duplicate");
    assert.ok(duplicate);
    assert.ok(duplicate.transactionIds.includes(again._id.toString()));
    assert.equal(duplicate.fix.method, "POST");
    assert.match(duplicate.fix.path, /\/merge$/);
  });

  it("names a card bill filed under the card it paid", async () => {
    const card = await models.Account.create({ userId, bankName: "ICICI Bank", last4: "2009", accountType: "CARD" });
    await threeMessages();
    // The parser alone takes the card's number for the account.
    await models.Transaction.create({
      userId,
      accountId: card._id,
      type: "DEBIT",
      amountMinor: 3_000_00,
      merchant: "ICICI Bank Credit Card",
      source: "SMS",
      rawText: "Rs 3,000.00 debited from HDFC Bank A/c XX4821 on 03-10-26 towards ICICI Bank Credit Card XX2009. Ref 123123123",
      occurredAt: new Date("2026-10-03T12:00:00+05:30"),
    });
    const result = await json(await call(`/accounts/${bankId}/reconcile`));
    const bill = result.suspects.find((suspect: { kind: string }) => suspect.kind === "card_bill_on_card");
    assert.ok(bill, "the bank's message says this account paid it");
    assert.deepEqual(bill.fix.body, { accountId: bankId.toString(), cardPaymentFor: card._id.toString() });
  });

  it("writes the gap in as a counted row that waits to be explained", async () => {
    await threeMessages();
    const response = await call(`/accounts/${bankId}/reconcile/adjust`, {
      method: "POST",
      body: JSON.stringify({ balanceMinor: 6_300_00 }),
    });
    assert.equal(response.status, 201);
    const { gapMinor, transaction, checkpoint } = await json(response);
    assert.equal(gapMinor, -3_000_00);
    assert.equal(transaction.type, "DEBIT", "the app showed more than the bank, so money goes out");
    assert.equal(transaction.amountMinor, 3_000_00);
    assert.equal(transaction.merchant, "Unexplained difference");
    assert.equal(transaction.isAdjustment, true);
    assert.equal(transaction.needsExplanation, true);
    assert.equal(transaction.countedAmountMinor, 3_000_00, "it stays visible as spending");
    assert.equal(checkpoint.balanceMinor, 6_300_00);

    assert.equal((await balanceOf(bankId))?.expectedMinor, 6_300_00);
    assert.equal((await balanceOf(bankId))?.drift, null);

    const dashboard = await json(await call("/dashboard"));
    const todo = dashboard.todos.find((item: { kind: string }) => item.kind === "unexplained_difference");
    assert.equal(todo.transactionId, transaction.id);
    assert.equal(todo.title, "₹3,000 unexplained out of HDFC Bank ••4821");

    const listed = await json(await call("/transactions?needsExplanation=1"));
    assert.equal(listed.total, 1);

    // A category explains it.
    const category = await models.Category.create({ name: "Rent", isSystem: true, userId: null });
    const filed = await json(await call(`/transactions/${transaction.id}`, { method: "PATCH", body: JSON.stringify({ categoryId: category._id.toString() }) }));
    assert.equal(filed.needsExplanation, false);
    assert.equal((await json(await call("/transactions?needsExplanation=1"))).total, 0);
  });

  it("writes a credit when the bank shows more, and refuses when nothing is off", async () => {
    await threeMessages();
    const { transaction } = await json(
      await call(`/accounts/${bankId}/reconcile/adjust`, { method: "POST", body: JSON.stringify({ balanceMinor: 9_800_00 }) })
    );
    assert.equal(transaction.type, "CREDIT");
    assert.equal(transaction.amountMinor, 500_00);

    const again = await call(`/accounts/${bankId}/reconcile/adjust`, { method: "POST", body: JSON.stringify({ balanceMinor: 9_800_00 }) });
    assert.equal(again.status, 400);
  });

  it("clears the explanation flag on request, or when given a merchant", async () => {
    await threeMessages();
    const { transaction } = await json(
      await call(`/accounts/${bankId}/reconcile/adjust`, { method: "POST", body: JSON.stringify({ balanceMinor: 6_300_00 }) })
    );
    const cleared = await json(await call(`/transactions/${transaction.id}`, { method: "PATCH", body: JSON.stringify({ needsExplanation: false }) }));
    assert.equal(cleared.needsExplanation, false);

    const { transaction: other } = await json(
      await call(`/accounts/${bankId}/reconcile/adjust`, { method: "POST", body: JSON.stringify({ balanceMinor: 1_000_00 }) })
    );
    const named = await json(await call(`/transactions/${other.id}`, { method: "PATCH", body: JSON.stringify({ merchant: "Cash to Dad" }) }));
    assert.equal(named.needsExplanation, false);
  });
});

describe("pairing two legs of a transfer by hand", () => {
  it("marks both as one transfer, so neither balance moves twice", async () => {
    const out = await models.Transaction.create({
      userId,
      accountId: bankId,
      type: "DEBIT",
      amountMinor: 1_000_00,
      source: "MANUAL",
      isTransfer: true,
      transferAccountId: cashId,
      occurredAt: new Date("2026-10-05T10:00:00+05:30"),
    });
    const inn = await models.Transaction.create({
      userId,
      accountId: cashId,
      type: "CREDIT",
      amountMinor: 1_000_00,
      source: "MANUAL",
      occurredAt: new Date("2026-10-05T10:30:00+05:30"),
    });
    assert.equal((await balanceOf(cashId))?.expectedMinor, 500_00 + 2_000_00, "counted twice before pairing");

    const response = await call(`/transactions/${out._id}/pair`, { method: "POST", body: JSON.stringify({ withId: inn._id.toString() }) });
    assert.equal(response.status, 200);
    assert.equal((await balanceOf(cashId))?.expectedMinor, 500_00 + 1_000_00);
    assert.equal((await balanceOf(bankId))?.expectedMinor, 9_000_00);

    const paired = await models.Transaction.findById(inn._id).orFail();
    assert.equal(paired.isTransfer, true);
    assert.ok(paired.transferPairId?.equals(out._id));
    assert.ok(paired.transferAccountId?.equals(bankId));
    assert.equal(paired.countedAmountMinor, 0);
  });
});

describe("the backfills", () => {
  it("read the balance off messages already stored, once", async () => {
    const stored = await models.Transaction.create({
      userId,
      accountId: bankId,
      type: "DEBIT",
      amountMinor: 500_00,
      source: "SMS",
      rawText: ZEPTO,
      occurredAt: new Date("2026-10-02T10:00:00+05:30"),
    });
    const fromEmail = await models.Transaction.create({
      userId,
      accountId: bankId,
      type: "DEBIT",
      amountMinor: 200_00,
      source: "SMS",
      rawText: "Rs 200 debited from A/c XX4821 to swiggy -HDFC Bank",
      sources: [
        { source: "SMS", rawText: "Rs 200 debited from A/c XX4821 to swiggy -HDFC Bank", receivedAt: new Date() },
        { source: "EMAIL", rawText: SWIGGY, receivedAt: new Date() },
      ],
      occurredAt: new Date("2026-10-04T10:00:00+05:30"),
    });
    const manual = await models.Transaction.create({
      userId,
      accountId: bankId,
      type: "DEBIT",
      amountMinor: 50_00,
      source: "MANUAL",
      note: "Avl Bal Rs 1",
      occurredAt: new Date("2026-10-04T11:00:00+05:30"),
    });

    assert.equal(await backfill.backfillStatedBalances(userId), 2);
    assert.equal((await models.Transaction.findById(stored._id))?.statedBalanceMinor, 9_500_00);
    assert.equal((await models.Transaction.findById(fromEmail._id))?.statedBalanceMinor, 6_300_00);
    assert.equal((await models.Transaction.findById(manual._id))?.statedBalanceMinor, null);
    assert.equal(await backfill.backfillStatedBalances(userId), 0, "nothing left to fill");
  });

  it("stop counting unplaced payments as cash, and leave edited rows alone", async () => {
    const guessed = await models.Transaction.create({
      userId,
      accountId: null,
      type: "DEBIT",
      amountMinor: 3_000_00,
      source: "SMS",
      rawText: RENT,
      occurredAt: new Date("2026-10-03T10:00:00+05:30"),
    });
    const corrected = await models.Transaction.create({
      userId,
      accountId: null,
      type: "DEBIT",
      amountMinor: 100_00,
      source: "SMS",
      rawText: RENT,
      editedAt: new Date(),
      occurredAt: new Date("2026-10-03T11:00:00+05:30"),
    });
    const named = await models.Transaction.create({
      userId,
      accountId: null,
      type: "DEBIT",
      amountMinor: 70_00,
      source: "SMS",
      rawText: ZEPTO,
      occurredAt: new Date("2026-10-03T12:00:00+05:30"),
    });
    const typed = await models.Transaction.create({
      userId,
      accountId: null,
      type: "DEBIT",
      amountMinor: 40_00,
      source: "MANUAL",
      occurredAt: new Date("2026-10-03T13:00:00+05:30"),
    });
    assert.equal((await balanceOf(cashId))?.expectedMinor, 500_00 - 3_210_00);

    assert.equal(await backfill.backfillAccountUnknown(userId), 1);
    assert.equal((await models.Transaction.findById(guessed._id))?.accountUnknown, true);
    for (const row of [corrected, named, typed]) {
      assert.equal((await models.Transaction.findById(row._id))?.accountUnknown, false);
    }
    assert.equal((await balanceOf(cashId))?.expectedMinor, 500_00 - 210_00, "the guess has left the cash balance");
    assert.equal(await backfill.backfillAccountUnknown(userId), 0);
  });
});
