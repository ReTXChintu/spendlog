import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { FixedCommitment, FundCache, FundCacheDoc, FundHolding, FundNav, FundTxn, Goal, Transaction, User } from "../../models";
import { istDayKey } from "../../time";
import { decryptPassword } from "../statements/statements.crypto";
import { AiError, withModel } from "../ai/ai.gemini";
import { fundAdvice } from "./funds.advice";
import { peers as loadPeers, requireScheme, STALE_AFTER_MS } from "./funds.cache";
import { linkSuggestions } from "./funds.links";
import { FLAG_RULES } from "./funds.math";
import { holdingJson, ledgerJson, loadPortfolio, portfolioTotals, sparkline } from "./funds.portfolio";
import { FundSourceError, isDirectPlan, isGrowthOption, isRegularPlan, searchSchemes } from "./funds.sources";

export const fundsRouter = Router();
fundsRouter.use(requireAuth);

/**
 * Mutual funds: what the user holds, worth what today, doing how well
 * against its category, and what the assistant makes of it.
 *
 * Holdings are added three ways and any mix of them: an opening snapshot
 * (units and amount as of a day, copied from a statement), a SIP's details
 * (each month's instalment worked out from the NAV that day), and debits
 * already in SpendLog linked to the fund. funds.math.ts keeps the three
 * from counting the same money twice. Linking a debit never touches the
 * transaction itself - it still counts against the monthly budget exactly
 * as before.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const sipSchema = z
  .object({
    amountMinor: z.number().int().min(100),
    dayOfMonth: z.number().int().min(1).max(31),
    startOn: day,
    endOn: day.nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((sip) => !sip.endOn || sip.endOn >= sip.startOn, { message: "The SIP can't end before it starts." });

const openingSchema = z
  .object({
    units: z.number().positive(),
    investedMinor: z.number().int().nonnegative(),
    asOf: day,
    firstOn: day.nullable().optional(),
  })
  .refine((opening) => !opening.firstOn || opening.firstOn <= opening.asOf, {
    message: "The first investment can't be after the snapshot.",
  });

const createSchema = z.object({
  schemeCode: z.number().int().positive(),
  folio: z.string().trim().max(40).nullable().optional(),
  sip: sipSchema.nullable().optional(),
  opening: openingSchema.nullable().optional(),
});

const updateSchema = z.object({
  folio: z.string().trim().max(40).nullable().optional(),
  sip: sipSchema.nullable().optional(),
  opening: openingSchema.nullable().optional(),
  /// A fixed commitment of kind SIP whose debits count as this holding's instalments.
  commitmentId: objectId.nullable().optional(),
});

/** A SIP as stored: stopped without an end date means stopped today. */
function sipToStore(sip: z.infer<typeof sipSchema> | null | undefined, today: string) {
  if (!sip) return sip;
  const active = sip.active ?? true;
  return { ...sip, active, endOn: sip.endOn ?? (active ? null : today) };
}

function futureCheck(input: { opening?: { asOf: string } | null }, today: string) {
  if (input.opening && input.opening.asOf > today) return "The snapshot can't be from the future.";
  return null;
}

async function holdingDetail(userId: Types.ObjectId, holdingId: string) {
  const portfolio = await loadPortfolio(userId);
  const view = portfolio.views.find((candidate) => candidate.holding._id.toString() === holdingId);
  if (!view) return null;
  return {
    ...holdingJson(view, portfolio.now),
    txns: view.ledger.map(ledgerJson).reverse(),
    sparkline: sparkline(view.series),
    navError: view.nav.lastError,
  };
}

