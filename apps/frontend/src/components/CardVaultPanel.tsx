import { useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Icon } from "./Icon";

/**
 * The full card details, behind a PIN.
 *
 * Locked is the resting state and the only state that survives a reload —
 * there is no unlock that lasts, because the server checks the PIN on the
 * request that reveals and on no other. Shown details clear themselves
 * after a minute, so a card number is not left on a screen someone walks
 * away from.
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

interface Revealed {
  number: string;
  expiry: string | null;
  nameOnCard: string | null;
  note: string | null;
  last4: string;
}

/** How long a revealed card stays on screen. */
const HIDE_AFTER_MS = 60_000;

type Mode = "locked" | "shown" | "editing" | "pin";

export function CardVaultPanel({
  accountId,
  last4,
  hasDetails,
  onChanged,
}: {
  accountId: string;
  last4: string | null;
  hasDetails: boolean;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [mode, setMode] = useState<Mode>("locked");
  const [pin, setPin] = useState("");
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<VaultStatus>("/vault")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [accountId]);

  // Back to locked when the card changes underneath, so switching tabs
  // never carries one card's details onto another's panel.
  useEffect(() => {
    setMode("locked");
    setRevealed(null);
    setPin("");
    setError(null);
  }, [accountId]);

  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => {
      setRevealed(null);
      setMode("locked");
    }, HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [revealed]);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      setRevealed(await api.post<Revealed>(`/vault/cards/${accountId}/reveal`, { pin }));
      setMode("shown");
      setPin("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  if (!status.available) {
    return (
      <div className="vault">
        <VaultHead last4={last4} locked />
        <p className="field-hint">
          The server has no STATEMENT_ENCRYPTION_KEY set, so card details cannot be stored yet.
        </p>
      </div>
    );
  }

  if (!status.hasPin) {
    return (
      <div className="vault">
        <VaultHead last4={last4} locked />
        {mode === "pin" ? (
          <SetPin
            onDone={() => {
              setMode("locked");
              api.get<VaultStatus>("/vault").then(setStatus);
            }}
            onCancel={() => setMode("locked")}
          />
        ) : (
          <>
            <p className="field-hint">
              Card details are kept encrypted and shown only after a PIN. Choose one to start.
            </p>
            <button className="btn btn-sm" onClick={() => setMode("pin")}>
              Set a PIN
            </button>
          </>
        )}
      </div>
    );
  }

  if (mode === "editing") {
    return (
      <div className="vault">
        <VaultHead last4={last4} locked={false} />
        <EditDetails
          accountId={accountId}
          onSaved={() => {
            setMode("locked");
            onChanged();
          }}
          onCancel={() => setMode("locked")}
        />
      </div>
    );
  }

  if (mode === "shown" && revealed) {
    return (
      <div className="vault is-open">
        <VaultHead last4={last4} locked={false} />

        <dl className="vault-fields">
          <div>
            <dt>Card number</dt>
            <dd className="vault-number">{spaced(revealed.number)}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>{revealed.expiry || "—"}</dd>
          </div>
          <div>
            <dt>Name on card</dt>
            <dd>{revealed.nameOnCard || "—"}</dd>
          </div>
          {revealed.note && (
            <div className="vault-note">
              <dt>Note</dt>
              <dd>{revealed.note}</dd>
            </div>
          )}
        </dl>

        <div className="set-card-actions">
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setRevealed(null);
              setMode("locked");
            }}
          >
            <Icon name="ic-lock" /> Hide
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setMode("editing")}>
            Replace
          </button>
        </div>
        <p className="field-hint">Hides itself in a minute. No CVV is stored.</p>
      </div>
    );
  }

  const lockedOut = status.lockedUntil && new Date(status.lockedUntil) > new Date();

  return (
    <div className="vault">
      <VaultHead last4={last4} locked />

      {!hasDetails ? (
        <>
          <p className="field-hint">
            Nothing stored for this card yet. The number, expiry and name are encrypted; the CVV is
            never kept.
          </p>
          <button className="btn btn-sm" onClick={() => setMode("editing")}>
            Add card details
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
            if (pin) reveal();
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
            {busy ? "Checking…" : "Show"}
          </button>
        </form>
      )}

      {error && <p className="desc set-warn">{error}</p>}
    </div>
  );
}

function VaultHead({ last4, locked }: { last4: string | null; locked: boolean }) {
  return (
    <div className="vault-head">
      <span className="vault-title">
        <Icon name="ic-lock" /> Card details
      </span>
      <span className="vault-masked">
        •••• •••• •••• {last4 ?? "••••"}
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
        Four to six digits, and the same PIN unlocks every card. Five wrong tries locks it for
        fifteen minutes.
      </p>
    </form>
  );
}

function EditDetails({
  accountId,
  onSaved,
  onCancel,
}: {
  accountId: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState("");
  const [number, setNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [nameOnCard, setNameOnCard] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/vault/cards/${accountId}`, {
        pin,
        number,
        expiry: expiry || null,
        nameOnCard: nameOnCard || null,
        note: note || null,
      });
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
        <span>Card number</span>
        <input
          className="filter-input"
          inputMode="numeric"
          autoComplete="off"
          placeholder="5252 2525 2525 6623"
          value={number}
          onChange={(event) => setNumber(event.target.value)}
        />
      </label>

      <div className="vault-edit-row">
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
        <label className="field">
          <span>Name on card</span>
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
          placeholder="Anything else worth remembering"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>

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

      {error && <p className="desc set-warn">{error}</p>}

      <div className="set-card-actions">
        <button
          className="btn btn-sm btn-primary"
          type="submit"
          disabled={busy || pin.length < 4 || number.length < 12}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-sm btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="field-hint">
        There is no CVV field, on purpose — it is the one thing that makes a stolen number
        spendable, and you already know yours.
      </p>
    </form>
  );
}
