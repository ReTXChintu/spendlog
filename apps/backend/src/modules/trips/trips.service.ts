import { Types } from "mongoose";
import { Trip } from "../../models";

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
    "members.userId": userId,
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
