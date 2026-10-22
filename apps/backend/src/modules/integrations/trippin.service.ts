import { HydratedDocument, Types } from "mongoose";
import { env } from "../../env";
import { Transaction, Trip, TripDoc, User } from "../../models";
import { ensureCashAccount } from "../../parsing/accounts";
import { istDayEnd, istDayKey, istDayStart } from "../../time";
import {
  claimTransactions,
  generateJoinCode,
  runningAt,
  tripSettlement,
  tripSpendSummary,
} from "../groups/groups.service";

/**
 * Trippin, the suite's trip planner, tracking a trip's spending here.
 *
 * Trippin is the hub: per trip, its owner can switch on "Track spending in
 * SpendLog", and from then on Trippin tells SpendLog what the trip is
 * called, when it is and who is on it. SpendLog does what it always does
 * with a trip - claims the payments in its window, totals them, settles
 * up - and answers Trippin's questions about the result.
 *
 * Each app still works on its own. A linked trip is an ordinary SpendLog
 * trip with a `source` saying where it was planned, and switching
 * tracking off unlinks it rather than deleting anything.
 *
 * People are matched across the two apps by their identity-server subject
 * (`oidcSub`), never by email.
 */

export interface TrippinPerson {
  sub: string;
  email?: string | null;
  name?: string | null;
  role?: string | null;
}

export interface TrippinTrip {
  id: string;
  title: string;
  startDate: string;
  endDate: string;
  destination?: string | null;
  url?: string | null;
  owner: TrippinPerson;
  members: TrippinPerson[];
}

export type TrippinEvent =
  | { id: string; type: "trip.linked" | "trip.updated" | "trip.members_changed"; trip: TrippinTrip }
  | { id: string; type: "trip.unlinked"; trip: { id: string } };

/**
 * Something Trippin asked for that SpendLog will not do, with a message
 * written for Trippin to show its user as it stands.
 */
export class TrippinRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** SpendLog's trip names are this long at most; Trippin's can be longer. */
const NAME_MAX = 80;

/** The SpendLog web page for a trip, which Trippin links to. */
export function tripWebUrl(tripId: Types.ObjectId | string): string {
  return `${env.frontendUrl.replace(/\/+$/, "")}/trips?trip=${tripId.toString()}`;
}

/**
 * Trippin's calendar dates as SpendLog's window: from midnight IST on the
 * first day to the last instant of the last, the same IST days SpendLog
 * files every payment under.
 */
export function tripWindow(trip: Pick<TrippinTrip, "startDate" | "endDate">) {
  const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && istDayKey(istDayStart(day)) === day;
  if (!valid(trip.startDate) || !valid(trip.endDate)) {
    throw new TrippinRefusal(400, "bad_dates", "startDate and endDate must be real dates, as YYYY-MM-DD.");
  }
  if (trip.endDate < trip.startDate) {
    throw new TrippinRefusal(400, "bad_dates", "The trip cannot end before it starts.");
  }
  return { startedAt: istDayStart(trip.startDate), endedAt: istDayEnd(trip.endDate) };
}

type Resolved = { userId: Types.ObjectId; sub: string } | { skipped: string; sub: string; reason: string };

/**
 * The SpendLog account for a person on a Trippin trip, made on the spot if
 * they have never used SpendLog.
 *
 * Found by subject only. Someone who has no account here gets a normal
 * owner account carrying their subject - exactly what their first sign-in
 * would have made - so signing in later simply finds it.
 *
 * An email already in use here, by an account not linked to this subject,
 * is left alone rather than claimed. Sign-in links such an account only
 * when the identity server vouches the address is verified, which Trippin
 * cannot say; the person is picked up by the next change after they sign
 * in to SpendLog once. A kid's email is never matched at all: kids are not
 * at the identity server, and a kid's login is never put on a trip this
 * way.
 */
export async function resolveSuitePerson(person: TrippinPerson): Promise<Resolved> {
  const sub = person.sub;
  const linked = await User.findOne({ oidcSub: sub }).select("_id role");
  if (linked) {
    if (linked.role === "KID") return { skipped: sub, sub, reason: "kid" };
    return { userId: linked._id, sub };
  }

  const email = person.email?.trim().toLowerCase();
  if (!email) return { skipped: sub, sub, reason: "no_email" };

  if (await User.exists({ email })) return { skipped: sub, sub, reason: "email_in_use" };

  try {
    const user = await User.create({ email, name: person.name?.trim() || null, oidcSub: sub });
    await ensureCashAccount(user._id);
    return { userId: user._id, sub };
  } catch (err) {
    // Two events for the same new person at once: the other one made the
    // account, so use it.
    if ((err as { code?: number }).code === 11000) {
      const made = await User.findOne({ oidcSub: sub, role: { $ne: "KID" } }).select("_id");
      if (made) return { userId: made._id, sub };
      return { skipped: sub, sub, reason: "email_in_use" };
    }
    throw err;
  }
}

