import { prisma } from "../db";
import { AccountType } from "../types";

/**
 * Finds or creates the Account row for a detected bank/card/UPI handle so
 * repeated messages from the same account resolve to the same Account id
 * (needed for self-transfer detection across two of the user's accounts).
 */
export async function resolveAccount(
  userId: string,
  detected: { bankName: string; last4: string | null; accountType: AccountType } | null
): Promise<string | null> {
  if (!detected) return null;

  const existing = await prisma.account.findFirst({
    where: {
      userId,
      bankName: detected.bankName,
      last4: detected.last4,
      accountType: detected.accountType,
    },
  });
  if (existing) return existing.id;

  const created = await prisma.account.create({
    data: {
      userId,
      bankName: detected.bankName,
      last4: detected.last4,
      accountType: detected.accountType,
    },
  });
  return created.id;
}
