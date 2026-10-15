import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { istDayStart } from "../../time";
import { CompareRow, compareLines } from "./statements.compare";

const own = "acc-own";
const elsewhere = "acc-other";

function line(fields: { id: string; day: string; amountMinor: number; type?: "DEBIT" | "CREDIT"; kind?: "SPEND" | "FEE" | "INCOME" | "PAYMENT" | "NOISE" }) {
  return {
    lineId: fields.id,
    date: istDayStart(fields.day),
    description: fields.id.toUpperCase(),
    amountMinor: fields.amountMinor,
    type: fields.type ?? "DEBIT",
    kind: fields.kind ?? "SPEND",
  };
}

function row(fields: { id: string; at: string; amountMinor: number; type?: "DEBIT" | "CREDIT"; accountId?: string | null }): CompareRow {
  return {
    transactionId: fields.id,
    occurredAt: new Date(fields.at),
    merchant: fields.id,
    amountMinor: fields.amountMinor,
    type: fields.type ?? "DEBIT",
    accountId: fields.accountId === undefined ? own : fields.accountId,
  };
}

describe("a statement beside the ledger", () => {
  it("matches by amount, direction and two days either way", () => {
    const result = compareLines(
      [line({ id: "swiggy", day: "2026-09-14", amountMinor: 432_50 }), line({ id: "zepto", day: "2026-09-20", amountMinor: 240_00 })],
      [
        row({ id: "t1", at: "2026-09-12T20:00:00+05:30", amountMinor: 432_50 }), // two days before: posting lag
        row({ id: "t2", at: "2026-09-17T20:00:00+05:30", amountMinor: 240_00 }), // three days off: not it
        row({ id: "t3", at: "2026-09-14T20:00:00+05:30", amountMinor: 432_50, type: "CREDIT" }), // wrong way
      ],
      new Set([own])
    );

    assert.deepEqual(result.pairs, [{ lineId: "swiggy", transactionId: "t1" }]);
    assert.deepEqual(result.onStatementNotInApp.map((l) => l.lineId), ["zepto"]);
    assert.deepEqual(result.inAppNotOnStatement.map((r) => r.transactionId).sort(), ["t2", "t3"]);
    assert.equal(result.matched, 1);
  });

  it("prefers a row on the statement's own account, and takes one elsewhere when there is none", () => {
    const result = compareLines(
      [line({ id: "a", day: "2026-09-14", amountMinor: 100_00 }), line({ id: "b", day: "2026-09-16", amountMinor: 200_00 })],
      [
        row({ id: "wrong-account", at: "2026-09-14T10:00:00+05:30", amountMinor: 100_00, accountId: elsewhere }),
        row({ id: "right-account", at: "2026-09-15T10:00:00+05:30", amountMinor: 100_00 }),
        row({ id: "filed-elsewhere", at: "2026-09-16T10:00:00+05:30", amountMinor: 200_00, accountId: elsewhere }),
      ],
      new Set([own])
    );

    assert.deepEqual(result.pairs, [
      { lineId: "a", transactionId: "right-account" },
      { lineId: "b", transactionId: "filed-elsewhere" },
    ]);
    // A row on another account is never "in the app, not on the statement"
    // for this account.
    assert.deepEqual(result.inAppNotOnStatement, []);
  });

  it("lets each row answer for one line only", () => {
    const result = compareLines(
      [line({ id: "first", day: "2026-09-14", amountMinor: 100_00 }), line({ id: "second", day: "2026-09-14", amountMinor: 100_00 })],
      [row({ id: "only", at: "2026-09-14T10:00:00+05:30", amountMinor: 100_00 })],
      new Set([own])
    );
    assert.equal(result.matched, 1);
    assert.deepEqual(result.onStatementNotInApp.map((l) => l.lineId), ["second"]);
  });

  it("leaves page furniture and a card's bill payment out of the question", () => {
    const result = compareLines(
      [line({ id: "noise", day: "2026-09-14", amountMinor: 1, kind: "NOISE" }), line({ id: "pay", day: "2026-09-14", amountMinor: 5_000_00, type: "CREDIT", kind: "PAYMENT" })],
      [],
      new Set([own])
    );
    assert.deepEqual(result.onStatementNotInApp, []);
  });
});