// GET /funds/search?q=parag — schemes by name, from mfapi. When mfapi is
// down, the schemes already known here (held by someone, or in the peer
// table) are searched instead, and `fromCache` says so.
fundsRouter.get("/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2) return res.status(400).json({ error: "Type at least two letters." });

  const shape = (schemeCode: number, schemeName: string) => ({
    schemeCode,
    schemeName,
    isDirect: isDirectPlan(schemeName),
    isGrowth: isGrowthOption(schemeName),
    isRegular: isRegularPlan(schemeName),
  });

  try {
    const results = await searchSchemes(q);
    return res.json({ results: results.slice(0, 50).map((row) => shape(row.schemeCode, row.schemeName)), fromCache: false });
  } catch (error) {
    if (!(error instanceof FundSourceError)) throw error;
    const words = q.toLowerCase().split(/\s+/);
    const matches = (name: string) => words.every((word) => name.toLowerCase().includes(word));
    const [stored, peerData] = await Promise.all([
      FundNav.find({ fetchedAt: { $ne: null } }).select("schemeCode schemeName").lean(),
      FundCache.findOne({ key: "peers" }).select("data").lean<Pick<FundCacheDoc, "data">>(),
    ]);
    const known = new Map<number, string>();
    for (const doc of stored) if (matches(doc.schemeName)) known.set(doc.schemeCode, doc.schemeName);
    const schemes = ((peerData?.data as { schemes?: { code: number; name: string }[] } | null)?.schemes ?? []);
    for (const scheme of schemes) if (!known.has(scheme.code) && matches(scheme.name)) known.set(scheme.code, scheme.name);
    res.json({
      results: [...known.entries()].slice(0, 50).map(([code, name]) => shape(code, name)),
      fromCache: true,
      error: error.message,
    });
  }
});

// GET /funds/portfolio — every holding with its figures, ranks and flags,
// and the portfolio's totals. Served from the stored NAVs when mfapi or
// AMFI can't be reached; `stale` says the prices are more than a day and
// a half old.
fundsRouter.get("/portfolio", async (req, res) => {
  const portfolio = await loadPortfolio(currentUserId(req));
  const { totals, allocation, lastNavDate } = portfolioTotals(portfolio.views);
  const holdings = portfolio.views.map((view) => holdingJson(view, portfolio.now));
  const failing = portfolio.views.find(
    (view) => view.nav.lastError && (!view.nav.fetchedAt || (view.nav.lastErrorAt && view.nav.lastErrorAt > view.nav.fetchedAt))
  );

  res.json({
    holdings,
    totals,
    allocation,
    lastNavDate,
    stale: holdings.some((holding) => holding.stale),
    error: failing?.nav.lastError ?? null,
    peers: portfolio.peers
      ? {
          available: true,
          asOf: portfolio.peers.table.asOf,
          oneYearOn: portfolio.peers.table.oneYearOn,
          threeYearOn: portfolio.peers.table.threeYearOn,
          fetchedAt: portfolio.peers.fetchedAt,
        }
      : { available: false, asOf: null, oneYearOn: null, threeYearOn: null, fetchedAt: null },
    flagRules: {
      minPeers: FLAG_RULES.minPeers,
      bottomPercentile: FLAG_RULES.bottomPercentile,
      belowMedianPp: FLAG_RULES.belowMedianPp,
      liquidRatePercent: FLAG_RULES.liquidRate * 100,
      lowXirrAfterDays: FLAG_RULES.lowXirrAfterDays,
    },
    staleAfterHours: STALE_AFTER_MS / 3_600_000,
  });
});

// POST /funds/holdings — add a fund, by scheme code from the search.
fundsRouter.post("/holdings", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const today = istDayKey(new Date());
  const problem = futureCheck(parsed.data, today);
  if (problem) return res.status(400).json({ error: problem });

  // Checked here as well as by the unique index, which a fresh database
  // may not have built yet.
  const folio = parsed.data.folio || null;
  if (await FundHolding.exists({ userId, schemeCode: parsed.data.schemeCode, folio })) {
    return res.status(409).json({ error: "That fund is already in your portfolio under this folio." });
  }

  let scheme;
  try {
    scheme = await requireScheme(parsed.data.schemeCode);
  } catch (error) {
    if (error instanceof FundSourceError) return res.status(error.status === 404 ? 404 : 502).json({ error: error.message });
    throw error;
  }

  try {
    const created = await FundHolding.create({
      userId,
      schemeCode: scheme.schemeCode,
      schemeName: scheme.schemeName,
      fundHouse: scheme.fundHouse,
      category: scheme.category,
      isDirect: isDirectPlan(scheme.schemeName),
      isGrowth: isGrowthOption(scheme.schemeName),
      folio,
      sip: sipToStore(parsed.data.sip, today) ?? null,
      opening: parsed.data.opening ?? null,
    });
    res.status(201).json(await holdingDetail(userId, created._id.toString()));
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return res.status(409).json({ error: "That fund is already in your portfolio under this folio." });
    }
    throw error;
  }
});

// GET /funds/holdings/:id — one holding with every line of its history
// (newest first) and about a year of NAVs for a sparkline.
fundsRouter.get("/holdings/:id", validObjectIdParam("id"), async (req, res) => {
  const detail = await holdingDetail(currentUserId(req), req.params.id);
  if (!detail) return res.status(404).json({ error: "Not found" });
  res.json(detail);
});

