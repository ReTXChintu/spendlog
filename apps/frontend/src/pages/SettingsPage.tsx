import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AccountModal } from "../components/AccountModal";
import { AccountPanel } from "../components/AccountPanel";
import { CommitmentModal } from "../components/CommitmentModal";
import { Icon } from "../components/Icon";
import { StatementShelf } from "../components/StatementShelf";
import { ThemeToggle } from "../components/ThemeToggle";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatMoney } from "../lib/format";
import {
  Account,
  AccountOverview,
  BudgetProfile,
  CardNetwork,
  Category,
  EmailConnectionStatus,
  FixedCommitment,
  MerchantPreset,
  NETWORK_LABELS,
  accountLabel,
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
  { id: "you", label: "You", icon: "ic-lock" },
  { id: "about", label: "About", icon: "ic-info" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Settings, in six tabs, each of which answers one question completely.
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

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Settings</h1>
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((candidate) => (
          <button
            key={candidate.id}
            role="tab"
            aria-selected={tab === candidate.id}
            className={`tab${tab === candidate.id ? " on" : ""}`}
            onClick={() => selectTab(candidate.id)}
          >
            <Icon name={candidate.icon} />
            {candidate.label}
          </button>
        ))}
      </div>

      {tab === "connections" && <ConnectionsTab />}
      {tab === "accounts" && <AccountsTab />}
      {tab === "budget" && <BudgetTab />}
      {tab === "presets" && <PresetsTab />}
      {tab === "you" && <YouTab />}
      {tab === "about" && <AboutTab />}
    </section>
  );
}

