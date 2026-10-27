/**
 * Who owes whom in a group (it began with trips).
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
  /** Each one's part when it was not split equally; see sharesOf. */
  shareAmounts?: ShareAmount[] | null;
}

/** One member's part of a group payment, typed by hand rather than equal. */
export interface ShareAmount {
  memberId: string;
  amountMinor: number;
}

/**
 * What one person owed another before any payment here: a group's opening
 * balance, already turned the right way round - `fromId` owes `toId`.
 */
export interface TripOpening {
  fromId: string;
  toId: string;
  amountMinor: number;
}

export interface TripBalance {
  userId: string;
  /** What this person put in. */
  paidMinor: number;
  /** What was spent on their behalf. */
  shareMinor: number;
  /**
   * Where they stood before any payment, from opening balances: positive
   * owed to them, negative owed by them. Apart from paid and share, which
   * stay what was spent, so a starting debt never reads as spending.
   */
  openingMinor: number;
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

/**
 * Splits an amount in proportion to parts typed by hand.
 *
 * The parts add up to the payment when they are saved, and then each gets
 * exactly its own. When the amount differs - the payment was edited, or
 * part of it came back as a refund - each keeps its proportion, in whole
 * paise, the leftover paise going to the largest remainders so the parts
 * still come to the amount exactly.
 */
export function shareByAmounts(amountMinor: number, amounts: ShareAmount[]): Map<string, number> {
  const shares = new Map<string, number>();
  const positive = amounts.filter((entry) => entry.amountMinor > 0);
  const total = positive.reduce((sum, entry) => sum + entry.amountMinor, 0);
  if (total <= 0) return shares;

  const ordered = [...positive].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
  const exact = ordered.map((entry) => (amountMinor * entry.amountMinor) / total);
  const floors = exact.map(Math.floor);
  let remainder = amountMinor - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, fraction: value - floors[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const { index } of byRemainder) {
    if (remainder <= 0) break;
    floors[index] += 1;
    remainder -= 1;
  }
  ordered.forEach((entry, index) => shares.set(entry.memberId, floors[index]));
  return shares;
}

/** Each sharer's part: the amounts typed by hand when there are any, else equal. */
export function sharesOf(
  amountMinor: number,
  sharerIds: string[],
  amounts?: ShareAmount[] | null
): Map<string, number> {
  return amounts?.some((entry) => entry.amountMinor > 0)
    ? shareByAmounts(amountMinor, amounts)
    : shareOut(amountMinor, sharerIds);
}

/**
 * What each person put in against what was spent on them, starting from
 * whatever they already owed each other.
 */
export function computeBalances(expenses: TripExpense[], openings: TripOpening[] = []): TripBalance[] {
  const paid = new Map<string, number>();
  const owed = new Map<string, number>();
  const opening = new Map<string, number>();

  const bump = (map: Map<string, number>, id: string, amount: number) =>
    map.set(id, (map.get(id) ?? 0) + amount);

  for (const expense of expenses) {
    if (expense.sharerIds.length === 0) continue;
    bump(paid, expense.payerId, expense.amountMinor);
    for (const [id, share] of sharesOf(expense.amountMinor, expense.sharerIds, expense.shareAmounts)) {
      bump(owed, id, share);
    }
  }

  for (const entry of openings) {
    if (entry.amountMinor <= 0 || entry.fromId === entry.toId) continue;
    bump(opening, entry.toId, entry.amountMinor);
    bump(opening, entry.fromId, -entry.amountMinor);
  }

  const everyone = new Set([...paid.keys(), ...owed.keys(), ...opening.keys()]);

  return [...everyone]
    .map((userId) => {
      const paidMinor = paid.get(userId) ?? 0;
      const shareMinor = owed.get(userId) ?? 0;
      const openingMinor = opening.get(userId) ?? 0;
      return { userId, paidMinor, shareMinor, openingMinor, netMinor: paidMinor - shareMinor + openingMinor };
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
