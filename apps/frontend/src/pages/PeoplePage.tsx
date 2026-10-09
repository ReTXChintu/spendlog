import { useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { formatDayLabel, formatMoney, formatMoneyShort, istToday } from "../lib/format";
import { Contact, ContactClearance, ContactDetail, ContactList, Transaction } from "../types";

/**
 * Who owes what.
 *
 * Every split with a person on it and every repayment marked against them
 * adds up to one figure each: what they still owe, or what is still owed
 * to them. Put down on the transaction itself - tick Split or Settling up
 * and say who - so there is no second list to keep in step.
 */
export function PeoplePage() {
  const [list, setList] = useState<ContactList | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api
      .get<ContactList>("/contacts")
      .then((next) => {
        setList(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(load, [load]);

  if (failed) {
    return (
      <section className="screen">
        <StateBlock
          icon="ic-wifioff"
          title="Couldn't reach the server"
          body="Try again in a moment."
          actions={
            <button className="btn btn-primary" onClick={load}>
              Try again
            </button>
          }
        />
      </section>
    );
  }

  if (!list) return <section className="screen" />;

  const selected = list.contacts.find((contact) => contact.id === selectedId) ?? null;

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">People</h1>
        <div className="screen-actions">
          <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            <Icon name="ic-plus" /> Add person
          </button>
        </div>
      </div>

      <div className="people-totals">
        <div className="stat-tile">
          <div className="label">Owed to you</div>
          <div className="value num credit">{formatMoney(list.owedToYouMinor)}</div>
        </div>
        <div className="stat-tile">
          <div className="label">You owe</div>
          <div className="value num debit">{formatMoney(list.youOweMinor)}</div>
        </div>
      </div>

      {adding && (
        <AddPerson
          onDone={(created) => {
            setAdding(false);
            load();
            if (created) setSelectedId(created.id);
          }}
        />
      )}

      {list.contacts.length === 0 ? (
        <StateBlock
          icon="ic-link"
          title="Nobody here yet"
          body="Mark a payment as split (or lent), or money in as settling up, and say who it was with — they'll appear here with what they owe. You can also add someone now."
        />
      ) : (
        <div className="layout-2 people-layout">
          <div className="people-list">
            {list.contacts.map((contact) => (
              <button
                key={contact.id}
                className={`people-card${contact.id === selectedId ? " is-selected" : ""}`}
                onClick={() => setSelectedId(contact.id === selectedId ? null : contact.id)}
              >
                <span className="people-avatar">{contact.name.charAt(0).toUpperCase()}</span>
                <span className="people-card-main">
                  <span className="people-card-name">{contact.name}</span>
                  <span className="people-card-sub">
                    {contact.transactionCount === 0
                      ? "Nothing yet"
                      : `${contact.transactionCount} ${contact.transactionCount === 1 ? "transaction" : "transactions"}`}
                    {contact.phone && ` · ${contact.phone}`}
                  </span>
                </span>
                <BalanceTag balanceMinor={contact.balanceMinor} />
              </button>
            ))}
          </div>

          <div>
            {selected ? (
              <PersonDetail
                key={selected.id}
                contact={selected}
                onChanged={load}
                onDeleted={() => {
                  setSelectedId(null);
                  load();
                }}
              />
            ) : (
              <p className="field-hint people-hint">
                Pick someone to see everything with them. To add to what someone owes, tick Split on a payment
                and say who; when they pay you back, tick Settling up on the money that came in and pick them.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * A starting balance as a person thinks of it: an amount and which way it
 * runs, rather than a signed number.
 */
function OwedInput({
  rupees,
  theyOwe,
  onRupees,
  onTheyOwe,
}: {
  rupees: string;
  theyOwe: boolean;
  onRupees: (value: string) => void;
  onTheyOwe: (value: boolean) => void;
}) {
  return (
    <span className="owed-input">
      <span className="amount-input">
        <span className="prefix">₹</span>
        <input
          className="filter-input"
          inputMode="decimal"
          placeholder="0"
          value={rupees}
          onChange={(e) => onRupees(e.target.value)}
          aria-label="Amount already owed"
        />
      </span>
      <span className="seg">
        <button type="button" className={theyOwe ? "on" : ""} onClick={() => onTheyOwe(true)}>
          They owe me
        </button>
        <button type="button" className={theyOwe ? "" : "on"} onClick={() => onTheyOwe(false)}>
          I owe them
        </button>
      </span>
    </span>
  );
}

/** The signed figure the server keeps, from the two halves above. */
function signedMinor(rupees: string, theyOwe: boolean): number {
  const minor = Math.round((Number.parseFloat(rupees.replace(/[₹,\s]/g, "")) || 0) * 100);
  return theyOwe ? Math.abs(minor) : -Math.abs(minor);
}

/** ₹1,000 when there are no paise, ₹999.50 when there are. */
function formatRupees(minor: number): string {
  return minor % 100 === 0 ? formatMoneyShort(minor) : formatMoney(minor);
}

/** What a balance amounts to, said the way round it runs. */
function owingSentence(name: string, balanceMinor: number, amount: string): string {
  return balanceMinor > 0 ? `${name} owes you ${amount}` : `You owe ${name} ${amount}`;
}

function BalanceTag({ balanceMinor }: { balanceMinor: number }) {
  if (balanceMinor === 0) return <span className="people-tag">Settled up</span>;
  return (
    <span className={`people-tag num ${balanceMinor > 0 ? "is-owed" : "is-owing"}`}>
      {balanceMinor > 0 ? "owes you " : "you owe "}
      {formatMoney(Math.abs(balanceMinor))}
    </span>
  );
}

function AddPerson({ onDone }: { onDone: (created: Contact | null) => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [owed, setOwed] = useState("");
  const [theyOwe, setTheyOwe] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<Contact>("/contacts", {
        name: name.trim(),
        phone: phone.trim() || null,
        openingBalanceMinor: signedMinor(owed, theyOwe),
      });
      onDone(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add them.");
      setBusy(false);
    }
  }

  return (
    <form
      className="card people-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) save();
      }}
    >
      <label className="field">
        <span>Name</span>
        <input autoFocus className="filter-input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>Phone (optional)</span>
        <input
          className="filter-input"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="98765 43210"
        />
      </label>
      <label className="field">
        <span>Already owed, before SpendLog (optional)</span>
        <OwedInput rupees={owed} theyOwe={theyOwe} onRupees={setOwed} onTheyOwe={setTheyOwe} />
      </label>
      <div className="set-card-actions">
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add"}
        </button>
        <button className="btn btn-sm btn-ghost" type="button" onClick={() => onDone(null)}>
          Cancel
        </button>
      </div>
      <p className="field-hint">On the phone app you can pick someone straight from your contacts.</p>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}

function PersonDetail({
  contact,
  onChanged,
  onDeleted,
}: {
  contact: Contact;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact.name);
  const [phone, setPhone] = useState(contact.phone ?? "");
  const opening = contact.openingBalanceMinor ?? 0;
  const [owed, setOwed] = useState(opening ? (Math.abs(opening) / 100).toFixed(2) : "");
  const [theyOwe, setTheyOwe] = useState(opening >= 0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .get<ContactDetail>(`/contacts/${contact.id}`)
      .then(setDetail)
      .catch(() => setError("Couldn't load their history."));
  }, [contact.id]);

  useEffect(reload, [reload, contact.balanceMinor]);

  async function undoClearance(clearance: ContactClearance) {
    setError(null);
    try {
      await api.delete(`/contacts/${contact.id}/clear/${clearance.id}`);
      reload();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't undo that.");
    }
  }

  // Transactions and clearances in one list, newest first: a clearance
  // happened on a day like anything else did.
  const rows: (
    | { kind: "transaction"; at: string; transaction: Transaction; amountMinor: number }
    | { kind: "clearance"; at: string; clearance: ContactClearance }
  )[] = detail
    ? [
        ...detail.history.map((row) => ({ kind: "transaction" as const, at: row.transaction.occurredAt, ...row })),
        ...(detail.clearances ?? []).map((clearance) => ({ kind: "clearance" as const, at: clearance.on, clearance })),
      ].sort((a, b) => b.at.localeCompare(a.at))
    : [];
  const cleared = contact.clearedMinor ?? 0;

  async function save() {
    setError(null);
    try {
      await api.patch(`/contacts/${contact.id}`, {
        name: name.trim(),
        phone: phone.trim() || null,
        openingBalanceMinor: signedMinor(owed, theyOwe),
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    }
  }

  async function remove() {
    try {
      await api.delete(`/contacts/${contact.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove them.");
    }
  }

  return (
    <div className="card people-detail">
      <div className="people-detail-head">
        <div>
          <h3>{contact.name}</h3>
          <p className="section-sub">
            {opening !== 0 &&
              `${opening > 0 ? "Owed you" : "You owed them"} ${formatMoney(Math.abs(opening))} before SpendLog · `}
            Lent or paid for {formatMoney(contact.givenMinor)} · paid back {formatMoney(contact.returnedMinor)}
            {cleared !== 0 && ` · cleared ${formatMoney(Math.abs(cleared))} without money moving`}
          </p>
        </div>
        <BalanceTag balanceMinor={contact.balanceMinor} />
      </div>

      {editing ? (
        <div className="people-edit">
          <input className="filter-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
          <input
            className="filter-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone"
            aria-label="Phone"
          />
          <label className="field people-edit-owed">
            <span>Already owed, before SpendLog</span>
            <OwedInput rupees={owed} theyOwe={theyOwe} onRupees={setOwed} onTheyOwe={setTheyOwe} />
          </label>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={!name.trim()}>
            Save
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="set-card-actions">
          {contact.balanceMinor !== 0 && (
            <button
              className="btn btn-sm"
              onClick={() => setClearing(true)}
              title="Settled some other way - a gift, a favour - with no money moving"
            >
              <Icon name="ic-check" /> Clear
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
            <Icon name="ic-pencil" /> Edit
          </button>
          <button
            className={`btn btn-sm ${confirmDelete ? "btn-primary" : "btn-ghost btn-danger-text"}`}
            onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
          >
            {confirmDelete ? "Really remove? Their transactions stay" : "Remove"}
          </button>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}

      {detail === null ? (
        <p className="field-hint">Loading…</p>
      ) : rows.length === 0 && opening === 0 ? (
        <p className="field-hint">
          Nothing with {contact.name} yet. If money changed hands before SpendLog, add it under Edit as what's
          already owed.
        </p>
      ) : (
        <div className="people-history">
          {rows.map((row) =>
            row.kind === "transaction" ? (
              <div className="people-history-row" key={row.transaction.id}>
                <span className="people-history-main">
                  <span className="people-history-name">
                    {row.transaction.merchant ??
                      row.transaction.split?.groupLabel ??
                      (row.amountMinor > 0 ? "Lent" : "Paid back")}
                  </span>
                  <span className="people-history-sub">
                    {formatDayLabel(row.transaction.occurredAt.slice(0, 10))}
                    {row.transaction.isSettlement ? " · settling up" : row.transaction.split ? " · split" : ""}
                  </span>
                </span>
                <span className={`num ${row.amountMinor > 0 ? "debit" : "credit"}`}>
                  {row.amountMinor > 0 ? "+" : "−"}
                  {formatMoney(Math.abs(row.amountMinor))}
                </span>
              </div>
            ) : (
              <div className="people-history-row is-clearance" key={row.clearance.id}>
                <span className="people-avatar people-clear-mark" aria-hidden="true">
                  <Icon name="ic-check" />
                </span>
                <span className="people-history-main">
                  <span className="people-history-name">
                    Cleared {formatRupees(row.clearance.amountMinor)}
                    {row.clearance.note && ` · ${row.clearance.note}`}
                  </span>
                  <span className="people-history-sub">
                    {formatDayLabel(row.clearance.on.slice(0, 10))} ·{" "}
                    {row.clearance.direction === "OWED_TO_ME" ? "off what they owed" : "off what you owed"}, no money
                    moved
                  </span>
                </span>
                <span className="num people-clear-amount">
                  {row.clearance.effectMinor > 0 ? "+" : "−"}
                  {formatMoney(Math.abs(row.clearance.effectMinor))}
                </span>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => undoClearance(row.clearance)}
                  title="Undo: it is owed again"
                >
                  Undo
                </button>
              </div>
            )
          )}
          {/* Oldest, so last: where the running figure started. */}
          {opening !== 0 && (
            <div className="people-history-row">
              <span className="people-history-main">
                <span className="people-history-name">Starting balance</span>
                <span className="people-history-sub">Before SpendLog</span>
              </span>
              <span className={`num ${opening > 0 ? "debit" : "credit"}`}>
                {opening > 0 ? "+" : "−"}
                {formatMoney(Math.abs(opening))}
              </span>
            </div>
          )}
        </div>
      )}

      {clearing && (
        <ClearDialog
          contact={contact}
          onClose={() => setClearing(false)}
          onCleared={() => {
            setClearing(false);
            reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * Settles part or all of what is owed without money moving - they owed
 * ₹1,000 and bought you a ₹999 watch, so ₹999 is cleared and ₹1 is still
 * owed. Starts at the whole amount, since clearing everything is the usual
 * case, and can be brought down for a part.
 */
function ClearDialog({
  contact,
  onClose,
  onCleared,
}: {
  contact: Contact;
  onClose: () => void;
  onCleared: () => void;
}) {
  const outstanding = Math.abs(contact.balanceMinor);
  const [amount, setAmount] = useState(
    outstanding % 100 === 0 ? String(outstanding / 100) : (outstanding / 100).toFixed(2)
  );
  const [note, setNote] = useState("");
  const [date, setDate] = useState(istToday());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const minor = Math.abs(signedMinor(amount, true));
  const problem =
    minor <= 0
      ? "Enter an amount greater than zero."
      : minor > outstanding
        ? `Only ${formatRupees(outstanding)} is owed — you can't clear more than that.`
        : null;
  const left = outstanding - minor;

  async function save() {
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post(`/contacts/${contact.id}/clear`, {
        amountMinor: minor,
        note: note.trim() || null,
        // Midday in India, so the day reads the same wherever it is shown.
        on: `${date}T12:00:00+05:30`,
      });
      onCleared();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't clear that.");
      setSaving(false);
    }
  }

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal people-clear"
        role="dialog"
        aria-modal="true"
        aria-labelledby="people-clear-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) void save();
        }}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>
        <h3 id="people-clear-title">Clear with {contact.name}</h3>
        <div className="modal-sub">
          Settled some other way — a gift, a favour. No money moves, and nothing counts as spending or income.
        </div>

        <label className="field">
          <span>Amount to clear</span>
          <div className="amount-input">
            <span className="prefix">₹</span>
            <input
              autoFocus
              className="filter-input"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setError(null);
              }}
              aria-describedby="people-clear-preview"
            />
          </div>
          <span id="people-clear-preview" className={`people-clear-preview${problem ? " is-wrong" : ""}`}>
            {owingSentence(contact.name, contact.balanceMinor, formatRupees(outstanding))}
            {" → "}
            {problem
              ? problem
              : left === 0
                ? "settled up after this"
                : `${formatRupees(left)} left after this`}
          </span>
        </label>

        <div className="people-clear-pair">
          <label className="field">
            <span>Note (optional)</span>
            <input
              className="filter-input"
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Bought me a watch"
            />
          </label>
          <label className="field">
            <span>Date</span>
            <input
              type="date"
              className="filter-input"
              value={date}
              max={istToday()}
              onChange={(event) => setDate(event.target.value || istToday())}
            />
          </label>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <span className="modal-actions-spacer" />
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !!problem}>
            {saving ? "Clearing…" : `Clear ${minor > 0 && !problem ? formatRupees(minor) : ""}`.trim()}
          </button>
        </div>
      </form>
    </div>
  );
}
