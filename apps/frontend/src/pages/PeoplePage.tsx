import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { formatDayLabel, formatMoney, formatMoneyShort, istToday } from "../lib/format";
import {
  Contact,
  ContactClearance,
  ContactDetail,
  ContactGroupOpening,
  ContactList,
  Transaction,
  groupOf,
} from "../types";

/** Two initials for an avatar. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

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
        <div className="screen-header">
          <h1 className="screen-title">People</h1>
        </div>
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
  const owedCount = list.contacts.filter((contact) => contact.balanceMinor > 0).length;
  const owingTo = list.contacts.filter((contact) => contact.balanceMinor < 0);
  const openCount = list.contacts.filter((contact) => contact.balanceMinor !== 0).length;

  return (
    <section className="screen people-screen">
      <div className="screen-header">
        <h1 className="screen-title">People</h1>
        <div className="screen-actions">
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="ic-plus" /> Add person
          </button>
        </div>
      </div>

      <div className="flow">
        <div className="people-left stack">
          <div className="card people-everyone">
            <div className="card-head">
              <h2>Everyone</h2>
              <span className="spacer" />
              {openCount > 0 && <span className="badge badge-neutral">{openCount} open</span>}
            </div>

            <div className="people-totals">
              <div className="people-total is-owed">
                <div className="t-label">Owed to you</div>
                <div className="people-total-value num">{formatMoneyShort(list.owedToYouMinor)}</div>
                <div className="people-total-note">
                  from {owedCount} {owedCount === 1 ? "person" : "people"}
                </div>
              </div>
              <div className="people-total">
                <div className="t-label">You owe</div>
                <div className="people-total-value num">{formatMoneyShort(list.youOweMinor)}</div>
                <div className="people-total-note">
                  {owingTo.length === 0
                    ? "to nobody"
                    : owingTo.length === 1
                      ? `to ${owingTo[0].name}`
                      : `to ${owingTo.length} people`}
                </div>
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
                icon="ic-users"
                title="Nobody here yet"
                body="Mark a payment as split (or lent), or money in as settling up, and say who it was with — they'll appear here with what they owe. You can also add someone now."
              />
            ) : (
              <div className="people-list">
                {list.contacts.map((contact) => (
                  <button
                    key={contact.id}
                    className={`people-card${contact.id === selectedId ? " is-selected" : ""}`}
                    aria-pressed={contact.id === selectedId}
                    onClick={() => setSelectedId(contact.id === selectedId ? null : contact.id)}
                  >
                    <span className="avatar">{initialsOf(contact.name)}</span>
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
            )}

            {!adding && (
              <button className="btn btn-lg people-add-btn" onClick={() => setAdding(true)}>
                <Icon name="ic-plus" /> Add person
              </button>
            )}
          </div>

          <div className="card card-dashed people-explainer">
            <span className="icon-tile tile-neutral">
              <Icon name="ic-info" />
            </span>
            <div>
              <h3 className="t-title-card">How balances are worked out</h3>
              <p className="desc">
                Pick someone to see everything with them. To add to what someone owes, tick Split on a payment and
                say who; when they pay you back, tick Settling up on the money that came in and pick them. A
                clearance moves a balance without any money changing hands — useful for gifts and favours.
              </p>
            </div>
          </div>
        </div>

        <div className="people-right stack">
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
            list.contacts.length > 0 && (
              <div className="empty-inline people-pick">
                <span className="icon-tile tile-neutral">
                  <Icon name="ic-users" />
                </span>
                Pick someone on the left to see everything with them.
              </div>
            )
          )}
        </div>
      </div>
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
  if (balanceMinor === 0) return <span className="people-tag is-settled">Settled up</span>;
  return (
    <span className={`people-tag ${balanceMinor > 0 ? "is-owed" : "is-owing"}`}>
      <span className="people-tag-label">{balanceMinor > 0 ? "owes you" : "you owe"}</span>
      <span className="people-tag-amount num">{formatRupees(Math.abs(balanceMinor))}</span>
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
      className="people-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) save();
      }}
    >
      <h3 className="t-title-card">Add a person</h3>
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
      <p className="field-hint">On the phone app you can pick someone straight from your contacts.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="people-actions">
        <button className="btn btn-ghost" type="button" onClick={() => onDone(null)}>
          Cancel
        </button>
        <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
    </form>
  );
}

/** What kind of row a history transaction is, as a badge. */
function kindBadge(transaction: Transaction, amountMinor: number) {
  if (transaction.offLedger) return <span className="badge badge-neutral">They paid</span>;
  if (transaction.isSettlement) return <span className="badge badge-good">Paid back</span>;
  if (transaction.split) return <span className="badge badge-neutral">Split</span>;
  return <span className="badge badge-neutral">{amountMinor > 0 ? "Lent" : "Paid back"}</span>;
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

  // Transactions, clearances and groups' opening balances in one list,
  // newest first: each happened on a day like anything else did.
  const rows: (
    | { kind: "transaction"; at: string; transaction: Transaction; amountMinor: number }
    | { kind: "clearance"; at: string; clearance: ContactClearance }
    | { kind: "groupOpening"; at: string; opening: ContactGroupOpening }
  )[] = detail
    ? [
        ...detail.history.map((row) => ({ kind: "transaction" as const, at: row.transaction.occurredAt, ...row })),
        ...(detail.clearances ?? []).map((clearance) => ({ kind: "clearance" as const, at: clearance.on, clearance })),
        ...(detail.groupOpenings ?? []).map((opening) => ({ kind: "groupOpening" as const, at: opening.setAt, opening })),
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

  const balance = contact.balanceMinor;

  return (
    <>
      <div className="card people-detail">
        <div className="people-detail-head">
          <span className="avatar people-detail-avatar">{initialsOf(contact.name)}</span>
          <div className="people-detail-who">
            <h2 className="t-title-page">{contact.name}</h2>
            <p className="people-detail-sub">
              {contact.phone && `${contact.phone} · `}
              {opening !== 0 &&
                `${opening > 0 ? "Owed you" : "You owed them"} ${formatMoney(Math.abs(opening))} before SpendLog · `}
              Lent or paid for {formatMoney(contact.givenMinor)} · paid back {formatMoney(contact.returnedMinor)}
              {cleared !== 0 && ` · cleared ${formatMoney(Math.abs(cleared))} without money moving`}
            </p>
          </div>
          <div className="people-detail-figure">
            <div className="t-label">{balance > 0 ? "Owes you" : balance < 0 ? "You owe" : "Balance"}</div>
            <div className={`people-big num${balance > 0 ? " is-owed" : balance === 0 ? " is-settled" : ""}`}>
              {balance === 0 ? "Settled up" : formatRupees(Math.abs(balance))}
            </div>
          </div>
        </div>

        {editing ? (
          <div className="people-edit">
            <label className="field">
              <span>Name</span>
              <input className="filter-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              <span>Phone</span>
              <input
                className="filter-input"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone"
              />
            </label>
            <label className="field people-edit-owed">
              <span>Already owed, before SpendLog</span>
              <OwedInput rupees={owed} theyOwe={theyOwe} onRupees={setOwed} onTheyOwe={setTheyOwe} />
            </label>
            <div className="people-actions">
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={save} disabled={!name.trim()}>
                Save
              </button>
            </div>
          </div>
        ) : (
          <div className="people-detail-actions">
            {balance !== 0 && (
              <button
                className="btn btn-primary btn-lg"
                onClick={() => setClearing(true)}
                title="Settled some other way - a gift, a favour - with no money moving"
              >
                <Icon name="ic-check" /> Clear
              </button>
            )}
            <button className="btn btn-lg" onClick={() => setEditing(true)}>
              <Icon name="ic-pencil" /> Edit
            </button>
            <span className="spacer" />
            <button
              className={`btn ${confirmDelete ? "btn-danger" : "btn-danger-text"}`}
              onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
            >
              <Icon name="ic-trash" />
              {confirmDelete ? "Really remove? Their transactions stay" : "Remove"}
            </button>
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
      </div>

      {clearing && (
        <ClearPanel
          contact={contact}
          onClose={() => setClearing(false)}
          onCleared={() => {
            setClearing(false);
            reload();
            onChanged();
          }}
        />
      )}

      <div className="card card-flush people-history-card">
        <div className="card-head people-history-head">
          <h2>History with {contact.name}</h2>
        </div>
        {detail === null ? (
          <div className="people-history-empty" aria-busy="true">
            <p className="skel-caption">Loading their history…</p>
            <span className="skel skel-line" style={{ width: "40%" }} />
            <span className="skel skel-line sm" style={{ width: "24%", marginTop: 8 }} />
          </div>
        ) : rows.length === 0 && opening === 0 ? (
          <div className="people-history-empty">
            <div className="empty-inline">
              Nothing with {contact.name} yet. If money changed hands before SpendLog, add it under Edit as what's
              already owed.
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table people-history">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What happened</th>
                  <th>Kind</th>
                  <th className="num">Amount</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) =>
                  row.kind === "groupOpening" ? (
                    // What a group said was owed when it began here; changed
                    // from the group's Starting balances.
                    <tr key={row.opening.id}>
                      <td className="people-date">{formatDayLabel(row.opening.setAt.slice(0, 10))}</td>
                      <td>
                        <div className="people-history-name">Opening balance in {row.opening.groupName}</div>
                        <div className="people-history-sub">
                          {row.opening.effectMinor > 0
                            ? `${contact.name} owes you ${formatRupees(row.opening.amountMinor)}`
                            : `You owe ${contact.name} ${formatRupees(row.opening.amountMinor)}`}
                          {row.opening.note && ` · ${row.opening.note}`}
                        </div>
                      </td>
                      <td>
                        <span className="badge badge-outline">Starting balance · no money moved</span>
                      </td>
                      <td className="num money-neutral">
                        {row.opening.effectMinor > 0 ? "+" : "−"}
                        {formatMoney(row.opening.amountMinor)}
                      </td>
                      <td />
                    </tr>
                  ) : row.kind === "transaction" ? (
                    <tr key={row.transaction.id}>
                      <td className="people-date">{formatDayLabel(row.transaction.occurredAt.slice(0, 10))}</td>
                      <td>
                        <div className="people-history-name">
                          {row.transaction.merchant ??
                            row.transaction.split?.groupLabel ??
                            (row.amountMinor > 0 ? "Lent" : "Paid back")}
                        </div>
                        <div className="people-history-sub">
                          {row.transaction.offLedger
                            ? `They paid${groupOf(row.transaction) ? ` · ${groupOf(row.transaction)!.name}` : ""}`
                            : groupOf(row.transaction)
                              ? `Split in ${groupOf(row.transaction)!.name}`
                              : row.transaction.isSettlement
                                ? "Settling up"
                                : row.transaction.split
                                  ? "Split"
                                  : "Lent"}
                        </div>
                      </td>
                      <td>{kindBadge(row.transaction, row.amountMinor)}</td>
                      <td className={`num ${row.amountMinor > 0 ? "money-out" : "money-in"}`}>
                        {row.amountMinor > 0 ? "−" : "+"}
                        {formatMoney(Math.abs(row.amountMinor))}
                      </td>
                      <td />
                    </tr>
                  ) : (
                    <tr key={row.clearance.id}>
                      <td className="people-date">{formatDayLabel(row.clearance.on.slice(0, 10))}</td>
                      <td>
                        <div className="people-history-name">
                          Cleared {formatRupees(row.clearance.amountMinor)}
                          {row.clearance.note && ` · ${row.clearance.note}`}
                        </div>
                        <div className="people-history-sub">
                          {row.clearance.direction === "OWED_TO_ME" ? "Off what they owed" : "Off what you owed"}
                        </div>
                      </td>
                      <td>
                        <span className="badge badge-outline">Cleared · no money moved</span>
                      </td>
                      <td className="num money-neutral">{formatMoney(Math.abs(row.clearance.effectMinor))}</td>
                      <td className="people-row-action">
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => undoClearance(row.clearance)}
                          title="Undo: it is owed again"
                        >
                          <Icon name="ic-undo" /> Undo
                        </button>
                      </td>
                    </tr>
                  )
                )}
                {/* Oldest, so last: where the running figure started. */}
                {opening !== 0 && (
                  <tr className="people-opening">
                    <td className="people-date">Before</td>
                    <td>
                      <div className="people-history-name">Starting balance</div>
                      <div className="people-history-sub">Before SpendLog</div>
                    </td>
                    <td>
                      <span className="badge badge-neutral">Starting</span>
                    </td>
                    <td className="num money-neutral">
                      {opening > 0 ? "Owed you " : "You owed "}
                      {formatMoney(Math.abs(opening))}
                    </td>
                    <td />
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Settles part or all of what is owed without money moving - they owed
 * ₹1,000 and bought you a ₹999 watch, so ₹999 is cleared and ₹1 is still
 * owed. Starts at the whole amount, since clearing everything is the usual
 * case, and can be brought down for a part. Opens inline, beside the
 * person, as the design's Clear panel.
 */
function ClearPanel({
  contact,
  onClose,
  onCleared,
}: {
  contact: Contact;
  onClose: () => void;
  onCleared: () => void;
}) {
  const outstanding = Math.abs(contact.balanceMinor);
  const wholeAmount = outstanding % 100 === 0 ? String(outstanding / 100) : (outstanding / 100).toFixed(2);
  const [amount, setAmount] = useState(wholeAmount);
  const [note, setNote] = useState("");
  const [date, setDate] = useState(istToday());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);

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
  const isAll = minor === outstanding;
  const share = outstanding > 0 ? Math.min(100, Math.max(0, (minor / outstanding) * 100)) : 0;

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
    <form
      className="card people-clear"
      role="region"
      aria-labelledby="people-clear-title"
      onSubmit={(event) => {
        event.preventDefault();
        if (!saving) void save();
      }}
    >
      <div className="people-clear-head">
        <h2 id="people-clear-title" className="t-title-section">
          {contact.balanceMinor > 0 ? `Clear what ${contact.name} owes` : `Clear what you owe ${contact.name}`}
        </h2>
        <button type="button" className="icon-btn round" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>
      </div>

      <div className="people-clear-fields">
        <label className="field">
          <span>Amount to clear</span>
          <div className="amount-input">
            <span className="prefix">₹</span>
            <input
              ref={amountRef}
              autoFocus
              className="filter-input input-lg"
              inputMode="decimal"
              value={amount}
              aria-invalid={!!problem && amount !== ""}
              onChange={(event) => {
                setAmount(event.target.value);
                setError(null);
              }}
              aria-describedby="people-clear-preview"
            />
          </div>
        </label>
        <label className="field">
          <span>Why (optional)</span>
          <input
            className="filter-input input-lg"
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
            className="filter-input input-lg"
            value={date}
            max={istToday()}
            onChange={(event) => setDate(event.target.value || istToday())}
          />
        </label>
      </div>

      <div className="chip-row" role="radiogroup" aria-label="How much">
        <button
          type="button"
          role="radio"
          aria-checked={isAll}
          className="chip"
          onClick={() => {
            setAmount(wholeAmount);
            setError(null);
          }}
        >
          {isAll && <Icon name="ic-check" />}
          Clear all {formatRupees(outstanding)}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!isAll}
          className="chip"
          onClick={() => amountRef.current?.focus()}
        >
          {!isAll && <Icon name="ic-check" />}
          Part of it
        </button>
      </div>

      <div className={`people-clear-preview${problem ? " is-wrong" : ""}`} id="people-clear-preview">
        <div className="people-clear-line num">
          {owingSentence(contact.name, contact.balanceMinor, formatRupees(outstanding))}
          {" → "}
          {problem ? problem : left === 0 ? "settled up after this" : `${formatRupees(left)} left after this`}
        </div>
        <div className="meter people-clear-meter">
          <div className={`meter-fill ${problem ? "is-crit" : "is-ink"}`} style={{ width: `${share}%` }} />
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="people-clear-foot">
        <p className="people-clear-note">
          <Icon name="ic-info" />
          No money moves, and nothing counts as spending or income. You can undo it from the history.
        </p>
        <button type="button" className="btn btn-ghost btn-lg" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-lg" disabled={saving || !!problem}>
          {saving ? "Clearing…" : `Clear ${minor > 0 && !problem ? formatRupees(minor) : ""}`.trim()}
        </button>
      </div>
    </form>
  );
}
