import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AccountModal } from "../components/AccountModal";
import { AccountPanel } from "../components/AccountPanel";
import { BudgetEditor } from "../components/budget/BudgetEditor";
import { CommitmentModal } from "../components/CommitmentModal";
import { FamilyTab } from "../components/FamilyTab";
import { Icon } from "../components/Icon";
import { LedgerStartCard } from "../components/LedgerStartCard";
import { LoanModal } from "../components/LoanModal";
import { StatementShelf } from "../components/StatementShelf";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatMoney, formatMoneyShort } from "../lib/format";
import { ThemeChoice, onThemeChange, setStoredTheme, storedTheme } from "../lib/theme";
import { SecretInput } from "../components/SecretInput";
import {
  Account,
  AccountOverview,
  AiSettings,
  BudgetProfile,
  CardNetwork,
  Category,
  EmailConnectionStatus,
  FixedCommitment,
  Loan,
  MerchantPreset,
  MonthlyBudgetStatus,
  NETWORK_LABELS,
  SavingsBucket,
  accountLabel,
  commitmentAmountLabel,
} from "../types";

/** A stored network in the words a person would use for it. */
function networkLabel(raw: string | null): string | null {
  if (!raw) return null;
  const folded = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  return NETWORK_LABELS[folded as CardNetwork] ?? raw;
}

