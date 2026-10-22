import express, { Router } from "express";
import { z } from "zod";
import { SuiteEvent } from "../../models";
import { requireSuiteSignature } from "./suite.signature";
import {
  TrippinEvent,
  TrippinRefusal,
  applyTrippinEvent,
  suiteUserExists,
  trippinCandidates,
  trippinSummary,
} from "./trippin.service";

/**
 * What Trippin calls, server to server. No user signs these: every request
 * is HMAC-signed by Trippin instead (see suite.signature.ts), so this
 * router is mounted ahead of the app's JSON parser and reads the body raw
 * to check the signature over the exact bytes sent.
 *
 *   POST /integrations/trippin/events
 *   GET  /integrations/trippin/trips/:trippinTripId/summary?sub=
 *   GET  /integrations/trippin/users/:sub
 */
export const trippinRouter = Router();

trippinRouter.use(express.raw({ type: () => true, limit: "1mb" }));
trippinRouter.use(requireSuiteSignature);

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const personSchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.string().max(320).nullish(),
  name: z.string().max(200).nullish(),
  role: z.string().max(40).nullish(),
});

const tripSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  startDate: DAY,
  endDate: DAY,
  destination: z.string().max(200).nullish(),
  url: z.string().max(2000).nullish(),
  owner: personSchema,
  members: z.array(personSchema).max(200).default([]),
});

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(200),
    type: z.literal("trip.linked"),
    occurredAt: z.string().optional(),
    trip: tripSchema,
    // One of the owner's existing groups to link instead of a new one.
    attachTo: z.string().min(1).max(200).optional(),
  }),
  z.object({
    id: z.string().min(1).max(200),
    type: z.enum(["trip.updated", "trip.members_changed"]),
    occurredAt: z.string().optional(),
    trip: tripSchema,
  }),
  z.object({
    id: z.string().min(1).max(200),
    type: z.literal("trip.unlinked"),
    occurredAt: z.string().optional(),
    // Switching off needs nothing but which trip; anything else is ignored.
    trip: z.object({ id: z.string().min(1).max(200) }).passthrough(),
  }),
]);

// POST /integrations/trippin/events — Trippin telling SpendLog what changed.
//
// Idempotent by event id: a retried delivery is answered with what the
// first one was, and nothing is done twice. A refused event is not
// remembered, so sending it again once the reason is gone works.
trippinRouter.post("/events", async (req, res) => {
  const parsed = eventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const event = parsed.data as TrippinEvent;

  const seen = await SuiteEvent.findOne({ app: "trippin", eventId: event.id }).lean();
  if (seen) return res.json(seen.response ?? {});

  let response: Record<string, unknown>;
  try {
    response = await applyTrippinEvent(event);
  } catch (err) {
    if (err instanceof TrippinRefusal) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
    }
    throw err;
  }

  try {
    await SuiteEvent.create({ app: "trippin", eventId: event.id, type: event.type, response });
  } catch (err) {
    // The same event, delivered twice at once: whichever finished first
    // recorded it, and both did the same idempotent work.
    if ((err as { code?: number }).code !== 11000) throw err;
  }

  res.json(response);
});

// GET /integrations/trippin/trips/:trippinTripId/summary?sub= — the live
// figures Trippin shows on its trip page, from that viewer's side.
trippinRouter.get("/trips/:trippinTripId/summary", async (req, res) => {
  const sub = typeof req.query.sub === "string" && req.query.sub ? req.query.sub : undefined;
  const summary = await trippinSummary(req.params.trippinTripId, sub);
  if (!summary) return res.status(404).json({ linked: false });
  res.json(summary);
});

const candidatesQuery = z.object({
  sub: z.string().min(1).max(255),
  tripId: z.string().min(1).max(200),
  title: z.string().max(200).default(""),
  start: DAY,
  end: DAY,
});

// GET /integrations/trippin/candidates?sub=&tripId=&title=&start=&end= -
// the trip owner's groups that could be linked to this trip instead of a
// new one, with what linking each would do to its payments.
trippinRouter.get("/candidates", async (req, res) => {
  const parsed = candidatesQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const q = parsed.data;
  try {
    const candidates = await trippinCandidates({ sub: q.sub, tripId: q.tripId, title: q.title, startDate: q.start, endDate: q.end });
    res.json({ candidates });
  } catch (err) {
    if (err instanceof TrippinRefusal) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
});

// GET /integrations/trippin/users/:sub — whether someone has SpendLog yet.
trippinRouter.get("/users/:sub", async (req, res) => {
  res.json({ exists: await suiteUserExists(req.params.sub) });
});
