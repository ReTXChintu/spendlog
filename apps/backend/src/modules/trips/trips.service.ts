import { FilterQuery, Types } from "mongoose";
import { Transaction, Trip, TripDoc, User } from "../../models";
import { istDayKey } from "../../time";
import { computeBalances, settle } from "./trips.settlement";

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
export async function assertTripMember(tripId: string, userId: Types.ObjectId) {
  return Trip.findOne({ _id: tripId, "members.userId": userId });
}

/**
 * Which trip, if any, a payment made at this moment belongs to.
 *
 * Matched on when the money was spent rather than when the message turned
 * up, so an SMS that syncs three days after the holiday still lands on the
 * holiday. A finished trip still claims payments inside its window for the
 * same reason: the last dinner abroad does not stop being part of the trip
 * because the alert arrived on the flight home.
 */
export async function tripForOccurredAt(
  userId: Types.ObjectId,
  occurredAt: Date
): Promise<Types.ObjectId | null> {
  const trip = await Trip.findOne({
    // Only from the point this person joined. Someone who joins on day
    // three is sharing the trip from then on, not handing over the
    // spending they did before it — that stays theirs to add on purpose.
    members: { $elemMatch: { userId, joinedAt: { $lte: occurredAt } } },
    startedAt: { $lte: occurredAt },
    $or: [{ endedAt: null }, { endedAt: { $gte: occurredAt } }],
  })
    // The most recently started wins, on the grounds that two overlapping
    // windows almost certainly means the newer one is the intended answer.
    .sort({ startedAt: -1 });

  return trip?._id ?? null;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A short code to read out or show as a QR.
 *
 * The alphabet leaves out the characters people misread to each other —
 * O and 0, I and 1 — because this gets spoken across a dinner table as
 * often as it gets scanned.
 */
export function generateJoinCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Whether a trip is running at this moment.
 *
 * A trip started here runs until somebody ends it, so it has no end yet.
 * One planned in Trippin comes with both dates, and runs between them:
 * a holiday from the 3rd to the 7th is on while it is the 5th, without
 * anyone having to switch it on.
 */
export function isTripActive(trip: Pick<TripDoc, "startedAt" | "endedAt">, now = new Date()): boolean {
  if (!trip.endedAt) return true;
  return trip.startedAt <= now && trip.endedAt >= now;
}

/** The query form of isTripActive, to merge into a trip filter. */
export function runningAt(now = new Date()): FilterQuery<TripDoc> {
  return { $or: [{ endedAt: null }, { startedAt: { $lte: now }, endedAt: { $gte: now } }] };
}

/**
 * Files everything inside the trip's window that is not on a trip already.
 *
 * Leaves anything hand-edited alone, which is how a transaction taken off a
 * trip on purpose stays off it — the same rule that stops automatic passes
 * overwriting corrections elsewhere.
 *
 * With `respectJoins`, each member's share of the window starts when they
 * joined rather than when the trip did: someone added on day three shares
 * the trip from then on, not the days before it.
 */
export async function claimTransactions(
  trip: Pick<TripDoc, "_id" | "members" | "startedAt" | "endedAt">,
  onlyUserId?: Types.ObjectId,
  respectJoins = false
): Promise<number> {
  const until = trip.endedAt ? { $lte: trip.endedAt } : {};

  if (!respectJoins) {
    const memberIds = onlyUserId ? [onlyUserId] : trip.members.map((member) => member.userId);
    const result = await Transaction.updateMany(
      {
        userId: { $in: memberIds },
        tripId: null,
        editedAt: null,
        occurredAt: { $gte: trip.startedAt, ...until },
      },
      { $set: { tripId: trip._id } }
    );
    return result.modifiedCount;
  }

  let claimed = 0;
  for (const member of trip.members) {
    if (onlyUserId && !member.userId.equals(onlyUserId)) continue;
    const from = member.joinedAt > trip.startedAt ? member.joinedAt : trip.startedAt;
    if (trip.endedAt && from > trip.endedAt) continue;

    const result = await Transaction.updateMany(
      { userId: member.userId, tripId: null, editedAt: null, occurredAt: { $gte: from, ...until } },
      { $set: { tripId: trip._id } }
    );
    claimed += result.modifiedCount;
  }
  return claimed;
}

/** What a trip cost, and where it went. */
export async function tripSpendSummary(trip: Pick<TripDoc, "_id">) {
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

  const totalMinor: number = byMember.reduce((sum, entry) => sum + entry.spentMinor, 0);

  // Days actually spent money on, not days elapsed: a trip with a quiet
  // Sunday should not look cheaper per day because of it.
  const dayCount = new Set(days.map((row) => istDayKey(row.occurredAt))).size;

  return {
    totalMinor,
    transactionCount: days.length,
    dayCount,
    perDayMinor: dayCount === 0 ? 0 : Math.round(totalMinor / dayCount),
    byMember,
    byCategory,
  };
}

/**
 * Who owes whom on a trip, and the payments that square it off.
 *
 * Every expense is shared by everyone on the trip unless it says
 * otherwise, which is the common case and saves marking each one up. The
 * figures come from countedAmountMinor, so a refunded hotel and a bill
 * split with somebody outside the trip both behave without this knowing
 * anything about refunds or splits.
 */
export async function tripSettlement(trip: Pick<TripDoc, "_id" | "members">) {
  const memberIds = trip.members.map((member) => member.userId.toString());

  const transactions = await Transaction.find({
    tripId: trip._id,
    type: "DEBIT",
    countedAmountMinor: { $gt: 0 },
  }).select("userId countedAmountMinor tripShareWith");

  const expenses = transactions.map((transaction) => ({
    payerId: transaction.userId.toString(),
    amountMinor: transaction.countedAmountMinor,
    sharerIds: transaction.tripShareWith?.length
      ? transaction.tripShareWith.map((id) => id.toString())
      : memberIds,
  }));

  const balances = computeBalances(expenses);
  const transfers = settle(balances);

  // Anyone who has left still appears in the arithmetic, so their name has
  // to be resolvable too.
  const involved = new Set([...balances.map((b) => b.userId), ...memberIds]);
  const users = await User.find({ _id: { $in: [...involved] } })
    .select("name email")
    .lean();

  const nameFor = (userId: string) => {
    const user = users.find((candidate) => candidate._id.toString() === userId);
    return user?.name ?? user?.email ?? "Someone";
  };

  return {
    balances: balances.map((balance) => ({ ...balance, name: nameFor(balance.userId) })),
    transfers: transfers.map((transfer) => ({
      ...transfer,
      fromName: nameFor(transfer.fromUserId),
      toName: nameFor(transfer.toUserId),
    })),
  };
}
