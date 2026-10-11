import { Types } from "mongoose";
import { FixedCommitment, FundHolding, FundHoldingDoc, FundTxn, Transaction } from "../../models";
import { istDayKey } from "../../time";
import { addDays } from "./funds.math";

/**
 * Debits that look like a SIP going out, offered against the holding they
 * most likely bought - never linked without the user saying so.
 *
 * A SIP debit rarely names the fund. It names whoever collected it: BSE's
 * clearing house (ICCL), NSE Clearing, a NACH mandate, or the app it was
 * set up in. So the words say "this is a fund purchase" and the amount and
 * day say which one.
 */

/** Words that mark a debit as a mutual fund purchase, whichever fund it was. */
export const SIP_WORDS =
  /mutual\s*fund|\bmf\b|\bbse\b|bse\s*star|iccl|indian clearing|nse clearing|nsccl|\bnach\b|\bach\b|groww|zerodha|\bcoin\b|kuvera|paytm\s*money|\bcams\b|camsonline|kfin|mf\s*utilit|\bsip\b/i;

/// Words in a fund house's name that say nothing about which one it is.
const FILLER = new Set(["mutual", "fund", "funds", "asset", "management", "amc", "limited", "ltd", "india", "the", "co", "company"]);

/** The words that identify a fund house in a debit: "HDFC", "Nippon", "PPFAS", "Parag". */
export function houseWords(holding: Pick<FundHoldingDoc, "fundHouse" | "schemeName">): string[] {
  const words = new Set<string>();
  const first = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .find((word) => word.length >= 3 && !FILLER.has(word));
  for (const text of [holding.fundHouse, holding.schemeName]) {
    const word = first(text ?? "");
    if (word) words.add(word);
  }
  return [...words];
}

export interface DebitLike {
  occurredAt: Date;
  amountMinor: number;
  merchant?: string | null;
  rawText?: string | null;
  note?: string | null;
}

export interface LinkScore {
  score: number;
  reasons: ("sip_words" | "fund_house" | "amount" | "amount_near" | "day" | "day_near")[];
}

/** Days apart on the calendar's circle, so the 30th and the 2nd are three days apart. */
function dayDistance(day: number, target: number): number {
  const apart = Math.abs(day - target);
  return Math.min(apart, 31 - apart);
}

/**
 * How much a debit looks like this holding's instalment. Words are worth
 * 2 (a fund purchase) and 1 (this fund house - a weak sign alone, since
 * HDFC and ICICI are banks too); the amount 3 when it's the SIP amount, 1
 * when near; the day 2 within three days of the SIP day, 1 within a week.
 */
export function scoreDebit(debit: DebitLike, holding: Pick<FundHoldingDoc, "fundHouse" | "schemeName" | "sip">): LinkScore {
  const text = [debit.merchant, debit.rawText, debit.note].filter(Boolean).join(" ").toLowerCase();
  const reasons: LinkScore["reasons"] = [];
  let score = 0;

  if (SIP_WORDS.test(text)) {
    score += 2;
    reasons.push("sip_words");
  }
  if (houseWords(holding).some((word) => new RegExp(`\\b${word}\\b`).test(text))) {
    score += 1;
    reasons.push("fund_house");
  }

  const sip = holding.sip;
  if (sip) {
    const off = Math.abs(debit.amountMinor - sip.amountMinor);
    if (off <= Math.max(sip.amountMinor * 0.01, 500)) {
      score += 3;
      reasons.push("amount");
    } else if (off <= sip.amountMinor * 0.1) {
      score += 1;
      reasons.push("amount_near");
    }

    const day = Number(istDayKey(debit.occurredAt).slice(8, 10));
    const apart = dayDistance(day, sip.dayOfMonth);
    if (apart <= 3) {
      score += 2;
      reasons.push("day");
    } else if (apart <= 7) {
      score += 1;
      reasons.push("day_near");
    }
  }
  return { score, reasons };
}

/**
 * Worth offering: it has to look like a fund purchase at all (the words or
 * the fund house), and then add up - with a SIP to compare against, the
 * words and the amount; without one, the words and the fund house.
 */
export function isLikelyLink(result: LinkScore, hasSip: boolean): boolean {
  const named = result.reasons.includes("sip_words") || result.reasons.includes("fund_house");
  return named && result.score >= (hasSip ? 4 : 3);
}

