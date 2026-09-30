import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";
import { Contact, ContactList, PersonShare } from "../types";
import { Icon } from "./Icon";

/**
 * Who a split or a settling-up was with, and how much each.
 *
 * The amounts start as an even share of whatever was not the user's own,
 * because that is what most splits are, and stay editable because the
 * rest are not. Any paise left over from dividing go on the first person
 * rather than vanishing.
 */

/** An even split of `totalMinor` across `count` people, remainder first. */
export function evenShares(totalMinor: number, count: number): number[] {
  if (count <= 0) return [];
  const each = Math.floor(totalMinor / count);
  const shares = Array.from({ length: count }, () => each);
  shares[0] += totalMinor - each * count;
  return shares;
}

export function PeoplePicker({
  title,
  roomMinor,
  value,
  onChange,
}: {
  title: string;
  /** How much can be put down to other people at all. */
  roomMinor: number;
  value: PersonShare[];
  onChange: (next: PersonShare[]) => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What is being typed into an amount, so "40" is not reformatted to
  // "40.00" under the cursor mid-keystroke.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .get<ContactList>("/contacts")
      .then((list) => setContacts(list.contacts))
      .catch(() => setContacts([]));
  }, []);

  const nameOf = useMemo(() => new Map(contacts.map((contact) => [contact.id, contact.name])), [contacts]);
  const chosen = new Set(value.map((person) => person.contactId));
  const needle = query.trim().toLowerCase();
  const matches = contacts
    .filter((contact) => !chosen.has(contact.id))
    .filter((contact) => !needle || contact.name.toLowerCase().includes(needle) || contact.phone?.includes(needle))
    .slice(0, 8);

  function withEvenShares(ids: string[]): PersonShare[] {
    const shares = evenShares(roomMinor, ids.length);
    return ids.map((contactId, index) => ({ contactId, amountMinor: shares[index] }));
  }

  function add(contact: Contact) {
    onChange(withEvenShares([...value.map((person) => person.contactId), contact.id]));
    setQuery("");
    setOpen(false);
  }

  async function addNew() {
    const name = query.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    try {
      const created = await api.post<Contact>("/contacts", { name });
      setContacts((current) => (current.some((c) => c.id === created.id) ? current : [...current, created]));
      add(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add them.");
    } finally {
      setAdding(false);
    }
  }

  function setAmount(contactId: string, rupees: string) {
    const minor = Math.round(Number.parseFloat(rupees || "0") * 100);
    onChange(
      value.map((person) =>
        person.contactId === contactId ? { ...person, amountMinor: Number.isFinite(minor) ? Math.max(0, minor) : 0 } : person
      )
    );
  }

  const assigned = value.reduce((sum, person) => sum + person.amountMinor, 0);

  return (
    <div className="people-picker">
      <div className="people-picker-head">
        <span className="people-picker-title">{title}</span>
        {value.length > 1 && (
          <button
            type="button"
            className="link-button"
            onClick={() => onChange(withEvenShares(value.map((person) => person.contactId)))}
          >
            Split evenly
          </button>
        )}
      </div>

      {value.map((person) => (
        <div className="people-row" key={person.contactId}>
          <span className="people-avatar">{initial(nameOf.get(person.contactId) ?? "?")}</span>
          <span className="people-name">{nameOf.get(person.contactId) ?? "…"}</span>
          <span className="amount-input">
            <span className="prefix">₹</span>
            <input
              className="filter-input"
              inputMode="decimal"
              value={drafts[person.contactId] ?? (person.amountMinor / 100).toFixed(2)}
              onChange={(e) => {
                setDrafts((current) => ({ ...current, [person.contactId]: e.target.value }));
                setAmount(person.contactId, e.target.value);
              }}
              onBlur={() =>
                setDrafts((current) => {
                  const next = { ...current };
                  delete next[person.contactId];
                  return next;
                })
              }
              aria-label={`Amount for ${nameOf.get(person.contactId) ?? "them"}`}
            />
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Remove"
            onClick={() => onChange(value.filter((other) => other.contactId !== person.contactId))}
          >
            <Icon name="ic-x" />
          </button>
        </div>
      ))}

      <div className="people-add">
        <input
          className="filter-input"
          placeholder={value.length ? "Add someone else" : "Add a person — type a name"}
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (matches[0]) add(matches[0]);
              else addNew();
            }
          }}
        />
        {open && (matches.length > 0 || needle) && (
          <div className="people-menu" role="listbox">
            {matches.map((contact) => (
              <button
                type="button"
                key={contact.id}
                className="people-option"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(contact)}
              >
                <span className="people-avatar">{initial(contact.name)}</span>
                <span>{contact.name}</span>
                {contact.balanceMinor !== 0 && (
                  <span className={`people-option-balance ${contact.balanceMinor > 0 ? "credit" : "debit"}`}>
                    {contact.balanceMinor > 0 ? "owes you " : "you owe "}
                    {formatMoney(Math.abs(contact.balanceMinor))}
                  </span>
                )}
              </button>
            ))}
            {needle && !contacts.some((contact) => contact.name.toLowerCase() === needle) && (
              <button
                type="button"
                className="people-option is-new"
                disabled={adding}
                onMouseDown={(e) => e.preventDefault()}
                onClick={addNew}
              >
                <Icon name="ic-plus" /> Add “{query.trim()}” as a new person
              </button>
            )}
          </div>
        )}
      </div>

      {value.length > 0 && (
        <p className={`field-hint${assigned > roomMinor ? " set-warn" : ""}`}>
          {formatMoney(assigned)} of {formatMoney(roomMinor)} assigned
          {assigned > roomMinor
            ? " — more than wasn't yours. Lower someone's amount, or your share."
            : assigned < roomMinor
              ? ` · ${formatMoney(roomMinor - assigned)} not put down to anyone`
              : ""}
        </p>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}
