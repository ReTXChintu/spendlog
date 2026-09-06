import { Router } from "express";
import { z } from "zod";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { ingestRawMessage } from "../../parsing/ingest";

export const smsRouter = Router();
smsRouter.use(requireAuth);

const smsSchema = z.object({
  rawText: z.string().min(1),
  sender: z.string().optional(),
  receivedAt: z.string().datetime(),
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
    receivedAt: new Date(parsed.data.receivedAt),
  });

  res.status(result.status === "created" ? 201 : 200).json(result);
});

const smsBatchSchema = z.array(smsSchema).max(500);

// POST /ingestion/sms/batch — used for the first-run backfill scan of
// existing SMS history on the device.
smsRouter.post("/batch", async (req, res) => {
  const parsed = smsBatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const results = [];
  for (const item of parsed.data) {
    const result = await ingestRawMessage({
      userId: currentUserId(req),
      rawText: item.rawText,
      source: "SMS",
      sourceRef: item.messageId ?? null,
      receivedAt: new Date(item.receivedAt),
    });
    results.push(result);
  }

  res.status(200).json({
    created: results.filter((r) => r.status === "created").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    ignored: results.filter((r) => r.status === "ignored").length,
  });
});
