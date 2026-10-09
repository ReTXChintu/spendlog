import { Types } from "mongoose";
import { Account, Transaction } from "../../models";
import { istDayKey } from "../../time";
import { CardNetwork, CARD_NETWORKS } from "../../types";
import { BillingCycle, cycleFor, floatDays } from "./cards.cycle";
import { cycleDaysFor } from "./cards.learn";
import { outstandingByCard, paidTowards, UpcomingBill } from "../statements/statements.bills";

/**
 * Where every card stands: its own billing cycle, what it owes the bank,
 * how much of its credit limit is left, and how long it would be before a
 * payment made today had to be paid for.
 *
 * Lives here rather than in the route because three screens want the same
 * figures - the card strip, the dashboard and the perk lookup - and three
 * places computing nearly the same thing is three things to keep in step.
 *
 * Every figure follows the card's own statement day. Two cards billing on
 * the 5th and the 20th are in different cycles on the same morning, and
 * neither is ever measured over the salary month: a card with no known
 * statement day says so (cycleKnown false) rather than borrowing a period
 * that has nothing to do with its bill.
 */

/**
 * How much of the credit limit can go before the bar changes colour: fine
 * below 70%, close from 70%, over from 90% - and over past the limit
 * itself. Later than a lender's comfort zone on purpose: the bar is about
 * running out, not about a credit score.
 */
export const CREDIT_CLOSE_AT = 0.7;
export const CREDIT_OVER_AT = 0.9;

/**
 * How far before the cycle's opening day a statement can be dated and
 * still be the bill for the cycle just closed. Banks draw a day early now
 * and then, and a statement whose own date could not be read is dated by
 * the close of its period instead - the day before.
 */
const STATEMENT_SLACK_MS = 7 * 24 * 60 * 60 * 1000;

export type CardState = "ok" | "close" | "over" | "unset";

/** The last bill, as the bank drew it or as near as SpendLog can tell. */
export interface CardBill {
  amountMinor: number;
  minimumDueMinor: number | null;
  statementOn: Date | null;
  dueOn: Date | null;
  /// Negative once the due date has gone past.
  daysUntilDue: number | null;
  /// Paid against it since it was drawn, and covered some other way
  /// (cashback, points) - both already taken off owedMinor.
  paidMinor: number;
  owedMinor: number;
  isPaid: boolean;
  /// Read off a statement whose total was printed: false. Worked out from
  /// a statement's rows, or - with no statement for the cycle just closed
  /// - from what that cycle charged the card: true, and said as "about".
  isEstimate: boolean;
  fromStatement: boolean;
}

export interface CardStatus {
  accountId: string;
  name: string;
  /// The bank's own name and the issuer, beside the nickname above, for a
  /// card face that shows both.
  bankName: string;
  issuer: string | null;
  color: string | null;
  last4: string | null;
  network: CardNetwork | null;
  /// The days the card bills and falls due on: stored, or read off its
  /// newest statement when it has never been told (statementDayInferred).
  statementDay: number | null;
  dueDay: number | null;
  statementDayInferred: boolean;
  /// Whether this card has a cycle at all. Without a statement day there is
  /// no telling which purchases are billed and which are not, so every
  /// figure that depends on it is null rather than a confident guess.
  cycleKnown: boolean;
  cycleStart: Date | null;
  /// The cycle's last day; the statement is drawn the day after.
  cycleEnd: Date | null;
  /// When the cycle now running will be billed, and when that bill falls
  /// due. Distinct from the last bill's own dates, below.
  statementOn: Date | null;
  dueOn: Date | null;
  floatDays: number | null;
  creditLimitMinor: number | null;
  /// Charged to the card since its last statement, net of refunds and
  /// anything else credited back - the cycle now running, not yet on a
  /// bill. What the bank charged rather than the user's share of it: a
  /// dinner split three ways is still the whole bill on this card.
  unbilledMinor: number | null;
  /// What is left to pay of the last bill. Zero once it is paid off.
  billedUnpaidMinor: number | null;
  /// Everything the card owes the bank right now: the unpaid part of the
  /// last bill plus everything since. Once the bill is paid, only the
  /// running cycle. This is what the credit limit has lost.
  outstandingMinor: number | null;
  /// Whether the bill in that figure is the one the bank printed, or one
  /// worked out (see CardBill.isEstimate). Shown as "about" rather than
  /// hidden.
  outstandingIsEstimate: boolean;
  lastBill: CardBill | null;
  billIsPaid: boolean | null;
  /// What this card holds against the limit - its outstanding, by another
  /// name, kept because a shared limit needs both.
  usedMinor: number | null;
  /// The credit limit less the outstanding. What is actually left to
  /// spend. Null without a credit limit to count from, or without a cycle
  /// to say what is outstanding.
  ///
  /// For a card that shares its limit, this is the group's figure: the one
  /// limit, less every member's outstanding. Spend on either card and both
  /// show less, which is what the bank does.
  availableMinor: number | null;
  /// The other cards this one shares a limit with, named. Empty for a card
  /// with a limit of its own.
  sharesLimitWith: string[];
  /// What the group as a whole has used, when there is a group. Null
  /// otherwise, so a screen can tell "this card's share" from "the pot".
  groupUsedMinor: number | null;
  /// How much of the credit limit is used: ok | close (70%) | over (90%,
  /// or past it). Unset with no credit limit, or no cycle to measure.
  state: CardState;
}

