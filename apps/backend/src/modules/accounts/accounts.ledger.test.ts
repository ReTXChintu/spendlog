import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Types } from "mongoose";
import { LedgerCheckpoint, LedgerRow, buildLedger, driftOf, ledgerContext, ledgerFilter, movementsOf } from "./accounts.balance";
import {
  SuspectRow,
  duplicateSuspects,
  exactMatchSuspects,
  missingDaysSuspects,
  oneSidedTransferSuspects,
  rankSuspects,
  unknownAccountSuspects,
} from "./accounts.suspects";

const bank = new Types.ObjectId();
const cash = new Types.ObjectId();
const card = new Types.ObjectId();
const other = new Types.ObjectId();
const opening = new Date("2026-10-01T00:00:00+05:30");

const accounts = [
  { _id: bank, accountType: "BANK" as const, linkedAccountId: null, openingBalanceMinor: 10_000_00, openingBalanceAt: opening },
  { _id: cash, accountType: "CASH" as const, linkedAccountId: null, openingBalanceMinor: 500_00, openingBalanceAt: opening },
  { _id: card, accountType: "DEBIT" as const, linkedAccountId: bank, openingBalanceMinor: null, openingBalanceAt: null },
  { _id: other, accountType: "BANK" as const, linkedAccountId: null, openingBalanceMinor: null, openingBalanceAt: null },
];
const context = ledgerContext(accounts);

function row(fields: Partial<Omit<LedgerRow, "occurredAt">> & { amountMinor: number; type: "DEBIT" | "CREDIT"; occurredAt: string }): LedgerRow {
  return {
    _id: new Types.ObjectId(),
    accountId: bank,
    isTransfer: false,
    transferAccountId: null,
    transferPairId: null,
    merchant: null,
    source: "SMS",
    ...fields,
    occurredAt: new Date(fields.occurredAt),
  };
}

