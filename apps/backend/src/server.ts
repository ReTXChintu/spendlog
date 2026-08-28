import { app } from "./app";
import { env } from "./env";
import { syncAllConnectedEmails } from "./modules/ingestion/gmail.service";

const EMAIL_SYNC_INTERVAL_MS = 15 * 60 * 1000;

app.listen(env.port, () => {
  console.log(`Backend listening on http://localhost:${env.port}`);
});

setInterval(() => {
  syncAllConnectedEmails().catch((err) => console.error("Background Gmail sync failed:", err));
}, EMAIL_SYNC_INTERVAL_MS);
