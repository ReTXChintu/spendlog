import { Types } from "mongoose";
import { runOncePerUser } from "../../backfill";
import { FundHolding } from "../../models";

/**
 * Gives every SIP stored as one amount a history of one step.
 *
 * Before steps, a SIP was an amount from its start date; now it is the
 * amounts it ran at, month by month (funds.sip.ts). One step at the old
 * amount from the old start is the same SIP, so no figure moves - units,
 * invested and XIRR come out exactly as they did. Written out rather than
 * only read that way so every SIP has the one shape to edit, though every
 * reader still treats a SIP without steps as that one step, so a row this
 * hasn't reached yet is never wrong.
 */
export const SIP_STEPS_BACKFILL = "sipSteps";
export const SIP_STEPS_BACKFILL_VERSION = 1;

/** One user's pass. Safe to run twice: the second finds nothing to do. */
export async function backfillSipSteps(userId: Types.ObjectId): Promise<number> {
  const result = await FundHolding.collection.updateMany(
    {
      userId,
      sip: { $type: "object" },
      $or: [{ "sip.steps": { $exists: false } }, { "sip.steps": null }, { "sip.steps": { $size: 0 } }],
    },
    [
      {
        $set: {
          "sip.steps": [{ fromOn: "$sip.startOn", amountMinor: "$sip.amountMinor", dayOfMonth: null }],
          "sip.skips": { $ifNull: ["$sip.skips", []] },
          "sip.pauses": { $ifNull: ["$sip.pauses", []] },
        },
      },
    ]
  );
  return result.modifiedCount;
}

/** Every user who has not had this pass yet. Called once at start-up. */
export async function runSipStepsBackfill(): Promise<void> {
  const { users, changed } = await runOncePerUser(SIP_STEPS_BACKFILL, SIP_STEPS_BACKFILL_VERSION, backfillSipSteps);
  if (changed > 0) console.log(`SIP steps backfill: gave ${changed} SIPs across ${users} users a one-step history.`);
}
