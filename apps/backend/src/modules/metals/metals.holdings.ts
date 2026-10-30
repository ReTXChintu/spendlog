import { HydratedDocument, Types } from "mongoose";
import { MetalBuy, MetalHolding, MetalHoldingDoc, MetalPurity, MetalRate, MetalRateDoc, Transaction, TransactionDoc } from "../../models";
import { istDayKey } from "../../time";
import { GST_PERCENT } from "./metals.service";

/**
 * Gold and silver the user owns, in grams.
 *
 * They say once what they hold; after that each purchase adds grams worked
 * out from that day's IBJA rate with GST - ₹500 of digital gold on a day
 * 24K is ₹14,089 a gram comes to 500 / (14,089 × 1.03) = 0.0345 g. A
 * jeweller's making charges mean fewer grams than that for the money, so
 * the grams can be typed instead. Everything is valued at today's rate for
 * its purity, before GST - roughly what it would sell for.
 */

/// IBJA's fineness for each purity, for a day only its 24K is known for.
const FINENESS: Record<Exclude<MetalPurity, "SILVER">, number> = { "24K": 1, "22K": 0.916, "18K": 0.75 };

/** A day's rate per gram for a purity, in paise, before GST. */
export function perGramFor(rate: Pick<MetalRateDoc, "gold999" | "gold916" | "gold750" | "silver999"> | null, purity: MetalPurity): number | null {
  if (!rate) return null;
  if (purity === "SILVER") return rate.silver999 === null ? null : Math.round(rate.silver999 / 10);
  const per10g = purity === "22K" ? rate.gold916 : purity === "18K" ? rate.gold750 : rate.gold999;
  if (per10g !== null) return per10g * 10;
  return rate.gold999 === null ? null : Math.round(rate.gold999 * 10 * FINENESS[purity]);
}

/** The rate a purchase on this day was made at: that day's, else the last one before it. */
export async function rateOn(day: string) {
  return MetalRate.findOne({ day: { $lte: day } }).sort({ day: -1 }).lean();
}

const fourPlaces = (value: number) => Math.round(value * 10_000) / 10_000;

export class MetalBuyError extends Error {}

/**
 * A payment as a purchase for a holding: the grams typed, or worked out
 * from the day's rate with GST. Refused for a holding that is not the
 * user's, or a day with no rate to work from and no grams given.
 */
export async function metalBuyFor(
  userId: Types.ObjectId,
  amountMinor: number,
  occurredAt: Date,
  asked: { holdingId: string; grams?: number | null }
): Promise<MetalBuy> {
  const holding = await MetalHolding.findOne({ _id: asked.holdingId, userId }).lean();
  if (!holding) throw new MetalBuyError("Unknown gold or silver holding");
  if (asked.grams !== undefined && asked.grams !== null) {
    if (!(asked.grams > 0)) throw new MetalBuyError("Grams bought have to be more than nothing.");
    return { holdingId: holding._id, grams: fourPlaces(asked.grams), rateMinor: null, gramsTyped: true };
  }
  const perGram = perGramFor(await rateOn(istDayKey(occurredAt)), holding.purity);
  if (!perGram) throw new MetalBuyError("There's no rate for that day yet - type the grams instead.");
  const withGst = Math.round(perGram * (1 + GST_PERCENT / 100));
  return { holdingId: holding._id, grams: fourPlaces(amountMinor / withGst), rateMinor: withGst, gramsTyped: false };
}

/** Words without case, spacing or punctuation, for matching a payee. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * A payment that just arrived, put down as a purchase for the holding
 * whose payee it names. Only a plain payment, and only a holding with a
 * payee saved.
 */
