import { Link } from "react-router-dom";
import { formatMoney } from "../../lib/format";
import { Contact, TransactionType } from "../../types";
import { PeoplePicker, PersonRow } from "../PeoplePicker";
import { SplitDraft, SplitResult } from "./split";

/**
 * Who a split was with, and how it divides.
 *
 * "Include me" is the whole difference between a split and lending: with
 * me left out, my share is nothing and all of it is owed back. Equal is
 * the default because most splits are; custom is there for the ones that
 * are not, and in it my share is simply whatever nobody else owes.
 */
export function SplitPanel({
  type,
  totalMinor,
  contacts,
  draft,
  result,
  onChange,
  onPersonAdded,
}: {
  type: TransactionType;
  totalMinor: number;
  contacts: Contact[] | null;
  draft: SplitDraft;
  result: SplitResult;
  onChange: (next: SplitDraft) => void;
  onPersonAdded: (contact: Contact, isFirst: boolean) => void;
}) {
  const nameOf = new Map((contacts ?? []).map((contact) => [contact.id, contact.name]));
  const isDebit = type === "DEBIT";

  function setMode(mode: SplitDraft["mode"]) {
    if (mode === draft.mode) return;
    // Custom starts from what equal was showing, so switching is a tweak
    // rather than a blank slate. Back to equal drops any unnamed remainder.
    onChange(
      mode === "custom"
        ? { ...draft, mode, people: result.people }
        : { ...draft, mode, unnamedMinor: 0 }
    );
  }

  function add(contact: Contact) {
    const isFirst = draft.people.length === 0;
    let amountMinor = 0;
    if (draft.mode === "custom") {
      const heads = draft.people.length + 1 + (draft.includeMe ? 1 : 0);
      const available = draft.includeMe ? result.myShareMinor : result.leftoverMinor;
      amountMinor = Math.min(Math.floor(totalMinor / heads), available);
      if (isFirst && !draft.includeMe) amountMinor = totalMinor;
    }
    onChange({ ...draft, people: [...draft.people, { contactId: contact.id, amountMinor }] });
    onPersonAdded(contact, isFirst);
  }

  function setAmount(contactId: string, amountMinor: number) {
    onChange({
      ...draft,
      people: draft.people.map((person) => (person.contactId === contactId ? { ...person, amountMinor } : person)),
    });
  }

  const shown = draft.mode === "equal" ? result.people : draft.people;

  return (
    <div className="tx-split">
      <div className="tx-split-controls">
        <label className="tx-switch">
          <input
            type="checkbox"
            checked={draft.includeMe}
            onChange={(e) => onChange({ ...draft, includeMe: e.target.checked })}
          />
          <span className="tx-switch-track" aria-hidden="true" />
          <span>Include me</span>
        </label>
        {draft.people.length > 0 && (
          <div className="seg seg-sm" role="radiogroup" aria-label="How to divide it">
            <button
              type="button"
              role="radio"
              aria-checked={draft.mode === "equal"}
              className={draft.mode === "equal" ? "on" : ""}
              onClick={() => setMode("equal")}
            >
              Split equally
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={draft.mode === "custom"}
              className={draft.mode === "custom" ? "on" : ""}
              onClick={() => setMode("custom")}
            >
              Custom amounts
            </button>
          </div>
        )}
      </div>

      <div className="tx-split-rows">
        {draft.includeMe && (
          <PersonRow
            isMe
            name="My share"
            note={
              draft.people.length === 0
                ? "type it, or add people below"
                : draft.mode === "custom"
                  ? "whatever nobody else owes"
                  : undefined
            }
            amountMinor={result.myShareMinor}
            onAmount={
              draft.people.length === 0
                ? (minor) => onChange({ ...draft, shareWithoutPeople: (minor / 100).toFixed(2) })
                : undefined
            }
            readOnly={draft.people.length > 0}
          />
        )}
        {shown.map((person) => (
          <PersonRow
            key={person.contactId}
            name={nameOf.get(person.contactId) ?? "…"}
            amountMinor={person.amountMinor}
            readOnly={draft.mode === "equal"}
            onAmount={(minor) => setAmount(person.contactId, minor)}
            onRemove={() =>
              onChange({ ...draft, people: draft.people.filter((other) => other.contactId !== person.contactId) })
            }
          />
        ))}
        {draft.unnamedMinor > 0 && (
          <PersonRow
            name="Someone not named"
            note="from before people were added — remove to make it yours"
            amountMinor={draft.unnamedMinor}
            readOnly
            onRemove={() => onChange({ ...draft, unnamedMinor: 0 })}
          />
        )}
      </div>

      <div className="tx-people-add">
        <PeoplePicker
          contacts={contacts}
          excludeIds={draft.people.map((person) => person.contactId)}
          onPick={add}
          placeholder={
            draft.people.length
              ? "Add someone else"
              : isDebit
                ? draft.includeMe
                  ? "Who was it split with?"
                  : "Who did you lend it to?"
                : "Whose money is part of it?"
          }
        />
        <Link to="/people" className="tx-manage-link">
          Manage people
        </Link>
      </div>

      <div className="form-row">
        <label htmlFor="e-group">What for</label>
        <input
          id="e-group"
          className="filter-input"
          placeholder={isDebit ? "Goa trip, flat rent…" : "Roommate reimbursement"}
          value={draft.groupLabel}
          onChange={(e) => onChange({ ...draft, groupLabel: e.target.value })}
        />
      </div>

      {result.error ? (
        <p className="form-error tx-inline-error" role="alert">
          {result.error}
        </p>
      ) : (
        <p className="field-hint">
          {!draft.includeMe && draft.people.length === 0
            ? `Pick who you ${isDebit ? "lent it to" : "got it from"} — all ${formatMoney(totalMinor)} is theirs.`
            : result.leftoverMinor > 0
              ? `${formatMoney(result.leftoverMinor)} isn't on anyone yet — give it to someone, or include yourself.`
              : isDebit
                ? result.othersMinor > 0
                  ? `${formatMoney(result.othersMinor)} is owed back to you; ${formatMoney(result.myShareMinor)} is your spending.`
                  : "All of it is your own spending."
                : result.othersMinor > 0
                  ? `${formatMoney(result.othersMinor)} is money coming back, not income; ${formatMoney(result.myShareMinor)} counts as income.`
                  : "All of it counts as income."}
        </p>
      )}
    </div>
  );
}
