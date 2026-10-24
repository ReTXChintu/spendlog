import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { Types } from "mongoose";
import { User } from "../../models";
import { distinctTokens } from "./family.devices";

/**
 * Waking the owner's phone so it reads new SMS, when a kid asks for fresh
 * transactions.
 *
 * Every bank message lands on the owner's phone, not the kid's - so a kid
 * pulling to refresh can only get something new if the owner's phone goes
 * and looks. A silent, high-priority Firebase data message does that: the
 * app wakes in the background, reads the inbox and uploads what it finds.
 *
 * Configured by a service-account key file from the Firebase project,
 * named in FIREBASE_SERVICE_ACCOUNT_FILE. Without one this says so, and a
 * kid's refresh simply reloads what the server already has.
 */

/** At most once in this long, however often a kid refreshes. */
export const PING_EVERY_MS = 10 * 60 * 1000;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cached: { account: ServiceAccount; auth: GoogleAuth } | null | undefined;

function firebase(): { account: ServiceAccount; auth: GoogleAuth } | null {
  if (cached !== undefined) return cached;
  const file = process.env.FIREBASE_SERVICE_ACCOUNT_FILE ?? "";
  try {
    if (!file) throw new Error("not set");
    const account = JSON.parse(fs.readFileSync(file, "utf8")) as ServiceAccount;
    if (!account.project_id || !account.client_email || !account.private_key) throw new Error("incomplete");
    cached = {
      account,
      auth: new GoogleAuth({
        credentials: { client_email: account.client_email, private_key: account.private_key },
        scopes: ["https://www.googleapis.com/auth/firebase.messaging"],
      }),
    };
  } catch {
    cached = null;
  }
  return cached;
}

export function pushAvailable(): boolean {
  return firebase() !== null;
}

/**
 * Stands in for the service-account file, for the tests: a project id and
 * a token to send, with no key to sign and no Google to ask. Null puts the
 * file back.
 */
export function useFirebaseForTests(fake: { projectId: string; accessToken: string } | null): void {
  cached =
    fake === null
      ? undefined
      : {
          account: { project_id: fake.projectId, client_email: "test@example.com", private_key: "" },
          auth: { getAccessToken: async () => fake.accessToken } as unknown as GoogleAuth,
        };
}

/**
 * One message to every device of a user's, through Firebase. Devices
 * Firebase says no longer exist are forgotten on the way. Returns how
 * many took it.
 */
async function deliver(
  config: { account: ServiceAccount; auth: GoogleAuth },
  userId: Types.ObjectId,
  tokens: string[],
  message: Record<string, unknown>
): Promise<number> {
  const accessToken = await config.auth.getAccessToken();
  const dead: string[] = [];
  let sent = 0;

  for (const token of tokens) {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${config.account.project_id}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { token, ...message } }),
        signal: AbortSignal.timeout(15_000),
      }
    ).catch(() => null);

    if (response?.ok) sent += 1;
    else if (response && (response.status === 404 || response.status === 400)) dead.push(token);
  }

  if (dead.length > 0) {
    await User.updateOne({ _id: userId }, { $pull: { fcmTokens: { token: { $in: dead } } } });
  }
  return sent;
}

export type NotifyResult =
  | { sent: true; devices: number }
  | { sent: false; reason: "not-configured" | "no-device" };

/**
 * Something the user should see: a notification with a title and a body,
 * shown by the phone whether or not the app is open, unlike the silent
 * ping above. `data` rides along for the app to open the right screen.
 */
export async function sendNotification(
  userId: Types.ObjectId,
  note: { title: string; body: string; data?: Record<string, string> }
): Promise<NotifyResult> {
  const config = firebase();
  if (!config) return { sent: false, reason: "not-configured" };

  const user = await User.findById(userId).select("fcmTokens");
  // Each phone once, even if its token was ever stored twice.
  const tokens = distinctTokens(user?.fcmTokens);
  if (tokens.length === 0) return { sent: false, reason: "no-device" };

  const devices = await deliver(config, userId, tokens, {
    notification: { title: note.title, body: note.body },
    data: note.data ?? {},
    android: { priority: "HIGH" },
  });
  return devices > 0 ? { sent: true, devices } : { sent: false, reason: "no-device" };
}

export type PingResult =
  | { pinged: true; devices: number }
  | { pinged: false; reason: "not-configured" | "no-device" | "too-soon"; nextAllowedAt?: Date };

/**
 * Asks the owner's phone(s) to read new SMS, unless one was asked within
 * the last ten minutes. A device Firebase says no longer exists is
 * forgotten on the way.
 */
export async function pingOwnerForSms(ownerId: Types.ObjectId, now = new Date()): Promise<PingResult> {
  const config = firebase();
  if (!config) return { pinged: false, reason: "not-configured" };

  const owner = await User.findById(ownerId).select("fcmTokens lastSmsPingAt").orFail();
  const tokens = distinctTokens(owner.fcmTokens);
  if (tokens.length === 0) return { pinged: false, reason: "no-device" };

  if (owner.lastSmsPingAt && now.getTime() - owner.lastSmsPingAt.getTime() < PING_EVERY_MS) {
    return {
      pinged: false,
      reason: "too-soon",
      nextAllowedAt: new Date(owner.lastSmsPingAt.getTime() + PING_EVERY_MS),
    };
  }

  // Claimed before sending, so two kids refreshing together send one.
  const claimed = await User.updateOne(
    {
      _id: ownerId,
      $or: [{ lastSmsPingAt: null }, { lastSmsPingAt: { $lte: new Date(now.getTime() - PING_EVERY_MS) } }],
    },
    { $set: { lastSmsPingAt: now } }
  );
  if (claimed.modifiedCount === 0) return { pinged: false, reason: "too-soon" };

  const sent = await deliver(config, ownerId, tokens, {
    // Data only: nothing is shown, the app just wakes and reads.
    data: { type: "SMS_SYNC" },
    android: { priority: "HIGH", ttl: "600s" },
  });

  return sent > 0 ? { pinged: true, devices: sent } : { pinged: false, reason: "no-device" };
}
