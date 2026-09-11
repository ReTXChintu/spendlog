import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Transaction, Trip, TripDoc } from "../../models";
import { istDayKey } from "../../time";
import { generateJoinCode } from "./trips.service";

export const tripsRouter = Router();
tripsRouter.use(requireAuth);

/**
 * The one place in the app where a query is scoped by something other than
 * the signed-in user.
 *
 * Everything else ends in `userId: currentUserId(req)`, which is what keeps
 * one person's ledger out of another's. A trip is shared on purpose, so its
 * reads are authorised by membership instead — and that exception lives
 * here, in one function, rather than being spelled out at each endpoint
 * where it could be forgotten.
 */
async function assertTripMember(tripId: string, userId: Types.ObjectId) {
  return Trip.findOne({ _id: tripId, "members.userId": userId });
}

// GET /trips — every trip the user is on, newest first.
tripsRouter.get("/", async (req, res) => {
  const userId = currentUserId(req);
  const trips = await Trip.find({ "members.userId": userId }).sort({ startedAt: -1 });

  // A count and a total per trip, so the list means something without
  // opening each one.
  const totals = await Transaction.aggregate<{ _id: Types.ObjectId; total: number; count: number }>([
    { $match: { tripId: { $in: trips.map((t) => t._id) }, type: "DEBIT" } },
    { $group: { _id: "$tripId", total: { $sum: "$countedAmountMinor" }, count: { $sum: 1 } } },
  ]);

  res.json(
    trips.map((trip) => {
      const totalsFor = totals.find((t) => t._id.equals(trip._id));
      return {
        ...trip.toJSON(),
        isActive: trip.endedAt === null,
        totalMinor: totalsFor?.total ?? 0,
        transactionCount: totalsFor?.count ?? 0,
      };
    })
  );
});

// GET /trips/active — the running trip, if trip mode is on.
tripsRouter.get("/active", async (req, res) => {
  const trip = await Trip.findOne({ "members.userId": currentUserId(req), endedAt: null });
  res.json(trip ?? null);
});

const createTripSchema = z.object({
  name: z.string().min(1).max(80),
  /** Defaults to now; set it earlier to take in a day already under way. */
  startedAt: z.coerce.date().optional(),
});

// POST /trips — turns trip mode on.
tripsRouter.post("/", async (req, res) => {
  const parsed = createTripSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);

  // Trip mode is a switch, and two trips running at once would leave every
  // payment ambiguous.
  const running = await Trip.findOne({ ownerId: userId, endedAt: null });
  if (running) {
    return res.status(409).json({
      error: `"${running.name}" is still running. End it before starting another.`,
      tripId: running.id,
    });
  }

  const trip = await Trip.create({
    ownerId: userId,
    name: parsed.data.name,
    startedAt: parsed.data.startedAt ?? new Date(),
    endedAt: null,
    members: [{ userId, joinedAt: new Date() }],
    joinCode: generateJoinCode(),
  });

  // Anything already recorded inside the window belongs to it — starting a
  // trip on the second morning should not cost you the first day.
  const claimed = await claimTransactions(trip);

  res.status(201).json({ ...trip.toJSON(), isActive: true, claimedCount: claimed });
});

const updateTripSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  startedAt: z.coerce.date().optional(),
  /** Passing a date ends the trip; passing null starts it running again. */
  endedAt: z.coerce.date().nullable().optional(),
});

tripsRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateTripSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const trip = await Trip.findOne({ _id: req.params.id, ownerId: userId });
  if (!trip) return res.status(404).json({ error: "Not found" });

  if (parsed.data.name !== undefined) trip.name = parsed.data.name;
  if (parsed.data.startedAt !== undefined) trip.startedAt = parsed.data.startedAt;
  if (parsed.data.endedAt !== undefined) trip.endedAt = parsed.data.endedAt;

  if (trip.endedAt && trip.endedAt < trip.startedAt) {
    return res.status(400).json({ error: "A trip cannot end before it started" });
  }

  await trip.save();

  // Moving either end of the window changes what falls inside it.
  const claimed = await claimTransactions(trip);

  res.json({ ...trip.toJSON(), isActive: trip.endedAt === null, claimedCount: claimed });
});

