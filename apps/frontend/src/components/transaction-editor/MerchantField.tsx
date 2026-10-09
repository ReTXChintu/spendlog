import { useState } from "react";
import { Contact, MerchantPreset } from "../../types";
import { Icon } from "../Icon";

/** How many saved merchants show before "more", so they stay one line. */
const PRESETS_SHOWN = 6;
/** How many people a typed name offers at once. */
const PEOPLE_SHOWN = 4;

/**
 * The merchant box with the user's saved merchants under it. A saved
 * merchant fills the name and its usual category in one go.
 *
 * As a name is typed, the people it could be are offered too. Picking one
 * says the money went to (or came from) that person, which the editor
 * turns into lent or paid back - see pickPerson there.
 */
export function MerchantField({
  value,
  placeholder,
  presets,
  people,
  personPicked,
  onType,
  onPreset,
  onPerson,
  onSavePreset,
  onRemovePreset,
}: {
  value: string;
  placeholder: string;
  presets: MerchantPreset[];
  people: Contact[] | null;
  /** The person this is already lent to or paid back by, if any. */
  personPicked: string | null;
  onType: (value: string) => void;
  onPreset: (preset: MerchantPreset) => void;
  onPerson: (contact: Contact) => void;
  onSavePreset: () => void;
  onRemovePreset: (preset: MerchantPreset) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const typed = value.trim().toLowerCase();
  const isSaved = presets.some((preset) => preset.merchant.toLowerCase() === typed);
  const shown = showAll ? presets : presets.slice(0, PRESETS_SHOWN);
  // Names that start with what was typed first, then any that contain it:
  // "ra" means Rahul before it means Bharat.
  const matches = typed
    ? (people ?? [])
        .filter((person) => person.name.toLowerCase().includes(typed))
        .sort(
          (a, b) =>
            Number(!a.name.toLowerCase().startsWith(typed)) - Number(!b.name.toLowerCase().startsWith(typed)) ||
            a.name.localeCompare(b.name)
        )
        .slice(0, PEOPLE_SHOWN)
    : [];

  return (
    <div className="form-row">
      <label htmlFor="e-merchant">Merchant</label>
      <input
        id="e-merchant"
        className="filter-input"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onType(e.target.value)}
        autoComplete="off"
      />
      {matches.length > 0 && (
        <div className="preset-row tx-presets" aria-label="People">
          {matches.map((person) => (
            <button
              key={person.id}
              type="button"
              className={`preset-chip tx-person-chip${person.id === personPicked ? " is-current" : ""}`}
              onClick={() => onPerson(person)}
              title={`Money between you and ${person.name} - not spending or income`}
            >
              <Icon name="ic-people" />
              {person.name}
            </button>
          ))}
        </div>
      )}
      {(presets.length > 0 || (typed && !isSaved)) && (
        <div className="preset-row tx-presets">
          {shown.map((preset) => {
            const isCurrent = preset.merchant.toLowerCase() === typed;
            return (
              <span
                key={preset.id}
                className={`preset-chip${isCurrent ? " is-current" : ""}`}
                onClick={() => onPreset(preset)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPreset(preset);
                  }
                }}
              >
                {preset.category?.color && (
                  <span className="preset-dot" style={{ background: preset.category.color }} />
                )}
                {preset.merchant}
                <button
                  type="button"
                  className="preset-remove"
                  title={`Forget ${preset.merchant}`}
                  aria-label={`Forget ${preset.merchant}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemovePreset(preset);
                  }}
                >
                  ×
                </button>
              </span>
            );
          })}
          {presets.length > PRESETS_SHOWN && (
            <button type="button" className="preset-save" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Fewer" : `+${presets.length - PRESETS_SHOWN} more`}
            </button>
          )}
          {typed && !isSaved && (
            <button className="preset-save" onClick={onSavePreset} type="button">
              Save “{value.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  );
}
