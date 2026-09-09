import { Router } from "express";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { Account } from "../../models";

export const accountsRouter = Router();
accountsRouter.use(requireAuth);

// GET /accounts — the bank accounts and cards detected from the user's
// messages, for the account filter on the transactions screen.
accountsRouter.get("/", async (req, res) => {
  const accounts = await Account.find({ userId: currentUserId(req) }).sort({ bankName: 1, last4: 1 });
  res.json(accounts);
});
