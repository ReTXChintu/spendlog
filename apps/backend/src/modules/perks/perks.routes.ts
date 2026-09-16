import express, { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { Account, Perk } from "../../models";
import { PERK_KINDS } from "../../types";
import { cardStatuses } from "../cards/cards.status";
import { extractPerk } from "./perks.extract";
import { visionProvider, VisionUnavailableError } from "./perks.vision";
import {
  bestMerchantStrength,
  comparePerks,
  normaliseMerchantQuery,
  perkIsLive,
  perkReach,
  perkValueMinor,
} from "./perks.match";

export const perksRouter = Router();
perksRouter.use(requireAuth);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const perkSchema = z.object({
  kind: z.enum(PERK_KINDS),
  title: z.string().trim().min(1).max(120),
  accountId: objectId.nullable().optional(),
  merchants: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  categoryId: objectId.nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  flatMinor: z.number().int().min(0).nullable().optional(),
  maxDiscountMinor: z.number().int().min(0).nullable().optional(),
  minSpendMinor: z.number().int().min(0).nullable().optional(),
  startsOn: z.coerce.date().nullable().optional(),
  expiresOn: z.coerce.date().nullable().optional(),
  code: z.string().trim().max(60).nullable().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  isActive: z.boolean().optional(),
});

/**
 * GET /perks/reader — whether a picture can be read at all.
 *
 * Asked before the button is drawn. A deployment with no model set up
 * hides it rather than offering something that will fail: reading a
 * picture is an extra way to add a coupon and never the only one.
 */
perksRouter.get("/reader", (_req, res) => {
  const provider = visionProvider();
  res.json({ available: provider !== null, model: provider?.name ?? null });
});

/**
 * POST /perks/read — one picture in, a draft out.
 *
 * Saves nothing, on purpose. A model that reads "20% up to ₹150" as "₹150
 * off" is wrong in a way nobody notices until they are at a till with the
 * wrong card out, so what comes back is a filled-in form rather than a
 * stored perk. Checking six fields beats typing twelve, and it keeps a
 * mistake in front of a person rather than inside a total.
 *
 * The image arrives as raw bytes rather than base64 in JSON: a photo of a
 * coupon is a few megabytes and base64 would add a third to that for
 * nothing.
 */
perksRouter.post(
  "/read",
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "12mb" }),
  async (req, res) => {
    const provider = visionProvider();
    if (!provider) {
      return res.status(503).json({
        error:
          "No vision model is set up on this server. Set VISION_BASE_URL in the .env at the repo " +
          "root — see docs/coupon-reading.md.",
      });
    }

    const image = req.body;
    if (!Buffer.isBuffer(image) || image.length === 0) {
      return res.status(400).json({
        error: "Send the image itself, with a Content-Type of image/jpeg, image/png or image/webp.",
      });
    }

    try {
      const draft = await extractPerk({
        userId: currentUserId(req),
        image,
        mimeType: req.headers["content-type"] ?? "image/jpeg",
        provider,
      });

      res.json(draft);
    } catch (error) {
      // A model that is down or talking nonsense is a thing to report
      // plainly, not a 500 - it is the most likely failure here and the
      // person reading it can usually fix it.
      if (error instanceof VisionUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      throw error;
    }
  }
);

// GET /perks — everything held, newest first, live ones before dead ones.
perksRouter.get("/", async (req, res) => {
  const perks = await Perk.find({ userId: currentUserId(req) })
    .populate("accountId")
    .populate("categoryId")
    .sort({ createdAt: -1 });

  const now = new Date();
  const withState = perks.map((perk) => ({
    ...perk.toJSON(),
    isLive: perkIsLive(perk, now),
    daysLeft: perk.expiresOn ? daysBetween(now, perk.expiresOn) : null,
  }));

  // Dead ones last rather than hidden: a coupon that has lapsed is worth
  // seeing once, so it can be deleted rather than wondered about.
  withState.sort((a, b) => Number(b.isLive) - Number(a.isLive));
  res.json(withState);
});

perksRouter.post("/", async (req, res) => {
  const parsed = perkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const problem = validate(parsed.data);
  if (problem) return res.status(400).json({ error: problem });

  const userId = currentUserId(req);
  if (parsed.data.accountId && !(await ownsCard(userId, parsed.data.accountId))) {
    return res.status(404).json({ error: "No such card" });
  }

  const perk = await Perk.create({ ...parsed.data, userId });
  res.status(201).json(perk.toJSON());
});

perksRouter.patch("/:id", validObjectIdParam("id"), async (req, res) => {
  const parsed = perkSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const userId = currentUserId(req);
  const perk = await Perk.findOne({ _id: req.params.id, userId });
  if (!perk) return res.status(404).json({ error: "Not found" });

  if (parsed.data.accountId && !(await ownsCard(userId, parsed.data.accountId))) {
    return res.status(404).json({ error: "No such card" });
  }

  Object.assign(perk, parsed.data);

  const problem = validate(perk);
  if (problem) return res.status(400).json({ error: problem });

  await perk.save();
  res.json(perk.toJSON());
});

// POST /perks/:id/used — mark a coupon spent, or put it back.
//
// A coupon is not deleted when it is used. It is evidence of what a
// purchase actually cost, and being able to say "I used that one in March"
// is worth more than a shorter list.
perksRouter.post("/:id/used", validObjectIdParam("id"), async (req, res) => {
  const used = req.body?.used !== false;

  const perk = await Perk.findOneAndUpdate(
    { _id: req.params.id, userId: currentUserId(req) },
    { $set: { usedAt: used ? new Date() : null } },
    { new: true }
  );
  if (!perk) return res.status(404).json({ error: "Not found" });

  res.json(perk.toJSON());
});