// PATCH /funds/holdings/:id — folio, SIP, opening snapshot, or the SIP
// commitment it's connected to. null clears any of them.
fundsRouter.patch("/holdings/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const userId = currentUserId(req);
  const today = istDayKey(new Date());
  const problem = futureCheck(parsed.data, today);
  if (problem) return res.status(400).json({ error: problem });

  const holding = await FundHolding.findOne({ _id: req.params.id, userId });
  if (!holding) return res.status(404).json({ error: "Not found" });

  if (parsed.data.commitmentId) {
    const commitment = await FixedCommitment.findOne({ _id: parsed.data.commitmentId, userId });
    if (!commitment) return res.status(404).json({ error: "That commitment wasn't found." });
    if (commitment.kind !== "SIP") return res.status(400).json({ error: "Only a SIP commitment can be connected to a fund." });
    const taken = await FundHolding.exists({ userId, commitmentId: commitment._id, _id: { $ne: holding._id } });
    if (taken) return res.status(409).json({ error: "That SIP is already connected to another fund." });
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.folio !== undefined) update.folio = parsed.data.folio || null;
  if (parsed.data.sip !== undefined) update.sip = sipToStore(parsed.data.sip, today);
  if (parsed.data.opening !== undefined) update.opening = parsed.data.opening;
  if (parsed.data.commitmentId !== undefined) update.commitmentId = parsed.data.commitmentId;
  holding.set(update);

  try {
    await holding.save();
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return res.status(409).json({ error: "That fund is already in your portfolio under this folio." });
    }
    throw error;
  }
  res.json(await holdingDetail(userId, holding._id.toString()));
});

// DELETE /funds/holdings/:id — the holding, its links and entries, and its
// place in any goal. The linked transactions themselves are untouched.
fundsRouter.delete("/holdings/:id", validObjectIdParam("id"), async (req, res) => {
  const userId = currentUserId(req);
  const deleted = await FundHolding.findOneAndDelete({ _id: req.params.id, userId });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  await Promise.all([
    FundTxn.deleteMany({ userId, holdingId: deleted._id }),
    Goal.updateMany({ userId }, { $pull: { holdingIds: deleted._id } }),
  ]);
  res.status(204).end();
});

const linkSchema = z.object({ transactionId: objectId });

// POST /funds/holdings/:id/link — this debit bought this fund. Units come
// from the NAV on its day (or the next one published). It replaces the
// scheduled SIP instalment of the same cycle.
fundsRouter.post("/holdings/:id/link", validObjectIdParam("id"), async (req, res) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pick a transaction to link." });

  const userId = currentUserId(req);
  const [holding, transaction] = await Promise.all([
    FundHolding.findOne({ _id: req.params.id, userId }),
    Transaction.findOne({ _id: parsed.data.transactionId, userId }).select("type occurredAt amountMinor"),
  ]);
  if (!holding || !transaction) return res.status(404).json({ error: "Not found" });
  if (transaction.type !== "DEBIT") return res.status(400).json({ error: "Only money going out can buy a fund." });

  const existing = await FundTxn.findOne({ userId, transactionId: transaction._id });
  if (existing && !existing.holdingId.equals(holding._id)) {
    return res.status(409).json({ error: "That payment is already linked to another fund." });
  }
  if (!existing) {
    try {
      await FundTxn.create({
        userId,
        holdingId: holding._id,
        kind: "LINKED",
        on: istDayKey(transaction.occurredAt),
        amountMinor: transaction.amountMinor,
        transactionId: transaction._id,
      });
    } catch (error) {
      // Two taps at once: the other one linked it.
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }
  res.json(await holdingDetail(userId, holding._id.toString()));
});

// DELETE /funds/holdings/:id/link/:transactionId — unlink. The scheduled
// instalment it stood in for comes back.
fundsRouter.delete(
  "/holdings/:id/link/:transactionId",
  validObjectIdParam("id"),
  validObjectIdParam("transactionId"),
  async (req, res) => {
    const userId = currentUserId(req);
    const removed = await FundTxn.findOneAndDelete({
      userId,
      holdingId: req.params.id,
      transactionId: req.params.transactionId,
    });
    if (!removed) return res.status(404).json({ error: "Not found" });
    res.json(await holdingDetail(userId, req.params.id));
  }
);

