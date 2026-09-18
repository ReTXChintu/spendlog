import { Types } from "mongoose";
import { Account, Transaction } from "../../models";
import { istDayEnd, istDayKey, istMonthKey, istMonthStart } from "../../time";
import { CardNetwork, CARD_NETWORKS } from "../../types";
import { cycleFor, floatDays } from "./cards.cycle";
import { outstandingByCard } from "../statements/statements.bills";

/**
 * Where every card stands: its cycle, its limit, and how long it would be
 * before a payment made today had to be paid for.
 *
 * Lives here rather than in the route because three screens want the same
 * figures - the card strip, the dashboard and the perk lookup - and three
 * places computing nearly the same thing is three things to keep in step.
 */

/** The point at which knowing you are near a limit changes a decision. */
const CLOSE_FRACTION = 0.8;

export type CardState = "ok" | "close" | "over" | "unset";

export interface CardStatus {
  accountId: string;
  name: string;
  last4: string | null;
  network: CardNetwork | null;
  statementDay: number | null;
  dueDay: number | null;
  cycleStart: Date | null;
  statementOn: Date | null;
  dueOn: Date | null;
  floatDays: number | null;
  spentMinor: number;
  /// What you allow yourself on this card in a period, and what the bank
  /// allows. Different things, and the one worth warning about is the
  /// first: being 90% through your own budget matters at a till, and
  /// being 30% through a credit limit tells you nothing.
  limitMinor: number | null;
  creditLimitMinor: number | null;
  /// What you have left of your own budget this cycle.
  remainingMinor: number | null;
  /// Last statement's bill, less anything paid against it since. Null when
  /// no statement has been read, which is not the same as nothing owed.
  ///
  /// This is money the bank is still holding against the credit limit. A
  /// card with a 25,000 limit and a 14,000 bill outstanding has 11,000 of
  /// room before this cycle's spending is counted at all - and a card bar
  /// that ignores it tells you that you have the whole limit to play with
  /// on the one day of the month when you have least of it.
  outstandingMinor: number | null;
  /// Whether the outstanding figure is the one the bank printed or one
  /// worked out from the statement's rows, for a statement whose summary
  /// block could not be read. Shown as "about" rather than hidden.
  outstandingIsEstimate: boolean;
  /// When that outstanding bill has to be paid. Distinct from dueOn, which
  /// is when the bill for the cycle now running will fall due.
  billDueOn: Date | null;
  /// The credit limit, less the outstanding bill, less this cycle. What is
  /// actually left to spend. Null without a credit limit to count from.
  ///
  /// For a card that shares its limit, this is the group's figure: the one
  /// limit, less every member's bill and every member's cycle. Spend on
  /// either card and both show less, which is what the bank does.
  availableMinor: number | null;
  /// The other cards this one shares a limit with, named. Empty for a card
  /// with a limit of its own.
  sharesLimitWith: string[];
  /// What the group as a whole has used, when there is a group. Null
  /// otherwise, so a screen can tell "this card's share" from "the pot".
  groupUsedMinor: number | null;
  /// Whether spentMinor covers a billing cycle or a calendar month. A card
  /// with no statement day has no cycle to measure, and a period of
  /// "nothing" used to report nothing spent.
  periodIsCycle: boolean;
  periodStart: Date;
  periodEnd: Date;
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

export async function cardStatuses(userId: Types.ObjectId, now = new Date()): Promise<CardStatus[]> {
  const [cards, bills] = await Promise.all([
    Account.find({ userId, accountType: "CARD", isActive: true }),
    outstandingByCard(userId, now),
  ]);

  const measured = await Promise.all(
    cards.map(async (card) => {
      const cycle = cycleFor(card, now);

      // The cycle where the card has one, and the calendar month where it
      // does not. A card with no statement day used to report nothing
      // spent - not "unknown", but a confident zero beside a real limit,
      // which is the most misleading figure this could produce.
      const from = cycle?.start ?? istMonthStart(istMonthKey(now));
      // To the end of the cycle's last day, which is the day before the
      // next statement. Taken as an inclusive instant rather than as a
      // midnight, so a purchase at eight in the evening on the last day
      // still falls inside the cycle it belongs to.
      const to = cycle ? istDayEnd(istDayKey(cycle.endsOn)) : now;

      const spentMinor =
        (
          await Transaction.aggregate<{ total: number }>([
            {
              $match: {
                userId,
                accountId: card._id,
                type: "DEBIT",
                occurredAt: { $gte: from, $lte: to },
              },
            },
            { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
          ])
        )[0]?.total ?? 0;

      // What last month's bill is still holding, and so what is genuinely
      // left. Cleared the moment a payment is marked against the card:
      // paying the 14,000 gives the 14,000 back.
      const bill = bills.get(card.id);
      const outstandingMinor = bill ? Math.max(0, bill.totalDueMinor - bill.paidMinor) : null;

      return {
        card,
        cycle,
        from,
        to,
        spentMinor,
        bill,
        outstandingMinor,
        usedMinor: (outstandingMinor ?? 0) + spentMinor,
      };
    })
  );

  // The bank's ceiling, which may be one pot shared by several cards. Each
  // card is answered with its group's limit less everything every member
  // has used - the holder's limit, because a card that shares has none of
  // its own. Worked out after every card's own figures exist, since a
  // group's total is the sum of its members' and cannot be had sooner.
  const holderOf = (card: (typeof measured)[number]["card"]) =>
    (card.sharesLimitWith ?? card._id).toString();
  const usedByHolder = new Map<string, number>();
  const membersByHolder = new Map<string, string[]>();
  for (const row of measured) {
    const holder = holderOf(row.card);
    usedByHolder.set(holder, (usedByHolder.get(holder) ?? 0) + row.usedMinor);
    membersByHolder.set(holder, [
      ...(membersByHolder.get(holder) ?? []),
      row.card.nickname?.trim() || row.card.bankName,
    ]);
  }
  const byId = new Map(measured.map((row) => [row.card.id, row.card]));

  const rows = measured.map(({ card, cycle, from, to, spentMinor, bill, outstandingMinor }): CardStatus => {
    {
      const holder = holderOf(card);
      const holderCard = byId.get(holder) ?? card;
      const members = membersByHolder.get(holder) ?? [];
      const shared = members.length > 1;

      const creditLimitMinor = holderCard.creditLimitMinor ?? null;
      const groupUsedMinor = shared ? (usedByHolder.get(holder) ?? 0) : null;
      const availableMinor =
        creditLimitMinor === null
          ? null
          : Math.max(0, creditLimitMinor - (groupUsedMinor ?? (outstandingMinor ?? 0) + spentMinor));

      const limitMinor = card.spendLimitMinor ?? null;
      const state: CardState = !limitMinor
        ? "unset"
        : spentMinor >= limitMinor
          ? "over"
          : spentMinor >= limitMinor * CLOSE_FRACTION
            ? "close"
            : "ok";

      return {
        accountId: card.id,
        name: card.nickname?.trim() || card.bankName,
        last4: card.last4 ?? null,
        network: normaliseNetwork(card.cardNetwork),
        statementDay: card.statementDay ?? null,
        dueDay: card.dueDay ?? null,
        cycleStart: cycle?.start ?? null,
        statementOn: cycle?.statementOn ?? null,
        dueOn: cycle?.dueOn ?? null,
        floatDays: floatDays(card, now),
        spentMinor,
        limitMinor,
        creditLimitMinor,
        remainingMinor: limitMinor === null ? null : Math.max(0, limitMinor - spentMinor),
        outstandingMinor,
        outstandingIsEstimate: bill?.isEstimate ?? false,
        billDueOn: bill?.dueDate ?? null,
        availableMinor,
        sharesLimitWith: shared
          ? members.filter((name) => name !== (card.nickname?.trim() || card.bankName))
          : [],
        groupUsedMinor,
        periodIsCycle: cycle !== null,
        periodStart: from,
        periodEnd: to,
        state,
      };
    }
  });

  // A card at its limit is not the answer however long its float, so the
  // limit outranks it. Nothing is filtered out, though - "why is it not
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
 * is that group's answer. A card over its limit is skipped: suggesting one
 * would be advice to make a bad month worse.
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
