import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma } from "../../db";
import { env } from "../../env";
import { requireAuth } from "../../middleware/auth";
import { buildConsentUrl, completeConnection, syncEmailConnection } from "./gmail.service";

export const emailRouter = Router();

// GET /ingestion/email/connect — returns the Google consent URL to open in
// a browser/webview. `state` carries the signed-in user's id through the
// redirect so the callback (which Google calls with no auth header) knows
// who to attach the connection to.
emailRouter.get("/connect", requireAuth, (req, res) => {
  const state = jwt.sign({ userId: req.user!.id }, env.jwtSecret, { expiresIn: "10m" });
  res.json({ url: buildConsentUrl(state) });
});

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

// GET /ingestion/email/callback — Google redirects here after consent.
emailRouter.get("/callback", async (req, res) => {
  const parsed = callbackSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.redirect(`${env.frontendUrl}/settings?gmail=error`);
  }

  let userId: string;
  try {
    const decoded = jwt.verify(parsed.data.state, env.jwtSecret) as { userId: string };
    userId = decoded.userId;
  } catch {
    return res.redirect(`${env.frontendUrl}/settings?gmail=error`);
  }

  try {
    await completeConnection(userId, parsed.data.code);
    res.redirect(`${env.frontendUrl}/settings?gmail=connected`);
  } catch (err) {
    console.error("Gmail OAuth callback failed:", err);
    res.redirect(`${env.frontendUrl}/settings?gmail=error`);
  }
});

// GET /ingestion/email/status — which Gmail accounts are connected.
emailRouter.get("/status", requireAuth, async (req, res) => {
  const connections = await prisma.emailConnection.findMany({
    where: { userId: req.user!.id },
    select: { id: true, email: true, lastSyncedAt: true, createdAt: true },
  });
  res.json(connections);
});

// POST /ingestion/email/sync — trigger an immediate sync (in addition to
// the periodic background sync in server.ts).
emailRouter.post("/sync", requireAuth, async (req, res) => {
  const connections = await prisma.emailConnection.findMany({ where: { userId: req.user!.id } });
  if (connections.length === 0) {
    return res.status(404).json({ error: "No Gmail account connected" });
  }

  const results = await Promise.all(connections.map((c) => syncEmailConnection(c.id)));
  res.json({ results });
});

emailRouter.delete("/:id", requireAuth, async (req, res) => {
  const connection = await prisma.emailConnection.findUnique({ where: { id: req.params.id } });
  if (!connection || connection.userId !== req.user!.id) {
    return res.status(404).json({ error: "Not found" });
  }
  await prisma.emailConnection.delete({ where: { id: connection.id } });
  res.status(204).end();
});
