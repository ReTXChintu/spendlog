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

const PORT = Number(process.env.FRONTEND_PORT ?? 5173);
const CERT_PATH = process.env.SSL_CERT_PATH ?? "";
const KEY_PATH = process.env.SSL_KEY_PATH ?? "";

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

const useHttps = CERT_PATH && KEY_PATH;
const server = useHttps
  ? https.createServer({ cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) }, handler)
  : http.createServer(handler);

server.listen(PORT, () => {
  console.log(`Frontend listening on ${useHttps ? "https" : "http"}://0.0.0.0:${PORT}`);
});
