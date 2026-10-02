import { Router } from "express";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { EmailConnection } from "../../models";
import { googleCallbackHandler, signOAuthState } from "../auth/auth.routes";
import { GmailNeedsReconnectError, buildConsentUrl, checkConnection, syncEmailConnection } from "./gmail.service";

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
//
// ?check=1 asks Google first whether each saved sign-in still works, so
// Settings never says "Connected" about a mailbox that can no longer be
// read just because no sync has tried it yet. Left off where the answer
// only decides wording, to keep those screens from waiting on Google.
emailRouter.get("/status", requireAuth, async (req, res) => {
  const userId = currentUserId(req);
  if (req.query.check === "1") {
    const live = await EmailConnection.find({ userId, needsReconnect: { $ne: true } });
    await Promise.all(live.map((connection) => checkConnection(connection)));
  }

  const connections = await EmailConnection.find({ userId }).select(
    "email lastSyncedAt createdAt needsReconnect"
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

  // Each mailbox on its own: one whose sign-in Google dropped is reported
  // and flagged, and the rest are still read.
  const settled = await Promise.allSettled(connections.map((c) => syncEmailConnection(c._id.toString())));
  const needsReconnect: string[] = [];
  const results: { created: number; scanned: number }[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") results.push(outcome.value);
    else if (outcome.reason instanceof GmailNeedsReconnectError) needsReconnect.push(connections[index].email);
    else throw outcome.reason;
  });

  // Nothing could be read at all: say so, rather than "nothing new".
  if (results.length === 0 && needsReconnect.length > 0) {
    throw new GmailNeedsReconnectError(needsReconnect.join(", "));
  }
  res.json({ results, needsReconnect });
});

emailRouter.delete("/:id", requireAuth, validObjectIdParam("id"), async (req, res) => {
  const deleted = await EmailConnection.findOneAndDelete({
    _id: req.params.id,
    userId: currentUserId(req),
  });
  if (!deleted) return res.status(404).json({ error: "Not found" });

  res.status(204).end();
});