/// How far back to look. A little over a year: further back is what the
/// opening snapshot is for.
const LOOKBACK_DAYS = 400;

export async function linkSuggestions(userId: Types.ObjectId, now = new Date()) {
  const holdings = await FundHolding.find({ userId }).lean<FundHoldingDoc[]>();
  const today = istDayKey(now);

  const [linkedTxns, commitments] = await Promise.all([
    FundTxn.find({ userId, transactionId: { $ne: null } }).select("transactionId").lean(),
    FixedCommitment.find({ userId, kind: "SIP" }).lean(),
  ]);
  const connected = new Set(holdings.map((holding) => holding.commitmentId?.toString()).filter(Boolean) as string[]);

  const suggestions: {
    transactionId: string;
    holdingId: string;
    schemeName: string;
    occurredAt: Date;
    amountMinor: number;
    merchant: string | null;
    score: number;
    reasons: LinkScore["reasons"];
  }[] = [];

  if (holdings.length > 0) {
    const debits = await Transaction.find({
      userId,
      type: "DEBIT",
      occurredAt: { $gte: new Date(Date.parse(`${addDays(today, -LOOKBACK_DAYS)}T00:00:00+05:30`)) },
      _id: { $nin: linkedTxns.map((txn) => txn.transactionId) },
      // Already flowing in through a connected commitment.
      commitmentId: { $nin: [...connected].map((id) => new Types.ObjectId(id)) },
      cardPaymentFor: null,
      isSettlement: { $ne: true },
    })
      .select("occurredAt amountMinor merchant rawText note")
      .sort({ occurredAt: -1 })
      .limit(2000)
      .lean();

    for (const debit of debits) {
      const day = istDayKey(debit.occurredAt);
      let best: { holding: FundHoldingDoc; result: LinkScore } | null = null;
      for (const holding of holdings) {
        if (holding.opening && day <= holding.opening.asOf) continue;
        if (holding.sip && !holding.opening && day < addDays(holding.sip.startOn, -7)) continue;
        const result = scoreDebit(debit, holding);
        if (!isLikelyLink(result, !!holding.sip)) continue;
        if (!best || result.score > best.result.score) best = { holding, result };
      }
      if (!best) continue;
      suggestions.push({
        transactionId: debit._id.toString(),
        holdingId: best.holding._id.toString(),
        schemeName: best.holding.schemeName,
        occurredAt: debit.occurredAt,
        amountMinor: debit.amountMinor,
        merchant: debit.merchant ?? null,
        score: best.result.score,
        reasons: best.result.reasons,
      });
    }
  }

  // SIP commitments not yet connected to a holding, each with the holding
  // it most likely is - same amount, the fund house in its name, same day.
  const counts = await Transaction.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { userId, type: "DEBIT", commitmentId: { $in: commitments.map((commitment) => commitment._id) } } },
    { $group: { _id: "$commitmentId", count: { $sum: 1 } } },
  ]);
  const debitCount = new Map(counts.map((row) => [row._id.toString(), row.count]));

  const commitmentSuggestions = commitments
    .filter((commitment) => !connected.has(commitment._id.toString()))
    .map((commitment) => {
      const text = `${commitment.name} ${commitment.merchant ?? ""}`.toLowerCase();
      let suggested: { id: string; score: number } | null = null;
      for (const holding of holdings) {
        if (holding.commitmentId) continue;
        let score = 0;
        if (holding.sip && Math.abs(holding.sip.amountMinor - commitment.amountMinor) <= holding.sip.amountMinor * 0.01) score += 3;
        if (houseWords(holding).some((word) => text.includes(word))) score += 2;
        if (holding.sip && dayDistance(holding.sip.dayOfMonth, commitment.dayOfMonth) <= 3) score += 1;
        if (score >= 2 && (!suggested || score > suggested.score)) suggested = { id: holding._id.toString(), score };
      }
      return {
        commitmentId: commitment._id.toString(),
        name: commitment.name,
        amountMinor: commitment.amountMinor,
        dayOfMonth: commitment.dayOfMonth,
        isActive: commitment.isActive,
        matchedDebits: debitCount.get(commitment._id.toString()) ?? 0,
        suggestedHoldingId: suggested?.id ?? null,
      };
    });

  return {
    suggestions: suggestions.sort((a, b) => b.score - a.score || b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, 50),
    commitments: commitmentSuggestions,
  };
}
