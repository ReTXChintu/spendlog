import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { User } from "../../models";

/** The newest few: a phone reinstalled ten times should not be woken ten times. */
export const MAX_DEVICES = 5;

/**
 * Remembers a phone's push token for its owner, as the newest one.
 *
 * One write, so it cannot race itself. The app registers on sign-in and
 * again whenever Firebase hands it a token, and the two calls can land
 * together; done as "remove it, then add it" in two writes, both removes
 * ran before either add and the token was kept twice - every notification
 * then reached the phone twice. Here the removal and the append happen in
 * the same single-document update, which MongoDB applies one at a time.
 */
export async function registerDevice(ownerId: Types.ObjectId, token: string, now = new Date()): Promise<void> {
  await User.collection.updateOne({ _id: ownerId }, [
    {
      $set: {
        fcmTokens: {
          $slice: [
            {
              $concatArrays: [
                {
                  $filter: {
                    input: { $ifNull: ["$fcmTokens", []] },
                    cond: { $ne: ["$$this.token", token] },
                  },
                },
                [{ token, updatedAt: now }],
              ],
            },
            -MAX_DEVICES,
          ],
        },
      },
    },
  ]);
}

/** Each token once, however many times it was stored. */
export function distinctTokens(entries: { token: string }[] | null | undefined): string[] {
  return [...new Set((entries ?? []).map((entry) => entry.token))];
}

export const FCM_TOKEN_DEDUPE_BACKFILL = "fcmTokenDedupe";
export const FCM_TOKEN_DEDUPE_BACKFILL_VERSION = 1;

/** One user's tokens with each kept once, at its newest. Returns how many copies went. */
export async function collapseDuplicateTokens(userId: Types.ObjectId): Promise<number> {
  const user = await User.findById(userId).select("fcmTokens").lean();
  const entries = user?.fcmTokens ?? [];
  const newest = new Map<string, { token: string; updatedAt: Date }>();
  for (const entry of entries) {
    const kept = newest.get(entry.token);
    if (!kept || new Date(entry.updatedAt) > new Date(kept.updatedAt)) newest.set(entry.token, entry);
  }
  const removed = entries.length - newest.size;
  if (removed === 0) return 0;

  const collapsed = [...newest.values()].sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
  await User.updateOne({ _id: userId }, { $set: { fcmTokens: collapsed } });
  return removed;
}

/** Tokens stored twice by the old two-step registration, kept once. */
export async function runFcmTokenDedupeBackfill(): Promise<{ users: number; changed: number }> {
  const result = await runOncePerUser(FCM_TOKEN_DEDUPE_BACKFILL, FCM_TOKEN_DEDUPE_BACKFILL_VERSION, collapseDuplicateTokens);
  if (result.users > 0) {
    console.log(`Push token cleanup: ${result.changed} duplicate tokens removed across ${result.users} users.`);
  }
  return result;
}
