import { useState } from "react";
import { MerchantPreset } from "../../types";

/** How many saved merchants show before "more", so they stay one line. */
const PRESETS_SHOWN = 6;

/**
 * The merchant box with the user's saved merchants under it. A saved
 * merchant fills the name and its usual category in one go.
 */
export function MerchantField({
  value,
  placeholder,
  presets,
  onType,
  onPreset,
  onSavePreset,
  onRemovePreset,
}: {
  value: string;
  placeholder: string;
  presets: MerchantPreset[];
  onType: (value: string) => void;
  onPreset: (preset: MerchantPreset) => void;
  onSavePreset: () => void;
  onRemovePreset: (preset: MerchantPreset) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const typed = value.trim().toLowerCase();
  const isSaved = presets.some((preset) => preset.merchant.toLowerCase() === typed);
  const shown = showAll ? presets : presets.slice(0, PRESETS_SHOWN);

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
