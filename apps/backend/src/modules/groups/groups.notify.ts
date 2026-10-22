import { Types } from "mongoose";
import { sendNotification } from "../family/family.push";

/**
 * What a group tells its people's phones: that they were put in one from
 * Trippin, that someone joined theirs, and that someone paid for something
 * they have a share of.
 *
 * Shares are gathered for a minute per person before anything is sent, so
 * a trip linked from Trippin that takes in twenty payments at once reads
 * as one notification, not twenty. A payment from more than a week ago
 * never notifies: that is a backfill or an old row being tidied, not news.
 *
 * Tapping any of them opens the group (spendlog://app/groups/<id>).
 */

export type GroupNote = { title: string; body: string; data: Record<string, string> };
type Sender = (userId: Types.ObjectId, note: GroupNote) => Promise<unknown>;

let send: Sender = (userId, note) => sendNotification(userId, note);

/** Stands in for Firebase, for the tests; null puts it back. */
export function setGroupNotifierForTests(fake: Sender | null): void {
  send = fake ?? ((userId, note) => sendNotification(userId, note));
}

export const SHARE_BATCH_MS = 60_000;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

const rupees = (minor: number) =>
  `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: minor % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

const groupData = (groupId: Types.ObjectId | string): Record<string, string> => ({
  type: "GROUP",
  groupId: groupId.toString(),
  link: `spendlog://app/groups/${groupId.toString()}`,
});

function deliver(userId: Types.ObjectId, note: GroupNote): void {
  // Never fails what caused it: a phone that can't be reached is not an error here.
  void send(userId, note).catch(() => {});
}

/** Trippin put them in a group (a linked trip they're on). */
export function noteAddedFromTrippin(userId: Types.ObjectId, group: { _id: Types.ObjectId; name: string }): void {
  deliver(userId, {
    title: `You're in ${group.name}`,
    body: "Added from Trippin. Spending on the trip is split here.",
    data: groupData(group._id),
  });
}

/** Someone joined the owner's group with its code. */
export function noteJoined(ownerId: Types.ObjectId, joinerName: string, group: { _id: Types.ObjectId; name: string }): void {
  deliver(ownerId, {
    title: `${joinerName} joined ${group.name}`,
    body: "Payments they share from now on are split with them.",
    data: groupData(group._id),
  });
}

interface Share {
  groupId: string;
  groupName: string;
  payerName: string;
  what: string | null;
  shareMinor: number;
}

const pending = new Map<string, { shares: Share[]; timer: NodeJS.Timeout | null }>();

/**
 * A mirror was just written: someone else paid and [holderId] has a share.
 * Sent a minute later, together with any others that came in meanwhile.
 */
export function noteShare(
  holderId: Types.ObjectId,
  share: Share & { occurredAt: Date },
  now = new Date()
): void {
  if (now.getTime() - share.occurredAt.getTime() > RECENT_MS) return;
  const key = holderId.toString();
  const batch = pending.get(key) ?? { shares: [], timer: null };
  batch.shares.push({ groupId: share.groupId, groupName: share.groupName, payerName: share.payerName, what: share.what, shareMinor: share.shareMinor });
  if (!batch.timer) {
    batch.timer = setTimeout(() => flushShares(key), SHARE_BATCH_MS);
    batch.timer.unref?.();
  }
  pending.set(key, batch);
}

/** The notification for a person's gathered shares. */
export function shareNote(shares: Share[]): GroupNote {
  const total = shares.reduce((sum, share) => sum + share.shareMinor, 0);
  const groups = [...new Set(shares.map((share) => share.groupId))];
  const first = shares[0];
  if (shares.length === 1) {
    return {
      title: `${first.payerName} paid${first.what ? ` for ${first.what}` : ""}`,
      body: `Your share: ${rupees(total)} · ${first.groupName}`,
      data: groupData(first.groupId),
    };
  }
  return {
    title: `${shares.length} payments include your share`,
    body:
      groups.length === 1
        ? `${rupees(total)} in all · ${first.groupName}`
        : `${rupees(total)} in all · ${groups.length} groups`,
    data: groups.length === 1 ? groupData(first.groupId) : { type: "GROUP" },
  };
}

/** Sends what's gathered for one person (or everyone), now. */
export function flushShares(key?: string): void {
  for (const [holder, batch] of [...pending]) {
    if (key && holder !== key) continue;
    if (batch.timer) clearTimeout(batch.timer);
    pending.delete(holder);
    if (batch.shares.length > 0) deliver(new Types.ObjectId(holder), shareNote(batch.shares));
  }
}
