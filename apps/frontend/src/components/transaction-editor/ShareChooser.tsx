/**
 * Who a payment in a group was for: everyone equally (the default), just
 * the user, or a chosen few, equally between them.
 */
export type ShareMode = "everyone" | "mine" | "custom";

/** The share mode a saved `groupShareWith` stands for. */
export function shareModeOf(shareWith: string[] | null | undefined, myUserId: string | null | undefined): ShareMode {
  if (!shareWith || shareWith.length === 0) return "everyone";
  if (shareWith.length === 1 && myUserId && shareWith[0] === myUserId) return "mine";
  return "custom";
}

/** What `groupShareWith` is sent as for a mode: null means everyone. */
export function shareWithFor(mode: ShareMode, myUserId: string | null, chosen: string[]): string[] | null {
  if (mode === "everyone") return null;
  if (mode === "mine") return myUserId ? [myUserId] : null;
  return chosen;
}

export function ShareChooser({
  mode,
  onMode,
  people,
  chosen,
  onChosen,
  mineLabel = "Just mine",
}: {
  mode: ShareMode;
  onMode: (mode: ShareMode) => void;
  /** Everyone in the group; null while still loading. */
  people: { id: string; name: string }[] | null;
  chosen: string[];
  onChosen: (ids: string[]) => void;
  mineLabel?: string;
}) {
  return (
    <div className="field group-share">
      <span>Split</span>
      <div className="seg" role="radiogroup" aria-label="Split">
        {(
          [
            ["everyone", "Everyone equally"],
            ["mine", mineLabel],
            ["custom", "Choose who"],
          ] as [ShareMode, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={mode === value ? "on" : ""}
            onClick={() => onMode(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "custom" && (
        <div className="group-share-people">
          {people === null ? (
            <span className="field-hint">Loading who's in it…</span>
          ) : (
            people.map((person) => (
              <label className="tx-toggle" key={person.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(person.id)}
                  onChange={(e) =>
                    onChosen(e.target.checked ? [...chosen, person.id] : chosen.filter((id) => id !== person.id))
                  }
                />
                <span>{person.name}</span>
              </label>
            ))
          )}
          <span className="field-hint">Split equally between the people ticked.</span>
        </div>
      )}
    </div>
  );
}