// DELETE /trips/:id — the trip goes, the spending stays. Nobody's ledger
// should lose rows because a label was removed.
tripsRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const trip = await Trip.findOne({ _id: req.params.id, ownerId: currentUserId(req) });
  if (!trip) return res.status(404).json({ error: "Not found" });

  await Transaction.updateMany({ tripId: trip._id }, { $set: { tripId: null } });
  await trip.deleteOne();

  res.status(204).end();
});

// POST /trips/:id/rescan — sweeps the window for anything not already on
// the trip, for a phone that was offline or a start date moved earlier.
tripsRouter.post("/:id/rescan", validObjectIdParam("id"), async (req, res) => {
  const trip = await assertTripMember(req.params.id, currentUserId(req));
  if (!trip) return res.status(404).json({ error: "Not found" });

  const claimed = await claimTransactions(trip, currentUserId(req));
  res.json({ claimedCount: claimed });
});

/**
 * Files everything inside the trip's window that is not on a trip already.
 *
 * Leaves anything hand-edited alone, which is how a transaction taken off a
 * trip on purpose stays off it — the same rule that stops automatic passes
 * overwriting corrections elsewhere.
 */
async function claimTransactions(
  trip: Pick<TripDoc, "_id" | "members" | "startedAt" | "endedAt">,
  onlyUserId?: Types.ObjectId
): Promise<number> {
  const memberIds = onlyUserId ? [onlyUserId] : trip.members.map((member) => member.userId);

  const result = await Transaction.updateMany(
    {
      userId: { $in: memberIds },
      tripId: null,
      editedAt: null,
      occurredAt: {
        $gte: trip.startedAt,
        ...(trip.endedAt ? { $lte: trip.endedAt } : {}),
      },
    },
    { $set: { tripId: trip._id } }
  );

  return result.modifiedCount;
}

// GET /trips/:id/summary — what the trip cost, and where it went.
tripsRouter.get("/:id/summary", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const trip = await assertTripMember(req.params.id, userId);
  if (!trip) return res.status(404).json({ error: "Not found" });

  const match = { tripId: trip._id, type: "DEBIT" as const };

  const [byMember, byCategory, days] = await Promise.all([
    Transaction.aggregate([
      { $match: match },
      { $group: { _id: "$userId", spentMinor: { $sum: "$countedAmountMinor" }, count: { $sum: 1 } } },
      { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user" } },
      {
        $project: {
          userId: "$_id",
          spentMinor: 1,
          count: 1,
          name: { $ifNull: [{ $first: "$user.name" }, { $first: "$user.email" }] },
        },
      },
      { $sort: { spentMinor: -1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...match, countedAmountMinor: { $gt: 0 } } },
      { $group: { _id: "$categoryId", amountMinor: { $sum: "$countedAmountMinor" } } },
      { $lookup: { from: "categories", localField: "_id", foreignField: "_id", as: "category" } },
      {
        $project: {
          categoryId: "$_id",
          amountMinor: 1,
          name: { $ifNull: [{ $first: "$category.name" }, "Uncategorized"] },
        },
      },
      { $sort: { amountMinor: -1 } },
    ]),
    Transaction.find({ ...match }).select("occurredAt").lean(),
  ]);

  const totalMinor = byMember.reduce((sum, entry) => sum + entry.spentMinor, 0);

  // Days actually spent money on, not days elapsed: a trip with a quiet
  // Sunday should not look cheaper per day because of it.
  const dayCount = new Set(days.map((row) => istDayKey(row.occurredAt))).size;

  res.json({
    trip: { ...trip.toJSON(), isActive: trip.endedAt === null },
    totalMinor,
    transactionCount: days.length,
    dayCount,
    perDayMinor: dayCount === 0 ? 0 : Math.round(totalMinor / dayCount),
    byMember,
    byCategory,
  });
});

// GET /trips/:id/transactions — everyone's spending on the trip.
tripsRouter.get("/:id/transactions", validObjectIdParam("id"), async (req, res) => {
  const trip = await assertTripMember(req.params.id, currentUserId(req));
  if (!trip) return res.status(404).json({ error: "Not found" });

  const transactions = await Transaction.find({ tripId: trip._id })
    .sort({ occurredAt: -1 })
    .limit(500)
    .populate("category")
    .populate("account")
    .populate({ path: "userId", select: "name email" });

  res.json(transactions);
});
