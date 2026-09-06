import { Router } from "express";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { EmailConnection } from "../../models";
import { googleCallbackHandler, signOAuthState } from "../auth/auth.routes";
import { buildConsentUrl, syncEmailConnection } from "./gmail.service";

export const emailRouter = Router();

// Same handler as /auth/google/callback. Mounted here too so either path
// can be the registered redirect URI in Google Console — existing setups
// pointing at this URL keep working without reconfiguration.
emailRouter.get("/callback", googleCallbackHandler);

// GET /ingestion/email/connect — only needed when Gmail access wasn't
// granted at sign-in (the user unticked it on the consent screen) or was
// later revoked. Reuses the single /auth/google/callback redirect URI,
// distinguished by the signed `state`.
emailRouter.get("/connect", requireAuth, (req, res) => {
  const state = signOAuthState({ purpose: "reconnect", userId: req.user!.id });
  res.json({ url: buildConsentUrl(state) });
});

// GET /ingestion/email/status — which Gmail accounts are connected.
emailRouter.get("/status", requireAuth, async (req, res) => {
  const connections = await EmailConnection.find({ userId: currentUserId(req) }).select(
    "email lastSyncedAt createdAt"
  );
  res.json(connections);
});

// POST /ingestion/email/sync — trigger an immediate sync (in addition to
// the periodic background sync in server.ts).
emailRouter.post("/sync", requireAuth, async (req, res) => {
  const connections = await EmailConnection.find({ userId: currentUserId(req) });
  if (connections.length === 0) {
    return res.status(404).json({ error: "No Gmail account connected" });
  }

  const results = await Promise.all(connections.map((c) => syncEmailConnection(c._id.toString())));
  res.json({ results });
});

emailRouter.delete("/:id", requireAuth, validObjectIdParam("id"), async (req, res) => {
  const deleted = await EmailConnection.findOneAndDelete({
    _id: req.params.id,
    userId: currentUserId(req),
  });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  res.status(204).end();
});
