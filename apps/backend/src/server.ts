import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { app } from "./app";
import { connectDatabase } from "./db";
import { env } from "./env";
import { runLendingBackfill } from "./modules/contacts/contacts.backfill";
import { runSpendLimitBackfill } from "./modules/accounts/accounts.backfill";
import { runCardBillAccountBackfill, runCardBillBackfill } from "./modules/cards/cards.billPayment.service";
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

  // One-off repairs, once per user (see backfill.ts). In the background:
  // a slow pass must not keep the server from answering.
  runLendingBackfill().catch((err) => console.error("Lent & borrowed backfill failed:", err));
  // The personal spend limit, retired: cleared off every account so it
  // stops travelling out with them.
  runSpendLimitBackfill().catch((err) => console.error("Spend limit backfill failed:", err));
  // Card bills filed under the wrong account - the bank's debit under the
  // card it paid, the card's credit under a bank account - then, once they
  // are where they belong, card bills imported before they were
  // recognised, still counted as spending, and the card's "payment
  // received", still counted as income. In that order, so the second pairs
  // legs that are already on the right accounts.
  runCardBillAccountBackfill()
    .catch((err) => console.error("Card bill account backfill failed:", err))
    .then(() => runCardBillBackfill())
    .catch((err) => console.error("Card bill backfill failed:", err));

  setInterval(() => {
    syncAllConnectedEmails().catch((err) => console.error("Background Gmail sync failed:", err));
  }, EMAIL_SYNC_INTERVAL_MS);
}

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