/** Whatever was typed into the network field, as one of the known ones. */
export function normaliseNetwork(raw: string | null | undefined): CardNetwork | null {
  if (!raw) return null;
  const folded = raw.trim().toUpperCase().replace(/[\s-]+/g, "");

  if (folded === "MASTER" || folded === "MC") return "MASTERCARD";
  if (folded === "AMERICANEXPRESS") return "AMEX";
  if (folded === "DINERSCLUB") return "DINERS";

  return (CARD_NETWORKS as readonly string[]).includes(folded) ? (folded as CardNetwork) : null;
}

/** ok | close | over for so much used of a limit; unset with nothing to measure. */
export function creditState(usedMinor: number | null, limitMinor: number | null): CardState {
  if (usedMinor === null || !limitMinor || limitMinor <= 0) return "unset";
  const share = usedMinor / limitMinor;
  if (share >= CREDIT_OVER_AT) return "over";
  if (share >= CREDIT_CLOSE_AT) return "close";
  return "ok";
}

/**
 * What the bank charged a card between two instants (the second one not
 * included), less what it credited back.
 *
 * The bank's figure, so the whole amount of every purchase rather than
 * the user's counted share of it, and refunds when they land on the card.
 * Left out: the card's own bill payments, which are paid towards the bill
 * rather than charged (see paidTowards), and an EMI's parent purchase,
 * whose instalments are what the bank bills instead.
 */
export async function chargedBetween(
  userId: Types.ObjectId,
  cardId: Types.ObjectId,
  from: Date,
  to: Date
): Promise<number> {
  const [row] = await Transaction.aggregate<{ total: number }>([
    {
      $match: {
        userId,
        accountId: cardId,
        occurredAt: { $gte: from, $lt: to },
        cardPaymentFor: null,
        emiRole: { $ne: "PARENT" },
        $or: [{ type: "DEBIT" }, { type: "CREDIT", isTransfer: { $ne: true } }],
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, "$amountMinor", { $multiply: ["$amountMinor", -1] }] } },
      },
    },
  ]);

  return Math.max(0, row?.total ?? 0);
}

/** Whole days from the start of today, in IST, to a date. */
function daysUntil(now: Date, to: Date | null): number | null {
  if (!to) return null;
  const today = Date.parse(`${istDayKey(now)}T00:00:00.000+05:30`);
  return Math.round((to.getTime() - today) / (24 * 60 * 60 * 1000));
}

/**
 * The bill for the cycle that has just closed.
 *
 * The statement, when one was read for it: the bank's total, less what was
 * paid and waived since (upcomingBills has worked that out already). A
 * statement older than the cycle just closed is last month's bill, not
 * this one, so it does not stand in for it.
 *
 * Without one - no statement password, a bank that does not email, the
 * mail not in yet - the bill is estimated as what that cycle charged the
 * card, less what has been paid towards the card since it closed. Close to
 * the bank's figure for a card that is paid off every month, which is the
 * card this app is for; marked as an estimate wherever it is shown.
 */
