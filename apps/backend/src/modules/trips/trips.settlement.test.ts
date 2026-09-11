import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeBalances, settle, shareOut, TripExpense } from "./trips.settlement";

const [ANA, BEN, CAL, DEV] = ["ana", "ben", "cal", "dev"];

describe("shareOut", () => {
  it("splits evenly when it divides", () => {
    const shares = shareOut(90000, [ANA, BEN, CAL]);
    assert.deepEqual([...shares.values()], [30000, 30000, 30000]);
  });

  it("never loses a paisa to rounding", () => {
    // ₹100 between three: 33.34 + 33.33 + 33.33, not three times 33.33.
    const shares = shareOut(10000, [ANA, BEN, CAL]);
    const total = [...shares.values()].reduce((sum, share) => sum + share, 0);

    assert.equal(total, 10000);
    assert.deepEqual([...shares.values()].sort((a, b) => b - a), [3334, 3333, 3333]);
  });

  it("splits the same way however the sharers are ordered", () => {
    const forwards = shareOut(10000, [ANA, BEN, CAL]);
    const backwards = shareOut(10000, [CAL, BEN, ANA]);

    assert.deepEqual([...forwards.entries()].sort(), [...backwards.entries()].sort());
  });

  it("gives the whole amount to a single sharer", () => {
    assert.deepEqual([...shareOut(12345, [ANA]).values()], [12345]);
  });

  it("shares nothing between nobody", () => {
    assert.equal(shareOut(10000, []).size, 0);
  });
});

describe("computeBalances", () => {
  it("leaves one person who paid for themselves square", () => {
    const balances = computeBalances([{ payerId: ANA, amountMinor: 50000, sharerIds: [ANA] }]);

    assert.equal(balances.length, 1);
    assert.equal(balances[0].netMinor, 0);
  });

  it("puts half a shared bill on the other person", () => {
    const balances = computeBalances([
      { payerId: ANA, amountMinor: 100000, sharerIds: [ANA, BEN] },
    ]);

    const ana = balances.find((b) => b.userId === ANA)!;
    const ben = balances.find((b) => b.userId === BEN)!;

    assert.equal(ana.paidMinor, 100000);
    assert.equal(ana.netMinor, 50000, "owed half back");
    assert.equal(ben.netMinor, -50000, "owes half");
  });

  it("leaves a personal expense out of everyone else's arithmetic", () => {
    // A souvenir bought for yourself, on a trip with three people.
    const balances = computeBalances([
      { payerId: ANA, amountMinor: 90000, sharerIds: [ANA, BEN, CAL] },
      { payerId: BEN, amountMinor: 40000, sharerIds: [BEN] },
    ]);

    const cal = balances.find((b) => b.userId === CAL)!;
    assert.equal(cal.netMinor, -30000, "only their share of the shared bill");

    const ben = balances.find((b) => b.userId === BEN)!;
    assert.equal(ben.netMinor, -30000, "the souvenir cancels itself out");
  });

  it("always sums to zero", () => {
    const expenses: TripExpense[] = [
      { payerId: ANA, amountMinor: 123457, sharerIds: [ANA, BEN, CAL] },
      { payerId: BEN, amountMinor: 6667, sharerIds: [ANA, BEN, CAL, DEV] },
      { payerId: CAL, amountMinor: 100, sharerIds: [ANA, DEV] },
      { payerId: DEV, amountMinor: 99999, sharerIds: [DEV] },
    ];

    const total = computeBalances(expenses).reduce((sum, b) => sum + b.netMinor, 0);
    assert.equal(total, 0, "every paisa is accounted to somebody");
  });

  it("ignores an expense shared with nobody", () => {
    const balances = computeBalances([{ payerId: ANA, amountMinor: 50000, sharerIds: [] }]);
    assert.deepEqual(balances, []);
  });
});

describe("settle", () => {
  function check(expenses: TripExpense[]) {
    const balances = computeBalances(expenses);
    const transfers = settle(balances);

    // Applying the transfers must leave everyone at zero, which is the
    // only property that really matters.
    const after = new Map(balances.map((b) => [b.userId, b.netMinor]));
    for (const transfer of transfers) {
      after.set(transfer.fromUserId, (after.get(transfer.fromUserId) ?? 0) + transfer.amountMinor);
      after.set(transfer.toUserId, (after.get(transfer.toUserId) ?? 0) - transfer.amountMinor);
    }

    for (const [userId, remaining] of after) {
      assert.equal(remaining, 0, `${userId} still off by ${remaining}`);
    }
    return transfers;
  }

  it("has nothing to do when everyone is square", () => {
    assert.deepEqual(settle(computeBalances([{ payerId: ANA, amountMinor: 100, sharerIds: [ANA] }])), []);
  });

  it("settles two people with one payment", () => {
    const transfers = check([{ payerId: ANA, amountMinor: 100000, sharerIds: [ANA, BEN] }]);

    assert.deepEqual(transfers, [{ fromUserId: BEN, toUserId: ANA, amountMinor: 50000 }]);
  });

  it("settles three people who split one bill with two payments, not three", () => {
    const transfers = check([{ payerId: ANA, amountMinor: 90000, sharerIds: [ANA, BEN, CAL] }]);

    assert.equal(transfers.length, 2);
    assert.ok(transfers.every((t) => t.toUserId === ANA));
  });

  it("needs at most one payment fewer than there are people", () => {
    const transfers = check([
      { payerId: ANA, amountMinor: 120000, sharerIds: [ANA, BEN, CAL, DEV] },
      { payerId: BEN, amountMinor: 40000, sharerIds: [ANA, BEN, CAL, DEV] },
      { payerId: CAL, amountMinor: 8000, sharerIds: [ANA, BEN, CAL, DEV] },
    ]);

    assert.ok(transfers.length <= 3, `${transfers.length} transfers for four people`);
  });

  it("settles a lopsided trip where one person paid for everything", () => {
    const transfers = check([
      { payerId: ANA, amountMinor: 400000, sharerIds: [ANA, BEN, CAL, DEV] },
    ]);

    assert.equal(transfers.length, 3);
    assert.ok(transfers.every((t) => t.amountMinor === 100000));
  });

  it("copes with amounts that do not divide", () => {
    check([
      { payerId: ANA, amountMinor: 10000, sharerIds: [ANA, BEN, CAL] },
      { payerId: BEN, amountMinor: 1, sharerIds: [ANA, BEN, CAL] },
      { payerId: CAL, amountMinor: 77777, sharerIds: [ANA, BEN, CAL, DEV] },
    ]);
  });

  it("never asks anybody to pay themselves", () => {
    const transfers = check([
      { payerId: ANA, amountMinor: 90000, sharerIds: [ANA, BEN, CAL] },
      { payerId: BEN, amountMinor: 30000, sharerIds: [ANA, BEN, CAL] },
    ]);

    assert.ok(transfers.every((t) => t.fromUserId !== t.toUserId));
  });

  it("never invents a transfer of nothing", () => {
    const transfers = check([
      { payerId: ANA, amountMinor: 60000, sharerIds: [ANA, BEN] },
      { payerId: BEN, amountMinor: 60000, sharerIds: [ANA, BEN] },
    ]);

    assert.deepEqual(transfers, [], "two people who each paid half owe nothing");
  });
});
