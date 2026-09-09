import path from "path";
import dotenv from "dotenv";

// The monorepo keeps a single .env at the repo root rather than one per app.
// __dirname is apps/backend/src when running via tsx and apps/backend/dist
// once compiled — both are one level below apps/backend, so the root is
// three levels up either way.
dotenv.config({ path: path.resolve(__dirname, "..", "..", "..", ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name} (set it in the .env at the repo root)`);
  }
  return value;
}

/** Treats only an explicit "false"/"0"/"no" as off. */
function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return !["false", "0", "no"].includes(value.toLowerCase());
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  // Bind to loopback when the frontend proxies /api to this process, so
  // the backend isn't reachable from the internet at all. Default stays
  // open for a standalone, directly-exposed deployment.
  host: process.env.BACKEND_HOST ?? "0.0.0.0",
  databaseUrl: required("DATABASE_URL"),
  jwtSecret: required("JWT_SECRET"),
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleOAuthRedirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:5173",
  // When both are set the backend serves HTTPS instead of HTTP. Google
  // requires HTTPS for any non-localhost OAuth redirect URI.
  sslCertPath: process.env.SSL_CERT_PATH ?? "",
  sslKeyPath: process.env.SSL_KEY_PATH ?? "",
  // Set BACKEND_TLS=false when the frontend terminates TLS and proxies to
  // this process over loopback. The two share one .env, so without this the
  // backend would also try to use the certificate — pointless work on a
  // local hop, and it needs read access to a root-only private key.
  backendTls: flag(process.env.BACKEND_TLS, true),
};
