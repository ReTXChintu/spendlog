import { formatMoneyShort } from "../lib/format";
import { GroupMemberKind, GroupOpening, OpeningDirection, OpeningInput } from "../types";

/** One person in the starting-balances editor, as typed. */
export interface OpeningRow {
  memberId: string;
  name: string;
  memberKind: GroupMemberKind;
  rupees: string;
  direction: OpeningDirection;
  /** Set when the other person already said what's owed between you: theirs stands. */
  setByThem?: string | null;
}

/** Rupees typed, in paise; 0 for nothing usable. */
function paiseOf(rupees: string): number {
  const value = Number(rupees.trim().replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}

/** Whole rupees without the ".00", for editing what was saved. */
export function rupeesOf(paise: number): string {
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/**
 * What the editor sends: one entry per person with an amount - leaving
 * someone at nothing takes theirs away.
 */
export function openingsBody(rows: OpeningRow[]): OpeningInput[] {
  return rows
    .filter((row) => !row.setByThem && paiseOf(row.rupees) > 0)
    .map((row) => ({
      memberKind: row.memberKind,
      ...(row.memberKind === "contact" ? { contactId: row.memberId } : { userId: row.memberId }),
      direction: row.direction,
      amountMinor: paiseOf(row.rupees),
    }));
}

/**
 * "Rahul owes you ₹1,200", "You owe Priya ₹450", or - between two other
 * people - "Meera owes Asha ₹300": an opening from the caller's side.
 */
export function openingSentence(opening: GroupOpening): string {
  const money = formatMoneyShort(opening.amountMinor);
  const other = opening.isMine ? opening.memberName : opening.setByName;
  if (opening.viewerDirection === "owes_me") return `${other} owes you ${money}`;
  if (opening.viewerDirection === "i_owe") return `You owe ${other} ${money}`;
  return `${opening.fromName} owes ${opening.toName} ${money}`;
}

/**
 * Every person with an amount and "Owes me / I owe": what was already owed
 * when a running group came into SpendLog. In the new-group form and in a
 * group's Starting balances.
 */
export function GroupOpeningsEditor({
  rows,
  onChange,
  disabled = false,
}: {
  rows: OpeningRow[];
  onChange: (rows: OpeningRow[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<OpeningRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <div className="group-openings">
      {rows.map((row, index) => (
        <div className="group-opening-row" key={row.memberId}>
          <span className="trip-who">
            <span className={`avatar${row.memberKind === "contact" ? " is-contact" : ""}`}>
              {row.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="group-person-text">
              {row.name}
              <span className="group-person-sub">
                {row.memberKind === "contact" ? "Your contact · on People too" : "On SpendLog · settles in the group"}
              </span>
            </span>
          </span>
          {row.setByThem ? (
            <span className="t-caption">
              {row.name} already set this: {row.setByThem}. Only they can change it.
            </span>
          ) : (
            <span className="owed-input">
              <span className="amount-input">
                <span className="prefix">₹</span>
                <input
                  className="filter-input"
                  inputMode="decimal"
                  placeholder="0"
                  value={row.rupees}
                  disabled={disabled}
                  onChange={(e) => update(index, { rupees: e.target.value })}
                  aria-label={`Amount for ${row.name}`}
                />
              </span>
              <span className="seg" role="radiogroup" aria-label={`Which way, with ${row.name}`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={row.direction === "owes_me"}
                  className={row.direction === "owes_me" ? "on" : ""}
                  disabled={disabled}
                  onClick={() => update(index, { direction: "owes_me" })}
                >
                  Owes me
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={row.direction === "i_owe"}
                  className={row.direction === "i_owe" ? "on" : ""}
                  disabled={disabled}
                  onClick={() => update(index, { direction: "i_owe" })}
                >
                  I owe
                </button>
              </span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