/** Where the data comes from: Gmail, SMS, and the statements in the inbox. */
function ConnectionsTab() {
  const [connections, setConnections] = useState<EmailConnectionStatus[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [statementSync, setStatementSync] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [apkAvailable, setApkAvailable] = useState<boolean | null>(null);
  const [searchParams] = useSearchParams();
  const gmailStatus = searchParams.get("gmail");

  const reload = useCallback(() => {
    api
      .get<EmailConnectionStatus[]>("/ingestion/email/status")
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
    try {
      await api.post("/ingestion/email/sync");
      reload();
    } finally {
      setSyncing(false);
    }
  }

  async function scanStatements() {
    setScanning(true);
    setStatementSync(null);
    try {
      const result = await api.post<{
        scanned: number;
        read: number;
        locked: number;
        unidentified: number;
        added: number;
      }>("/statements/sync");

      setStatementSync(
        result.scanned === 0
          ? "No statements found in the mailbox."
          : `Read ${result.read} of ${result.scanned}. ${result.added} transactions added` +
              `${result.locked > 0 ? `, ${result.locked} still locked` : ""}` +
              `${result.unidentified > 0 ? `, ${result.unidentified} on an unknown card` : ""}.`
      );
    } catch (error) {
      setStatementSync(error instanceof Error ? error.message : "That didn't work.");
    } finally {
      setScanning(false);
    }
  }

  const connection = connections[0];

  return (
    <div className="settings-grid">
      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
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
              <button
                className="btn btn-sm btn-ghost btn-danger-text"
                onClick={async () => {
                  await api.delete(`/ingestion/email/${connection.id}`);
                  reload();
                }}
              >
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
          <div className="set-card-icon">
            <Icon name="ic-receipt" />
          </div>
          <div>
            <h4>Card statements</h4>
            <p className="set-card-sub">The monthly PDF, from the same mailbox</p>
          </div>
        </div>
        <p className="desc">
          An alert only arrives for what the bank chose to announce. The statement is its own complete
          list, so reading it finds the annual fees, finance charges and anything that happened while the
          phone was off.
        </p>
        {statementSync && <p className="desc">{statementSync}</p>}
        <div className="set-card-actions">
          <button className="btn btn-sm" onClick={scanStatements} disabled={scanning || !connection}>
            <Icon name="ic-sync" />
            {scanning ? "Reading…" : "Read statements"}
          </button>
        </div>
        <p className="field-hint">
          What they found is filed under each card, in Accounts and cards.
        </p>
      </div>

      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
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
          Reading text messages isn't something a browser is allowed to do, and most Indian banks only
          text. The Android app is the only route to that data.
        </p>
        {apkAvailable === false ? (
          <p className="desc">No build has been published yet. Gmail import works in the meantime.</p>
        ) : (
          <>
            <div className="set-card-actions">
              <a className="btn btn-sm btn-primary" href="/SpendLog.apk" download>
                <Icon name="ic-download" /> Download the Android app
              </a>
            </div>
            <p className="field-hint" style={{ marginTop: 10 }}>
              Android warns about installing outside the Play Store — expected for a direct download.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

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

  const reload = useCallback(() => {
    api
      .get<AccountOverview[]>("/accounts/overview")
      .then(setAccounts)
      .catch(() => setAccounts([]))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(reload, [reload]);

  const wanted = searchParams.get("account");
  const selected = accounts.find((account) => account.id === wanted) ?? accounts[0] ?? null;

  function select(accountId: string) {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "accounts");
    next.set("account", accountId);
    setSearchParams(next, { replace: true });
  }

  const missingNetwork = accounts.filter(
    (account) => account.accountType === "CARD" && account.isActive && !account.cardNetwork
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
          </div>
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

  return (
    <div className="accounts-layout">
      <div className="accounts-bar">
        <div className="accounts-rail" role="tablist" aria-label="Accounts">
          {accounts.map((account) => (
            <button
              key={account.id}
              role="tab"
              aria-selected={selected?.id === account.id}
              className={`account-tab${selected?.id === account.id ? " on" : ""}${
                account.isActive ? "" : " is-closed"
              }`}
              onClick={() => select(account.id)}
            >
              <span className="account-tab-badge">
                <Icon name={account.accountType === "BANK" ? "ic-bank" : "ic-wallet"} />
              </span>
              <span className="account-tab-main">
                <span className="account-tab-name">{account.nickname || account.bankName}</span>
                <span className="account-tab-sub">
                  {[
                    account.last4 ? `•••• ${account.last4}` : null,
                    networkLabel(account.cardNetwork),
                    account.isActive ? null : "closed",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </button>
          ))}
        </div>

        <button className="btn btn-sm btn-primary" onClick={() => setEditing({ account: null })}>
          <Icon name="ic-plus" /> Add card or account
        </button>
      </div>

      <div className="accounts-body">
        {missingNetwork.length > 0 && (
          <p className="desc set-warn">
            <Icon name="ic-alert" />
            {missingNetwork.length === 1
              ? `${accountLabel(missingNetwork[0])} has no network set, so it never gets suggested at a till.`
              : `${missingNetwork.length} cards have no network set, so they never get suggested at a till.`}
          </p>
        )}

        {selected && (
          <AccountPanel
            key={selected.id}
            account={selected}
            onEdit={() => setEditing({ account: selected })}
            onChanged={reload}
          />
        )}

        {/* A card's statements are that card's paperwork, so they live with
            it rather than under the mailbox they arrived through. */}
        <StatementShelf accounts={accounts} onChanged={reload} focusAccountId={selected?.id ?? null} />
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

  const [commitments, setCommitments] = useState<FixedCommitment[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editingCommitment, setEditingCommitment] = useState<{ commitment: FixedCommitment | null } | null>(
    null
  );

  const reloadCommitments = useCallback(() => {
    api.get<FixedCommitment[]>("/budget/commitments").then(setCommitments).catch(() => setCommitments([]));
  }, []);

  useEffect(reloadCommitments, [reloadCommitments]);
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
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="settings-grid">
      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-wallet" />
          </div>
          <div>
            <h4>What lands each month</h4>
            <p className="set-card-sub">
              {profile?.salaryAmountMinor
                ? `${formatMoney(profile.salaryAmountMinor)} on the ${profile.salaryDay}th`
                : "Not set"}
            </p>
          </div>
        </div>

        <p className="desc">
          With these, the dashboard can say how much a day is left before the next one arrives. It is a
          pace, not a balance — SpendLog reads messages about transactions and has never known what is
          actually in an account.
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
                : `${formatMoney(commitments.reduce((sum, c) => sum + c.amountMinor, 0))} a month`}
            </p>
          </div>
        </div>

        <p className="desc">
          Rent, a SIP, insurance — anything that goes out every month whatever else happens. They are held
          back from what is left to spend, so the daily figure is what is actually free.
        </p>

        {commitments.length > 0 && (
          <div className="account-list">
            {commitments.map((commitment) => (
              <button
                className="account-row"
                key={commitment.id}
                onClick={() => setEditingCommitment({ commitment })}
              >
                <span className="account-badge">
                  <Icon name="ic-calendar" />
                </span>
                <span className="account-row-main">
                  <span className="account-row-name">{commitment.name}</span>
                  <span className="account-row-sub">
                    {[
                      `${formatMoney(commitment.amountMinor)} on the ${commitment.dayOfMonth}${ordinal(
                        commitment.dayOfMonth
                      )}`,
                      commitment.merchant,
                      typeof commitment.categoryId === "object" ? commitment.categoryId?.name : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="account-row-type">Edit</span>
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
          Signed in with Google. Signing out doesn't remove any imported transactions — they are on the
          server, not in this browser.
        </p>
        <div className="set-card-actions">
          <button className="btn btn-sm btn-ghost btn-danger-text" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>

      <div className="card set-card">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-sun" />
          </div>
          <div>
            <h4>Appearance</h4>
            <p className="set-card-sub">Light or dark, on this device</p>
          </div>
        </div>
        <p className="desc">
          Follows the system by default. The choice is remembered in this browser and nowhere else.
        </p>
        <div className="set-card-actions">
          <ThemeToggle />
        </div>
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