/**
 * The overlap rule.
 *
 * SpendLog runs one trip per person at a time - "trip mode" is a switch,
 * and two at once would leave every payment ambiguous. A Trippin trip
 * whose dates include today is running from the moment it is linked, so
 * linking it (or moving its dates onto today) while the owner already has
 * another trip running here is refused, with a message Trippin shows as it
 * stands. Nothing is changed and the event is not remembered, so the same
 * event goes through once the other trip has been ended.
 *
 * A trip entirely in the past or the future is never refused: it is not
 * running, and SpendLog's own trips can be scheduled around it.
 */
async function assertNoRunningOverlap(
  ownerId: Types.ObjectId,
  window: { startedAt: Date; endedAt: Date },
  exceptTripId?: Types.ObjectId
): Promise<void> {
  const now = new Date();
  if (window.startedAt > now || window.endedAt < now) return;

  const running = await Trip.findOne({
    ownerId,
    ...(exceptTripId ? { _id: { $ne: exceptTripId } } : {}),
    ...runningAt(now),
  }).select("name");

  if (running) {
    throw new TrippinRefusal(
      409,
      "running_trip_overlap",
      `"${running.name}" is already running in SpendLog. End it in SpendLog, then switch tracking on again.`,
      { spendlogTripId: running.id as string, spendlogTripName: running.name }
    );
  }
}

/**
 * Brings the trip's members in line with Trippin's list.
 *
 * Adds whoever is new, with `joinedAt` as given, so the payments they made
 * before joining are not pulled in (the same rule as joining with a code).
 * Removes only people Trippin itself put there and has now taken off;
 * someone who joined here with the code was never on Trippin's list and
 * stays. The owner is never removed. What a removed member spent stays on
 * the trip, as when the owner removes somebody here.
 */
async function syncMembers(trip: HydratedDocument<TripDoc>, trippin: TrippinTrip, joinedAt: Date) {
  const people = new Map<string, TrippinPerson>();
  for (const person of [trippin.owner, ...trippin.members]) {
    if (person?.sub && !people.has(person.sub)) people.set(person.sub, person);
  }

  const resolved = await Promise.all([...people.values()].map(resolveSuitePerson));
  const skipped = resolved.filter((r): r is Extract<Resolved, { skipped: string }> => "skipped" in r);

  for (const person of resolved) {
    if (!("userId" in person)) continue;
    if (!trip.members.some((member) => member.userId.equals(person.userId))) {
      trip.members.push({ userId: person.userId, joinedAt });
    }
  }

  const listed = new Set(people.keys());
  const previously = new Set(trip.source?.memberSubs ?? []);
  const leaving = [...previously].filter((sub) => !listed.has(sub));
  if (leaving.length > 0) {
    const gone = await User.find({ oidcSub: { $in: leaving } }).select("_id");
    trip.members = trip.members.filter(
      (member) => member.userId.equals(trip.ownerId) || !gone.some((user) => user._id.equals(member.userId))
    );
  }

  if (trip.source) trip.source.memberSubs = [...listed];
  return skipped.map(({ sub, reason }) => ({ sub, reason }));
}

/**
 * Takes back what an automatic pass put on the trip but its new dates no
 * longer cover. Anything edited by hand - including payments added to the
 * trip on purpose, whatever their date - stays exactly where it is.
 */
async function releaseOutsideWindow(trip: Pick<TripDoc, "_id" | "startedAt" | "endedAt">) {
  await Transaction.updateMany(
    {
      groupId: trip._id,
      editedAt: null,
      $or: [{ occurredAt: { $lt: trip.startedAt } }, { occurredAt: { $gt: trip.endedAt } }],
    },
    { $set: { groupId: null } }
  );
}

function findByTrippinId(externalId: string) {
  return Trip.findOne({ "source.app": "trippin", "source.externalId": externalId });
}

async function linkTrip(trippin: TrippinTrip) {
  const window = tripWindow(trippin);
  const now = new Date();
  // Everyone on the trip when tracking is switched on planned it together,
  // so they share it from its first day - unless it is linked late, in
  // which case from now, as anyone joining a trip under way would.
  const foundingJoin = now < window.startedAt ? now : window.startedAt;
  const name = trippin.title.trim().slice(0, NAME_MAX);

  let trip = await findByTrippinId(trippin.id);

  if (!trip) {
    const owner = await resolveSuitePerson(trippin.owner);
    if (!("userId" in owner)) {
      throw new TrippinRefusal(
        409,
        "owner_unavailable",
        owner.reason === "email_in_use"
          ? "A SpendLog account already uses this email but isn't linked to this sign-in yet. Sign in to SpendLog once, then switch tracking on again."
          : "This trip's owner can't have a SpendLog account through Trippin.",
        { reason: owner.reason }
      );
    }
    await assertNoRunningOverlap(owner.userId, window);

    trip = new Trip({
      ownerId: owner.userId,
      name,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
      members: [{ userId: owner.userId, joinedAt: foundingJoin }],
      joinCode: generateJoinCode(),
      source: { app: "trippin", externalId: trippin.id, linked: true, linkedAt: now, unlinkedAt: null },
    });
  } else {
    // Linked again after being switched off: the same trip, carrying on
    // with everything already on it.
    await assertNoRunningOverlap(trip.ownerId, window, trip._id);
    trip.name = name;
    trip.startedAt = window.startedAt;
    trip.endedAt = window.endedAt;
    trip.source!.linked = true;
    trip.source!.linkedAt = now;
    trip.source!.unlinkedAt = null;
  }
  trip.source!.url = trippin.url ?? null;

  const skippedMembers = await syncMembers(trip, trippin, foundingJoin);
  await trip.save();

  await releaseOutsideWindow(trip);
  // Anything already recorded inside the window belongs to it, exactly as
  // when a trip is started here.
  const claimedCount = await claimTransactions(trip, undefined, true);

  return { remoteId: trip.id as string, url: tripWebUrl(trip._id), claimedCount, skippedMembers };
}

