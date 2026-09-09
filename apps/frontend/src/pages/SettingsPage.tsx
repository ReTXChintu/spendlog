import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { EmailConnectionStatus } from "../types";

export function SettingsPage() {
  const { user, logout } = useAuth();
  const [connections, setConnections] = useState<EmailConnectionStatus[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [apkAvailable, setApkAvailable] = useState<boolean | null>(null);
  const [searchParams] = useSearchParams();
  const gmailStatus = searchParams.get("gmail");

  const reload = useCallback(() => {
    api.get<EmailConnectionStatus[]>("/ingestion/email/status").then(setConnections).catch(() => setConnections([]));
  }, []);

  useEffect(reload, [reload, gmailStatus]);

  // The APK is published by CI, so a fresh deployment may not have one yet.
  useEffect(() => {
    fetch("/SpendLog.apk", { method: "HEAD" })
      .then((res) => setApkAvailable(res.ok))
      .catch(() => setApkAvailable(false));
  }, []);

  async function connect() {
    const { url } = await api.get<{ url: string }>("/ingestion/email/connect");
    window.location.href = url;
  }

  async function syncNow() {
    setSyncing(true);
    try {
      await api.post("/ingestion/email/sync");
      reload();
    } finally {
      setSyncing(false);
    }
  }

  async function disconnect(id: string) {
    await api.delete(`/ingestion/email/${id}`);
    reload();
  }

  const connection = connections[0];

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Settings</h1>
      </div>

      <div className="settings-grid">
        {apkAvailable === false ? (
          <div className="settings-banner">
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div className="settings-banner-icon">
                <Icon name="ic-phone" />
              </div>
              <div>
                <h3>Android app — build in progress</h3>
                <p>
                  No build has been published yet. Check back shortly, or continue with Gmail import in the
                  meantime.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="settings-banner">
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <div className="settings-banner-icon">
                <Icon name="ic-phone" />
              </div>
              <div>
                <h3>Get the Android app</h3>
                <p>
                  SMS import — catching bank and UPI texts the moment they arrive — only works from the Android
                  app. It's the only route to that data.
                </p>
              </div>
            </div>
            <div className="settings-banner-right">
              <a className="btn btn-primary" href="/SpendLog.apk" download>
                <Icon name="ic-download" /> Download APK
              </a>
              <span className="settings-banner-note">
                Android will warn about installing outside the Play Store — that's expected for a direct download.
              </span>
            </div>
          </div>
        )}

        <div className="card set-card">
          <div className="set-card-head">
            <div className="set-card-icon" style={{ background: "var(--brand-50)" }}>
              <Icon name="ic-mail" />
            </div>
            <div>
              <h4>Email import</h4>
              <p className="set-card-sub">Gmail, read-only</p>
            </div>
          </div>

          {gmailStatus === "connected" && <p className="desc">Gmail connected successfully.</p>}
          {gmailStatus === "denied" && (
            <p className="desc">Gmail access wasn't granted. Email import stays off until you allow it.</p>
          )}

          {connection ? (
            <>
              <p className="desc">
                <span className="status-pill status-on">
                  <Icon name="ic-check" />
                  Connected
                </span>
                &nbsp;{connection.email}
                <br />
                {connection.lastSyncedAt
                  ? `Last synced ${new Date(connection.lastSyncedAt).toLocaleString("en-IN")}.`
                  : "Not synced yet."}
              </p>
              <div className="set-card-actions">
                <button className="btn btn-sm" onClick={syncNow} disabled={syncing}>
                  <Icon name="ic-sync" />
                  {syncing ? "Syncing…" : "Sync now"}
                </button>
                <button className="btn btn-sm btn-ghost btn-danger-text" onClick={() => disconnect(connection.id)}>
                  Disconnect
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="desc">
                <span className="status-pill status-off">Not connected</span>
                <br />
                Email access was declined when you signed in. You can grant it here instead.
              </p>
              <div className="set-card-actions">
                <button className="btn btn-sm btn-primary" onClick={connect}>
                  Connect Gmail
                </button>
              </div>
            </>
          )}
        </div>

        <div className="card set-card">
          <div className="set-card-head">
            <div className="set-card-icon" style={{ background: "var(--brand-50)" }}>
              <Icon name="ic-message" />
            </div>
            <div>
              <h4>SMS import</h4>
              <p className="set-card-sub">Android only</p>
            </div>
          </div>
          <p className="desc">
            <span className="status-pill status-off">Not available here</span>
            <br />
            Reading text messages isn't something a browser is allowed to do. Install the Android app to capture
            SMS automatically.
          </p>
        </div>

        <div className="card set-card">
          <div className="set-card-head">
            <div className="set-card-icon" style={{ background: "var(--brand-50)" }}>
              <Icon name="ic-lock" />
            </div>
            <div>
              <h4>Account</h4>
              <p className="set-card-sub">{user?.email ?? ""}</p>
            </div>
          </div>
          <p className="desc">Signed in with Google. Signing out doesn't remove any imported transactions.</p>
          <div className="set-card-actions">
            <button className="btn btn-sm btn-ghost btn-danger-text" onClick={logout}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
