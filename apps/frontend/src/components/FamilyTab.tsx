import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Account, Kid, KidsResponse, accountLabel } from "../types";
import { Icon } from "./Icon";

/** The server's own words when it refuses, otherwise a plain fallback. */
function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Logins for the owner's children. A kid signs in only on the phone app
 * and sees only the pocket money accounts given to them here — the web
 * app stays the owner's, and the server refuses a kid's sign-in on it.
 */
export function FamilyTab() {
  const [data, setData] = useState<KidsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const reload = useCallback(() => {
    api
      .get<KidsResponse>("/family/kids")
      .then((next) => {
        setData(next);
        setLoadError(null);
      })
      .catch((error) => setLoadError(errorText(error, "Couldn't load your kids' logins.")));
  }, []);

  useEffect(reload, [reload]);
  useEffect(() => {
    api.get<Account[]>("/accounts").then(setAccounts).catch(() => setAccounts([]));
  }, []);

  const pocketAccounts = accounts.filter((account) => account.pocketMoney);
  const kids = data?.kids ?? [];

  return (
    <div className="settings-grid">
      <div className="card set-card set-card-wide">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-people" />
          </div>
          <div>
            <h4>Kids' logins</h4>
            <p className="set-card-sub">For the SpendLog phone app only</p>
          </div>
        </div>
        <p className="desc">
          Give a child their own login to see and add their pocket money on the SpendLog phone app. They can't
          see anything else, and can't create an account themselves.
        </p>
        {data && !data.pushAvailable && (
          <p className="field-hint">
            Kids' refresh can't wake your phone yet — Firebase isn't set up on the server.
          </p>
        )}
        {loadError && (
          <p className="form-error" role="alert">
            {loadError}
          </p>
        )}

        {kids.length > 0 && (
          <ul className="kid-list">
            {kids.map((kid) => (
              <KidRow key={kid.id} kid={kid} kids={kids} pocketAccounts={pocketAccounts} onChanged={reload} />
            ))}
          </ul>
        )}
      </div>

      <div className="card set-card set-card-wide">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-plus" />
          </div>
          <div>
            <h4>Add a kid</h4>
            <p className="set-card-sub">They sign in with this email and password on the phone</p>
          </div>
        </div>
        {pocketAccounts.length === 0 ? (
          <p className="desc">
            You don't have a pocket money account yet, so there's nothing to give a kid.{" "}
            <Link to="/settings?tab=accounts">Make an account pocket money first</Link>.
          </p>
        ) : (
          <AddKidForm kids={kids} pocketAccounts={pocketAccounts} onAdded={reload} />
        )}
      </div>
    </div>
  );
}

