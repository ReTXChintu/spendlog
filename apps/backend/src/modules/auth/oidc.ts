import crypto, { KeyObject } from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../../env";

/**
 * The client half of signing in through the shared identity server.
 *
 * Written on jsonwebtoken and node:crypto, both already here, rather than
 * a new OIDC library: what SpendLog needs is small (discovery, one code
 * exchange, ID token checks), and everything goes out through
 * globalThis.fetch, so a test can stand the whole identity server up by
 * stubbing it - the way the other tests here stub IPO Guru and Gemini.
 *
 * The identity server only proves who somebody is. What they get after
 * that is SpendLog's own session, exactly as before.
 */

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** What SpendLog reads out of a verified ID token. */
export interface OidcClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

/** The identity server said no, or said something that does not check out. */
export class OidcError extends Error {}

export const OIDC_SCOPES = "openid email profile offline_access";

/** How long discovery and the key set are trusted before being asked again. */
const CACHE_MS = 60 * 60 * 1000;
/**
 * A token signed with a key we have not seen is how a key rotation looks
 * from here, so it earns one fresh look at the key set - but not more
 * than one every this often, or a stream of junk tokens becomes a stream
 * of requests to the identity server.
 */
const JWKS_REFRESH_MIN_MS = 30 * 1000;
/** Clocks drift; a minute either way is not an attack. */
const CLOCK_TOLERANCE_S = 60;

let discoveryCache: { value: OidcDiscovery; at: number } | null = null;
let jwksCache: { keys: Map<string, KeyObject>; unnamed: KeyObject[]; at: number } | null = null;

/** Forgets what was fetched, for tests that stand up a fresh server. */
export function resetOidcCache(): void {
  discoveryCache = null;
  jwksCache = null;
}

export function oidcConfigured(): boolean {
  return Boolean(env.oidcIssuer);
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new OidcError(`${url} answered ${response.status}`);
  return (await response.json()) as T;
}

export async function discover(): Promise<OidcDiscovery> {
  if (discoveryCache && Date.now() - discoveryCache.at < CACHE_MS) return discoveryCache.value;
  if (!env.oidcIssuer) throw new OidcError("OIDC_ISSUER is not set");

  const issuer = withoutTrailingSlash(env.oidcIssuer);
  const doc = await getJson<OidcDiscovery>(`${issuer}/.well-known/openid-configuration`);

  // A discovery document that names some other issuer is either a
  // misconfiguration or somebody else's server; either way its tokens
  // would never verify, so it is better to say so here.
  if (withoutTrailingSlash(doc.issuer ?? "") !== issuer) {
    throw new OidcError(`Discovery names issuer ${doc.issuer}, not ${env.oidcIssuer}`);
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new OidcError("Discovery document is missing an endpoint");
  }

  discoveryCache = { value: doc, at: Date.now() };
  return doc;
}

interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

async function loadJwks(): Promise<NonNullable<typeof jwksCache>> {
  const { jwks_uri } = await discover();
  const { keys } = await getJson<{ keys: Jwk[] }>(jwks_uri);

  const named = new Map<string, KeyObject>();
  const unnamed: KeyObject[] = [];
  for (const jwk of keys ?? []) {
    // RS256 is all the identity server signs with; anything else in the
    // set (an encryption key, an EC key for something else) is skipped.
    if (jwk.kty !== "RSA" || (jwk.use && jwk.use !== "sig")) continue;
    if (jwk.alg && jwk.alg !== "RS256") continue;
    const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
    if (jwk.kid) named.set(jwk.kid, key);
    else unnamed.push(key);
  }

  jwksCache = { keys: named, unnamed, at: Date.now() };
  return jwksCache;
}

async function signingKey(kid: string | undefined): Promise<KeyObject> {
  let set = jwksCache && Date.now() - jwksCache.at < CACHE_MS ? jwksCache : await loadJwks();

  const pick = (from: typeof set) => {
    if (kid) return from.keys.get(kid);
    // No kid in the token: fine only when there is exactly one key it
    // could mean.
    const all = [...from.keys.values(), ...from.unnamed];
    return all.length === 1 ? all[0] : undefined;
  };

  let key = pick(set);
  if (!key && Date.now() - set.at >= JWKS_REFRESH_MIN_MS) {
    set = await loadJwks();
    key = pick(set);
  }
  if (!key) throw new OidcError("ID token is signed with a key the identity server does not publish");
  return key;
}

