import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

// Set outright rather than ??=: dotenv never overwrites a key that exists,
// and these have to be the fake identity server's, not a developer's real
// one from the repo-root .env.
process.env.DATABASE_URL ??= "mongodb://127.0.0.1:27017/spendlog_unused";
process.env.JWT_SECRET ??= "oidc-test-secret";
process.env.OIDC_ISSUER = "https://id.test:50011";
process.env.OIDC_CLIENT_ID = "spendlog-web";
process.env.OIDC_CLIENT_SECRET = "web-secret";
process.env.OIDC_REDIRECT_URI = "https://spend.test/api/auth/oidc/callback";
process.env.OIDC_POST_LOGOUT_URI = "https://spend.test/";
process.env.OIDC_MOBILE_CLIENT_ID = "spendlog-mobile";
process.env.FRONTEND_URL = "https://spend.test";

const ISSUER = "https://id.test:50011";

/**
 * Signing in through the shared identity server, end to end over real
 * HTTP, against a fake identity server that lives in this file.
 *
 * The fake is a real RS256 key pair behind a stubbed globalThis.fetch:
 * discovery, JWKS and a token endpoint that checks the client secret and
 * the PKCE verifier exactly as a real one would. The authorize step - a
 * person typing a password into the identity server - is what each test
 * plays itself, by reading /start's redirect and choosing what the
 * identity server would then vouch for.
 */
const signingKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const strangerKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-key-1";

interface IssuedCode {
  codeChallenge: string;
  idToken: string;
}
/** Codes the "identity server" has handed out, by code. */
let codes = new Map<string, IssuedCode>();
let tokenRequests: { auth: string | null; body: URLSearchParams }[] = [];

let mongod: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let models: typeof import("../../models");
let oidc: typeof import("./oidc");
let hashPassword: typeof import("../family/family.password").hashPassword;

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeIdentityServer(url: string, init?: RequestInit): Response {
  const path = url.slice(ISSUER.length);
  if (path === "/.well-known/openid-configuration") {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      end_session_endpoint: `${ISSUER}/logout`,
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    });
  }
  if (path === "/jwks") {
    const jwk = signingKey.publicKey.export({ format: "jwk" });
    return json({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] });
  }
  if (path === "/token" && init?.method === "POST") {
    const body = new URLSearchParams(String(init.body));
    const auth = new Headers(init.headers).get("Authorization");
    tokenRequests.push({ auth, body });

    const expected = `Basic ${Buffer.from("spendlog-web:web-secret").toString("base64")}`;
    if (auth !== expected) return json({ error: "invalid_client" }, 401);

    const issued = codes.get(body.get("code") ?? "");
    if (!issued) return json({ error: "invalid_grant" }, 400);
    codes.delete(body.get("code")!);
    const challenge = crypto.createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url");
    if (challenge !== issued.codeChallenge) return json({ error: "invalid_grant" }, 400);
    if (body.get("redirect_uri") !== process.env.OIDC_REDIRECT_URI) return json({ error: "invalid_grant" }, 400);

    return json({ access_token: "at", token_type: "Bearer", id_token: issued.idToken, refresh_token: "rt" });
  }
  return json({ error: "not_found" }, 404);
}

/** An ID token as the identity server would sign one. */
function idToken(claims: Record<string, unknown>, options: { key?: crypto.KeyObject; audience?: string } = {}) {
  return jwt.sign(
    { email_verified: true, ...claims },
    options.key ?? signingKey.privateKey,
    {
      algorithm: "RS256",
      keyid: KID,
      issuer: ISSUER,
      audience: options.audience ?? "spendlog-web",
      expiresIn: "5m",
    }
  );
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("spendlog_oidc_test"));

  const [{ app }, loadedModels, loadedOidc, password] = await Promise.all([
    import("../../app"),
    import("../../models"),
    import("./oidc"),
    import("../family/family.password"),
  ]);
  models = loadedModels;
  oidc = loadedOidc;
  hashPassword = password.hashPassword;
  await models.User.syncIndexes();

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // The identity server is stubbed; the test's own calls to the app go
  // through for real.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(ISSUER)) return fakeIdentityServer(url, init);
    return realFetch(input, init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  codes = new Map();
  tokenRequests = [];
  oidc.resetOidcCache();
  await Promise.all([models.User.deleteMany({}), models.Account.deleteMany({})]);
});

