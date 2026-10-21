import { Request, Response, Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../../env";
import { requireAuth, signSessionToken } from "../../middleware/auth";
import { EmailConnection, User } from "../../models";
import { ensureCashAccount } from "../../parsing/accounts";
import { gmailCallbackHandler } from "../ingestion/email.routes";
import {
  OidcClaims,
  OidcError,
  authorizeUrl,
  endSessionUrl,
  exchangeCode,
  newAuthRequest,
  oidcConfigured,
  verifyIdToken,
} from "./oidc";

export const authRouter = Router();

/**
 * Owners sign in through the identity server SpendLog shares with Trippin
 * and InFrame, and nothing else. It only proves who somebody is: once it
 * has, they get SpendLog's own session token, the same one as ever, and
 * requireAuth never hears about the identity server.
 *
 * Kids are not here. They sign in with the email and password a parent
 * set, at POST /kid/login, and never touch the identity server.
 */

// GET /auth/me — the signed-in user, for the account block in the sidebar.
// The session token carries only an id and email, and the display name is
// not in it, so the client asks for the record.
authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.user!.id);
  if (!user) return res.status(404).json({ error: "Not found" });
  res.json({ id: user._id.toString(), email: user.email, name: user.name });
});

// Where Google sends the browser back after connecting Gmail. Only Gmail:
// nobody signs in with Google any more. Kept at this path because it is
// the redirect URI already registered in Google Console.
authRouter.get("/google/callback", gmailCallbackHandler);

/** An owner sign-in with an email that belongs to a kid's login. */
export class KidEmailError extends Error {
  constructor() {
    super("That email is used for a kid's login on SpendLog, so it can't be used to sign in here.");
  }
}

/**
 * The identity server vouched for somebody, but they cannot be matched to
 * a SpendLog account safely. `code` is what the web login page shows.
 */
export class OidcAccountError extends Error {
  constructor(
    readonly code: "email_unverified" | "account_conflict",
    message: string
  ) {
    super(message);
  }
}

/**
 * The SpendLog account for somebody the identity server has just vouched
 * for, found or made in this order:
 *
 *  1. Already linked: the account carrying their `sub`.
 *  2. An account with their email, if the identity server says it has
 *     verified that address. The account is linked to them from then on.
 *     This is how everybody who used to sign in with Google keeps their
 *     ledger.
 *  3. Nobody has that email: a new account.
 *
 * An unverified email that matches an existing account is refused, not
 * given a second account. Emails are unique here, so a second account
 * with the same address cannot exist - and linking would hand the
 * existing ledger to anybody who typed its owner's address into a sign-up
 * form. Verifying the address at the identity server and signing in again
 * links it. An account already linked to a different `sub` is refused
 * the same way: one ledger, one person.
 */
export async function findOrCreateOidcUser(claims: OidcClaims) {
  const linked = await User.findOne({ oidcSub: claims.sub, role: { $ne: "KID" } });
  if (linked) {
    if (claims.name && claims.name !== linked.name) {
      linked.name = claims.name;
      await linked.save();
    }
    await ensureCashAccount(linked._id);
    return linked;
  }

  const email = claims.email.trim().toLowerCase();

  // A kid's email is typed in by a parent and never checked, so an account
  // at the identity server with the same address proves nothing about who
  // holds it. Letting it through would hand that stranger the kid's record.
  if (await User.exists({ email, role: "KID" })) throw new KidEmailError();

  const existing = await User.findOne({ email });
  let user;
  if (existing) {
    if (!claims.email_verified) {
      throw new OidcAccountError(
        "email_unverified",
        "A SpendLog account already uses this email. Verify the address with your account, then sign in again."
      );
    }
    if (existing.oidcSub && existing.oidcSub !== claims.sub) {
      throw new OidcAccountError(
        "account_conflict",
        "This email's SpendLog account is already linked to a different sign-in."
      );
    }
    existing.oidcSub = claims.sub;
    if (claims.name) existing.name = claims.name;
    user = await existing.save();
  } else {
    user = await User.create({ email, name: claims.name ?? null, oidcSub: claims.sub });
  }

  // Somewhere to file a cash payment, which no message will ever announce.
  await ensureCashAccount(user._id);

  return user;
}

// ---------------------------------------------------------------- web ---

/**
 * One sign-in's PKCE verifier, state and nonce, between /start and
 * /callback. Kept in the browser as a signed httpOnly cookie rather than
 * on the server, so nothing has to be stored or cleaned up; ten minutes
 * is plenty to get through a login form.
 */
const LOGIN_COOKIE = "spendlog_oidc";
const LOGIN_COOKIE_MS = 10 * 60 * 1000;

interface LoginCookie {
  purpose: "oidc-login";
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo?: string;
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

function cookieOptions(req: Request) {
  return {
    httpOnly: true,
    // Lax, not Strict: the callback is a top-level navigation arriving from
    // the identity server's origin, and Strict would leave the cookie off it.
    sameSite: "lax" as const,
    // req.secure sees through the frontend's /api proxy, which says
    // whether the browser came in over HTTPS.
    secure: req.secure,
    // "/" rather than "/auth/oidc": the browser sees this path with the
    // proxy's /api in front, the backend sees it without.
    path: "/",
  };
}

/**
 * Only a path on SpendLog's own web app: anything that could name another
 * site ("//evil.example", "https://…", "/\\evil") is dropped, so the login
 * flow cannot be used as an open redirect.
 */
function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^\/(?![/\\])[^\s\\]*$/.test(value)) return undefined;
  return value;
}

