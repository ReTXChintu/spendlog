import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { ingestRawMessage } from "../../parsing/ingest";

export const smsRouter = Router();
smsRouter.use(requireAuth);

export const smsSchema = z.object({
  rawText: z.string().min(1),
  // Nullable, not just optional: a message from a shortcode can arrive with
  // no address at all, and rejecting it would lose a real transaction.
  sender: z.string().nullable().optional(),
  // Coerced rather than a strict ISO string. Dart's toIso8601String() omits
  // the timezone for a local DateTime, so a strict check rejected every
  // message the app has ever sent. The app sends UTC now; this stays
  // tolerant so an older build on someone's phone starts working too.
  receivedAt: z.coerce.date(),
  // The mobile app should send a stable id per SMS (e.g. `${sender}-${timestamp}`)
  // so retries/re-syncs don't create duplicates.
  messageId: z.string().optional(),
});

// POST /ingestion/sms — the mobile app posts each new SMS here as it
// arrives (via a background listener), or in bulk for the initial backfill.
smsRouter.post("/", async (req, res) => {
  const parsed = smsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const result = await ingestRawMessage({
    userId: currentUserId(req),
    rawText: parsed.data.rawText,
    source: "SMS",
    sourceRef: parsed.data.messageId ?? null,
    receivedAt: parsed.data.receivedAt,
  });

  res.status(result.status === "created" ? 201 : 200).json(result);
});

const smsBatchSchema = z.array(z.unknown()).max(500);

// POST /ingestion/sms/batch — used for the first-run backfill scan of
// existing SMS history on the device, and for a manual re-sync.
//
// Items are validated one at a time on purpose. An inbox is full of things
// that are not bank alerts — an empty-bodied MMS is enough — and rejecting
// the whole batch for one of them threw away the other 99 messages with it.
smsRouter.post("/batch", async (req, res) => {
  const batch = smsBatchSchema.safeParse(req.body);
  if (!batch.success) return res.status(400).json({ error: batch.error.flatten() });

  let created = 0;
  let duplicates = 0;
  let ignored = 0;
  let invalid = 0;

  for (const raw of batch.data) {
    const item = smsSchema.safeParse(raw);
    if (!item.success) {
      invalid += 1;
      continue;
    }

    const result = await ingestRawMessage({
      userId: currentUserId(req),
      rawText: item.data.rawText,
      source: "SMS",
      sourceRef: item.data.messageId ?? null,
      receivedAt: item.data.receivedAt,
    });

    if (result.status === "created") created += 1;
    else if (result.status === "duplicate") duplicates += 1;
    else ignored += 1;
  }

  res.status(200).json({ created, duplicates, ignored, invalid });
});
