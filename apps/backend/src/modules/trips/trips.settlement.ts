/**
 * Who owes whom at the end of a trip.
 *
 * Kept free of the database so the arithmetic can be checked directly: the
 * failure mode here is a balance that looks plausible and is wrong by a
 * few rupees, which no amount of clicking around would reveal.
 */

export interface TripExpense {
  /** Who actually paid. */
  payerId: string;
  /** What it counts for — after any split, refund or transfer rule. */
  amountMinor: number;
  /** Everyone it was for. The payer is usually among them. */
  sharerIds: string[];
}

export interface TripBalance {
  userId: string;
  /** What this person put in. */
  paidMinor: number;
  /** What was spent on their behalf. */
  shareMinor: number;
  /** Positive means they are owed; negative means they owe. */
  netMinor: number;
}

export interface TripTransfer {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
}

/**
 * Splits an amount across people in whole paise.
 *
 * The remainder goes to the earliest sharers rather than being dropped: a
 * ₹100 dinner between three has to come to exactly ₹100, or every balance
 * inherits the missing paisa and nothing ever settles to zero.
 */
export function shareOut(amountMinor: number, sharerIds: string[]): Map<string, number> {
  const shares = new Map<string, number>();
  if (sharerIds.length === 0) return shares;

  const ordered = [...sharerIds].sort();
  const base = Math.floor(amountMinor / ordered.length);
  let remainder = amountMinor - base * ordered.length;

  for (const id of ordered) {
    shares.set(id, base + (remainder > 0 ? 1 : 0));
    if (remainder > 0) remainder -= 1;
  }

  return shares;
}

/** What each person put in against what was spent on them. */
export function computeBalances(expenses: TripExpense[]): TripBalance[] {
  const paid = new Map<string, number>();
  const owed = new Map<string, number>();

  const bump = (map: Map<string, number>, id: string, amount: number) =>
    map.set(id, (map.get(id) ?? 0) + amount);

  for (const expense of expenses) {
    if (expense.sharerIds.length === 0) continue;
    bump(paid, expense.payerId, expense.amountMinor);
    for (const [id, share] of shareOut(expense.amountMinor, expense.sharerIds)) {
      bump(owed, id, share);
    }
  }

  const everyone = new Set([...paid.keys(), ...owed.keys()]);

  return [...everyone]
    .map((userId) => {
      const paidMinor = paid.get(userId) ?? 0;
      const shareMinor = owed.get(userId) ?? 0;
      return { userId, paidMinor, shareMinor, netMinor: paidMinor - shareMinor };
    })
    .sort((a, b) => b.netMinor - a.netMinor);
}

/**
 * The payments that square everyone off.
 *
 * Pairs the person owed most with the person owing most, repeatedly. That
 * settles a group in at most one payment fewer than there are people,
 * rather than everybody paying everybody — which for four people is three
 * transfers instead of twelve.
 *
 * It does not try to find the theoretical minimum, which is NP-hard and
 * would save at most a transfer or two on a holiday.
 */
export function settle(balances: TripBalance[]): TripTransfer[] {
  const creditors = balances
    .filter((balance) => balance.netMinor > 0)
    .map((balance) => ({ userId: balance.userId, amount: balance.netMinor }))
    .sort((a, b) => b.amount - a.amount);

  const debtors = balances
    .filter((balance) => balance.netMinor < 0)
    .map((balance) => ({ userId: balance.userId, amount: -balance.netMinor }))
    .sort((a, b) => b.amount - a.amount);

  const transfers: TripTransfer[] = [];
  let c = 0;
  let d = 0;

  while (c < creditors.length && d < debtors.length) {
    const amountMinor = Math.min(creditors[c].amount, debtors[d].amount);

    if (amountMinor > 0) {
      transfers.push({
        fromUserId: debtors[d].userId,
        toUserId: creditors[c].userId,
        amountMinor,
      });
    }

    creditors[c].amount -= amountMinor;
    debtors[d].amount -= amountMinor;

    if (creditors[c].amount === 0) c += 1;
    if (debtors[d].amount === 0) d += 1;
  }

  return transfers;
}
