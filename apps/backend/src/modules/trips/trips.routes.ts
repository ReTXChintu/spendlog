import { Router } from "express";
import { FilterQuery, Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { AccountDoc, CategoryDoc, Transaction, TransactionDoc, Trip, TripDoc, User } from "../../models";
import { accountLabel } from "../accounts/accounts.label";
import {
  assertTripMember,
  claimTransactions,
  generateJoinCode,
  isTripActive,
  runningAt,
  tripSettlement,
  tripSpendSummary,
} from "./trips.service";
import { isLikelyTravel } from "./trips.travel";

export const tripsRouter = Router();
tripsRouter.use(requireAuth);

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
        isActive: isTripActive(trip),
        totalMinor: totalsFor?.total ?? 0,
        transactionCount: totalsFor?.count ?? 0,
      };
    })
  );
});

// GET /trips/active — the running trip, if trip mode is on.
tripsRouter.get("/active", async (req, res) => {
  const trip = await Trip.findOne({ "members.userId": currentUserId(req), ...runningAt() }).sort({
    startedAt: -1,
  });
  res.json(trip ? { ...trip.toJSON(), isActive: true } : null);
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
  // payment ambiguous. A trip planned in Trippin whose dates are under way
  // counts as running too.
  const running = await Trip.findOne({ ownerId: userId, ...runningAt() });
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

  res.json({ ...trip.toJSON(), isActive: isTripActive(trip), claimedCount: claimed });
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

// GET /trips/:id/summary — what the trip cost, and where it went.
tripsRouter.get("/:id/summary", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const trip = await assertTripMember(req.params.id, userId);
  if (!trip) return res.status(404).json({ error: "Not found" });

  res.json({ trip: { ...trip.toJSON(), isActive: isTripActive(trip) }, ...(await tripSpendSummary(trip)) });
});

// GET /trips/:id/transactions — everyone's spending on the trip.
tripsRouter.get("/:id/transactions", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const trip = await assertTripMember(req.params.id, userId);
  if (!trip) return res.status(404).json({ error: "Not found" });

  const transactions = await Transaction.find({ tripId: trip._id })
    .sort({ occurredAt: -1 })
    .limit(500)
    .populate("category")
    .populate("account")
    .populate<{ userId: { _id: Types.ObjectId; name?: string | null; email: string } }>({
      path: "userId",
      select: "name email",
    });

  // userId is the payer's name once populated, so whether a row is the
  // caller's own - the only ones they can edit or take off - is said here.
  res.json(transactions.map((row) => ({ ...row.toJSON(), isMine: Boolean(row.userId?._id?.equals(userId)) })));
});

const DAY_MS = 24 * 60 * 60 * 1000;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** Enough to scroll through; a search narrows anything past it. */
const CANDIDATE_LIMIT = 300;

const candidatesQuerySchema = z.object({
  // How far before the start to look. Tickets are often booked months out,
  // so a year is allowed; asking for more gets a year rather than an error.
  days: z.coerce
    .number()
    .int()
    .min(0)
    .default(60)
    .transform((days) => Math.min(days, 365)),
  q: z.string().trim().max(80).optional(),
});

