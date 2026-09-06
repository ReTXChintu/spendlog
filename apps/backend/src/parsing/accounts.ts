import { Types } from "mongoose";
import { Account } from "../models";
import { AccountType } from "../types";

/**
 * Finds or creates the Account row for a detected bank/card/UPI handle so
 * repeated messages from the same account resolve to the same Account id
 * (needed for self-transfer detection across two of the user's accounts).
 */
export async function resolveAccount(
  userId: Types.ObjectId,
  detected: { bankName: string; last4: string | null; accountType: AccountType } | null
): Promise<Types.ObjectId | null> {
  if (!detected) return null;

  const account = await Account.findOneAndUpdate(
    {
      userId,
      bankName: detected.bankName,
      last4: detected.last4,
      accountType: detected.accountType,
    },
    { $setOnInsert: { userId, ...detected } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return account._id;
}