async function updateTrip(trippin: TrippinTrip, moveDates: boolean) {
  const trip = await findByTrippinId(trippin.id);
  // Never linked, or switched off since: it is SpendLog's own trip now,
  // and Trippin no longer gets a say in it.
  if (!trip || !trip.source?.linked) return { ignored: "not_linked" };

  if (moveDates) {
    const window = tripWindow(trippin);
    await assertNoRunningOverlap(trip.ownerId, window, trip._id);
    trip.name = trippin.title.trim().slice(0, NAME_MAX);
    trip.startedAt = window.startedAt;
    trip.endedAt = window.endedAt;
    trip.source.url = trippin.url ?? trip.source.url ?? null;
  }

  const skippedMembers = await syncMembers(trip, trippin, new Date());
  await trip.save();

  if (moveDates) await releaseOutsideWindow(trip);
  await claimTransactions(trip, undefined, true);

  return skippedMembers.length > 0 ? { skippedMembers } : {};
}

async function unlinkTrip(externalId: string) {
  const trip = await findByTrippinId(externalId);
  if (trip?.source?.linked) {
    trip.source.linked = false;
    trip.source.unlinkedAt = new Date();
    await trip.save();
  }
  return {};
}

/** Does what an event says, and returns what Trippin is answered with. */
export async function applyTrippinEvent(event: TrippinEvent): Promise<Record<string, unknown>> {
  switch (event.type) {
    case "trip.linked":
      return linkTrip(event.trip);
    case "trip.updated":
      return updateTrip(event.trip, true);
    case "trip.members_changed":
      return updateTrip(event.trip, false);
    case "trip.unlinked":
      return unlinkTrip(event.trip.id);
  }
}

/**
 * The linked trip's figures, as Trippin shows them on its own trip page,
 * from the viewer's side: what they owe and are owed comes out of the
 * same settlement SpendLog shows.
 */
export async function trippinSummary(externalId: string, viewerSub: string | undefined) {
  const trip = await findByTrippinId(externalId);
  if (!trip || !trip.source?.linked) return null;

  const [summary, settlement, viewer, latest] = await Promise.all([
    tripSpendSummary(trip),
    tripSettlement(trip),
    viewerSub ? User.findOne({ oidcSub: viewerSub }).select("_id") : null,
    Transaction.findOne({ groupId: trip._id }).sort({ updatedAt: -1 }).select("updatedAt"),
  ]);

  const viewerId = viewer?._id.toString();
  const mine = viewerId ? settlement.balances.find((balance) => balance.userId === viewerId) : undefined;
  const sum = (amounts: number[]) => amounts.reduce((total, amount) => total + amount, 0);

  const latestUpdate = latest?.get("updatedAt") as Date | undefined;
  const updatedAt = latestUpdate && latestUpdate > trip.updatedAt ? latestUpdate : trip.updatedAt;

  return {
    linked: true,
    url: tripWebUrl(trip._id),
    totalSpentMinor: summary.totalMinor,
    currency: "INR",
    myShareMinor: mine?.shareMinor ?? 0,
    iOweMinor: viewerId
      ? sum(settlement.transfers.filter((t) => t.fromUserId === viewerId).map((t) => t.amountMinor))
      : 0,
    owedToMeMinor: viewerId
      ? sum(settlement.transfers.filter((t) => t.toUserId === viewerId).map((t) => t.amountMinor))
      : 0,
    settlement: settlement.transfers.map((t) => ({
      fromName: t.fromName,
      toName: t.toName,
      amountMinor: t.amountMinor,
    })),
    transactionCount: summary.transactionCount,
    updatedAt,
  };
}

/** Whether somebody already has a SpendLog account. Kids never count. */
export async function suiteUserExists(sub: string): Promise<boolean> {
  return Boolean(await User.exists({ oidcSub: sub, role: { $ne: "KID" } }));
}
