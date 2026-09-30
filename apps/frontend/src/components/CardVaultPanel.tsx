import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { OpenedDetails, lockVault, replaceDetails, unlockVault, useVaultSession } from "../lib/vaultSession";
import { Icon } from "./Icon";

/**
 * A card's or bank account's full details, behind the one PIN.
 *
 * One PIN guards every card and account, and one entry of it opens them
 * all for a few minutes (see lib/vaultSession.ts) - so going through three
 * cards is one prompt, not three. The server still checks the PIN on the
 * request that reveals; nothing is kept past a reload.
 *
 * There is no CVV here and no field for one. It is the one value that
 * turns a stolen number into someone else's purchase, and its owner knows
 * it by heart.
 */

interface VaultStatus {
  hasPin: boolean;
  lockedUntil: string | null;
  attemptsLeft: number;
  available: boolean;
}

export function CardVaultPanel({
  accountId,
  last4,
  hasDetails,
  isBank = false,
  onChanged,
}: {
  accountId: string;
  last4: string | null;
  hasDetails: boolean;
  /** A bank account keeps an account number and IFSC rather than a card's number and expiry. */
  isBank?: boolean;
  onChanged: () => void;
}) {
  const session = useVaultSession();
  const opened = session?.details.get(accountId) ?? null;

  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [editing, setEditing] = useState(false);
  const [settingPin, setSettingPin] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<VaultStatus>("/vault")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [accountId]);

  // A different account underneath is a different form.
  useEffect(() => {
    setEditing(false);
    setPin("");
    setError(null);
  }, [accountId]);

  async function unlock() {
    setBusy(true);
    setError(null);
    try {
      await unlockVault(pin);
      setPin("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
      api.get<VaultStatus>("/vault").then(setStatus).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const what = isBank ? "Account details" : "Card details";

  if (!status) return null;

  if (!status.available) {
    return (
      <div className="vault">
        <VaultHead title={what} last4={last4} isBank={isBank} locked />
        <p className="field-hint">
          The server has no STATEMENT_ENCRYPTION_KEY set, so details cannot be stored yet.
        </p>
      </div>
    );
  }

  if (!status.hasPin) {
    return (
      <div className="vault">
        <VaultHead title={what} last4={last4} isBank={isBank} locked />
        {settingPin ? (
          <SetPin
            onDone={() => {
              setSettingPin(false);
              api.get<VaultStatus>("/vault").then(setStatus);
            }}
            onCancel={() => setSettingPin(false)}
          />
        ) : (
          <>
            <p className="field-hint">
              Card and account details are kept encrypted and shown only after a PIN — one PIN for all of
              them. Choose one to start.
            </p>
            <button className="btn btn-sm" onClick={() => setSettingPin(true)}>
              Set a PIN
            </button>
          </>
        )}
      </div>
    );
  }

  if (editing) {
    return (
      <div className="vault">
        <VaultHead title={what} last4={last4} isBank={isBank} locked={false} />
        <EditDetails
          accountId={accountId}
          isBank={isBank}
          sessionPin={session?.pin ?? null}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  if (opened) {
    return (
      <div className="vault is-open">
        <VaultHead title={what} last4={last4} isBank={isBank} locked={false} />
        <DetailFields details={opened} isBank={isBank} />
        <div className="set-card-actions">
          <button className="btn btn-sm btn-ghost" onClick={lockVault}>
            <Icon name="ic-lock" /> Lock all
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
            Replace
          </button>
        </div>
        <p className="field-hint">
          Every card and account is open until{" "}
          {new Date(session!.locksAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}.
          {!isBank && " No CVV is stored."}
        </p>
      </div>
    );
  }

  const lockedOut = status.lockedUntil && new Date(status.lockedUntil) > new Date();

  return (
    <div className="vault">
      <VaultHead title={what} last4={last4} isBank={isBank} locked={!session} />

      {!hasDetails ? (
        <>
          <p className="field-hint">
            {isBank
              ? "Nothing stored for this account yet. The account number, IFSC and holder's name are encrypted."
              : "Nothing stored for this card yet. The number, expiry and name are encrypted; the CVV is never kept."}
          </p>
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            {isBank ? "Add account details" : "Add card details"}
          </button>
        </>
      ) : lockedOut ? (
        <p className="desc set-warn">
          Too many wrong PINs. Try again after{" "}
          {new Date(status.lockedUntil!).toLocaleTimeString("en-IN", {
            hour: "numeric",
            minute: "2-digit",
          })}
          .
        </p>
      ) : (
        <form
          className="vault-pin"
          onSubmit={(event) => {
            event.preventDefault();
            if (pin) unlock();
          }}
        >
          <input
            className="filter-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            placeholder="PIN"
            maxLength={6}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          />
          <button className="btn btn-sm" type="submit" disabled={busy || pin.length < 4}>
            {busy ? "Checking…" : "Unlock all"}
          </button>
          <span className="field-hint">Opens every card and account for five minutes.</span>
        </form>
      )}

      {error && <p className="desc set-warn">{error}</p>}
    </div>
  );
}

function DetailFields({ details, isBank }: { details: OpenedDetails; isBank: boolean }) {
  return (
    <dl className="vault-fields">
      <div>
        <dt>{isBank ? "Account number" : "Card number"}</dt>
        <dd className="vault-number">
          {isBank ? details.number : spaced(details.number)} <CopyButton text={details.number} />
        </dd>
      </div>
      {isBank ? (
        <div>
          <dt>IFSC</dt>
          <dd className="vault-number">
            {details.ifsc || "—"} {details.ifsc && <CopyButton text={details.ifsc} />}
          </dd>
        </div>
      ) : (
        <div>
          <dt>Expires</dt>
          <dd>{details.expiry || "—"}</dd>
        </div>
      )}
      <div>
        <dt>{isBank ? "Account holder" : "Name on card"}</dt>
        <dd>{details.nameOnCard || "—"}</dd>
      </div>
      {details.note && (
        <div className="vault-note">
          <dt>Note</dt>
          <dd>{details.note}</dd>
        </div>
      )}
    </dl>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="link-button vault-copy"
      onClick={() => {
        navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function VaultHead({
  title,
  last4,
  isBank,
  locked,
}: {
  title: string;
  last4: string | null;
  isBank: boolean;
  locked: boolean;
}) {
  return (
    <div className="vault-head">
      <span className="vault-title">
        <Icon name="ic-lock" /> {title}
      </span>
      <span className="vault-masked">
        {isBank ? "•••••••" : "•••• •••• ••••"} {last4 ?? "••••"}
        {locked && <span className="vault-state">Locked</span>}
      </span>
    </div>
  );
}

/** Groups of four, which is how a card number is read aloud. */
function spaced(number: string): string {
  return number.replace(/(.{4})/g, "$1 ").trim();
}

function SetPin({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (pin !== again) return setError("Those two don't match.");

    setBusy(true);
    setError(null);
    try {
      await api.put("/vault/pin", { pin });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="vault-setpin"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className="vault-pin">
        <input
          className="filter-input"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          placeholder="New PIN"
          maxLength={6}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
        />
        <input
          className="filter-input"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          placeholder="Again"
          maxLength={6}
          value={again}
          onChange={(event) => setAgain(event.target.value.replace(/\D/g, ""))}
        />
      </div>

      {error && <p className="desc set-warn">{error}</p>}

      <div className="set-card-actions">
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy || pin.length < 4}>
          {busy ? "Saving…" : "Set PIN"}
        </button>
        <button className="btn btn-sm btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="field-hint">
        Four to six digits, and the same PIN unlocks every card and account. Five wrong tries locks it for
        fifteen minutes.
      </p>
    </form>
  );
}

function EditDetails({
  accountId,
  isBank,
  sessionPin,
  onSaved,
  onCancel,
}: {
  accountId: string;
  isBank: boolean;
  /** Already unlocked: no second prompt for the same PIN. */
  sessionPin: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [nameOnCard, setNameOnCard] = useState("");
  const [ifsc, setIfsc] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const usePin = sessionPin ?? pin;
  const digits = number.replace(/\D/g, "").length;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/vault/cards/${accountId}`, {
        pin: usePin,
        number,
        expiry: isBank ? null : expiry || null,
        nameOnCard: nameOnCard || null,
        ifsc: isBank ? ifsc || null : null,
        note: note || null,
      });
      // Keep the open session's copy current, so what was just saved is
      // what shows without asking for the PIN again.
      if (sessionPin) {
        const fresh = await api.post<OpenedDetails>(`/vault/cards/${accountId}/reveal`, { pin: sessionPin });
        replaceDetails(accountId, { ...fresh, accountId });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="vault-edit"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className="field">
        <span>{isBank ? "Account number" : "Card number"}</span>
        <input
          className="filter-input"
          inputMode="numeric"
          autoComplete="off"
          placeholder={isBank ? "50100123456789" : "5252 2525 2525 6623"}
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
      </label>

      <div className="vault-edit-row">
        {isBank ? (
          <label className="field">
            <span>IFSC</span>
            <input
              className="filter-input"
              autoComplete="off"
              placeholder="HDFC0001234"
              maxLength={11}
              value={ifsc}
              onChange={(event) => setIfsc(event.target.value.toUpperCase())}
            />
          </label>
        ) : (
          <label className="field">
            <span>Expires</span>
            <input
              className="filter-input"
              autoComplete="off"
              placeholder="08/29"
              maxLength={7}
              value={expiry}
              onChange={(event) => setExpiry(event.target.value)}
            />
          </label>
        )}
        <label className="field">
          <span>{isBank ? "Account holder" : "Name on card"}</span>
          <input
            className="filter-input"
            autoComplete="off"
            value={nameOnCard}
            onChange={(event) => setNameOnCard(event.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>Note</span>
        <input
          className="filter-input"
          autoComplete="off"
          placeholder={isBank ? "Branch, customer ID, anything worth remembering" : "Anything else worth remembering"}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

      {!sessionPin && (
        <label className="field">
          <span>Your PIN</span>
          <input
            className="filter-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
          />
        </label>
      )}

      {error && <p className="desc set-warn">{error}</p>}

      <div className="set-card-actions">
        <button
          className="btn btn-sm btn-primary"
          type="submit"
          disabled={busy || usePin.length < 4 || digits < (isBank ? 6 : 12)}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-sm btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {!isBank && (
        <p className="field-hint">
          There is no CVV field, on purpose — it is the one thing that makes a stolen number spendable, and
          you already know yours.
        </p>
      )}
    </form>
  );
}
