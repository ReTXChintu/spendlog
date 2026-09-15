import { Types } from "mongoose";
import { Account, Transaction } from "../../models";
import { istMonthKey, istMonthStart } from "../../time";
import { CardNetwork, CARD_NETWORKS } from "../../types";
import { cycleFor, floatDays } from "./cards.cycle";

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
  remainingMinor: number | null;
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
  const cards = await Account.find({ userId, accountType: "CARD", isActive: true });

  const rows = await Promise.all(
    cards.map(async (card): Promise<CardStatus> => {
      const cycle = cycleFor(card, now);

      // The cycle where the card has one, and the calendar month where it
      // does not. A card with no statement day used to report nothing
      // spent - not "unknown", but a confident zero beside a real limit,
      // which is the most misleading figure this could produce.
      const from = cycle?.start ?? istMonthStart(istMonthKey(now));
      const to = cycle?.statementOn ?? now;

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
        creditLimitMinor: card.creditLimitMinor ?? null,
        remainingMinor: limitMinor === null ? null : Math.max(0, limitMinor - spentMinor),
        periodIsCycle: cycle !== null,
        periodStart: from,
        periodEnd: to,
        state,
      };
    })
  );

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