perksRouter.delete("/:id", validObjectIdParam("id"), async (req, res) => {
  const deleted = await Perk.findOneAndDelete({ _id: req.params.id, userId: currentUserId(req) });
  if (!deleted) return res.status(404).json({ error: "Not found" });
  res.status(204).end();
});

const lookupSchema = z.object({
  q: z.string().trim().min(1).max(120),
  categoryId: objectId.optional(),
  /// What is about to be spent, where it is known. Turns a percentage into
  /// a figure, which is the difference between "5% back" and "₹450 back".
  amountMinor: z.coerce.number().int().min(0).optional(),
});

/**
 * GET /perks/lookup?q=... — "I am at Gucci. Do I have anything?"
 *
 * Answers with the offers first and the float advice underneath. Money
 * back is certain and immediate; float is timing, so the offer leads and
 * what the other card would have bought you in days is said below it.
 *
 * The verdict sentence is composed here rather than on each client, so the
 * phone and the web cannot drift into saying different things about the
 * same cards.
 */
perksRouter.get("/lookup", async (req, res) => {
  const parsed = lookupSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const userId = currentUserId(req);
  const { q, categoryId, amountMinor } = parsed.data;
  const spendMinor = amountMinor ?? null;
  const now = new Date();

  const [perks, cards] = await Promise.all([
    Perk.find({ userId, isActive: true, usedAt: null }).populate("accountId").populate("categoryId"),
    cardStatuses(userId, now),
  ]);

  const cardById = new Map(cards.map((card) => [card.accountId, card]));

  const matches = perks
    .filter((perk) => perkIsLive(perk, now))
    .map((perk) => {
      const reach = perkReach(perk, q, categoryId ?? null);
      if (!reach) return null;

      // The populated document, read back for the id the card map is keyed by.
      const account = perk.accountId as unknown as { _id?: { toString(): string } } | null;
      const accountId = account?._id?.toString() ?? null;

      return {
        ...perk.toJSON(),
        reach,
        // How squarely the query hit, so a perk whose pattern merely shares
        // a word never outranks the one that named the shop.
        strength: bestMerchantStrength(perk.merchants, q),
        valueMinor: perkValueMinor(perk, spendMinor),
        card: accountId ? (cardById.get(accountId) ?? null) : null,
        daysLeft: perk.expiresOn ? daysBetween(now, perk.expiresOn) : null,
      };
    })
    .filter((match): match is NonNullable<typeof match> => match !== null)
    .sort(comparePerks);

  const usable = cards.filter((card) => card.state !== "over" && card.floatDays !== null);
  const bestForFloat = usable[0] ?? null;

  // Only worth saying when it is a different card from the one the offer
  // points at. Naming the same card twice reads as two pieces of advice.
  const top = matches[0] ?? null;
  const floatAlternative =
    bestForFloat && (!top?.card || top.card.accountId !== bestForFloat.accountId) ? bestForFloat : null;

  res.json({
    query: normaliseMerchantQuery(q),
    matches,
    bestForFloat,
    floatAlternative,
    verdict: verdictFor(normaliseMerchantQuery(q), matches, floatAlternative),
  });
});

type Match = { kind: string; title: string; card: { name: string } | null; percent?: number | null };

/**
 * The one line at the top of the answer.
 *
 * Written to be read while standing up, so it says the number and the card
 * and stops. Everything else is on the rows underneath.
 */
function verdictFor(
  query: string,
  matches: Match[],
  floatAlternative: { name: string; floatDays: number | null } | null
): string {
  const where = query ? ` at ${query}` : "";

  if (matches.length === 0) {
    return floatAlternative
      ? `Nothing saved${where}. ${floatAlternative.name} gives you the longest to pay — ` +
          `${floatAlternative.floatDays} days.`
      : `Nothing saved${where}.`;
  }

  const coupons = matches.filter((match) => match.kind === "COUPON").length;
  const offers = matches.length - coupons;

  const parts: string[] = [];
  if (coupons > 0) parts.push(`${coupons} ${coupons === 1 ? "coupon" : "coupons"}`);
  if (offers > 0) parts.push(`${offers} card ${offers === 1 ? "offer" : "offers"}`);

  const top = matches[0];
  const lead = top.card ? `${top.title} on ${top.card.name}` : top.title;

  return `${parts.join(" and ")}${where}. Best: ${lead}.`;
}

/**
 * A perk may only ever name one of your own cards.
 *
 * Without this, a perk could be saved against someone else's account id
 * and the lookup would go looking for it in their cards.
 */
async function ownsCard(userId: Types.ObjectId, accountId: string): Promise<boolean> {
  return Boolean(await Account.exists({ _id: accountId, userId }));
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * The combinations that would produce a perk nobody can act on.
 *
 * Checked here rather than in the schema because each rule is about two
 * fields at once, which zod can express but not readably.
 */
function validate(perk: {
  kind: string;
  accountId?: unknown;
  percent?: number | null;
  flatMinor?: number | null;
}): string | null {
  if (perk.kind === "CARD_OFFER" && !perk.accountId) {
    return "A card offer has to say which card it is on";
  }
  if (!perk.percent && !perk.flatMinor) {
    return "Say what it is worth — a percentage or an amount";
  }
  if (perk.percent && perk.flatMinor) {
    return "A perk is either a percentage or an amount, not both";
  }
  return null;
}