async function lastBillFor(
  userId: Types.ObjectId,
  cardId: Types.ObjectId,
  cycle: BillingCycle,
  previous: BillingCycle,
  statement: UpcomingBill | undefined,
  now: Date
): Promise<CardBill> {
  const statementFits =
    statement?.statementDate && statement.statementDate.getTime() >= cycle.start.getTime() - STATEMENT_SLACK_MS;

  if (statement && statementFits) {
    const dueOn = statement.dueDate ?? previous.dueOn;
    return {
      amountMinor: statement.totalDueMinor,
      minimumDueMinor: statement.minimumDueMinor,
      statementOn: statement.statementDate,
      dueOn,
      daysUntilDue: statement.daysUntilDue ?? daysUntil(now, dueOn),
      paidMinor: statement.paidMinor + statement.waivedMinor,
      owedMinor: statement.owedMinor,
      isPaid: statement.isPaid,
      isEstimate: statement.isEstimate,
      fromStatement: true,
    };
  }

  const [amountMinor, paidMinor] = await Promise.all([
    chargedBetween(userId, cardId, previous.start, cycle.start),
    paidTowards(userId, cardId, cycle.start),
  ]);
  const owedMinor = Math.max(0, amountMinor - paidMinor);

  return {
    amountMinor,
    minimumDueMinor: null,
    statementOn: cycle.start,
    dueOn: previous.dueOn,
    daysUntilDue: daysUntil(now, previous.dueOn),
    paidMinor,
    owedMinor,
    isPaid: owedMinor <= 0,
    isEstimate: true,
    fromStatement: false,
  };
}

