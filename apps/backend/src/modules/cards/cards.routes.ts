import { Router } from "express";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { cardStatuses, pickCards } from "./cards.status";

export const cardsRouter = Router();
cardsRouter.use(requireAuth);

export type { CardState, CardStatus } from "./cards.status";

/**
 * Every card, with where it is in its cycle and how much of its own limit
 * is left — ordered so the first one is the card to pay with today.
 *
 * One endpoint rather than two because the warning strip, the card
 * suggestion and the account screen all want the same figures, and two
 * endpoints returning nearly the same thing is two things to keep in step.
 */
cardsRouter.get("/", async (req, res) => {
  res.json(await cardStatuses(currentUserId(req)));
});

/**
 * GET /cards/pick — which card to reach for, one answer per network.
 *
 * Separate from the list because it answers a different question. The list
 * is "how are my cards doing"; this is "what do I hand over", and at a till
 * that is really "which card that this place takes" — in India, mostly a
 * question about networks, since a RuPay credit card pays over UPI and a
 * Visa one does not.
 */
cardsRouter.get("/pick", async (req, res) => {
  res.json(pickCards(await cardStatuses(currentUserId(req))));
});
