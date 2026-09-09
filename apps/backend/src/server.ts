import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { app } from "./app";
import { connectDatabase } from "./db";
import { env } from "./env";
import { syncAllConnectedEmails } from "./modules/ingestion/gmail.service";

const EMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;

// Shared with the frontend's static server, which is plain JS outside this
// TypeScript project — hence the runtime require rather than an import.
// __dirname is apps/backend/dist once compiled, so the root is three up.
/* eslint-disable @typescript-eslint/no-var-requires */
const certHelperPath = path.resolve(__dirname, "..", "..", "..", "scripts", "ensure-certs.js");

/**
 * Serves HTTPS when a certificate and key are configured, otherwise plain
 * HTTP. Local development needs no certs (Google exempts localhost from
 * its HTTPS requirement); a deployed instance does. A missing certificate
 * is generated rather than treated as a fatal error, so a fresh deployment
 * only needs the paths set in .env.
 */
function createServer() {
  if (!env.sslCertPath || !env.sslKeyPath || !env.backendTls) {
    return { server: http.createServer(app), scheme: "http" };
  }

  const { ensureCerts, resolveConfig } = require(certHelperPath);
  const status = ensureCerts({
    ...resolveConfig(),
    certPath: env.sslCertPath,
    keyPath: env.sslKeyPath,
  });
  if (status !== "exists") console.log(`TLS certificate: ${status}`);

  const credentials = {
    cert: fs.readFileSync(env.sslCertPath),
    key: fs.readFileSync(env.sslKeyPath),
  };
  return { server: https.createServer(credentials, app), scheme: "https" };
}

async function start() {
  // Connect before listening so the first request can't race the database.
  await connectDatabase();
  console.log("Connected to MongoDB");

  const { server, scheme } = createServer();
  server.listen(env.port, env.host, () => {
    console.log(`Backend listening on ${scheme}://${env.host}:${env.port}`);
    if (env.host === "127.0.0.1") {
      console.log("Bound to loopback only — reachable through the frontend's /api proxy.");
    }
  });

  setInterval(() => {
    syncAllConnectedEmails().catch((err) => console.error("Background Gmail sync failed:", err));
  }, EMAIL_SYNC_INTERVAL_MS);
}

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
