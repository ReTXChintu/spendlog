import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { formatMoney } from "../lib/format";
import { Contact } from "../types";
import { Icon } from "./Icon";

/** An even split of `totalMinor` across `count` people, remainder first. */
export function evenShares(totalMinor: number, count: number): number[] {
  if (count <= 0) return [];
  const each = Math.floor(totalMinor / count);
  const shares = Array.from({ length: count }, () => each);
  shares[0] += totalMinor - each * count;
  return shares;
}

export function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

/** Rupees typed into a box, as paise. Anything unreadable is zero. */
export function toMinor(rupees: string): number {
  const minor = Math.round(Number.parseFloat(rupees || "0") * 100);
  return Number.isFinite(minor) ? Math.max(0, minor) : 0;
}

/**
 * Picks someone from the user's own people.
 *
 * Only existing contacts: a name typed here on the fly is how "Rahul" and
 * "rahul k" end up as two people with half a balance each. Adding someone
 * new is one link away, on the People page, where the name gets a second
 * look.
 */
export function PeoplePicker({
  contacts,
  excludeIds,
  onPick,
  placeholder = "Add a person",
}: {
  contacts: Contact[] | null;
  /** Already picked, so not offered again. */
  excludeIds: string[];
  onPick: (contact: Contact) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  const chosen = new Set(excludeIds);
  const needle = query.trim().toLowerCase();
  const matches = (contacts ?? [])
    .filter((contact) => !chosen.has(contact.id))
    .filter((contact) => !needle || contact.name.toLowerCase().includes(needle) || contact.phone?.includes(needle))
    .slice(0, 8);

  useEffect(() => setActive(0), [needle]);

  function pick(contact: Contact) {
    onPick(contact);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="people-add">
      <div className="filter-input-icon">
        <Icon name="ic-search" />
        <input
          className="filter-input"
          placeholder={contacts === null ? "Loading your people…" : placeholder}
          value={query}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={placeholder}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, Math.max(0, matches.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (matches[active]) pick(matches[active]);
            } else if (e.key === "Escape" && open) {
              // Closes the list, not the whole form around it.
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </div>
      {open && contacts !== null && (
        <div className="people-menu" role="listbox" id={listId}>
          {matches.map((contact, index) => (
            <button
              type="button"
              key={contact.id}
              role="option"
              aria-selected={index === active}
              className={`people-option${index === active ? " is-active" : ""}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(contact)}
            >
              <span className="people-avatar">{initialOf(contact.name)}</span>
              <span>{contact.name}</span>
              {contact.balanceMinor !== 0 && (
                <span className={`people-option-balance ${contact.balanceMinor > 0 ? "credit" : "debit"}`}>
                  {contact.balanceMinor > 0 ? "owes you " : "you owe "}
                  {formatMoney(Math.abs(contact.balanceMinor))}
                </span>
              )}
            </button>
          ))}
          {matches.length === 0 && (
            <p className="people-menu-empty">
              {contacts.length === 0
                ? "You haven't added anyone yet."
                : needle
                  ? `No one called “${query.trim()}”.`
                  : "Everyone's already picked."}{" "}
              <Link to="/people">Add people</Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One person and their amount. Holds what is being typed apart from the
 * value, so "40" is not reformatted to "40.00" under the cursor.
 */
export function PersonRow({
  name,
  amountMinor,
  onAmount,
  onRemove,
  readOnly = false,
  note,
  isMe = false,
}: {
  name: string;
  amountMinor: number;
  /** Omitted for a figure worked out rather than typed. */
  onAmount?: (minor: number) => void;
  onRemove?: () => void;
  readOnly?: boolean;
  note?: string;
  isMe?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const editable = !readOnly && !!onAmount;

  return (
    <div className={`people-row${isMe ? " is-me" : ""}`}>
      <span className="people-avatar">{isMe ? "You" : initialOf(name)}</span>
      <span className="people-name">
        {name}
        {note && <span className="people-row-note">{note}</span>}
      </span>
      {editable ? (
        <span className="amount-input">
          <span className="prefix">₹</span>
          <input
            className="filter-input"
            inputMode="decimal"
            value={draft ?? (amountMinor / 100).toFixed(2)}
            onChange={(e) => {
              setDraft(e.target.value);
              onAmount!(toMinor(e.target.value));
            }}
            onFocus={(e) => e.target.select()}
            onBlur={() => setDraft(null)}
            aria-label={`Amount for ${name}`}
          />
        </span>
      ) : (
        <span className="people-row-amount num">{formatMoney(amountMinor)}</span>
      )}
      {onRemove ? (
        <button type="button" className="icon-button" aria-label={`Remove ${name}`} onClick={onRemove}>
          <Icon name="ic-x" />
        </button>
      ) : (
        <span className="people-row-spacer" aria-hidden="true" />
      )}
    </div>
  );
}
