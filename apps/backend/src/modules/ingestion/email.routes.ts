import { RequestHandler, Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../env";
import { currentUserId, requireAuth } from "../../middleware/auth";
import { validObjectIdParam } from "../../middleware/validate";
import { EmailConnection, User } from "../../models";
import {
  GmailNeedsReconnectError,
  buildConsentUrl,
  checkConnection,
  exchangeCode,
  grantedGmailAccess,
  saveConnection,
  syncEmailConnection,
} from "./gmail.service";

export const emailRouter = Router();

/**
 * Connecting Gmail is its own Google consent, separate from signing in -
 * that goes through the shared identity server, which knows nothing about
 * anybody's mailbox.
 *
 * `state` is a short-lived signed token naming who asked, so the redirect
 * back from Google lands on the right account without a session cookie.
 * `purpose` is kept from when the same callback also signed people in; a
 * state that says anything but "reconnect" is one of those old links and
 * is refused.
 */
interface GmailOAuthState {
  purpose: "reconnect";
  userId: string;
}

export function signGmailState(state: GmailOAuthState): string {
  return jwt.sign(state, env.jwtSecret, { expiresIn: "10m" });
}

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  scope: z.string().optional(),
});

function frontendRedirect(path: string, params: Record<string, string>): string {
  return `${env.frontendUrl}${path}?${new URLSearchParams(params).toString()}`;
}

/**
 * Where Google sends the browser back after the Gmail consent screen.
 * Mounted at both /auth/google/callback and /ingestion/email/callback so
 * whichever is registered as the redirect URI in Google Console works.
 */
export const gmailCallbackHandler: RequestHandler = async (req, res) => {
  const parsed = callbackSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.redirect(frontendRedirect("/login", { error: "oauth_failed" }));
  }

  let state: GmailOAuthState;
  try {
    state = jwt.verify(parsed.data.state, env.jwtSecret) as GmailOAuthState;
  } catch {
    return res.redirect(frontendRedirect("/login", { error: "oauth_expired" }));
  }
  if (state.purpose !== "reconnect" || !state.userId) {
    return res.redirect(frontendRedirect("/login", { error: "oauth_failed" }));
  }

  try {
    const tokens = await exchangeCode(parsed.data.code);
    const gmailGranted = grantedGmailAccess(tokens.scope);
    const user = await User.findById(state.userId).orFail();
    if (gmailGranted && tokens.refresh_token) {
      await saveConnection({
        userId: user._id,
        email: mailboxAddress(tokens.id_token, user.email),
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
      });
    }
    res.redirect(frontendRedirect("/settings", { gmail: gmailGranted ? "connected" : "denied" }));
  } catch (err) {
    console.error("Gmail OAuth callback failed:", err);
    res.redirect(frontendRedirect("/login", { error: "oauth_failed" }));
  }
};

/**
 * Which mailbox was connected. The Google account need not be the address
 * somebody signs in to SpendLog with any more, so it is read from Google's
 * ID token (which came straight from Google's token endpoint over TLS, so
 * its claims are taken as they are) and falls back to the account email.
 */
function mailboxAddress(idToken: string | null | undefined, fallback: string): string {
  if (!idToken) return fallback;
  const claims = jwt.decode(idToken);
  return claims && typeof claims === "object" && typeof claims.email === "string" ? claims.email : fallback;
}

emailRouter.get("/callback", gmailCallbackHandler);

// GET /ingestion/email/connect — the Gmail consent screen, for connecting
// a mailbox for the first time or again after Google dropped it.
emailRouter.get("/connect", requireAuth, (req, res) => {
  const state = signGmailState({ purpose: "reconnect", userId: req.user!.id });
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