export async function linkMetalPurchase(row: HydratedDocument<TransactionDoc>): Promise<boolean> {
  if (row.type !== "DEBIT" || row.metalBuy || row.isTransfer || row.cardPaymentFor || row.offLedger) return false;
  const holdings = await MetalHolding.find({ userId: row.userId, isActive: true, payee: { $nin: [null, ""] } }).lean();
  if (holdings.length === 0) return false;
  const words = squash([row.merchant, row.rawText, ...row.sources.map((source) => source.rawText)].filter(Boolean).join(" "));
  const holding = holdings.find((h) => {
    const payee = squash(h.payee ?? "");
    return payee.length >= 3 && words.includes(payee);
  });
  if (!holding) return false;
  try {
    row.metalBuy = await metalBuyFor(row.userId, row.amountMinor, row.occurredAt, { holdingId: holding._id.toString() });
  } catch {
    return false;
  }
  await row.save();
  return true;
}

export interface HoldingView {
  id: string;
  name: string;
  purity: MetalPurity;
  kind: MetalHoldingDoc["kind"];
  payee: string | null;
  isActive: boolean;
  grams: number;
  openingGrams: number;
  /// What it all cost: the opening figure (when given) and every purchase.
  investedMinor: number | null;
  /// At today's rate for its purity, before GST.
  valueMinor: number | null;
  gainMinor: number | null;
  purchases: number;
  boughtThisMonthGrams: number;
}

/** Every holding with its grams, cost and today's value. */
export async function holdingsOf(userId: Types.ObjectId, now = new Date()): Promise<HoldingView[]> {
  const holdings = await MetalHolding.find({ userId }).sort({ isActive: -1, createdAt: 1 }).lean();
  if (holdings.length === 0) return [];
  const [buys, latest] = await Promise.all([
    Transaction.find({ userId, type: "DEBIT", "metalBuy.holdingId": { $in: holdings.map((h) => h._id) } })
      .select("amountMinor occurredAt metalBuy")
      .lean(),
    MetalRate.findOne({}).sort({ day: -1 }).lean(),
  ]);
  const monthStart = istDayKey(now).slice(0, 7);

  return holdings.map((holding) => {
    const mine = buys.filter((buy) => buy.metalBuy!.holdingId.equals(holding._id));
    const boughtGrams = mine.reduce((sum, buy) => sum + buy.metalBuy!.grams, 0);
    const spent = mine.reduce((sum, buy) => sum + buy.amountMinor, 0);
    const grams = fourPlaces(holding.openingGrams + boughtGrams);
    // The opening grams' cost unknown, the gain is only known when there
    // were none.
    const investedMinor =
      holding.openingInvestedMinor !== null ? holding.openingInvestedMinor + spent : holding.openingGrams === 0 ? spent : null;
    const perGram = perGramFor(latest, holding.purity);
    const valueMinor = perGram === null ? null : Math.round(grams * perGram);
    return {
      id: holding._id.toString(),
      name: holding.name,
      purity: holding.purity,
      kind: holding.kind,
      payee: holding.payee,
      isActive: holding.isActive,
      grams,
      openingGrams: holding.openingGrams,
      investedMinor,
      valueMinor,
      gainMinor: valueMinor !== null && investedMinor !== null ? valueMinor - investedMinor : null,
      purchases: mine.length,
      boughtThisMonthGrams: fourPlaces(
        mine.filter((buy) => istDayKey(buy.occurredAt).startsWith(monthStart)).reduce((sum, buy) => sum + buy.metalBuy!.grams, 0)
      ),
    };
  });
}

/** One holding's purchases, newest first. */
export async function holdingPurchases(userId: Types.ObjectId, holdingId: Types.ObjectId) {
  const rows = await Transaction.find({ userId, type: "DEBIT", "metalBuy.holdingId": holdingId })
    .sort({ occurredAt: -1 })
    .limit(200)
    .select("merchant occurredAt amountMinor metalBuy")
    .lean();
  return rows.map((row) => ({
    transactionId: row._id.toString(),
    merchant: row.merchant ?? null,
    occurredAt: row.occurredAt.toISOString(),
    amountMinor: row.amountMinor,
    grams: row.metalBuy!.grams,
    rateMinor: row.metalBuy!.rateMinor,
    gramsTyped: row.metalBuy!.gramsTyped,
  }));
}