function loginRedirect(res: Response, error: string) {
  res.redirect(`${env.frontendUrl}/login?${new URLSearchParams({ error }).toString()}`);
}

// GET /auth/oidc/start?returnTo=/path — begins sign-in. A plain redirect,
// so the web app only needs a link.
authRouter.get("/oidc/start", async (req, res) => {
  if (!oidcConfigured() || !env.oidcRedirectUri || !env.oidcClientSecret) {
    return res.status(500).json({ error: "Sign-in is not configured on the server" });
  }

  const request = newAuthRequest();
  let url: string;
  try {
    url = await authorizeUrl(request);
  } catch (err) {
    console.error("Identity server unreachable at sign-in:", err);
    return loginRedirect(res, "sso_unavailable");
  }

  const cookie: LoginCookie = {
    purpose: "oidc-login",
    state: request.state,
    nonce: request.nonce,
    codeVerifier: request.codeVerifier,
    returnTo: safeReturnTo(req.query.returnTo),
  };
  res.cookie(LOGIN_COOKIE, jwt.sign(cookie, env.jwtSecret, { expiresIn: LOGIN_COOKIE_MS / 1000 }), {
    ...cookieOptions(req),
    maxAge: LOGIN_COOKIE_MS,
  });
  res.redirect(url);
});

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

// GET /auth/oidc/callback — the identity server sends the browser back
// here. Every failure lands on the login page with a reason it can show.
authRouter.get("/oidc/callback", async (req, res) => {
  const raw = readCookie(req, LOGIN_COOKIE);
  // One use only, whatever happens next.
  res.clearCookie(LOGIN_COOKIE, cookieOptions(req));

  if (typeof req.query.error === "string") return loginRedirect(res, "oauth_failed");

  const parsed = callbackSchema.safeParse(req.query);
  if (!parsed.success) return loginRedirect(res, "oauth_failed");

  let login: LoginCookie;
  try {
    if (!raw) throw new Error("no login cookie");
    login = jwt.verify(raw, env.jwtSecret) as LoginCookie;
    if (login.purpose !== "oidc-login") throw new Error("not a login cookie");
  } catch {
    // Took too long, or started in another browser.
    return loginRedirect(res, "oauth_expired");
  }
  if (parsed.data.state !== login.state) return loginRedirect(res, "oauth_failed");

  try {
    const { id_token } = await exchangeCode(parsed.data.code, login.codeVerifier);
    const claims = await verifyIdToken(id_token, { audience: env.oidcClientId, nonce: login.nonce });
    const user = await findOrCreateOidcUser(claims);

    // Kept so signing out can name this session to the identity server.
    await User.updateOne({ _id: user._id }, { $set: { oidcIdToken: id_token } });

    // The session token goes back in the URL fragment rather than the query
    // string: fragments are never sent to a server or written to access
    // logs, and the frontend strips it from history immediately.
    const sessionToken = signSessionToken({ id: user._id.toString(), email: user.email });
    const fragment = new URLSearchParams({ token: sessionToken });
    if (login.returnTo) fragment.set("returnTo", login.returnTo);
    res.redirect(`${env.frontendUrl}/auth/callback#${fragment.toString()}`);
  } catch (err) {
    if (err instanceof KidEmailError) return loginRedirect(res, "kid_email");
    if (err instanceof OidcAccountError) return loginRedirect(res, err.code);
    console.error("Sign-in callback failed:", err);
    loginRedirect(res, "oauth_failed");
  }
});

// GET /auth/oidc/logout-url — where to send the browser so signing out of
// SpendLog signs out of the identity server too. null when it offers no
// way to, and the web app just signs out locally.
authRouter.get("/oidc/logout-url", requireAuth, async (req, res) => {
  if (!oidcConfigured()) return res.json({ url: null });
  const user = await User.findById(req.user!.id).select("oidcIdToken");
  try {
    res.json({ url: await endSessionUrl(user?.oidcIdToken) });
  } catch (err) {
    console.error("Identity server unreachable at sign-out:", err);
    res.json({ url: null });
  }
});

// ------------------------------------------------------------- mobile ---

const mobileLoginSchema = z.object({ idToken: z.string().min(1) });

// POST /auth/oidc/mobile { idToken } — the phone app runs the login
// itself (flutter_appauth, PKCE, as the public spendlog-mobile client) and
// sends the ID token it got. Checked here against the identity server's
// keys and that client id; the nonce was already checked by AppAuth.
authRouter.post("/oidc/mobile", async (req, res) => {
  if (!oidcConfigured()) return res.status(503).json({ error: "Sign-in is not configured on the server" });

  const parsed = mobileLoginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "idToken is required" });

  let claims: OidcClaims;
  try {
    claims = await verifyIdToken(parsed.data.idToken, { audience: env.oidcMobileClientId });
  } catch (err) {
    if (!(err instanceof OidcError)) console.error("Mobile sign-in could not verify a token:", err);
    return res.status(401).json({ error: "That sign-in could not be verified. Please try again." });
  }

  let user;
  try {
    user = await findOrCreateOidcUser(claims);
  } catch (err) {
    if (err instanceof OidcAccountError) return res.status(403).json({ error: err.message, code: err.code });
    throw err; // KidEmailError becomes a 403 in app.ts
  }

  const gmailConnected = Boolean(await EmailConnection.exists({ userId: user._id, needsReconnect: { $ne: true } }));
  res.json({
    token: signSessionToken({ id: user._id.toString(), email: user.email }),
    user: { id: user._id.toString(), email: user.email, name: user.name },
    gmailConnected,
  });
});
