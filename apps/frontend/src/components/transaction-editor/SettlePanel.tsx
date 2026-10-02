import { Link } from "react-router-dom";
import { formatMoney } from "../../lib/format";
import { Contact, PersonShare, TransactionType } from "../../types";
import { PeoplePicker, PersonRow, evenShares } from "../PeoplePicker";

/**
 * Who is being paid back, or paying back, and how much each.
 *
 * Usually it is one person and the whole amount, so the first person
 * picked gets all of it. Someone paying in parts is just several of these
 * over time, each against the same running balance.
 */
export function SettlePanel({
  type,
  totalMinor,
  contacts,
  people,
  onChange,
  onPersonAdded,
}: {
  type: TransactionType;
  totalMinor: number;
  contacts: Contact[] | null;
  people: PersonShare[];
  onChange: (next: PersonShare[]) => void;
  onPersonAdded: (contact: Contact, isFirst: boolean) => void;
}) {
  const nameOf = new Map((contacts ?? []).map((contact) => [contact.id, contact.name]));
  const assigned = people.reduce((sum, person) => sum + person.amountMinor, 0);
  const left = totalMinor - assigned;

  function add(contact: Contact) {
    const isFirst = people.length === 0;
    onChange([...people, { contactId: contact.id, amountMinor: Math.max(0, left) }]);
    onPersonAdded(contact, isFirst);
  }

  return (
    <div className="tx-split">
      <div className="tx-split-rows">
        {people.map((person) => {
          const contact = (contacts ?? []).find((c) => c.id === person.contactId);
          return (
            <PersonRow
              key={person.contactId}
              name={nameOf.get(person.contactId) ?? "…"}
              note={
                contact && contact.balanceMinor !== 0
                  ? contact.balanceMinor > 0
                    ? `owed you ${formatMoney(contact.balanceMinor)}`
                    : `you owed ${formatMoney(-contact.balanceMinor)}`
                  : undefined
              }
              amountMinor={person.amountMinor}
              onAmount={(minor) =>
                onChange(people.map((p) => (p.contactId === person.contactId ? { ...p, amountMinor: minor } : p)))
              }
              onRemove={() => onChange(people.filter((p) => p.contactId !== person.contactId))}
            />
          );
        })}
      </div>

      <div className="tx-people-add">
        <PeoplePicker
          contacts={contacts}
          excludeIds={people.map((person) => person.contactId)}
          onPick={add}
          placeholder={
            people.length ? "Add someone else" : type === "CREDIT" ? "Who paid you back?" : "Who did you pay back?"
          }
        />
        {people.length > 1 && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              const shares = evenShares(totalMinor, people.length);
              onChange(people.map((person, index) => ({ ...person, amountMinor: shares[index] })));
            }}
          >
            Split evenly
          </button>
        )}
        <Link to="/people" className="tx-manage-link">
          Manage people
        </Link>
      </div>

      {left < 0 ? (
        <p className="form-error tx-inline-error" role="alert">
          That's {formatMoney(-left)} more than the {formatMoney(totalMinor)} total.
        </p>
      ) : (
        <p className="field-hint">
          {people.length === 0
            ? type === "CREDIT"
              ? "Pick who paid. Part payments are fine — whatever they still owe stays on their balance."
              : "Pick who you paid back."
            : left > 0
              ? `${formatMoney(assigned)} of ${formatMoney(totalMinor)} put down to someone · ${formatMoney(left)} not on anyone`
              : type === "CREDIT"
                ? "Comes off what they owe you. Not income."
                : "Comes off what you owe them. Not spending."}
        </p>
      )}
    </div>
  );
}
