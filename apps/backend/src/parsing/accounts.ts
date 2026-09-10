import { Types } from "mongoose";
import { Account } from "../models";
import { AccountType } from "../types";

/**
 * Finds or creates the Account row for a detected bank/card/UPI handle so
 * repeated messages from the same account resolve to the same Account id
 * (needed for self-transfer detection across two of the user's accounts).
 *
 * The detected tuple is matched against each account's own identity *and*
 * its aliases. Without the alias check, merging two accounts that the same
 * bank spells differently would only hold until its next message, which
 * would recreate the duplicate.
 */
export async function resolveAccount(
  userId: Types.ObjectId,
  detected: { bankName: string; last4: string | null; accountType: AccountType } | null
): Promise<Types.ObjectId | null> {
  if (!detected) return null;

  const existing = await findByTuple(userId, detected);
  if (existing) return existing;

  try {
    const created = await Account.create({ userId, ...detected });
    return created._id;
  } catch (error) {
    // Two messages for a new account can be ingested at once — the
    // foreground listener and the background isolate both post. The unique
    // index settles it; the loser just reads back the winner's row.
    if (isDuplicateKeyError(error)) {
      const raced = await findByTuple(userId, detected);
      if (raced) return raced;
    }
    throw error;
  }
}

async function findByTuple(
  userId: Types.ObjectId,
  detected: { bankName: string; last4: string | null; accountType: AccountType }
): Promise<Types.ObjectId | null> {
  const account = await Account.findOne({
    userId,
    $or: [
      { bankName: detected.bankName, last4: detected.last4, accountType: detected.accountType },
      { aliases: { $elemMatch: detected } },
    ],
  });

  return account?._id ?? null;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}
