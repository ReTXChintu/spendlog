import fs from "fs";
import http from "http";
import https from "https";
import { app } from "./app";
import { connectDatabase } from "./db";
import { env } from "./env";
import { syncAllConnectedEmails } from "./modules/ingestion/gmail.service";

const EMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Serves HTTPS when a certificate and key are configured, otherwise plain
 * HTTP. Local development needs no certs (Google exempts localhost from
 * its HTTPS requirement); a deployed instance does.
 */
function createServer() {
  if (!env.sslCertPath || !env.sslKeyPath) {
    return { server: http.createServer(app), scheme: "http" };
  }

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
  server.listen(env.port, () => {
    console.log(`Backend listening on ${scheme}://localhost:${env.port}`);
  });

  setInterval(() => {
    syncAllConnectedEmails().catch((err) => console.error("Background Gmail sync failed:", err));
  }, EMAIL_SYNC_INTERVAL_MS);
}

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