describe("which balances a row moves", () => {
  it("moves the account it is on, and a debit card's moves its bank", () => {
    assert.deepEqual(movementsOf(row({ amountMinor: 100, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z" }), context).map((m) => m.owner), [bank.toString()]);
    assert.deepEqual(
      movementsOf(row({ accountId: card, amountMinor: 100, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z" }), context).map((m) => m.owner),
      [bank.toString()]
    );
  });

  it("counts a row with no account as cash, unless nobody knows the account", () => {
    const paid = row({ accountId: null, amountMinor: 100, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z" });
    assert.deepEqual(movementsOf(paid, context).map((m) => m.owner), [cash.toString()]);
    assert.deepEqual(movementsOf({ ...paid, accountUnknown: true }, context), []);
  });

  it("moves the other account of a one-row transfer, the other way, and not a paired one", () => {
    const transfer = row({ amountMinor: 100, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z", isTransfer: true, transferAccountId: cash });
    const moves = movementsOf(transfer, context);
    assert.deepEqual(
      moves.map((m) => [m.owner, m.type, m.viaTransfer]),
      [
        [bank.toString(), "DEBIT", false],
        [cash.toString(), "CREDIT", true],
      ]
    );
    assert.equal(movementsOf({ ...transfer, transferPairId: new Types.ObjectId() }, context).length, 1);
  });

  it("moves nothing at all for a group payment somebody else made", () => {
    // No account, and not cash: the money was never the user's.
    const theirs = row({ accountId: null, amountMinor: 2000_00, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z", offLedger: true });
    assert.deepEqual(movementsOf(theirs, context), []);
    // Not even if something were to give it an account or call it a transfer.
    assert.deepEqual(movementsOf({ ...theirs, accountId: bank, isTransfer: true, transferAccountId: cash }, context), []);
  });

  it("leaves it out of the rows a cash passbook reads", () => {
    const filter = ledgerFilter(new Types.ObjectId(), context, [cash.toString()]);
    assert.deepEqual(filter.$or[0], { accountId: { $in: [cash] } });
    assert.deepEqual(filter.$or[1], { accountId: null, offLedger: { $ne: true } });
  });

  it("moves nothing before the starting balance was read", () => {
    assert.deepEqual(movementsOf(row({ amountMinor: 100, type: "DEBIT", occurredAt: "2026-09-30T10:00:00Z" }), context), []);
  });
});

function ledgerOf(rows: LedgerRow[], checkpoints: LedgerCheckpoint[] = []) {
  const moves = rows.flatMap((r) => movementsOf(r, context).filter((m) => m.owner === bank.toString()).map((move) => ({ row: r, move })));
  return buildLedger({ accountId: bank.toString(), openingMinor: 10_000_00, openingAt: opening, moves, checkpoints });
}

describe("the passbook's running balance and drift", () => {
  it("runs from the opening row, and sets each stated figure against it", () => {
    const ledger = ledgerOf([
      row({ amountMinor: 500_00, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z", statedBalanceMinor: 9_500_00 }),
      row({ amountMinor: 2_000_00, type: "CREDIT", occurredAt: "2026-10-03T10:00:00Z" }),
      row({ amountMinor: 300_00, type: "DEBIT", occurredAt: "2026-10-04T10:00:00Z", statedBalanceMinor: 8_200_00 }),
    ]);

    assert.deepEqual(
      ledger.entries.map((e) => [e.kind, e.runningMinor, e.statedMinor, e.driftMinor]),
      [
        ["opening", 10_000_00, 10_000_00, 0],
        ["txn", 9_500_00, 9_500_00, 0],
        ["txn", 11_500_00, null, null],
        ["txn", 11_200_00, 8_200_00, -3_000_00],
      ]
    );
    assert.equal(ledger.expectedNowMinor, 11_200_00);
    assert.equal(ledger.lastStated?.driftMinor, -3_000_00);
    // The first drift is the row where the two parted, and the clean figure
    // before it is where to start looking.
    assert.equal(ledger.firstDrift?.seq, 3);
    assert.equal(ledger.cleanBefore?.seq, 1);
    assert.deepEqual(driftOf(ledger), { minor: -3_000_00, since: ledger.entries[3].at, statedAt: ledger.entries[3].at });
  });

  it("absorbs a rupee of rounding without calling it a drift", () => {
    const ledger = ledgerOf([row({ amountMinor: 500_00, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z", statedBalanceMinor: 9_499_50 })]);
    assert.equal(ledger.firstDrift, null);
    assert.equal(driftOf(ledger), null);
  });

  it("keeps the first drift once found, even when a later figure agrees again", () => {
    const ledger = ledgerOf([
      row({ amountMinor: 100_00, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z", statedBalanceMinor: 9_000_00 }),
      row({ amountMinor: 100_00, type: "DEBIT", occurredAt: "2026-10-03T10:00:00Z", statedBalanceMinor: 9_800_00 }),
    ]);
    assert.equal(ledger.firstDrift?.seq, 1);
    assert.equal(ledger.cleanBefore, null);
    assert.equal(ledger.lastStated?.driftMinor, 0);
  });

  it("reads a checkpoint as a stated figure, after that instant's rows", () => {
    const at = new Date("2026-10-02T10:00:00Z");
    const ledger = ledgerOf(
      [row({ amountMinor: 500_00, type: "DEBIT", occurredAt: at.toISOString() })],
      [{ _id: new Types.ObjectId(), accountId: bank, on: at, balanceMinor: 9_500_00, source: "MANUAL", note: "bank app" }]
    );
    assert.deepEqual(ledger.entries.map((e) => e.kind), ["opening", "txn", "checkpoint"]);
    assert.equal(ledger.entries[2].driftMinor, 0);
    assert.equal(ledger.entries[2].note, "bank app");
  });

  it("shows the far leg of a transfer as money the other way, with no stated figure", () => {
    const transfer = row({
      accountId: other,
      amountMinor: 700_00,
      type: "DEBIT",
      occurredAt: "2026-10-02T10:00:00Z",
      isTransfer: true,
      transferAccountId: bank,
      statedBalanceMinor: 1_00,
    });
    const ledger = ledgerOf([transfer]);
    const entry = ledger.entries[1];
    assert.equal(entry.type, "CREDIT");
    assert.equal(entry.runningMinor, 10_700_00);
    assert.equal(entry.statedMinor, null);
    assert.equal(entry.transferAccountId, other.toString());
  });

  it("marks an adjustment as its own kind of row", () => {
    const ledger = ledgerOf([row({ amountMinor: 3_000_00, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z", isAdjustment: true, needsExplanation: true })]);
    assert.equal(ledger.entries[1].kind, "adjustment");
    assert.equal(ledger.entries[1].needsExplanation, true);
  });
});

function suspectRow(fields: Partial<Omit<SuspectRow, "occurredAt">> & { amountMinor: number; type: "DEBIT" | "CREDIT"; occurredAt: string }): SuspectRow {
  return {
    id: new Types.ObjectId().toString(),
    accountId: bank.toString(),
    merchant: null,
    sourceRef: null,
    isTransfer: false,
    transferAccountId: null,
    transferPairId: null,
    cardPaymentFor: null,
    accountUnknown: false,
    ...fields,
    occurredAt: new Date(fields.occurredAt),
  };
}

describe("what could explain a gap", () => {
  const gap = -3_000_00; // the app shows ₹3,000 more than the bank

  it("names a payment with no account that is exactly the gap", () => {
    const missing = suspectRow({ accountId: null, accountUnknown: true, amountMinor: 3_000_00, type: "DEBIT", occurredAt: "2026-10-03T10:00:00Z", merchant: "Zepto" });
    const small = suspectRow({ accountId: null, accountUnknown: true, amountMinor: 200_00, type: "DEBIT", occurredAt: "2026-10-03T11:00:00Z" });
    const credit = suspectRow({ accountId: null, accountUnknown: true, amountMinor: 3_000_00, type: "CREDIT", occurredAt: "2026-10-03T12:00:00Z" });

    const suspects = unknownAccountSuspects([missing, small, credit], gap, bank.toString());
    assert.equal(suspects[0].transactionIds[0], missing.id);
    assert.equal(suspects[0].score, 5);
    assert.deepEqual(suspects[0].fix, {
      method: "PATCH",
      path: `/transactions/${missing.id}`,
      body: { accountId: bank.toString() },
      label: "It was on this account",
    });
    // A credit cannot explain the app showing too much.
    assert.ok(!suspects.some((s) => s.transactionIds.includes(credit.id)));
    // The small one is still listed, lower.
    assert.ok(suspects.some((s) => s.transactionIds.includes(small.id) && s.score === 1));
  });

  it("adds up several payments with no account that make the gap between them", () => {
    const rows = [1_000_00, 2_000_00].map((amount, i) =>
      suspectRow({ accountId: null, accountUnknown: true, amountMinor: amount, type: "DEBIT", occurredAt: `2026-10-0${i + 2}T10:00:00Z` })
    );
    const summed = unknownAccountSuspects(rows, gap, bank.toString()).find((s) => s.transactionIds.length === 2);
    assert.ok(summed);
    assert.equal(summed.amountMinor, 3_000_00);
  });

  it("lists every payment with no account when the bank has never said a figure", () => {
    const rows = [suspectRow({ accountId: null, accountUnknown: true, amountMinor: 50_00, type: "DEBIT", occurredAt: "2026-10-02T10:00:00Z" })];
    assert.equal(unknownAccountSuspects(rows, null, bank.toString()).length, 1);
  });

  it("spots the same payment twice within ten minutes from different messages", () => {
    const first = suspectRow({ amountMinor: 450_00, type: "DEBIT", occurredAt: "2026-10-03T10:00:00Z", sourceRef: "sms-1" });
    const second = suspectRow({ amountMinor: 450_00, type: "DEBIT", occurredAt: "2026-10-03T10:06:00Z", sourceRef: "mail-1" });
    const later = suspectRow({ amountMinor: 450_00, type: "DEBIT", occurredAt: "2026-10-03T11:00:00Z", sourceRef: "sms-2" });
    const sameRef = suspectRow({ amountMinor: 450_00, type: "DEBIT", occurredAt: "2026-10-03T10:07:00Z", sourceRef: "sms-1" });

    const suspects = duplicateSuspects([first, second, later, sameRef], null);
    assert.equal(suspects.length, 1);
    assert.deepEqual(suspects[0].transactionIds, [first.id, second.id]);
    assert.equal(suspects[0].fix?.path, `/transactions/${first.id}/merge`);
    assert.deepEqual(suspects[0].fix?.body, { sourceIds: [second.id] });
  });

  it("scores a duplicate higher when it is the gap exactly", () => {
    // Two debits of ₹3,000 leave the app ₹3,000 lower than the bank: a
    // positive gap.
    const a = suspectRow({ amountMinor: 3_000_00, type: "DEBIT", occurredAt: "2026-10-03T10:00:00Z", sourceRef: "a" });
    const b = suspectRow({ amountMinor: 3_000_00, type: "DEBIT", occurredAt: "2026-10-03T10:01:00Z", sourceRef: "b" });
    assert.equal(duplicateSuspects([a, b], 3_000_00)[0].score, 5);
    assert.equal(duplicateSuspects([a, b], -3_000_00)[0].score, 3);
  });

  it("finds this account counted twice by a transfer recorded on the other one", () => {
    const own = suspectRow({ amountMinor: 5_000_00, type: "CREDIT", occurredAt: "2026-10-03T10:00:00Z" });
    const theirs = suspectRow({
      accountId: other.toString(),
      amountMinor: 5_000_00,
      type: "DEBIT",
      occurredAt: "2026-10-03T09:00:00Z",
      isTransfer: true,
      transferAccountId: bank.toString(),
    });
    const suspects = oneSidedTransferSuspects([own], [theirs], -5_000_00, bank.toString());
    assert.equal(suspects[0].kind, "one_sided_transfer");
    assert.equal(suspects[0].score, 5);
    assert.deepEqual(suspects[0].fix, {
      method: "POST",
      path: `/transactions/${own.id}/pair`,
      body: { withId: theirs.id },
      label: "They are one transfer",
    });
  });

  it("ignores a transfer that already has its pair", () => {
    const own = suspectRow({ amountMinor: 5_000_00, type: "CREDIT", occurredAt: "2026-10-03T10:00:00Z" });
    const theirs = suspectRow({
      accountId: other.toString(),
      amountMinor: 5_000_00,
      type: "DEBIT",
      occurredAt: "2026-10-03T09:00:00Z",
      isTransfer: true,
      transferAccountId: bank.toString(),
      transferPairId: own.id,
    });
    assert.equal(oneSidedTransferSuspects([own], [theirs], null, bank.toString()).length, 0);
  });

  it("mentions a debit here with a matching credit elsewhere, below everything else", () => {
    const own = suspectRow({ amountMinor: 2_000_00, type: "DEBIT", occurredAt: "2026-10-03T10:00:00Z" });
    const theirs = suspectRow({ accountId: other.toString(), amountMinor: 2_000_00, type: "CREDIT", occurredAt: "2026-10-03T20:00:00Z" });
    const [suspect] = oneSidedTransferSuspects([own], [theirs], null, bank.toString());
    assert.equal(suspect.score, 0);
    assert.match(suspect.explanation, /does not change this balance/);
  });

  it("says between which stated figures the bank moved more than the rows explain", () => {
    const ledger = ledgerOf([
      row({ amountMinor: 100_00, type: "DEBIT", occurredAt: "2026-10-12T10:00:00Z", statedBalanceMinor: 9_900_00 }),
      row({ amountMinor: 100_00, type: "DEBIT", occurredAt: "2026-10-14T10:00:00Z", statedBalanceMinor: 6_800_00 }),
      row({ amountMinor: 100_00, type: "DEBIT", occurredAt: "2026-10-15T10:00:00Z", statedBalanceMinor: 6_700_00 }),
    ]);
    const suspects = missingDaysSuspects(ledger, 0);
    assert.equal(suspects.length, 1);
    assert.equal(suspects[0].amountMinor, 3_000_00);
    assert.match(suspects[0].explanation, /between 12 Oct and 14 Oct/);
    assert.match(suspects[0].explanation, /more left the account/);
    // The span where the drift began outranks any other.
    assert.equal(suspects[0].score, 4);
  });

  it("offers one row that is the gap on its own, unless another suspect already names it", () => {
    const credit = suspectRow({ amountMinor: 3_000_00, type: "CREDIT", occurredAt: "2026-10-03T10:00:00Z", merchant: "Refund" });
    assert.equal(exactMatchSuspects([credit], gap, new Set()).length, 1);
    assert.equal(exactMatchSuspects([credit], gap, new Set([credit.id])).length, 0);
    assert.equal(exactMatchSuspects([credit], 3_000_00, new Set()).length, 0, "a credit cannot explain the app showing too little");
  });

  it("ranks likeliest first, then earliest", () => {
    const ranked = rankSuspects([
      { kind: "exact_match", transactionIds: [], amountMinor: 1, explanation: "", on: new Date("2026-10-05"), score: 2 },
      { kind: "duplicate", transactionIds: [], amountMinor: 1, explanation: "", on: new Date("2026-10-04"), score: 5 },
      { kind: "missing_days", transactionIds: [], amountMinor: 1, explanation: "", on: new Date("2026-10-01"), score: 2 },
    ]);
    assert.deepEqual(
      ranked.map((s) => s.kind),
      ["duplicate", "missing_days", "exact_match"]
    );
  });
});
