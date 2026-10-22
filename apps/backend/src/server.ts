import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { app } from "./app";
import { connectDatabase } from "./db";
import { env } from "./env";
import { runLendingBackfill } from "./modules/contacts/contacts.backfill";
import { runGroupsMigration } from "./modules/groups/groups.migration";
import { runSpendLimitBackfill } from "./modules/accounts/accounts.backfill";
import { runNightlyDriftCheck } from "./modules/accounts/accounts.drift";
import { runAccountUnknownBackfill, runStatedBalanceBackfill } from "./modules/accounts/accounts.statedBackfill";
import { runMissingCreditBackfill } from "./modules/accounts/accounts.missingCredits";
import { runCardBillAccountBackfill, runCardBillBackfill } from "./modules/cards/cards.billPayment.service";
import { runCardBillLegBackfill } from "./modules/cards/cards.billLeg";
import { runCardCreditBackfill, runPaymentTwinBackfill, runSelfPaymentRepair } from "./modules/cards/cards.billRepair";
import { runDailyFundRefresh } from "./modules/funds/funds.cache";
import { runSipStepsBackfill } from "./modules/funds/funds.backfill";
import { runTransferLegBackfill } from "./modules/transactions/transactions.transfer";
import { runLoanSplitBackfill } from "./modules/loans/loans.backfill";
import { syncAllConnectedEmails } from "./modules/ingestion/gmail.service";

const EMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;

// How often the daily fund refresh asks whether it is due. The guard in
// Mongo (funds.cache.ts) makes it once a day, after NAVs are published,
// however often it asks and however often the process restarts.
const FUND_REFRESH_CHECK_MS = 30 * 60 * 1000;

// The same, for the nightly check of every balance against the bank's
// (accounts.drift.ts): due after half past ten at night, guarded in Mongo.
const DRIFT_CHECK_MS = 30 * 60 * 1000;

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

  // Trips became groups. Before listening, unlike the repairs below: until
  // it has run, a group a transaction points at may not be in `groups`
  // yet, and every screen that shows one would come up empty. It is one
  // pass, and every later start finds nothing left to do.
  await runGroupsMigration().catch((err) => console.error("Groups migration failed:", err));

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
  // legs that are already on the right accounts. Then every transfer still
  // recorded as one row is given its other leg - after the card bills, so
  // a bill's two sides are paired as a bill and not taken for a transfer.
  // Between the two, every card bill still recorded as the bank's debit
  // alone is given its card side, once the bills are all marked.
  // Woven in (cards.billRepair): purchases once marked as paying their own
  // card counted again, before anything pairs with them; money onto a card
  // "from a/c" recognised as a payment once the bills are marked; and an
  // issuer's second "payment received" folded into the first once every
  // bill has its card side, so the one kept is the paired one.
  const legsDone = runCardBillAccountBackfill()
    .catch((err) => console.error("Card bill account backfill failed:", err))
    .then(() => runSelfPaymentRepair())
    .catch((err) => console.error("Card self-payment repair failed:", err))
    .then(() => runCardBillBackfill())
    .catch((err) => console.error("Card bill backfill failed:", err))
    .then(() => runCardCreditBackfill())
    .catch((err) => console.error("Card credit backfill failed:", err))
    .then(() => runCardBillLegBackfill())
    .catch((err) => console.error("Card bill leg backfill failed:", err))
    .then(() => runPaymentTwinBackfill())
    .catch((err) => console.error("Card payment twin backfill failed:", err))
    .then(() => runTransferLegBackfill())
    .catch((err) => console.error("Transfer leg backfill failed:", err));
  // The bank's balance read off every message already stored, and the
  // payments that were guessed to be cash taken out of the cash balance.
  const statedDone = runStatedBalanceBackfill().catch((err) => console.error("Stated balance backfill failed:", err));
  // Then the last ninety days' money in that no message ever announced,
  // once per user: after the balances are read off the stored messages,
  // which is what it is measured from, and after transfers have their
  // other legs, which explain some of what would otherwise look missing.
  Promise.all([legsDone, statedDone])
    .then(() => runMissingCreditBackfill())
    .catch((err) => console.error("Missing credit backfill failed:", err));
  runAccountUnknownBackfill().catch((err) => console.error("Account unknown backfill failed:", err));
  // Loan repayments onto loanSplits, and every loan's instalments covered
  // by what was actually paid towards it rather than one tick per payment.
  runLoanSplitBackfill().catch((err) => console.error("Loan split backfill failed:", err));
  // Every SIP stored as one amount given a one-step history, the shape a
  // SIP's changes of amount and skipped months are kept in.
  runSipStepsBackfill().catch((err) => console.error("SIP steps backfill failed:", err));

  setInterval(() => {
    syncAllConnectedEmails().catch((err) => console.error("Background Gmail sync failed:", err));
  }, EMAIL_SYNC_INTERVAL_MS);

  // Mutual fund NAVs: at start-up when last night's are missing, then
  // every half hour until tonight's are in.
  const refreshFunds = () =>
    runDailyFundRefresh().catch((err) => console.error("Daily fund refresh failed:", err));
  refreshFunds();
  setInterval(refreshFunds, FUND_REFRESH_CHECK_MS);

  // Every balance against the bank's latest figure for it, once a night:
  // at start-up when last night's is missing, then every half hour until
  // tonight's has run.
  const checkDrift = () =>
    runNightlyDriftCheck().catch((err) => console.error("Balance drift check failed:", err));
  checkDrift();
  setInterval(checkDrift, DRIFT_CHECK_MS);
}

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
