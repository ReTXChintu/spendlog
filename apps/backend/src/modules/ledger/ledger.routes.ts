import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { User } from "../../models";
import { istMonthKey } from "../../time";
import { syncStatements } from "../statements/statements.service";
import { EmailConnection } from "../../models";
import { syncEmailConnection } from "../ingestion/gmail.service";
import {
  defaultHorizon,
  isMonthKey,
  monthBefore,
  planPurge,
  purgeBeforeHorizon,
} from "./ledger.horizon";

/**
 * Where the ledger starts, and moving it.
 *
 * The one setting behind all of it: SpendLog imports nothing from before
 * the month you joined, unless you ask it to. Everything here is about
 * that month — reading it, moving it back a month at a time, and clearing
 * out anything that came in before it was set.
 */

export const ledgerRouter = Router();
ledgerRouter.use(requireAuth);

/** How far back "load earlier" is willing to go, in months. */
const OLDEST_MONTHS_BACK = 36;

// GET /ledger — the month the ledger starts, and the one it would open up
// next. Both, because the button that moves it has to be able to name the
// month it is offering.
ledgerRouter.get("/", async (req, res) => {
  const user = await User.findById(currentUserId(req)).select("ledgerFrom createdAt");
  if (!user) return res.status(404).json({ error: "Not found" });

  const joined = defaultHorizon(user.createdAt);
  const month = user.ledgerFrom ?? joined;

  res.json({
    month,
    joined,
    previous: monthBefore(month),
    /// Whether there is any point offering to go back further.
    canGoBack: monthsBetween(monthBefore(month), istMonthKey(new Date())) <= OLDEST_MONTHS_BACK,
  });
});

const monthBody = z.object({ month: z.string() });

/**
 * PUT /ledger — set the month the ledger starts.
 *
 * Moving it *back* opens months up, and the syncs that follow will fill
 * them. Moving it *forward* only stops new imports: what is already here
 * stays until it is purged, because silently deleting somebody's ledger
 * because they changed a date is not a thing a setting should do.
 */
ledgerRouter.put("/", async (req, res) => {
  const parsed = monthBody.safeParse(req.body);
  if (!parsed.success || !isMonthKey(parsed.data.month)) {
    return res.status(400).json({ error: "A month looks like 2026-09." });
  }

  const thisMonth = istMonthKey(new Date());
  if (parsed.data.month > thisMonth) {
    return res.status(400).json({ error: "The ledger cannot start in the future." });
  }

  const user = await User.findByIdAndUpdate(
    currentUserId(req),
    { $set: { ledgerFrom: parsed.data.month } },
    { new: true }
  );
  if (!user) return res.status(404).json({ error: "Not found" });

  res.json({ month: user.ledgerFrom, previous: monthBefore(user.ledgerFrom!) });
});

/**
 * POST /ledger/earlier — go back one more month, and fetch it.
 *
 * Opening a month up is only half of it: the alerts and statements for
 * that month were skipped when they went past the first time, so moving
 * the horizon without going back for them would show an empty month and
 * look broken.
 */
ledgerRouter.post("/earlier", async (req, res) => {
  const userId = currentUserId(req);
  const user = await User.findById(userId).select("ledgerFrom createdAt");
  if (!user) return res.status(404).json({ error: "Not found" });

  const month = monthBefore(user.ledgerFrom ?? defaultHorizon(user.createdAt));
  user.ledgerFrom = month;
  await user.save();

  // Deliberately sequential and deliberately awaited. This is a button
  // somebody presses and then watches, and the honest answer is how much
  // it found rather than "started".
  const connections = await EmailConnection.find({ userId }).select("_id");

  let imported = 0;
  for (const connection of connections) {
    const done = await syncEmailConnection(connection._id.toString()).catch(() => null);
    imported += done?.created ?? 0;
  }

  const statements = await syncStatements(userId).catch(() => null);

  res.json({
    month,
    previous: monthBefore(month),
    imported,
    statementsRead: statements?.read ?? 0,
  });
});

// GET /ledger/purge — what clearing out everything before the horizon
// would remove, without removing any of it.
ledgerRouter.get("/purge", async (req, res) => {
  const plan = await planPurge(currentUserId(req));
  if (!plan) return res.status(404).json({ error: "Not found" });

  res.json(plan);
});

/**
 * POST /ledger/purge — remove everything imported from before the horizon.
 *
 * Behind a body that has to say so in words. This deletes transactions,
 * and a mis-click is not a thing to discover afterwards.
 */
ledgerRouter.post("/purge", async (req, res) => {
  if (req.body?.confirm !== "clear the old months") {
    return res.status(400).json({
      error:
        "This deletes every imported transaction from before the month your ledger starts. " +
        'Send { "confirm": "clear the old months" }.',
    });
  }

  const result = await purgeBeforeHorizon(currentUserId(req));
  if (!result) return res.status(404).json({ error: "Not found" });

  res.json(result);
});

/** How many months apart two month keys are. */
function monthsBetween(from: string, to: string): number {
  const [fromYear, fromMonth] = from.split("-").map(Number);
  const [toYear, toMonth] = to.split("-").map(Number);

  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}
