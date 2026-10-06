import fs from "node:fs";
import { GoogleAuth } from "google-auth-library";
import { Types } from "mongoose";
import { User } from "../../models";

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
  const tokens = (owner.fcmTokens ?? []).map((entry) => entry.token);
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

  const accessToken = await config.auth.getAccessToken();
  const dead: string[] = [];
  let sent = 0;

  for (const token of tokens) {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${config.account.project_id}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            // Data only: nothing is shown, the app just wakes and reads.
            data: { type: "SMS_SYNC" },
            android: { priority: "HIGH", ttl: "600s" },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      }
    ).catch(() => null);

    if (response?.ok) sent += 1;
    else if (response && (response.status === 404 || response.status === 400)) dead.push(token);
  }

  if (dead.length > 0) {
    await User.updateOne({ _id: ownerId }, { $pull: { fcmTokens: { token: { $in: dead } } } });
  }

  return sent > 0 ? { pinged: true, devices: sent } : { pinged: false, reason: "no-device" };
}
