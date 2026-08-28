import { prisma } from "../db";

/**
 * Picks a categoryId for a new transaction by checking the user's own rules
 * first (most specific / most recently added wins via priority), then the
 * system default rules, matching against merchant name and the raw source
 * text. Returns null if nothing matches — caller leaves it uncategorized
 * for the user to set manually ("Others" is a rule-based match, not a
 * silent fallback, so truly unmatched transactions stay visibly unsorted).
 */
export async function categorizeTransaction(params: {
  userId: string;
  merchant: string | null;
  rawText: string | null;
}): Promise<string | null> {
  const haystack = `${params.merchant ?? ""} ${params.rawText ?? ""}`.toLowerCase();
  if (!haystack.trim()) return null;

  const rules = await prisma.categoryRule.findMany({
    where: { OR: [{ userId: params.userId }, { userId: null }] },
    orderBy: [{ userId: "desc" }, { priority: "desc" }],
  });

  for (const rule of rules) {
    const pattern = rule.pattern.toLowerCase();
    const matched =
      rule.matchType === "EXACT"
        ? haystack.trim() === pattern
        : haystack.includes(pattern);

    if (matched) return rule.categoryId;
  }

  return null;
}