/** Starts a web sign-in and reads what /start sent to the identity server. */
async function start(returnTo?: string) {
  const query = returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
  const response = await realFetch(`${baseUrl}/auth/oidc/start${query}`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  return { location, cookie, setCookie };
}

/**
 * Plays the person signing in at the identity server: it vouches for
 * `claims` and hands back a code, which the browser carries to /callback.
 */
async function signInAs(
  claims: Record<string, unknown>,
  tweak: { state?: string; nonce?: string; audience?: string; cookie?: string | null; returnTo?: string } = {}
) {
  const { location, cookie } = await start(tweak.returnTo);
  const code = crypto.randomBytes(8).toString("hex");
  codes.set(code, {
    codeChallenge: location.searchParams.get("code_challenge")!,
    idToken: idToken(
      { ...claims, nonce: tweak.nonce ?? location.searchParams.get("nonce") },
      { audience: tweak.audience }
    ),
  });

  const state = tweak.state ?? location.searchParams.get("state")!;
  const headers: Record<string, string> = {};
  const sentCookie = tweak.cookie === undefined ? cookie : tweak.cookie;
  if (sentCookie) headers.Cookie = sentCookie;
  const response = await realFetch(
    `${baseUrl}/auth/oidc/callback?code=${code}&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers }
  );
  assert.equal(response.status, 302);
  return new URL(response.headers.get("location")!);
}

/** The session token out of the hand-off redirect, or a failure's reason. */
function handOff(location: URL) {
  if (location.pathname === "/login") return { error: location.searchParams.get("error") };
  assert.equal(location.pathname, "/auth/callback");
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  return { token: fragment.get("token")!, returnTo: fragment.get("returnTo") };
}

async function me(token: string) {
  const response = await realFetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: (await response.json()) as { id: string; email: string; name: string } };
}

async function mobileSignIn(token: string) {
  const response = await realFetch(`${baseUrl}/auth/oidc/mobile`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-spendlog-client": "mobile" },
    body: JSON.stringify({ idToken: token }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

describe("web sign-in", () => {
  it("sends the browser to the identity server with PKCE, state and nonce", async () => {
    const { location, setCookie } = await start();
    assert.equal(location.origin + location.pathname, `${ISSUER}/authorize`);
    assert.equal(location.searchParams.get("client_id"), "spendlog-web");
    assert.equal(location.searchParams.get("redirect_uri"), "https://spend.test/api/auth/oidc/callback");
    assert.equal(location.searchParams.get("scope"), "openid email profile offline_access");
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.ok(location.searchParams.get("code_challenge"));
    assert.ok(location.searchParams.get("state"));
    assert.ok(location.searchParams.get("nonce"));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
  });

  it("creates a new owner on a first sign-in and hands over a SpendLog session", async () => {
    const result = handOff(await signInAs({ sub: "sub-new", email: "New@Example.com", name: "New Person" }));
    assert.ok(result.token);

    // The client secret went in a Basic header, with the PKCE verifier.
    assert.equal(tokenRequests.length, 1);
    assert.ok(tokenRequests[0].auth?.startsWith("Basic "));
    assert.equal(tokenRequests[0].body.get("client_secret"), null);

    const { status, body } = await me(result.token!);
    assert.equal(status, 200);
    assert.equal(body.email, "new@example.com");
    assert.equal(body.name, "New Person");

    const user = await models.User.findById(body.id).orFail();
    assert.equal(user.oidcSub, "sub-new");
    assert.equal(user.role, "OWNER");
    assert.ok(user.oidcIdToken, "keeps the ID token for signing out");
    // A brand new ledger still gets its cash account.
    assert.equal(await models.Account.countDocuments({ userId: user._id, accountType: "CASH" }), 1);

    // The second sign-in finds the same account by sub, even if the email moved.
    const again = handOff(await signInAs({ sub: "sub-new", email: "moved@example.com", name: "New Person" }));
    assert.equal((await me(again.token!)).body.id, body.id);
    assert.equal(await models.User.countDocuments({}), 1);
  });

  it("carries a same-site returnTo through, and drops one that leaves the site", async () => {
    const kept = handOff(await signInAs({ sub: "s1", email: "r@example.com" }, { returnTo: "/trips?id=1" }));
    assert.equal(kept.returnTo, "/trips?id=1");

    for (const evil of ["//evil.example/x", "https://evil.example", "/\\evil.example"]) {
      const dropped = handOff(await signInAs({ sub: "s1", email: "r@example.com" }, { returnTo: evil }));
      assert.ok(dropped.token);
      assert.equal(dropped.returnTo, null, evil);
    }
  });

  it("links an existing account by a verified email, keeping its ledger", async () => {
    const existing = await models.User.create({ email: "old@example.com", name: "Old", googleId: "g-123" });

    const result = handOff(await signInAs({ sub: "sub-old", email: "old@example.com", email_verified: true, name: "Old Name" }));
    const { body } = await me(result.token!);
    assert.equal(body.id, existing._id.toString());

    const linked = await models.User.findById(existing._id).orFail();
    assert.equal(linked.oidcSub, "sub-old");
    assert.equal(linked.name, "Old Name");
    assert.equal(linked.googleId, "g-123");
    assert.equal(await models.User.countDocuments({}), 1);
  });

  it("refuses to link an existing account to an unverified email", async () => {
    const existing = await models.User.create({ email: "victim@example.com", name: "Victim" });

    const result = handOff(await signInAs({ sub: "sub-attacker", email: "victim@example.com", email_verified: false }));
    assert.equal(result.error, "email_unverified");

    const untouched = await models.User.findById(existing._id).orFail();
    assert.equal(untouched.oidcSub, null);
    assert.equal(await models.User.countDocuments({}), 1);
  });

  it("still creates an account for an unverified email nobody uses yet", async () => {
    const result = handOff(await signInAs({ sub: "sub-fresh", email: "fresh@example.com", email_verified: false }));
    assert.ok(result.token);
    assert.equal((await models.User.findOne({ email: "fresh@example.com" }).orFail()).oidcSub, "sub-fresh");
  });

  it("refuses an account already linked to somebody else's sub", async () => {
    await models.User.create({ email: "taken@example.com", oidcSub: "sub-first" });
    const result = handOff(await signInAs({ sub: "sub-second", email: "taken@example.com" }));
    assert.equal(result.error, "account_conflict");
  });

  it("rejects a callback whose state does not match the one it started with", async () => {
    const result = handOff(await signInAs({ sub: "s", email: "s@example.com" }, { state: "forged-state" }));
    assert.equal(result.error, "oauth_failed");
    assert.equal(tokenRequests.length, 0, "never exchanges the code");
    assert.equal(await models.User.countDocuments({}), 0);
  });

  it("rejects an ID token whose nonce is not this sign-in's", async () => {
    const result = handOff(await signInAs({ sub: "s", email: "s@example.com" }, { nonce: "replayed-nonce" }));
    assert.equal(result.error, "oauth_failed");
    assert.equal(await models.User.countDocuments({}), 0);
  });

  it("rejects a callback with no login cookie, as started in another browser", async () => {
    const result = handOff(await signInAs({ sub: "s", email: "s@example.com" }, { cookie: null }));
    assert.equal(result.error, "oauth_expired");
  });

  it("rejects an ID token issued to another client", async () => {
    const result = handOff(await signInAs({ sub: "s", email: "s@example.com" }, { audience: "trippin-web" }));
    assert.equal(result.error, "oauth_failed");
    assert.equal(await models.User.countDocuments({}), 0);
  });

  it("refuses a kid's email", async () => {
    const { hash, salt } = hashPassword("kidpassword");
    const parent = await models.User.create({ email: "parent@example.com" });
    await models.User.create({
      email: "kid@example.com",
      role: "KID",
      parentId: parent._id,
      passwordHash: hash,
      passwordSalt: salt,
    });

    const result = handOff(await signInAs({ sub: "sub-kid", email: "kid@example.com" }));
    assert.equal(result.error, "kid_email");
    assert.equal((await models.User.findOne({ email: "kid@example.com" }).orFail()).oidcSub, null);
  });

  it("gives the identity server's end-session URL for signing out", async () => {
    const result = handOff(await signInAs({ sub: "sub-out", email: "out@example.com" }));
    const response = await realFetch(`${baseUrl}/auth/oidc/logout-url`, {
      headers: { Authorization: `Bearer ${result.token}` },
    });
    const { url } = (await response.json()) as { url: string };
    const logout = new URL(url);
    assert.equal(logout.origin + logout.pathname, `${ISSUER}/logout`);
    assert.equal(logout.searchParams.get("client_id"), "spendlog-web");
    assert.equal(logout.searchParams.get("post_logout_redirect_uri"), "https://spend.test/");
    const hint = jwt.decode(logout.searchParams.get("id_token_hint")!) as jwt.JwtPayload;
    assert.equal(hint.sub, "sub-out");
  });
});

describe("mobile sign-in", () => {
  it("verifies the app's ID token and issues the same session as before", async () => {
    const { status, body } = await mobileSignIn(
      idToken({ sub: "sub-phone", email: "phone@example.com", name: "Phone" }, { audience: "spendlog-mobile" })
    );
    assert.equal(status, 200);
    assert.ok(body.token);
    assert.equal(body.user.email, "phone@example.com");
    assert.equal(body.user.name, "Phone");
    assert.equal(body.gmailConnected, false);

    const session = jwt.verify(body.token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    assert.equal(session.id, body.user.id);
    assert.equal(session.role, undefined, "an owner's session, not a kid's");
    assert.equal((await me(body.token)).status, 200);
  });

  it("refuses a token issued to the web client", async () => {
    const { status } = await mobileSignIn(idToken({ sub: "s", email: "s@example.com" }, { audience: "spendlog-web" }));
    assert.equal(status, 401);
    assert.equal(await models.User.countDocuments({}), 0);
  });

  it("refuses a token signed by a key the identity server does not publish", async () => {
    const { status } = await mobileSignIn(
      idToken({ sub: "s", email: "s@example.com" }, { audience: "spendlog-mobile", key: strangerKey.privateKey })
    );
    assert.equal(status, 401);
  });

  it("refuses a kid's email", async () => {
    await models.User.create({ email: "kid2@example.com", role: "KID" });
    const { status, body } = await mobileSignIn(
      idToken({ sub: "sub-k", email: "kid2@example.com" }, { audience: "spendlog-mobile" })
    );
    assert.equal(status, 403);
    assert.match(body.error, /kid/);
  });

  it("refuses to link by an unverified email", async () => {
    await models.User.create({ email: "m@example.com" });
    const { status, body } = await mobileSignIn(
      idToken({ sub: "sub-m", email: "m@example.com", email_verified: false }, { audience: "spendlog-mobile" })
    );
    assert.equal(status, 403);
    assert.equal(body.code, "email_unverified");
  });
});

describe("kids", () => {
  it("still sign in with their own email and password, untouched by the identity server", async () => {
    const parent = await models.User.create({ email: "p@example.com" });
    const { hash, salt } = hashPassword("pocketmoney");
    const kid = await models.User.create({
      email: "child@example.com",
      name: "Child",
      role: "KID",
      parentId: parent._id,
      passwordHash: hash,
      passwordSalt: salt,
    });

    const response = await realFetch(`${baseUrl}/kid/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-spendlog-client": "mobile" },
      body: JSON.stringify({ email: "child@example.com", password: "pocketmoney" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { token: string; kid: { id: string } };
    assert.equal(body.kid.id, kid._id.toString());
    const session = jwt.verify(body.token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    assert.equal(session.role, "KID");

    // Nothing went near the identity server.
    assert.equal(tokenRequests.length, 0);
  });
});

describe("the old Google sign-in", () => {
  it("is gone", async () => {
    const start = await realFetch(`${baseUrl}/auth/google/start`, { redirect: "manual" });
    assert.equal(start.status, 404);
    const mobile = await realFetch(`${baseUrl}/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: "x" }),
    });
    assert.equal(mobile.status, 404);
  });
});