/**
 * Checks an ID token properly: RS256 signature against the identity
 * server's published keys, issuer, audience, expiry, and the nonce when
 * this server chose one.
 */
export async function verifyIdToken(
  idToken: string,
  options: { audience: string; nonce?: string }
): Promise<OidcClaims> {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded.payload === "string") throw new OidcError("ID token is not a JWT");
  if (decoded.header.alg !== "RS256") throw new OidcError(`ID token uses ${decoded.header.alg}, not RS256`);

  const { issuer } = await discover();
  const key = await signingKey(decoded.header.kid);

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(idToken, key, {
      algorithms: ["RS256"],
      issuer,
      audience: options.audience,
      clockTolerance: CLOCK_TOLERANCE_S,
    }) as jwt.JwtPayload;
  } catch (err) {
    throw new OidcError(`ID token rejected: ${(err as Error).message}`);
  }

  // A token minted for several clients names the one it was handed to.
  if (payload.azp !== undefined && payload.azp !== options.audience) {
    throw new OidcError("ID token was issued to a different client");
  }
  if (options.nonce !== undefined && payload.nonce !== options.nonce) {
    throw new OidcError("ID token nonce does not match this sign-in");
  }
  if (typeof payload.sub !== "string" || !payload.sub) throw new OidcError("ID token has no subject");
  if (typeof payload.email !== "string" || !payload.email) throw new OidcError("ID token has no email");

  return {
    sub: payload.sub,
    email: payload.email,
    // Only a literal true counts. Some servers send the string "true".
    email_verified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" && payload.name ? payload.name : undefined,
    picture: typeof payload.picture === "string" && payload.picture ? payload.picture : undefined,
  };
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

/** A fresh PKCE verifier, state and nonce for one sign-in. */
export function newAuthRequest() {
  const codeVerifier = base64url(crypto.randomBytes(32));
  return {
    codeVerifier,
    codeChallenge: base64url(crypto.createHash("sha256").update(codeVerifier).digest()),
    state: base64url(crypto.randomBytes(16)),
    nonce: base64url(crypto.randomBytes(16)),
  };
}

export async function authorizeUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
  const { authorization_endpoint } = await discover();
  const url = new URL(authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.oidcClientId);
  url.searchParams.set("redirect_uri", env.oidcRedirectUri);
  url.searchParams.set("scope", OIDC_SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/**
 * Trades the authorization code for tokens, as the confidential web
 * client. client_secret_basic is the spec's default and is used unless
 * the identity server says it only takes the secret in the body.
 */
export async function exchangeCode(code: string, codeVerifier: string): Promise<{ id_token: string }> {
  const { token_endpoint, token_endpoint_auth_methods_supported: methods } = await discover();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.oidcRedirectUri,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  const useBasic = !methods || methods.length === 0 || methods.includes("client_secret_basic");
  if (useBasic) {
    // RFC 6749 2.3.1: each half is form-encoded before being joined.
    const id = encodeURIComponent(env.oidcClientId);
    const secret = encodeURIComponent(env.oidcClientSecret);
    headers.Authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  } else {
    body.set("client_id", env.oidcClientId);
    body.set("client_secret", env.oidcClientSecret);
  }

  const response = await fetch(token_endpoint, { method: "POST", headers, body: body.toString() });
  const json = (await response.json().catch(() => ({}))) as { id_token?: string; error?: string };
  if (!response.ok) throw new OidcError(`Token endpoint answered ${response.status} ${json.error ?? ""}`.trim());
  if (!json.id_token) throw new OidcError("Token endpoint returned no id_token");
  return { id_token: json.id_token };
}

/**
 * Where to send the browser to end its session at the identity server
 * too, or null when the server does not offer RP-initiated logout.
 */
export async function endSessionUrl(idTokenHint?: string | null): Promise<string | null> {
  const { end_session_endpoint } = await discover();
  if (!end_session_endpoint) return null;

  const url = new URL(end_session_endpoint);
  url.searchParams.set("client_id", env.oidcClientId);
  if (idTokenHint) url.searchParams.set("id_token_hint", idTokenHint);
  if (env.oidcPostLogoutUri) url.searchParams.set("post_logout_redirect_uri", env.oidcPostLogoutUri);
  return url.toString();
}