const TABS = [
  { id: "connections", label: "Connections", icon: "ic-mail" },
  { id: "accounts", label: "Accounts and cards", icon: "ic-wallet" },
  { id: "budget", label: "Budget", icon: "ic-calendar" },
  { id: "presets", label: "Presets", icon: "ic-bolt" },
  { id: "family", label: "Family", icon: "ic-people" },
  { id: "ai", label: "AI assistant", icon: "ic-spark" },
  { id: "you", label: "You", icon: "ic-lock" },
  { id: "about", label: "About", icon: "ic-info" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Settings, in tabs, each of which answers one question completely.
 *
 * It was five, and every one of them touched everything. Statements — the
 * paperwork of a particular card — sat under Connections because that is
 * where they are fetched from. "You" held a salary, a set of monthly
 * commitments, an email address and a logout button, which is a budget and
 * an identity in one drawer. The Android app was offered under Connections
 * and again under About.
 *
 * Now: where data comes from, what it lands in and the statements that
 * prove it, what is already spoken for each month, shortcuts for typing
 * things by hand, who you are, and what this app is. Nothing appears
 * twice, and nothing needs a second tab to finish.
 *
 * The tab lives in the query string so a link can point straight at one —
 * the dashboard sends you here to set a card's network.
 */
export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: TabId = TABS.some((candidate) => candidate.id === requested)
    ? (requested as TabId)
    : "connections";

  function selectTab(next: TabId) {
    // Replace rather than push: six tabs would otherwise fill the back
    // button with places nobody meant to travel through.
    setSearchParams(next === "connections" ? {} : { tab: next }, { replace: true });
  }

  // Accounts, Budget and Family have places of their own in the sidebar, so
  // they read as pages of their own: their own title, no settings list
  // beside them. The rest share the settings list on the left.
  const standalone = STANDALONE[tab as keyof typeof STANDALONE];

  if (standalone) {
    return (
      <section className="screen settings-screen">
        <div className="screen-header">
          <h1 className="screen-title">{standalone.title}</h1>
          <span className="screen-header-note">{standalone.note}</span>
        </div>
        {tab === "accounts" && <AccountsTab />}
        {tab === "budget" && <BudgetTab />}
        {tab === "family" && <FamilyTab />}
      </section>
    );
  }

  const current = TABS.find((candidate) => candidate.id === tab)!;

  return (
    <section className="screen settings-screen">
      <div className="screen-header">
        <h1 className="screen-title">Settings</h1>
      </div>

      <div className="settings-layout">
        <SettingsNav tab={tab} onSelect={selectTab} />

        <div className="settings-pane">
          <div className="settings-pane-head">
            <h2 className="section-title">{current.label}</h2>
            <p className="settings-pane-sub">{SECTION_SUB[tab]}</p>
          </div>
          {tab === "connections" && <ConnectionsTab />}
          {tab === "presets" && <PresetsTab />}
          {tab === "ai" && <AiTab />}
          {tab === "you" && <YouTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </section>
  );
}

const STANDALONE = {
  accounts: { title: "Accounts & cards", note: "Every account, its passbook and its statements" },
  budget: { title: "Budget", note: "Pay day, the monthly budget, fixed costs and loans" },
  family: { title: "Family", note: "Kids' logins for the phone app" },
} as const;

/** The one line under each section's heading. */
const SECTION_SUB: Record<TabId, string> = {
  connections: "Where SpendLog reads your payments from.",
  accounts: "",
  budget: "",
  presets: "Shortcuts for the payments you type in by hand.",
  family: "",
  ai: "Ask AI and daily insights use your own Gemini key.",
  you: "Who you're signed in as, and how this browser looks.",
  about: "What this app is, and what it can and can't know.",
};

/** The second line of each entry in the settings list. */
const NAV_SUB: Partial<Record<TabId, string>> = {
  you: "Account and appearance",
  connections: "Gmail and the phone app",
  presets: "Merchant shortcuts",
  ai: "Gemini key and model",
  about: `SpendLog ${__APP_VERSION__}`,
};

/** The settings list: who you are on top, then each section, then Sign out. */
function SettingsNav({ tab, onSelect }: { tab: TabId; onSelect: (next: TabId) => void }) {
  const { user, logout } = useAuth();
  const order: TabId[] = ["you", "connections", "presets", "ai", "about"];
  const name = user?.name?.trim() || user?.email?.split("@")[0] || "You";
  const initials = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

  return (
    <nav className="card settings-nav" aria-label="Settings">
      <div className="settings-nav-profile">
        <span className="avatar lg" aria-hidden="true">
          {initials || "?"}
        </span>
        <div className="settings-nav-who">
          <span className="settings-nav-name">{name}</span>
          <span className="settings-nav-email">{user?.email ?? ""}</span>
        </div>
      </div>

      <div className="settings-nav-list" role="tablist" aria-orientation="vertical">
        {order.map((id) => {
          const entry = TABS.find((candidate) => candidate.id === id)!;
          return (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`settings-nav-item${tab === id ? " on" : ""}`}
              onClick={() => onSelect(id)}
            >
              <span className="settings-nav-title">{entry.label}</span>
              <span className="settings-nav-sub">{NAV_SUB[id]}</span>
            </button>
          );
        })}
      </div>

      <button className="btn btn-danger-text btn-block settings-nav-signout" onClick={logout}>
        Sign out
      </button>
      <p className="settings-nav-foot">SpendLog {__APP_VERSION__}</p>
    </nav>
  );
}

/** Where the data comes from: Gmail, SMS, and the statements in the inbox. */
function ConnectionsTab() {
  const [connections, setConnections] = useState<EmailConnectionStatus[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [apkAvailable, setApkAvailable] = useState<boolean | null>(null);
  const [searchParams] = useSearchParams();
  const gmailStatus = searchParams.get("gmail");

  const reload = useCallback(() => {
    api
      // Checked with Google, so this never says "Connected" about a mailbox
      // that can no longer be read.
      .get<EmailConnectionStatus[]>("/ingestion/email/status?check=1")
      .then(setConnections)
      .catch(() => setConnections([]));
  }, []);

  useEffect(reload, [reload, gmailStatus]);
  useEffect(() => {
    api.get<Account[]>("/accounts").then(setAccounts).catch(() => setAccounts([]));
  }, []);

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
    setSyncError(null);
    try {
      await api.post("/ingestion/email/sync");
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Couldn't sync just now.");
    } finally {
      setSyncing(false);
      reload();
    }
  }

  const connection = connections[0];

  const stopped = Boolean(connection?.needsReconnect);

  return (
    <div className="settings-grid">
      {gmailStatus === "connected" && (
        <p className="callout callout-good set-card-wide">
          <Icon name="ic-check" />
          <span>Gmail connected successfully.</span>
        </p>
      )}
      {gmailStatus === "denied" && (
        <p className="callout callout-warn set-card-wide">
          <Icon name="ic-alert" />
          <span>Gmail access wasn't granted. Email import stays off until you allow it.</span>
        </p>
      )}

      <div className="card set-card conn-card">
        <div className="set-card-head">
          <div className="set-card-icon tile-good">
            <Icon name="ic-message" />
          </div>
          <div className="set-card-titles">
            <h4>Bank SMS</h4>
            <p className="set-card-sub">Read on your Android phone — never OTPs or chats</p>
          </div>
          <span className="badge badge-neutral">Phone only</span>
        </div>
        <p className="desc">
          Reading text messages isn't something a browser is allowed to do, and most Indian banks only
          text. The Android app is the only route to that data.
        </p>
        {apkAvailable === false ? (
          <p className="callout callout-neutral">
            <Icon name="ic-info" />
            <span>No build has been published yet. Gmail import works in the meantime.</span>
          </p>
        ) : (
          <>
            <div className="set-card-actions">
              <a className="btn" href="/SpendLog.apk" download>
                <Icon name="ic-download" /> Download the Android app
              </a>
            </div>
            <p className="field-hint">
              Android warns about installing outside the Play Store — expected for a direct download.
            </p>
          </>
        )}
      </div>

      <div className={`card set-card conn-card${stopped ? " is-crit" : ""}`}>
        <div className="set-card-head">
          <div className={`set-card-icon ${stopped ? "tile-on-tint conn-icon-crit" : connection ? "tile-good" : ""}`}>
            <Icon name="ic-mail" />
          </div>
          <div className="set-card-titles">
            <h4>{stopped ? "Google stopped letting SpendLog read your mail" : "Gmail"}</h4>
            <p className="set-card-sub">{connection?.email ?? "Read-only — bank alerts and statements"}</p>
          </div>
          {stopped ? (
            <span className="badge badge-on-tint conn-badge-crit">
              <Icon name="ic-alert" /> Stopped
            </span>
          ) : connection ? (
            <span className="badge badge-good">
              <Icon name="ic-check" /> Connected
            </span>
          ) : (
            <span className="badge badge-neutral">Not connected</span>
          )}
        </div>

        {stopped ? (
          <>
            <p className="desc">
              Google stopped letting SpendLog read this mailbox, so it has been unlinked. Nothing already
              imported is lost — connect it again to carry on reading new emails and statements.
            </p>
            <div className="set-card-actions conn-actions">
              <button className="btn btn-lg btn-primary" onClick={connect}>
                <Icon name="ic-refresh" /> Reconnect Gmail
              </button>
            </div>
          </>
        ) : connection ? (
          <>
            <div className="conn-stats">
              <div>
                <span className="kpi-label">Last synced</span>
                <span className="kpi-value num">
                  {connection.lastSyncedAt
                    ? new Date(connection.lastSyncedAt).toLocaleString("en-IN", {
                        day: "numeric",
                        month: "short",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "Not yet"}
                </span>
              </div>
            </div>
            <div className="set-card-actions conn-actions">
              <button className="btn" onClick={syncNow} disabled={syncing}>
                <Icon name="ic-sync" />
                {syncing ? "Syncing…" : "Sync now"}
              </button>
              <button
                className="btn btn-ghost btn-danger-text"
                onClick={async () => {
                  await api.delete(`/ingestion/email/${connection.id}`);
                  reload();
                }}
              >
                Disconnect
              </button>
            </div>
            {syncError && <p className="form-error">{syncError}</p>}
          </>
        ) : (
          <>
            <p className="desc">
              Connect a Gmail account to pick up bank alerts and statements from email. SpendLog only ever reads
              it.
            </p>
            <div className="set-card-actions conn-actions">
              <button className="btn btn-primary" onClick={connect}>
                <Icon name="ic-mail" /> Connect Gmail
              </button>
            </div>
          </>
        )}
      </div>

      <LedgerStartCard />
    </div>
  );
}

/** The group the server files a statement under when it has no account. */
const UNFILED = "unfiled";

/**
 * Every account, one at a time.
 *
 * A single list of accounts told you almost nothing about any of them: to
 * find out where a card stood you opened a modal, and to find its
 * statements you went to a different tab. So each account gets a tab of
 * its own, and under it everything that belongs to it - what it is, where
 * it stands this cycle, when it bills, its stored details, and its
 * statements.
 *
 * The tab list is a rail on a wide screen and a scrolling strip on a
 * narrow one. Which account is selected lives in the query string, so the
 * dashboard can send you straight at one.
 */
function AccountsTab() {
  const [accounts, setAccounts] = useState<AccountOverview[]>([]);
  const [editing, setEditing] = useState<{ account: Account | null } | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [loaded, setLoaded] = useState(false);
  const [unfiled, setUnfiled] = useState(0);

  // Reading statements lives here, beside the cards they get filed under,
  // rather than in Connections beside the mailbox they arrive through. It
  // was there, and the result was that you pressed the button in one tab
  // and went to another to see what it did - which is the one thing a tab
  // should never ask of you.
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .get<AccountOverview[]>("/accounts/overview")
      .then(setAccounts)
      .catch(() => setAccounts([]))
      .finally(() => setLoaded(true));

    // How many statements have no account. Asked here rather than inside
    // the shelf because the tab that leads to them lives out here.
    api
      .get<{ accountId: string; months: { statements: unknown[] }[] }[]>("/statements/filed")
      .then((groups) => {
        const orphans = groups.find((group) => group.accountId === UNFILED);
        setUnfiled(
          orphans?.months.reduce((sum, month) => sum + month.statements.length, 0) ?? 0,
        );
      })
      .catch(() => setUnfiled(0));
  }, []);

  useEffect(reload, [reload]);

  async function scanStatements() {
    setScanning(true);
    setScanResult(null);
    try {
      const result = await api.post<{
        scanned: number;
        read: number;
        locked: number;
        unidentified: number;
        added: number;
        needsReconnect?: string[];
      }>("/statements/sync");

      const skipped = result.needsReconnect?.length
        ? ` ${result.needsReconnect.join(", ")} needs reconnecting under Connections.`
        : "";
      setScanResult(
        (result.scanned === 0
          ? "No statements found in the mailbox."
          : `Read ${result.read} of ${result.scanned}. ${result.added} transactions added` +
            `${result.locked > 0 ? `, ${result.locked} still locked` : ""}` +
            `${result.unidentified > 0 ? `, ${result.unidentified} on an unknown card` : ""}.`) + skipped
      );
      reload();
    } catch (error) {
      setScanResult(error instanceof Error ? error.message : "That didn't work.");
    } finally {
      setScanning(false);
    }
  }

  const wanted = searchParams.get("account");
  const showingUnfiled = wanted === UNFILED;
  const selected = showingUnfiled
    ? null
    : (accounts.find((account) => account.id === wanted) ?? accounts[0] ?? null);

  function select(accountId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "accounts");
    next.set("account", accountId);
    setSearchParams(next, { replace: true });
  }

  const missingNetwork = accounts.filter(
    (account) =>
      (account.accountType === "CARD" || account.accountType === "DEBIT") &&
      account.isActive &&
      !account.cardNetwork
  );

  if (loaded && accounts.length === 0) {
    return (
      <div className="settings-grid">
        <div className="card set-card set-card-wide">
          <div className="set-card-head">
            <div className="set-card-icon">
              <Icon name="ic-wallet" />
            </div>
            <div>
              <h4>Accounts and cards</h4>
              <p className="set-card-sub">None yet</p>
            </div>
          </div>
          <p className="desc">
            These appear on their own the first time a bank texts you. Add one by hand for anything
            that doesn&apos;t — cash, or an account that never sends alerts.
          </p>
          <div className="set-card-actions">
            <button className="btn btn-sm btn-primary" onClick={() => setEditing({ account: null })}>
              <Icon name="ic-plus" /> Add an account
            </button>
            <button className="btn btn-sm" onClick={scanStatements} disabled={scanning}>
              <Icon name="ic-sync" /> {scanning ? "Reading…" : "Read statements"}
            </button>
          </div>
          {scanResult && <p className="field-hint">{scanResult}</p>}
        </div>

        {editing && (
          <AccountModal
            account={editing.account}
            accounts={accounts}
            onSaved={() => {
              setEditing(null);
              reload();
            }}
            onClose={() => setEditing(null)}
          />
        )}
      </div>
    );
  }

  const groups = [
    {
      label: "Banks & cash",
      items: accounts.filter((account) => account.accountType !== "CARD" && !account.pocketMoney),
    },
    { label: "Credit cards", items: accounts.filter((account) => account.accountType === "CARD") },
    {
      label: "Pocket money",
      items: accounts.filter((account) => account.accountType !== "CARD" && account.pocketMoney),
    },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="accounts-layout">
      <aside className="card accounts-list" aria-label="Accounts">
        <div className="card-head accounts-list-head">
          <h2>All accounts</h2>
          <span className="spacer" />
          <button className="btn btn-sm btn-primary" onClick={() => setEditing({ account: null })}>
            <Icon name="ic-plus" /> Add
          </button>
        </div>

        {!loaded && (
          <div aria-busy="true">
            <p className="skel-caption">Loading your accounts…</p>
            {[0, 1, 2, 3].map((row) => (
              <div className="skel-row" key={row}>
                <span className="skel skel-circle" />
                <span>
                  <span className="skel skel-line" style={{ width: "62%", marginBottom: 6 }} />
                  <span className="skel skel-line sm" style={{ width: "40%" }} />
                </span>
                <span className="skel skel-line" />
              </div>
            ))}
          </div>
        )}

        <div className="accounts-rail" role="tablist" aria-label="Accounts" aria-orientation="vertical">
          {groups.map((group) => (
            <div className="accounts-group" key={group.label}>
              <p className="accounts-group-label">{group.label}</p>
              {group.items.map((account) => (
                <AccountListRow
                  key={account.id}
                  account={account}
                  selected={selected?.id === account.id}
                  onSelect={() => select(account.id)}
                />
              ))}
            </div>
          ))}

          {/* Last, and only while there is something in it: the statements
              no account could be found for. A to-do list rather than a
              place, so it says how long it is. */}
          {unfiled > 0 && (
            <div className="accounts-group">
              <p className="accounts-group-label">To sort out</p>
              <button
                role="tab"
                aria-selected={showingUnfiled}
                className={`account-tab is-unfiled${showingUnfiled ? " on" : ""}`}
                onClick={() => select(UNFILED)}
              >
                <span className="icon-tile sm tile-warn">
                  <Icon name="ic-question" />
                </span>
                <span className="account-tab-main">
                  <span className="account-tab-name">Not on an account</span>
                  <span className="account-tab-sub">
                    {unfiled} statement{unfiled === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            </div>
          )}
        </div>

        {/* The one action that changes what is under every card, beside
            the cards, so what it finds is one scroll away rather than one
            tab away. */}
        <div className="accounts-toolbar">
          <button className="btn btn-block" onClick={scanStatements} disabled={scanning}>
            <Icon name="ic-sync" /> {scanning ? "Reading…" : "Read statements"}
          </button>
          <span className="accounts-toolbar-note">
            {scanResult ?? "Reads the monthly PDFs from your mailbox and files each under its card."}
          </span>
        </div>
      </aside>

      <div className="accounts-body">
        {missingNetwork.length > 0 && (
          <p className="callout callout-warn">
            <Icon name="ic-alert" />
            <span>
              {missingNetwork.length === 1
                ? `${accountLabel(missingNetwork[0])} has no network set, so it never gets suggested at a till.`
                : `${missingNetwork.length} cards have no network set, so they never get suggested at a till.`}
            </span>
          </p>
        )}

        {showingUnfiled ? (
          <p className="callout callout-info">
            <Icon name="ic-info" />
            <span>
              These were read but no account could be matched to what was printed inside. Point each
              one at the account it belongs to, or forget it.
            </span>
          </p>
        ) : (
          selected && (
            <AccountPanel
              key={selected.id}
              account={selected}
              onEdit={() => setEditing({ account: selected })}
              onDeleted={() => {
                setSearchParams({ tab: "accounts" }, { replace: true });
                reload();
              }}
              onChanged={reload}
            />
          )
        )}

        {/* A card's statements are that card's paperwork, so they live with
            it rather than under the mailbox they arrived through. */}
        {(showingUnfiled || selected?.accountType !== "DEBIT") && (
          <StatementShelf
            accounts={accounts}
            onChanged={reload}
            focusAccountId={showingUnfiled ? UNFILED : (selected?.id ?? null)}
          />
        )}
      </div>

      {editing && (
        <AccountModal
          account={editing.account}
          accounts={accounts}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/** Two letters for an account's monogram, from its own name. */
function accountInitials(account: AccountOverview): string {
  if (account.accountType === "CASH") return "₹";
  const words = (account.nickname || account.bankName).split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

/**
 * One account in the list: its name, what it is, and the one figure that
 * says where it stands — what a card owes against its limit, what a bank
 * account should hold, or else what it spent this month.
 */
function AccountListRow({
  account,
  selected,
  onSelect,
}: {
  account: AccountOverview;
  selected: boolean;
  onSelect: () => void;
}) {
  const cycle = account.cycle;
  const isCard = account.accountType === "CARD";
  const owed = isCard && cycle?.cycleKnown ? (cycle.usedMinor ?? cycle.outstandingMinor) : null;
  const limit = cycle?.creditLimitMinor ?? null;
  const share = owed != null && limit && limit > 0 ? Math.min(1, owed / limit) : null;
  const state = cycle?.state ?? "unset";

  let figure: string;
  let figureNote: string | null = null;
  if (owed != null) {
    figure = formatMoneyShort(owed);
  } else if (account.balance) {
    figure = formatMoney(account.balance.expectedMinor);
    figureNote = "should hold";
  } else {
    figure = formatMoneyShort(account.month?.spentMinor ?? 0);
    figureNote = "this month";
  }

  const sub = [
    account.accountType === "CARD"
      ? "Credit card"
      : account.accountType === "DEBIT"
        ? "Debit card"
        : account.accountType === "BANK"
          ? account.isSavings
            ? "Savings"
            : "Bank account"
          : account.accountType === "CASH"
            ? "Cash"
            : "UPI",
    networkLabel(account.cardNetwork),
    account.pocketMoney?.holder ?? null,
    account.isActive ? null : "closed",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      role="tab"
      aria-selected={selected}
      className={`account-tab${selected ? " on" : ""}${account.isActive ? "" : " is-closed"}`}
      onClick={onSelect}
    >
      <span className="monogram">{accountInitials(account)}</span>
      <span className="account-tab-main">
        <span className="account-tab-top">
          <span className="account-tab-name">
            {account.nickname || account.bankName}
            {account.last4 && <span className="account-tab-last4"> ••{account.last4}</span>}
          </span>
          <span className="account-tab-figure num">{figure}</span>
        </span>
        <span className="account-tab-sub">
          {sub}
          {figureNote && <> · {figureNote}</>}
        </span>
        {share != null && (
          <span className="meter account-tab-meter" aria-hidden="true">
            <span
              className={`meter-fill ${state === "over" ? "is-crit" : state === "close" ? "is-warn" : "is-good"}`}
              style={{ width: `${Math.round(share * 100)}%`, display: "block" }}
            />
          </span>
        )}
        {(share != null || account.bill) && (
          <span className="account-tab-badges">
            {share != null && (
              <span className={`account-tab-caption${state === "over" ? " is-crit" : ""}`}>
                {Math.round(share * 100)}% of {formatMoneyShort(limit!)}
              </span>
            )}
            {account.bill &&
              (account.bill.isPaid ? (
                <span className="badge badge-good">
                  <Icon name="ic-check" /> Bill paid
                </span>
              ) : account.bill.daysUntilDue != null && account.bill.daysUntilDue >= 0 ? (
                <span className="badge badge-warn">
                  {formatMoneyShort(account.bill.totalDueMinor)} due in {account.bill.daysUntilDue}{" "}
                  {account.bill.daysUntilDue === 1 ? "day" : "days"}
                </span>
              ) : account.bill.daysUntilDue != null ? (
                <span className="badge badge-crit">
                  {formatMoneyShort(account.bill.totalDueMinor)} overdue
                </span>
              ) : null)}
          </span>
        )}
      </span>
    </button>
  );
}

/** The merchant shortcuts, so a payment entered by hand takes one tap. */
function PresetsTab() {
  const [presets, setPresets] = useState<MerchantPreset[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [merchant, setMerchant] = useState("");
  const [categoryId, setCategoryId] = useState("");

  const reload = useCallback(() => {
    api.get<MerchantPreset[]>("/merchant-presets").then(setPresets).catch(() => setPresets([]));
  }, []);

  useEffect(reload, [reload]);
  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories).catch(() => setCategories([]));
  }, []);

  async function add() {
    if (!merchant.trim()) return;
    await api.post("/merchant-presets", {
      merchant: merchant.trim(),
      categoryId: categoryId || null,
    });
    setMerchant("");
    setCategoryId("");
    reload();
  }

  return (
    <div className="settings-grid">
      <div className="card set-card set-card-wide">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-bolt" />
          </div>
          <div>
            <h4>Merchant presets</h4>
            <p className="set-card-sub">A name and the category it usually belongs to</p>
          </div>
        </div>

        <p className="desc">
          These appear under the merchant field when you add or edit a payment. Picking one fills in both,
          which is most of the typing gone.
        </p>

        <div className="budget-setup">
          <input
            className="filter-input"
            placeholder="Merchant name"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <select className="filter-input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <button className="btn btn-sm btn-primary" onClick={add} disabled={!merchant.trim()}>
            Add
          </button>
        </div>

        {presets.length > 0 && (
          <div className="preset-list">
            {presets.map((preset) => (
              <span className="preset-chip" key={preset.id}>
                {preset.merchant}
                {preset.category && <em>{preset.category.name}</em>}
                <button
                  className="preset-remove"
                  title={`Remove ${preset.merchant}`}
                  onClick={async () => {
                    await api.delete(`/merchant-presets/${preset.id}`);
                    reload();
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What is already spoken for each month: pay in, and the fixed payments
 * out. Together these are what the dashboard paces a month against, and
 * they used to sit in the same drawer as the sign-out button.
 */
function BudgetTab() {
  const [profile, setProfile] = useState<BudgetProfile | null>(null);
  const [salary, setSalary] = useState("");
  const [salaryDay, setSalaryDay] = useState("");
  const [saved, setSaved] = useState(false);

  const [budget, setBudget] = useState<MonthlyBudgetStatus | null>(null);
  const [bucket, setBucket] = useState<SavingsBucket | null>(null);
  const [editingBudget, setEditingBudget] = useState(false);

  const [commitments, setCommitments] = useState<FixedCommitment[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editingCommitment, setEditingCommitment] = useState<{ commitment: FixedCommitment | null } | null>(
    null
  );

  const [loans, setLoans] = useState<Loan[]>([]);
  const [editingLoan, setEditingLoan] = useState<{ loan: Loan | null } | null>(null);

  const reloadCommitments = useCallback(() => {
    api.get<FixedCommitment[]>("/budget/commitments").then(setCommitments).catch(() => setCommitments([]));
  }, []);

  const reloadLoans = useCallback(() => {
    api.get<Loan[]>("/loans").then(setLoans).catch(() => setLoans([]));
  }, []);

  const reloadBudget = useCallback(() => {
    api.get<MonthlyBudgetStatus>("/budget/monthly").then(setBudget).catch(() => setBudget(null));
    api.get<SavingsBucket>("/budget/bucket").then(setBucket).catch(() => setBucket(null));
  }, []);

  useEffect(reloadCommitments, [reloadCommitments]);
  useEffect(reloadLoans, [reloadLoans]);
  useEffect(reloadBudget, [reloadBudget]);
  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    api
      .get<BudgetProfile>("/budget/profile")
      .then((next) => {
        setProfile(next);
        if (next.salaryAmountMinor) setSalary((next.salaryAmountMinor / 100).toFixed(0));
        if (next.salaryDay) setSalaryDay(String(next.salaryDay));
      })
      .catch(() => setProfile(null));
  }, []);

  async function save() {
    const rupees = Number.parseFloat(salary);
    const next = await api.patch<BudgetProfile>("/budget/profile", {
      salaryAmountMinor: Number.isFinite(rupees) ? Math.round(rupees * 100) : null,
      salaryDay: Number.parseInt(salaryDay, 10) || null,
    });
    setProfile(next);
    // A new pay day moves where the month starts and ends.
    reloadBudget();
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="settings-grid settings-budget">
      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-banknote" />
          </div>
          <div>
            <h4>What lands each month</h4>
            <p className="set-card-sub">
              {profile?.salaryAmountMinor
                ? `${formatMoneyShort(profile.salaryAmountMinor)} on the ${profile.salaryDay}th`
                : "Not set"}
            </p>
          </div>
        </div>

        <p className="desc">
          Your month runs from pay day to the day before the next, and the budget, the ledger and Analytics
          all go by it. Without a pay day, a month is simply the calendar month.
        </p>

        <div className="budget-setup">
          <label className="field">
            <span>Salary (₹)</span>
            <input
              className="filter-input"
              inputMode="decimal"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="100000"
            />
          </label>
          <label className="field">
            <span>Paid on</span>
            <input
              className="filter-input"
              inputMode="numeric"
              value={salaryDay}
              onChange={(e) => setSalaryDay(e.target.value)}
              placeholder="15"
            />
          </label>
          <button className="btn btn-sm btn-primary" onClick={save}>
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>

      <MonthlyBudgetSettings budget={budget} bucket={bucket} onEdit={() => setEditingBudget(true)} />

      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-calendar" />
          </div>
          <div>
            <h4>Fixed each month</h4>
            <p className="set-card-sub">
              {commitments.length === 0
                ? "None yet"
                : `${formatMoneyShort(commitments.reduce((sum, c) => sum + c.amountMinor, 0))} a month`}
            </p>
          </div>
        </div>

        <p className="desc">
          Rent, a SIP, insurance — anything that goes out every month whatever else happens. They count
          against the monthly budget like everything else, and until one has gone out the budget keeps its
          amount aside, so the safe-a-day figure is what is actually free.
        </p>

        {commitments.length > 0 && (
          <div className="item-list">
            {commitments.map((commitment) => (
              <button
                className="item-row"
                key={commitment.id}
                onClick={() => setEditingCommitment({ commitment })}
              >
                <span className="icon-tile sm tile-neutral">
                  <Icon name="ic-calendar" />
                </span>
                <span className="item-row-main">
                  <span className="item-row-name">{commitment.name}</span>
                  <span className="item-row-sub">
                    {[
                      `${commitmentAmountLabel(commitment, formatMoneyShort)} on the ${commitment.dayOfMonth}${ordinal(
                        commitment.dayOfMonth
                      )}`,
                      commitment.merchant,
                      typeof commitment.categoryId === "object" ? commitment.categoryId?.name : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="item-row-action">Edit</span>
              </button>
            ))}
          </div>
        )}

        <div className="set-card-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-sm" onClick={() => setEditingCommitment({ commitment: null })}>
            <Icon name="ic-plus" /> Add a fixed cost
          </button>
        </div>
        <p className="field-hint" style={{ marginTop: 8 }}>
          Tick one off on the dashboard when it has actually gone out.
        </p>
      </div>

      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-wallet" />
          </div>
          <div>
            <h4>Loans</h4>
            <p className="set-card-sub">
              {loans.filter((loan) => loan.status === "ACTIVE").length === 0
                ? "None yet"
                : `${formatMoneyShort(
                    loans
                      .filter((loan) => loan.status === "ACTIVE")
                      .reduce((sum, loan) => sum + loan.monthlyAmountMinor, 0)
                  )} a month`}
            </p>
          </div>
        </div>

        <p className="desc">
          A bank's personal loan, an employer advance, money from a relative — anything with a fixed
          term and a monthly repayment. Mark a payment against one from the transaction it shows up
          as, or from here if it never produced a message to match.
        </p>

        {loans.length > 0 && (
          <div className="item-list">
            {loans.map((loan) => (
              <button className="item-row" key={loan.id} onClick={() => setEditingLoan({ loan })}>
                <span className="icon-tile sm tile-neutral">
                  <Icon name="ic-wallet" />
                </span>
                <span className="item-row-main">
                  <span className="item-row-name">{loan.label}</span>
                  <span className="item-row-sub">
                    {loan.status !== "ACTIVE"
                      ? loan.status === "CLOSED"
                        ? "Closed"
                        : "Cancelled"
                      : `${formatMoneyShort(loan.monthlyAmountMinor)} a month · ${loan.paidCount} of ${loan.months} paid · ${formatMoneyShort(loan.remainingMinor)} left`}
                  </span>
                </span>
                <span className="item-row-action">Edit</span>
              </button>
            ))}
          </div>
        )}

        <div className="set-card-actions" style={{ marginTop: 12 }}>
          <button className="btn btn-sm" onClick={() => setEditingLoan({ loan: null })}>
            <Icon name="ic-plus" /> Add a loan
          </button>
        </div>
      </div>

      {editingCommitment && (
        <CommitmentModal
          commitment={editingCommitment.commitment}
          categories={categories}
          onSaved={() => {
            setEditingCommitment(null);
            reloadCommitments();
          }}
          onClose={() => setEditingCommitment(null)}
        />
      )}

      {editingLoan && (
        <LoanModal
          loan={editingLoan.loan}
          onSaved={() => {
            setEditingLoan(null);
            reloadLoans();
          }}
          onClose={() => setEditingLoan(null)}
        />
      )}

      {editingBudget && (
        <BudgetEditor
          status={budget}
          onSaved={(next) => {
            setEditingBudget(false);
            setBudget(next);
            reloadBudget();
          }}
          onClose={() => setEditingBudget(false)}
        />
      )}
    </div>
  );
}

/**
 * The monthly budget, its category limits, and the savings bucket its
 * leftovers have filled, month by month. Changed in the same editor the
 * dashboard opens.
 */
function MonthlyBudgetSettings({
  budget,
  bucket,
  onEdit,
}: {
  budget: MonthlyBudgetStatus | null;
  bucket: SavingsBucket | null;
  onEdit: () => void;
}) {
  const set = budget?.configured && budget.budgetMinor !== null;
  const months = bucket?.configured ? bucket.months.slice(0, 6) : [];

  return (
    <div className="card set-card set-card-wide">
      <div className="set-card-head">
        <div className="set-card-icon">
          <Icon name="ic-trend" />
        </div>
        <div>
          <h4>Monthly budget</h4>
          <p className="set-card-sub">
            {set
              ? `${formatMoneyShort(budget!.budgetMinor!)} a month${
                  budget!.categories.length > 0
                    ? ` · ${budget!.categories.length} category ${budget!.categories.length === 1 ? "limit" : "limits"}`
                    : ""
                }`
              : "Not set"}
          </p>
        </div>
      </div>

      <p className="desc">
        One amount for the month, and everything counts against it — rent, EMIs, SIPs and the day to day.
        Categories can be given a share of it; the shares never add up to more than the whole. Whatever is
        left when the month ends goes into the savings bucket below.
      </p>

      {set && budget!.categories.length > 0 && (
        <ul className="budget-summary-limits">
          {budget!.categories.map((category) => (
            <li key={category.categoryId}>
              {category.name} <b>{formatMoneyShort(category.limitMinor)}</b>
            </li>
          ))}
          {budget!.unassigned && (
            <li>
              Everything else <b>{formatMoneyShort(budget!.unassigned.amountMinor)}</b>
            </li>
          )}
        </ul>
      )}

      {bucket?.configured && (
        <>
          <div className="settings-bucket-title">
            Savings bucket · {formatMoneyShort(bucket.balanceMinor)}
            {bucket.balanceIfMonthEndedNowMinor !== bucket.balanceMinor &&
              ` · ${formatMoneyShort(bucket.balanceIfMonthEndedNowMinor)} if this month ended now`}
          </div>
          <ul className="bucket-months">
            {months.map((month) => (
              <li className="bucket-month" key={month.key}>
                <div className="bucket-month-top">
                  <span>{month.label}</span>
                  <span className={month.toBucketMinor < 0 ? "is-down" : "is-up"}>
                    {month.toBucketMinor < 0 ? "−" : "+"}
                    {formatMoneyShort(Math.abs(month.toBucketMinor))}
                  </span>
                </div>
                <span className="bucket-month-sub">
                  {formatMoneyShort(month.spentMinor)} of {formatMoneyShort(month.budgetMinor)}
                  {month.era === "daily" ? " · on the old daily budget" : ""}
                  {month.settled ? "" : " · still running"}
                </span>
              </li>
            ))}
          </ul>
          {bucket.openingFromDailyMinor !== 0 && (
            <p className="field-hint" style={{ marginBottom: 12 }}>
              Includes {formatMoneyShort(bucket.openingFromDailyMinor)} carried over from the old daily budget.
            </p>
          )}
        </>
      )}

      <div className="set-card-actions">
        <button className={`btn btn-sm${set ? "" : " btn-primary"}`} onClick={onEdit}>
          <Icon name={set ? "ic-pencil" : "ic-plus"} /> {set ? "Edit budget" : "Set a budget"}
        </button>
      </div>
    </div>
  );
}

/**
 * The assistant's key and model.
 *
 * The key is the user's own, so the quota and the bill are theirs too -
 * SpendLog only forwards. Once saved it never comes back to the browser;
 * this screen only ever knows its last four characters.
 */
function AiTab() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadModels = useCallback(() => {
    api
      .get<{ id: string; name: string }[]>("/ai/models")
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

  useEffect(() => {
    api
      .get<AiSettings>("/ai/settings")
      .then((next) => {
        setSettings(next);
        if (next.hasKey) loadModels();
      })
      .catch(() => setError("Couldn't load the assistant's settings."));
  }, [loadModels]);

  async function save(body: { apiKey?: string | null; model?: string | null }, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api.put<AiSettings>("/ai/settings", body);
      setSettings(next);
      setKey("");
      setNotice(done);
      if (next.hasKey) loadModels();
      else setModels([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return <div className="settings-grid">{error && <p className="form-error">{error}</p>}</div>;
  }

  return (
    <div className="settings-grid">
      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-spark" />
          </div>
          <div className="set-card-titles">
            <h4>AI</h4>
            <p className="set-card-sub">Your own Gemini key, stored encrypted</p>
          </div>
        </div>

        {settings.hasKey ? (
          <span className="badge badge-good ai-key-badge">
            <Icon name="ic-check" /> Key saved · ends in {settings.keyHint}
          </span>
        ) : (
          <span className="badge badge-neutral ai-key-badge">No key yet</span>
        )}

        <p className="desc">
          Ask questions like “how much did I spend on eating out this month?” and get answers from your own
          transactions. Get a free key from{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            Google AI Studio
          </a>
          . Your question and the figures needed to answer it are sent to Google with your key; the key is
          stored encrypted and never shown again.
        </p>

        {!settings.canStoreKey ? (
          <p className="field-hint">
            This server has no encryption key set, so it can't store an API key yet.
          </p>
        ) : (
          <form
            className="budget-setup ai-key-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (key.trim()) save({ apiKey: key.trim() }, "Key saved.");
            }}
          >
            <label className="field ai-key-field">
              <span>{settings.hasKey ? "Replace with a new Gemini API key" : "Gemini API key"}</span>
              <SecretInput
                noun="key"
                className="filter-input input-lg"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="AIza…"
              />
            </label>
            <button className="btn btn-lg btn-primary" type="submit" disabled={busy || !key.trim()}>
              {busy ? "Checking…" : "Save key"}
            </button>
            {settings.hasKey && (
              <button
                className="btn btn-lg btn-danger-text"
                type="button"
                disabled={busy}
                onClick={() => save({ apiKey: null }, "Key removed.")}
              >
                Remove
              </button>
            )}
          </form>
        )}

        {error && <p className="form-error">{error}</p>}
        {notice && !error && <p className="field-hint">{notice}</p>}
      </div>

      {settings.hasKey && (
        <div className="card set-card">
          <div className="set-card-head">
            <div className="set-card-icon">
              <Icon name="ic-bolt" />
            </div>
            <div>
              <h4>Model</h4>
              <p className="set-card-sub">{settings.model ?? `Default (${settings.defaultModel})`}</p>
            </div>
          </div>
          <p className="desc">
            The default is Google's current Flash model: quick, and well inside the free tier. A Pro model
            thinks harder and uses more of your quota.
          </p>
          <label className="field">
            <span>Answer with</span>
            <select
              className="filter-input"
              value={settings.model ?? ""}
              disabled={busy}
              onChange={(e) => save({ model: e.target.value || null }, "Model saved.")}
            >
              <option value="">Default ({settings.defaultModel})</option>
              {settings.model && !models.some((model) => model.id === settings.model) && (
                <option value={settings.model}>{settings.model}</option>
              )}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name} ({model.id})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );
}

/** Who you are signed in as, and how to stop being. */
function YouTab() {
  const { user, logout } = useAuth();

  return (
    <div className="settings-grid">
      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-lock" />
          </div>
          <div>
            <h4>Account</h4>
            <p className="set-card-sub">{user?.email ?? ""}</p>
          </div>
        </div>
        <p className="desc">
          Signed in with your account — the same one as Trippin and InFrame. Signing out doesn't remove any
          imported transactions — they are on the server, not in this browser.
        </p>
        <div className="set-card-actions">
          <button className="btn btn-sm btn-ghost btn-danger-text" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>

      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon tile-neutral">
            <Icon name="ic-sliders" />
          </div>
          <div className="set-card-titles">
            <h4>Appearance</h4>
            <p className="set-card-sub">Applies to this browser. Your phone keeps its own.</p>
          </div>
        </div>
        <AppearanceControl />
        <p className="field-hint">
          Follows the system by default. The choice is remembered in this browser and nowhere else.
        </p>
      </div>
    </div>
  );
}

const THEME_OPTIONS: { id: ThemeChoice; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

/**
 * Light, Dark or System as a segmented control, with a small preview of
 * each, through the same lib/theme functions the sidebar's toggle uses.
 */
function AppearanceControl() {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);

  // Follow the sidebar toggle if it changes the theme while this is open.
  useEffect(() => onThemeChange(setChoice), []);

  function pick(next: ThemeChoice) {
    setStoredTheme(next);
    setChoice(next);
  }

  return (
    <div className="appearance">
      <p className="t-label">Theme</p>
      <div className="seg appearance-seg" role="radiogroup" aria-label="Theme">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={choice === option.id}
            className={choice === option.id ? "on" : ""}
            onClick={() => pick(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="theme-previews" aria-hidden="true">
        {(["light", "dark"] as const).map((look) => (
          <button
            type="button"
            tabIndex={-1}
            key={look}
            className={`theme-preview is-${look}${choice === look ? " on" : ""}`}
            onClick={() => pick(look)}
          >
            <span className="theme-preview-name">{look === "light" ? "Light" : "Dark"}</span>
            <span className="theme-preview-bar">
              <span className="theme-preview-spent" />
              <span className="theme-preview-tick" />
            </span>
            <span className="theme-preview-figure">₹22,060</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** What the app is, and what it cannot do. */
function AboutTab() {
  return (
    <div className="settings-grid">
      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-info" />
          </div>
          <div>
            <h4>SpendLog {__APP_VERSION__}</h4>
            <p className="set-card-sub">Web, server and Android app, released together</p>
          </div>
        </div>
        <p className="desc">
          They share this version number, so what you are running always matches the server.
        </p>
      </div>

      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-question" />
          </div>
          <div>
            <h4>What it knows</h4>
            <p className="set-card-sub">And what it doesn't</p>
          </div>
        </div>
        <p className="desc">
          SpendLog reads the messages your banks send about <b>transactions</b>, and the statements they
          email. It has never known a <b>balance</b>.
        </p>
        <p className="desc">
          So it can say you are spending faster this fortnight than your salary supports. It cannot say
          whether you can afford next week's bill. Every figure here is built from money that moved.
        </p>
      </div>
    </div>
  );
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
}
