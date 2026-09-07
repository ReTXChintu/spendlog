// Production static server for the built frontend, run under PM2.
// Vite's dev server isn't meant for production, and `pm2 serve` can't do
// HTTPS — which is required here because Google refuses non-HTTPS OAuth
// redirects outside localhost. No dependencies: the frontend package
// otherwise has no runtime deps and this keeps it that way.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = path.join(__dirname, "..", "..", ".env");

/**
 * Reads the repo-root .env, the same file the backend loads. Done here
 * rather than relying on PM2 to inject the values, because PM2 caches a
 * process's environment and only refreshes it when restarted with
 * --update-env — so an edit to .env would otherwise appear to do nothing.
 * Real environment variables still win, for one-off overrides.
 */
function readRootEnv() {
  const values = {};
  try {
    for (const line of fs.readFileSync(ROOT_ENV, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env (local dev, or a container passing real env vars) — fine.
  }
  return values;
}

const fileEnv = readRootEnv();
const setting = (key, fallback) => process.env[key] || fileEnv[key] || fallback;

const PORT = Number(setting("FRONTEND_PORT", 5173));
const CERT_PATH = setting("SSL_CERT_PATH", "");
const KEY_PATH = setting("SSL_KEY_PATH", "");

// dist/ is the build output. public/ is checked as a fallback so a file
// dropped there after the build — notably SpendLog.apk from CI — is served
// immediately without needing a rebuild.
const ROOTS = [path.join(__dirname, "dist"), path.join(__dirname, "public")];
const INDEX = path.join(ROOTS[0], "index.html");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".apk": "application/vnd.android.package-archive",
};

/** Resolves a URL path to a real file inside one of the roots, or null. */
function resolveFile(urlPath) {
  // Strip the query/hash and normalise away any ../ traversal attempts.
  const decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const relative = path.normalize(decoded).replace(/^([/\\])+/, "");

  for (const root of ROOTS) {
    const candidate = path.join(root, relative);
    // path.join already collapsed .., so this catches escapes from the root.
    if (!candidate.startsWith(root)) continue;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "Method Not Allowed");
  }

  const file = resolveFile(req.url ?? "/");

  // No matching file: fall through to index.html so client-side routes
  // (/settings, /auth/callback, …) work on a hard refresh.
  const target = file ?? INDEX;
  if (!fs.existsSync(target)) {
    return send(res, 404, "Not found — has the frontend been built? Run: npm run build");
  }

  const ext = path.extname(target).toLowerCase();
  const headers = {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Content-Length": fs.statSync(target).size,
  };

  // Hashed build assets are immutable; everything else must revalidate so
  // a redeploy is picked up.
  headers["Cache-Control"] = target.includes(`${path.sep}assets${path.sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";

  if (ext === ".apk") {
    headers["Content-Disposition"] = 'attachment; filename="SpendLog.apk"';
  }

  if (req.method === "HEAD") return send(res, 200, null, headers);

  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
}

/** Reads the TLS pair, failing with a pointed message rather than a stack. */
function readCredentials() {
  for (const [label, file] of [
    ["SSL_CERT_PATH", CERT_PATH],
    ["SSL_KEY_PATH", KEY_PATH],
  ]) {
    if (!fs.existsSync(file)) {
      console.error(`${label} points at a file that does not exist:\n  ${file}`);
      console.error("Generate a pair with:  ./scripts/generate-certs.sh <ip-or-hostname>");
      process.exit(1);
    }
  }
  return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
}

const useHttps = Boolean(CERT_PATH && KEY_PATH);
const server = useHttps ? https.createServer(readCredentials(), handler) : http.createServer(handler);

server.listen(PORT, () => {
  console.log(`Frontend listening on ${useHttps ? "https" : "http"}://0.0.0.0:${PORT}`);
  if (!useHttps) {
    console.log("TLS is off (SSL_CERT_PATH / SSL_KEY_PATH not set in .env) — serving plain HTTP.");
  }
});

server.on("error", (err) => {
  if (err.code === "EACCES" && PORT < 1024) {
    console.error(
      `Cannot bind port ${PORT}: ports below 1024 need privileges. Either run\n` +
        `  sudo setcap 'cap_net_bind_service=+ep' $(which node)\n` +
        `or put a reverse proxy in front and keep FRONTEND_PORT above 1024.`
    );
  } else if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use — is another copy of the frontend running?`);
  } else {
    console.error("Frontend server error:", err);
  }
  process.exit(1);
});