/** Escapes regex metacharacters so a search term can't alter the pattern. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /trips/:id/candidates — the caller's own payments that could be put
// on the trip by hand: the train booked a month before, the hotel's
// advance. Nothing the window would ever claim on its own, which is the
// point.
//
// Only the caller's, never another member's: adding a payment to a trip
// publishes it to everyone on it, and that is each person's own call.
tripsRouter.get("/:id/candidates", validObjectIdParam("id"), async (req, res) => {
  const parsed = candidatesQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const trip = await assertTripMember(req.params.id, userId);
  if (!trip) return res.status(404).json({ error: "Not found" });

  const filter: FilterQuery<TransactionDoc> = {
    userId,
    type: "DEBIT",
    // Not on this trip or any other. Moving a payment between trips is the
    // edit sheet's job, where the trip it is leaving is in plain sight.
    tripId: null,
    // Money that only moved between the user's own accounts, or paid off a
    // card whose purchases are already here, was never trip spending.
    isTransfer: { $ne: true },
    cardPaymentFor: null,
    occurredAt: { $gte: new Date(trip.startedAt.getTime() - parsed.data.days * DAY_MS), $lte: new Date() },
  };
  if (parsed.data.q) {
    const term = { $regex: escapeRegex(parsed.data.q), $options: "i" };
    filter.$or = [{ merchant: term }, { note: term }];
  }

  const rows = await Transaction.find(filter)
    .sort({ occurredAt: -1 })
    .limit(CANDIDATE_LIMIT)
    .populate<{ category: CategoryDoc | null }>("category")
    .populate<{ account: AccountDoc | null }>("account");

  const candidates = rows.map((row) => {
    const categoryName = row.category?.name ?? null;
    return {
      id: row.id as string,
      occurredAt: row.occurredAt,
      merchant: row.merchant ?? null,
      amountMinor: row.amountMinor,
      accountLabel: row.account ? accountLabel(row.account) : null,
      categoryName,
      likelyTravel: isLikelyTravel({ merchant: row.merchant, categoryName }),
    };
  });

  // The tickets and rooms first, each half still newest first - sort() is
  // stable, so the order from the query survives within each.
  candidates.sort((a, b) => Number(b.likelyTravel) - Number(a.likelyTravel));

  res.json(candidates);
});

const addSchema = z.object({
  transactionIds: z.array(z.string().regex(OBJECT_ID)).min(1).max(500),
});

// POST /trips/:id/add — puts payments on the trip by hand, whatever their
// dates.
//
// Marked as edited, the same as an edit sheet's save, so no re-scan or
// change to the trip's dates ever takes them back off. Only the caller's
// own rows move; anything else in the list is counted as skipped rather
// than refused outright, so one stale id does not lose the rest.
tripsRouter.post("/:id/add", validObjectIdParam("id"), async (req, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const trip = await assertTripMember(req.params.id, userId);
  if (!trip) return res.status(404).json({ error: "Not found" });

  const ids = [...new Set(parsed.data.transactionIds)];
  const own = await Transaction.find({ _id: { $in: ids }, userId }).select("_id tripId");
  const moving = own.filter((row) => !row.tripId?.equals(trip._id)).map((row) => row._id);

  if (moving.length > 0) {
    await Transaction.updateMany(
      { _id: { $in: moving }, userId },
      // "Just me" was said about whichever trip it was on before, and names
      // people who may not be on this one.
      { $set: { tripId: trip._id, tripShareWith: null, editedAt: new Date() } }
    );
  }

  res.json({ added: own.length, skipped: ids.length - own.length });
});

// GET /trips/:id — the trip and who is on it.
tripsRouter.get("/:id", validObjectIdParam("id"), async (req, res) => {
  const trip = await assertTripMember(req.params.id, currentUserId(req));
  if (!trip) return res.status(404).json({ error: "Not found" });

  const users = await User.find({ _id: { $in: trip.members.map((m) => m.userId) } })
    .select("name email")
    .lean();

  res.json({
    ...trip.toJSON(),
    isActive: isTripActive(trip),
    members: trip.members.map((member) => {
      const user = users.find((u) => u._id.equals(member.userId));
      return {
        userId: member.userId,
        joinedAt: member.joinedAt,
        name: user?.name ?? user?.email ?? "Someone",
        isOwner: trip.ownerId.equals(member.userId),
      };
    }),
  });
});

const joinSchema = z.object({
  code: z.string().min(4).max(12),
});

// POST /trips/join — the other half of a code read out or scanned.
//
// Joining shares the trip from this moment on. It deliberately does not
// reach back and hand over what was already spent: someone joining on day
// three has agreed to share a holiday, not to publish the week before it.
// Their earlier payments can still be added on purpose, through re-scan or
// picked one by one (POST /trips/:id/add).
tripsRouter.post("/join", async (req, res) => {
  const parsed = joinSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const trip = await Trip.findOne({ joinCode: parsed.data.code.trim().toUpperCase() });
  if (!trip) return res.status(404).json({ error: "No trip with that code" });

  if (trip.members.some((member) => member.userId.equals(userId))) {
    return res.json({ ...trip.toJSON(), isActive: isTripActive(trip), alreadyJoined: true });
  }

  trip.members.push({ userId, joinedAt: new Date() });
  await trip.save();

  res.json({ ...trip.toJSON(), isActive: isTripActive(trip), alreadyJoined: false });
});

// POST /trips/:id/rotate-code — for a code that has ended up somewhere it
// should not have. Everyone already on the trip stays on it.
tripsRouter.post("/:id/rotate-code", validObjectIdParam("id"), async (req, res) => {
  const trip = await Trip.findOne({ _id: req.params.id, ownerId: currentUserId(req) });
  if (!trip) return res.status(404).json({ error: "Not found" });

  trip.joinCode = generateJoinCode();
  await trip.save();

  res.json({ joinCode: trip.joinCode });
});

// POST /trips/:id/leave — stop seeing a trip someone else is running.
//
// What they spent stays on the trip: the total should not quietly drop
// because a person walked away from it. The owner cannot leave, since
// somebody has to be able to end or delete it.
tripsRouter.post("/:id/leave", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const trip = await assertTripMember(req.params.id, userId);
  if (!trip) return res.status(404).json({ error: "Not found" });

  if (trip.ownerId.equals(userId)) {
    return res.status(400).json({ error: "You started this trip. End or delete it instead." });
  }

  trip.members = trip.members.filter((member) => !member.userId.equals(userId));
  await trip.save();

  res.status(204).end();
});

// DELETE /trips/:id/members/:userId — the owner removing someone.
tripsRouter.delete(
  "/:id/members/:memberId",
  validObjectIdParam("id"),
  validObjectIdParam("memberId"),
  async (req, res) => {
    const userId = currentUserId(req);
    const trip = await Trip.findOne({ _id: req.params.id, ownerId: userId });
    if (!trip) return res.status(404).json({ error: "Not found" });

    if (trip.ownerId.equals(new Types.ObjectId(req.params.memberId))) {
      return res.status(400).json({ error: "The owner cannot be removed from their own trip" });
    }

    trip.members = trip.members.filter(
      (member) => !member.userId.equals(new Types.ObjectId(req.params.memberId))
    );
    await trip.save();

    res.status(204).end();
  }
);

// GET /trips/:id/settlement — who owes whom, and the payments that square
// it off. The arithmetic and its rules live in tripSettlement.
tripsRouter.get("/:id/settlement", validObjectIdParam("id"), async (req, res) => {
  const trip = await assertTripMember(req.params.id, currentUserId(req));
  if (!trip) return res.status(404).json({ error: "Not found" });

  res.json(await tripSettlement(trip));
});
