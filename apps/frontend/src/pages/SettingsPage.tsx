import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { EmailConnectionStatus } from "../types";

export function SettingsPage() {
  const [connections, setConnections] = useState<EmailConnectionStatus[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [searchParams] = useSearchParams();
  const gmailStatus = searchParams.get("gmail");

  function reload() {
    api.get<EmailConnectionStatus[]>("/ingestion/email/status").then(setConnections);
  }

  useEffect(reload, [gmailStatus]);

  async function handleConnect() {
    const { url } = await api.get<{ url: string }>("/ingestion/email/connect");
    window.location.href = url;
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await api.post("/ingestion/email/sync");
      reload();
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect(id: string) {
    await api.delete(`/ingestion/email/${id}`);
    reload();
  }

  return (
    <div className="settings-page">
      <h2>Email import</h2>
      {gmailStatus === "connected" && <p className="success-text">Gmail connected successfully.</p>}
      {gmailStatus === "error" && <p className="error-text">Couldn't connect Gmail — please try again.</p>}

      {connections.length === 0 ? (
        <button onClick={handleConnect}>Connect Gmail</button>
      ) : (
        <div>
          {connections.map((c) => (
            <div key={c.id} className="connection-row">
              <div>
                <strong>{c.email}</strong>
                <div className="transaction-meta">
                  {c.lastSyncedAt ? `Last synced ${new Date(c.lastSyncedAt).toLocaleString("en-IN")}` : "Not synced yet"}
                </div>
              </div>
              <button onClick={() => handleDisconnect(c.id)}>Disconnect</button>
            </div>
          ))}
          <button onClick={handleSync} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      )}

      <h2>SMS import</h2>
      <p>SMS auto-import is available in the Android mobile app. Install it and sign in with the same account to start capturing SMS transactions automatically.</p>
    </div>
  );
}
