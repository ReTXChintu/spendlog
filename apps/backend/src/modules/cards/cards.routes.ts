import { Router } from "express";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { Account, Transaction } from "../../models";
import { cycleFor, floatDays } from "./cards.cycle";

export const cardsRouter = Router();
cardsRouter.use(requireAuth);

/** The point at which knowing you are near a limit changes a decision. */
const CLOSE_FRACTION = 0.8;

export type CardState = "ok" | "close" | "over" | "unset";

/**
 * Every card, with where it is in its cycle and how much of its own limit
 * is left — ordered so the first one is the card to pay with today.
 *
 * One endpoint rather than two because the warning strip, the card
 * suggestion and the account screen all want the same figures, and two
 * endpoints returning nearly the same thing is two things to keep in step.
 */
cardsRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const now = new Date();

  const cards = await Account.find({ userId, accountType: "CARD", isActive: true });

  const rows = await Promise.all(
    cards.map(async (card) => {
      const cycle = cycleFor(card, now);

      const spentMinor = cycle
        ? (
            await Transaction.aggregate<{ total: number }>([
              {
                $match: {
                  userId,
                  accountId: card._id,
                  type: "DEBIT",
                  occurredAt: { $gte: cycle.start, $lte: cycle.statementOn },
                },
              },
              { $group: { _id: null, total: { $sum: "$countedAmountMinor" } } },
            ])
          )[0]?.total ?? 0
        : 0;

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
        last4: card.last4,
        statementDay: card.statementDay ?? null,
        dueDay: card.dueDay ?? null,
        cycleStart: cycle?.start ?? null,
        statementOn: cycle?.statementOn ?? null,
        dueOn: cycle?.dueOn ?? null,
        floatDays: floatDays(card, now),
        spentMinor,
        limitMinor,
        remainingMinor: limitMinor === null ? null : Math.max(0, limitMinor - spentMinor),
        state,
      };
    })
  );

  // A card at its limit is not the answer however long its float, so the
  // limit outranks it. Nothing is filtered out, though — "why is it not
  // suggesting my usual card" should never be a mystery.
  rows.sort((a, b) => {
    if ((a.state === "over") !== (b.state === "over")) return a.state === "over" ? 1 : -1;
    return (b.floatDays ?? -1) - (a.floatDays ?? -1);
  });

  res.json(rows);
});