export async function cardStatuses(userId: Types.ObjectId, now = new Date()): Promise<CardStatus[]> {
  const [cards, bills] = await Promise.all([
    Account.find({ userId, accountType: "CARD", isActive: true }),
    outstandingByCard(userId, now),
  ]);
  const days = await cycleDaysFor(userId, cards);

  const measured = await Promise.all(
    cards.map(async (card) => {
      const own = days.get(card.id) ?? { statementDay: null, dueDay: null, inferred: false };
      const cycle = cycleFor(own, now);

      // No statement day, stored or learned: no cycle, and so nothing to
      // say about what is billed and what is not. Not the salary month in
      // its place - a card is billed on its own day, and a figure measured
      // over the wrong period is worse than none.
      if (!cycle) {
        return { card, own, cycle, unbilledMinor: null, bill: null, outstandingMinor: null };
      }

      // The cycle before this one, whose bill is the one now to pay.
      const previous = cycleFor(own, new Date(cycle.start.getTime() - 1))!;

      const [unbilledMinor, bill] = await Promise.all([
        chargedBetween(userId, card._id, cycle.start, cycle.statementOn),
        lastBillFor(userId, card._id, cycle, previous, bills.get(card.id), now),
      ]);

      return {
        card,
        own,
        cycle,
        unbilledMinor,
        bill,
        // The unpaid part of the last bill, and everything since. Once the
        // bill is paid off only the running cycle is left; a part payment
        // takes off exactly what was paid.
        outstandingMinor: bill.owedMinor + unbilledMinor,
      };
    })
  );

  // The bank's ceiling, which may be one pot shared by several cards. Each
  // card is answered with its group's limit less everything every member
  // owes - the holder's limit, because a card that shares has none of its
  // own. Worked out after every card's own figures exist, since a group's
  // total is the sum of its members' and cannot be had sooner. A member
  // with no cycle leaves the pot unknown rather than looking emptier than
  // it is.
  const holderOf = (card: (typeof measured)[number]["card"]) =>
    (card.sharesLimitWith ?? card._id).toString();
  const usedByHolder = new Map<string, number | null>();
  const membersByHolder = new Map<string, string[]>();
  for (const row of measured) {
    const holder = holderOf(row.card);
    const sofar = usedByHolder.has(holder) ? usedByHolder.get(holder)! : 0;
    usedByHolder.set(holder, sofar === null || row.outstandingMinor === null ? null : sofar + row.outstandingMinor);
    membersByHolder.set(holder, [
      ...(membersByHolder.get(holder) ?? []),
      row.card.nickname?.trim() || row.card.bankName,
    ]);
  }
  const byId = new Map(measured.map((row) => [row.card.id, row.card]));

  const rows = measured.map(({ card, own, cycle, unbilledMinor, bill, outstandingMinor }): CardStatus => {
    const holder = holderOf(card);
    const holderCard = byId.get(holder) ?? card;
    const members = membersByHolder.get(holder) ?? [];
    const shared = members.length > 1;

    const creditLimitMinor = holderCard.creditLimitMinor ?? null;
    const groupUsedMinor = shared ? (usedByHolder.get(holder) ?? null) : null;
    const usedAgainstLimit = shared ? groupUsedMinor : outstandingMinor;
    const availableMinor =
      creditLimitMinor === null || usedAgainstLimit === null
        ? null
        : Math.max(0, creditLimitMinor - usedAgainstLimit);

    return {
      accountId: card.id,
      name: card.nickname?.trim() || card.bankName,
      bankName: card.bankName,
      issuer: card.issuer ?? null,
      color: card.color ?? null,
      last4: card.last4 ?? null,
      network: normaliseNetwork(card.cardNetwork),
      statementDay: own.statementDay,
      dueDay: own.dueDay,
      statementDayInferred: own.inferred,
      cycleKnown: cycle !== null,
      cycleStart: cycle?.start ?? null,
      cycleEnd: cycle?.endsOn ?? null,
      statementOn: cycle?.statementOn ?? null,
      dueOn: cycle?.dueOn ?? null,
      floatDays: floatDays(own, now),
      creditLimitMinor,
      unbilledMinor,
      billedUnpaidMinor: bill?.owedMinor ?? null,
      outstandingMinor,
      outstandingIsEstimate: bill?.isEstimate ?? false,
      lastBill: bill,
      billIsPaid: bill ? bill.isPaid : null,
      usedMinor: outstandingMinor,
      availableMinor,
      sharesLimitWith: shared
        ? members.filter((name) => name !== (card.nickname?.trim() || card.bankName))
        : [],
      groupUsedMinor,
      state: creditState(usedAgainstLimit, creditLimitMinor),
    };
  });

  // A card nearly out of credit is not the answer however long its float,
  // so that outranks it. Nothing is filtered out, though - "why is it not
  // suggesting my usual card" should never be a mystery.
  return rows.sort((a, b) => {
    if ((a.state === "over") !== (b.state === "over")) return a.state === "over" ? 1 : -1;
    return (b.floatDays ?? -1) - (a.floatDays ?? -1);
  });
}

export interface CardPicks {
  /// The best card overall, and the best on each network that has one.
  ///
  /// Networks matter at a till rather than in the ledger: a RuPay credit
  /// card pays over UPI and a Visa one does not, so the real question is
  /// not "which card" but "which card that this place takes".
  best: CardStatus | null;
  byNetwork: { network: CardNetwork; card: CardStatus }[];
  /// Cards with no network recorded. Named so the answer can say why a
  /// card is missing from the list rather than leaving it a mystery.
  unknownNetwork: CardStatus[];
}

/**
 * Which card to reach for, one answer per network.
 *
 * `cardStatuses` has already put them in order, so the first of each group
 * is that group's answer. A card with 90% or more of its credit limit used
 * is skipped: suggesting one would be advice to run it out. So is a card
 * with no cycle, which has no float to rank it by.
 */
export function pickCards(statuses: CardStatus[]): CardPicks {
  const usable = statuses.filter((card) => card.state !== "over" && card.floatDays !== null);

  const byNetwork: CardPicks["byNetwork"] = [];
  for (const network of CARD_NETWORKS) {
    const card = usable.find((candidate) => candidate.network === network);
    if (card) byNetwork.push({ network, card });
  }

  return {
    best: usable[0] ?? null,
    byNetwork,
    unknownNetwork: statuses.filter((card) => card.network === null),
  };
}