/** Ticks for the owner's pocket money accounts; one held by another kid can't be picked. */
function AccountChoices({
  pocketAccounts,
  kids,
  selfId,
  selected,
  onChange,
}: {
  pocketAccounts: Account[];
  kids: Kid[];
  selfId: string | null;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="kid-accounts">
      <legend>Pocket money accounts they can see</legend>
      {pocketAccounts.map((account) => {
        // An account belongs to one kid at most — the server refuses a second.
        const holder = kids.find((kid) => kid.id !== selfId && kid.accountIds.includes(account.id));
        return (
          <label className="checkbox-row" key={account.id}>
            <input
              type="checkbox"
              checked={selected.includes(account.id)}
              disabled={Boolean(holder)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, account.id]
                    : selected.filter((id) => id !== account.id)
                )
              }
            />
            <span>
              {accountLabel(account)}
              {account.pocketMoney?.holder ? ` · ${account.pocketMoney.holder}` : ""}
              {holder && <em className="kid-taken"> — {holder.name}'s</em>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** A password box with a show/hide button, since the owner types it for someone else. */
function PasswordInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [shown, setShown] = useState(false);
  const id = useId();
  return (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      <div className="kid-password">
        <input
          id={id}
          className="filter-input"
          type={shown ? "text" : "password"}
          autoComplete="new-password"
          minLength={6}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-pressed={shown}
          onClick={() => setShown((current) => !current)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

function AddKidForm({
  kids,
  pocketAccounts,
  onAdded,
}: {
  kids: Kid[];
  pocketAccounts: Account[];
  onAdded: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const emailId = useId();

  const ready = name.trim() && email.trim() && password.length >= 6;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/family/kids", { name: name.trim(), email: email.trim(), password, accountIds });
      setName("");
      setEmail("");
      setPassword("");
      setAccountIds([]);
      onAdded();
    } catch (caught) {
      setError(errorText(caught, "Couldn't add this kid."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="kid-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor={nameId}>Name</label>
          <input id={nameId} className="filter-input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-row">
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            className="filter-input"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={`${emailId}-hint`}
          />
          <p className="field-hint" id={`${emailId}-hint`}>
            Used only to sign in — nothing is sent to it.
          </p>
        </div>
        <div className="form-row-wide">
          <PasswordInput label="Password (at least 6 characters)" value={password} onChange={setPassword} />
        </div>
        <div className="form-row-wide">
          <AccountChoices
            pocketAccounts={pocketAccounts}
            kids={kids}
            selfId={null}
            selected={accountIds}
            onChange={setAccountIds}
          />
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !ready}>
          {busy ? "Adding…" : "Add kid"}
        </button>
      </div>
    </form>
  );
}

type Mode = "view" | "edit" | "password" | "remove";

function KidRow({
  kid,
  kids,
  pocketAccounts,
  onChanged,
}: {
  kid: Kid;
  kids: Kid[];
  pocketAccounts: Account[];
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<Mode>("view");
  const [name, setName] = useState(kid.name);
  const [accountIds, setAccountIds] = useState<string[]>(kid.accountIds);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nameId = useId();

  function open(next: Mode) {
    // Start each action from what is saved, not from a half-finished earlier try.
    setName(kid.name);
    setAccountIds(kid.accountIds);
    setPassword("");
    setError(null);
    setNotice(null);
    setMode(next);
  }

  async function run(action: () => Promise<unknown>, fallback: string, done?: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setMode("view");
      if (done) setNotice(done);
      onChanged();
    } catch (caught) {
      setError(errorText(caught, fallback));
    } finally {
      setBusy(false);
    }
  }

  // An account switched off pocket money since is still named, so it isn't silently dropped.
  const accountNames = kid.accountIds.map((id) => {
    const account = pocketAccounts.find((candidate) => candidate.id === id);
    return account ? accountLabel(account) : "An account that's no longer pocket money";
  });

  return (
    <li className="kid-row">
      <div className="kid-row-top">
        <div className="kid-row-who">
          <span className="kid-row-name">{kid.name}</span>
          <span className="kid-row-email">{kid.email}</span>
          <span className="kid-row-accounts">
            {accountNames.length > 0 ? accountNames.join(", ") : "No pocket money accounts yet"}
          </span>
        </div>
        {mode === "view" && (
          <div className="set-card-actions">
            <button className="btn btn-sm btn-ghost" onClick={() => open("edit")}>
              Edit
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => open("password")}>
              Reset password
            </button>
            <button className="btn btn-sm btn-ghost btn-danger-text" onClick={() => open("remove")}>
              Remove
            </button>
          </div>
        )}
      </div>

      {notice && mode === "view" && (
        <p className="field-hint" role="status">
          {notice}
        </p>
      )}

      {mode === "edit" && (
        <form
          className="kid-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim()) return;
            run(
              () => api.patch(`/family/kids/${kid.id}`, { name: name.trim(), accountIds }),
              "Couldn't save these changes."
            );
          }}
        >
          <div className="form-row">
            <label htmlFor={nameId}>Name</label>
            <input id={nameId} className="filter-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <AccountChoices
            pocketAccounts={pocketAccounts}
            kids={kids}
            selfId={kid.id}
            selected={accountIds}
            onChange={setAccountIds}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === "password" && (
        <form
          className="kid-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (password.length < 6) return;
            run(
              () => api.patch(`/family/kids/${kid.id}`, { password }),
              "Couldn't change the password.",
              `Password changed. ${kid.name} will need to sign in again on their phone.`
            );
          }}
        >
          <PasswordInput label="New password (at least 6 characters)" value={password} onChange={setPassword} />
          <p className="field-hint">This signs {kid.name} out of the phone app until they use the new one.</p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button className="btn btn-sm btn-primary" type="submit" disabled={busy || password.length < 6}>
              {busy ? "Saving…" : "Set password"}
            </button>
            <button className="btn btn-sm btn-ghost" type="button" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {mode === "remove" && (
        <div className="kid-form" role="group" aria-label={`Remove ${kid.name}`}>
          <p className="desc">
            Remove {kid.name}'s login? They'll be signed out of the phone app. What they added stays in your
            ledger.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => run(() => api.delete(`/family/kids/${kid.id}`), "Couldn't remove this login.")}
            >
              {busy ? "Removing…" : "Remove"}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
