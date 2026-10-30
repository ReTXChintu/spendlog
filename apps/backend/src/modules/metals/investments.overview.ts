import { Router } from "express";
import { Types } from "mongoose";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { depositsOf } from "../deposits/deposits.service";
import { loadPortfolio, portfolioTotals } from "../funds/funds.portfolio";
import { holdingsOf } from "./metals.holdings";

/**
 * Everything the user holds, in one total: mutual funds at today's NAV,
 * RDs and FDs at what they hold, gold and silver at today's rate - each
 * with what went into it, and the gain where that is known. A deposit's
 * gain is not kept (no interest is tracked), so it counts at what went in.
 */

export interface OverviewPart {
  kind: "FUNDS" | "DEPOSITS" | "GOLD" | "SILVER";
  label: string;
  valueMinor: number;
  /// Null when part of it was held before SpendLog with no cost given.
  investedMinor: number | null;
  count: number;
}

export async function investmentsOverview(userId: Types.ObjectId, now = new Date()) {
  const [portfolio, deposits, holdings] = await Promise.all([
    loadPortfolio(userId, now).catch(() => null),
    depositsOf(userId, now),
    holdingsOf(userId, now),
  ]);

  const parts: OverviewPart[] = [];
  if (portfolio && portfolio.views.length > 0) {
    const { totals } = portfolioTotals(portfolio.views);
    parts.push({ kind: "FUNDS", label: "Mutual funds", valueMinor: totals.valueMinor, investedMinor: totals.investedMinor, count: portfolio.views.length });
  }
  const openDeposits = deposits.filter((d) => d.isActive);
  if (openDeposits.length > 0) {
    const total = openDeposits.reduce((sum, d) => sum + d.totalMinor, 0);
    parts.push({ kind: "DEPOSITS", label: "RDs and FDs", valueMinor: total, investedMinor: total, count: openDeposits.length });
  }
  for (const [kind, label, metal] of [
    ["GOLD", "Gold", (p: string) => p !== "SILVER"],
    ["SILVER", "Silver", (p: string) => p === "SILVER"],
  ] as const) {
    const mine = holdings.filter((h) => h.isActive && metal(h.purity));
    if (mine.length === 0) continue;
    parts.push({
      kind,
      label,
      valueMinor: mine.reduce((sum, h) => sum + (h.valueMinor ?? 0), 0),
      investedMinor: mine.some((h) => h.investedMinor === null) ? null : mine.reduce((sum, h) => sum + h.investedMinor!, 0),
      count: mine.length,
    });
  }

  const valueMinor = parts.reduce((sum, part) => sum + part.valueMinor, 0);
  const known = parts.filter((part) => part.investedMinor !== null);
  const investedMinor = known.reduce((sum, part) => sum + part.investedMinor!, 0);
  const knownValue = known.reduce((sum, part) => sum + part.valueMinor, 0);
  return {
    valueMinor,
    /// What went into the parts whose cost is known, and their gain.
    investedMinor,
    gainMinor: knownValue - investedMinor,
    gainPercent: investedMinor > 0 ? Math.round(((knownValue - investedMinor) / investedMinor) * 10_000) / 100 : null,
    /// Whether some of it has no cost to measure a gain against.
    partial: known.length < parts.length,
    parts,
    holdings,
  };
}

export const investmentsRouter = Router();
investmentsRouter.use(requireAuth);

// GET /investments/overview — everything held, in one total.
investmentsRouter.get("/overview", async (req, res) => {
  res.json(await investmentsOverview(currentUserId(req)));
});
