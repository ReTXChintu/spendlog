import { RequestHandler, Router } from "express";
import { OAuth2Client, TokenPayload } from "google-auth-library";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../env";
import { requireAuth, signSessionToken } from "../../middleware/auth";
import { User } from "../../models";
import { ensureCashAccount } from "../../parsing/accounts";
import {
  buildConsentUrl,
  exchangeCode,
  grantedGmailAccess,
  saveConnection,
} from "../ingestion/gmail.service";

export const authRouter = Router();

const googleClient = new OAuth2Client(env.googleClientId);

/**
 * Identity and Gmail access are granted in a single consent screen at
 * sign-in, so there is no second "connect Gmail" step for most users.
 *
 * `state` is a short-lived signed token carrying the flow's purpose, so
 * one registered redirect URI serves both first-time login and a later
 * reconnect from Settings.
 */
type OAuthPurpose = "login" | "reconnect";

interface OAuthState {
  purpose: OAuthPurpose;
  userId?: string;
}

export function signOAuthState(state: OAuthState): string {
  return jwt.sign(state, env.jwtSecret, { expiresIn: "10m" });
}

function verifyOAuthState(token: string): OAuthState {
  return jwt.verify(token, env.jwtSecret) as OAuthState;
}

// GET /auth/google/start — begins sign-in. Plain redirect so the frontend
// only needs a link, with no Google JavaScript SDK involved.
authRouter.get("/google/start", (_req, res) => {
  if (!env.googleClientId || !env.googleClientSecret) {
    return res.status(500).json({ error: "Google OAuth is not configured on the server" });
  }
  res.redirect(buildConsentUrl(signOAuthState({ purpose: "login" })));
});

// GET /auth/me — the signed-in user, for the account block in the sidebar.
// The session token carries only an id and email, and the display name is
// not in it, so the client asks for the record.
authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user!.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ id: user._id.toString(), email: user.email, name: user.name });
});

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  scope: z.string().optional(),
});

function frontendRedirect(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${env.frontendUrl}${path}?${query}`;
}

// Handles the redirect back from Google for every flow (first sign-in and
// a later Gmail reconnect), told apart by the signed `state`. Exported so
// it can also be mounted at the legacy /ingestion/email/callback path —
// whichever redirect URI is registered in Google Console will work.
export const googleCallbackHandler: RequestHandler = async (req, res) => {
  const parsed = callbackSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.redirect(frontendRedirect("/login", { error: "oauth_failed" }));
  }

  let state: OAuthState;
  try {
    state = verifyOAuthState(parsed.data.state);
  } catch {
    return res.redirect(frontendRedirect("/login", { error: "oauth_expired" }));
  }

  try {
    const tokens = await exchangeCode(parsed.data.code);
    const gmailGranted = grantedGmailAccess(tokens.scope);

    // Reconnect: the user is already signed in, we only needed new tokens.
    if (state.purpose === "reconnect" && state.userId) {
      const user = await User.findById(state.userId).orFail();
      if (gmailGranted && tokens.refresh_token) {
        await saveConnection({
          userId: user._id,
          email: user.email,
          accessToken: tokens.access_token!,
          refreshToken: tokens.refresh_token,
          expiryDate: tokens.expiry_date,
        });
      }
      return res.redirect(frontendRedirect("/settings", { gmail: gmailGranted ? "connected" : "denied" }));
    }

    if (!tokens.id_token) throw new Error("Google did not return an id_token");

    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: env.googleClientId,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) throw new Error("Google token missing email");

    const user = await upsertUser(payload);

    if (gmailGranted && tokens.refresh_token) {
      await saveConnection({
        userId: user._id,
        email: payload.email,
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
      });
    }

    // The session token goes back in the URL fragment rather than the query
    // string: fragments are never sent to a server or written to access
    // logs, and the frontend strips it from history immediately.
    const sessionToken = signSessionToken({ id: user._id.toString(), email: user.email });
    res.redirect(`${env.frontendUrl}/auth/callback#token=${encodeURIComponent(sessionToken)}`);
  } catch (err) {
    console.error("Google OAuth callback failed:", err);
    res.redirect(frontendRedirect("/login", { error: "oauth_failed" }));
  }
};

authRouter.get("/google/callback", googleCallbackHandler);

async function upsertUser(payload: TokenPayload) {
  const user = await User.findOneAndUpdate(
    { email: payload.email },
    { $set: { googleId: payload.sub, name: payload.name ?? null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).orFail();

  // Somewhere to file a cash payment, which no message will ever announce.
  await ensureCashAccount(user._id);

  return user;
}

const mobileLoginSchema = z.object({
  // Preferred: an auth code from google_sign_in's serverAuthCode, which can
  // be exchanged for a refresh token so email import works without a
  // second consent step.
  serverAuthCode: z.string().min(1).optional(),
  // Fallback: identity only, no Gmail access.
  idToken: z.string().min(1).optional(),
});

// POST /auth/google — used by the mobile app, which runs the consent flow
// natively rather than through a browser redirect.
authRouter.post("/google", async (req, res) => {
  const parsed = mobileLoginSchema.safeParse(req.body);
  if (!parsed.success || (!parsed.data.serverAuthCode && !parsed.data.idToken)) {
    return res.status(400).json({ error: "serverAuthCode or idToken is required" });
  }

  let payload: TokenPayload | undefined;
  let gmailConnected = false;

  if (parsed.data.serverAuthCode) {
    let tokens;
    try {
      tokens = await exchangeCode(parsed.data.serverAuthCode);
    } catch (err) {
      console.error("Failed to exchange serverAuthCode:", err);
      return res.status(401).json({ error: "Could not exchange Google auth code" });
    }

    if (!tokens.id_token) return res.status(401).json({ error: "Google did not return an id_token" });

    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: tokens.id_token,
        audience: env.googleClientId,
      });
      payload = ticket.getPayload();
    } catch {
      return res.status(401).json({ error: "Invalid Google ID token" });
    }

    if (!payload?.email || !payload.sub) {
      return res.status(401).json({ error: "Google token missing email" });
    }

    const user = await upsertUser(payload);
    if (grantedGmailAccess(tokens.scope) && tokens.refresh_token) {
      await saveConnection({
        userId: user._id,
        email: payload.email,
        accessToken: tokens.access_token!,
        refreshToken: tokens.refresh_token,
        expiryDate: tokens.expiry_date,
      });
      gmailConnected = true;
    }

    return res.json({
      token: signSessionToken({ id: user._id.toString(), email: user.email }),
      user: { id: user._id.toString(), email: user.email, name: user.name },
      gmailConnected,
    });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: parsed.data.idToken!,
      audience: env.googleClientId,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: "Invalid Google ID token" });
  }

  if (!payload?.email || !payload.sub) {
    return res.status(401).json({ error: "Google token missing email" });
  }

  const user = await upsertUser(payload);
  res.json({
    token: signSessionToken({ id: user._id.toString(), email: user.email }),
    user: { id: user._id.toString(), email: user.email, name: user.name },
    gmailConnected: false,
  });
});

export type { OAuthState };
