import { app } from "./app";
import { connectDatabase } from "./db";
import { env } from "./env";
import { syncAllConnectedEmails } from "./modules/ingestion/gmail.service";

const EMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;

async function start() {
  // Connect before listening so the first request can't race the database.
  await connectDatabase();
  console.log("Connected to MongoDB");

  app.listen(env.port, () => {
    console.log(`Backend listening on http://localhost:${env.port}`);
  });

  setInterval(() => {
    syncAllConnectedEmails().catch((err) => console.error("Background Gmail sync failed:", err));
  }, EMAIL_SYNC_INTERVAL_MS);
}

start().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