const txnSchema = z
  .object({
    kind: z.enum(["MANUAL_BUY", "REDEEM"]),
    on: day,
    amountMinor: z.number().int().nonnegative().optional(),
    units: z.number().positive().nullable().optional(),
  })
  .refine((txn) => (txn.amountMinor ?? 0) > 0 || (txn.units ?? 0) > 0, { message: "Give an amount or units." });

// POST /funds/holdings/:id/txns — a one-off purchase not in SpendLog, or a
// redemption. Either amount or units will do; the other comes from the NAV.
fundsRouter.post("/holdings/:id/txns", validObjectIdParam("id"), async (req, res) => {
  const parsed = txnSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.on > istDayKey(new Date())) return res.status(400).json({ error: "That date is in the future." });

  const userId = currentUserId(req);
  const holding = await FundHolding.findOne({ _id: req.params.id, userId });
  if (!holding) return res.status(404).json({ error: "Not found" });

  await FundTxn.create({
    userId,
    holdingId: holding._id,
    kind: parsed.data.kind,
    on: parsed.data.on,
    amountMinor: parsed.data.amountMinor ?? 0,
    units: parsed.data.units ?? null,
  });
  res.status(201).json(await holdingDetail(userId, holding._id.toString()));
});

// DELETE /funds/holdings/:id/txns/:txnId — a purchase or redemption added by hand.
fundsRouter.delete("/holdings/:id/txns/:txnId", validObjectIdParam("id"), validObjectIdParam("txnId"), async (req, res) => {
  const userId = currentUserId(req);
  const removed = await FundTxn.findOneAndDelete({
    _id: req.params.txnId,
    userId,
    holdingId: req.params.id,
    kind: { $in: ["MANUAL_BUY", "REDEEM"] },
  });
  if (!removed) return res.status(404).json({ error: "Not found" });
  res.json(await holdingDetail(userId, req.params.id));
});

// GET /funds/link-suggestions — debits that look like SIP instalments, each
// against the holding it most likely bought, and SIP commitments that
// could be connected to a holding. Nothing is linked until the user says.
fundsRouter.get("/link-suggestions", async (req, res) => {
  res.json(await linkSuggestions(currentUserId(req)));
});

async function savedKey(userId: Types.ObjectId) {
  const user = await User.findById(userId).select("geminiApiKeyEnc geminiModel").orFail();
  return { key: decryptPassword(user.geminiApiKeyEnc), model: user.geminiModel ?? null };
}

function adviceJson(result: Awaited<ReturnType<typeof fundAdvice>>, hasKey: boolean) {
  return {
    advice: result.doc?.advice ?? null,
    day: result.doc?.day ?? null,
    model: result.doc?.model ?? null,
    cached: result.cached,
    hasKey,
  };
}

// GET /funds/advice — the last advice made, without making any.
fundsRouter.get("/advice", async (req, res) => {
  const userId = currentUserId(req);
  const { key } = await savedKey(userId);
  res.json(adviceJson(await fundAdvice(userId, null), Boolean(key)));
});

// POST /funds/advice?refresh=1 — today's advice: made once a day with the
// user's own Gemini key and kept, unless refresh asks for a new one.
fundsRouter.post("/advice", async (req, res) => {
  const userId = currentUserId(req);
  const refresh = ["1", "true"].includes(String(req.query.refresh ?? ""));
  const { key, model } = await savedKey(userId);

  if (!key) {
    // Today's, already made, needs no key to show again.
    const cached = await fundAdvice(userId, null);
    if (!refresh && cached.doc?.day === istDayKey(new Date())) return res.json(adviceJson(cached, false));
    return res.status(409).json({ error: "Add a Gemini API key in Settings first." });
  }

  try {
    const { result } = await withModel(model, (candidate) => fundAdvice(userId, { key, model: candidate }, refresh));
    res.json(adviceJson(result, true));
  } catch (error) {
    if (error instanceof AiError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
});

// GET /funds/peers/status — whether category data is there yet, for the
// app to say "ranks coming" rather than show blanks.
fundsRouter.get("/peers/status", async (_req, res) => {
  const peerData = await loadPeers();
  res.json({
    available: Boolean(peerData),
    asOf: peerData?.table.asOf ?? null,
    schemes: peerData?.table.schemes.length ?? 0,
    fetchedAt: peerData?.fetchedAt ?? null,
  });
});
