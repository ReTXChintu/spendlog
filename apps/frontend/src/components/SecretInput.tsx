import { InputHTMLAttributes, forwardRef, useState } from "react";
import { Icon } from "./Icon";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** What the field holds, for the eye button's label: "Show password", "Show PIN", "Show key". */
  noun?: string;
  /** Class for the wrapper, e.g. to size it in a row. */
  wrapClassName?: string;
};

/**
 * A password, PIN or key field with an eye button that shows and hides what
 * was typed (design system §7.2). Every secret field in the app uses this.
 * When shown, the value switches to Plex Mono so ambiguous characters read
 * clearly. The wrapper takes the field's width; the input fills it.
 */
export const SecretInput = forwardRef<HTMLInputElement, Props>(function SecretInput(
  { noun = "password", wrapClassName = "", className = "filter-input", ...rest },
  ref
) {
  const [shown, setShown] = useState(false);
  return (
    <div className={`secret-field ${wrapClassName}`.trim()}>
      <input
        {...rest}
        ref={ref}
        type={shown ? "text" : "password"}
        className={`${className}${shown ? " is-shown" : ""}`}
      />
      <button
        type="button"
        className="secret-toggle"
        aria-label={`${shown ? "Hide" : "Show"} ${noun}`}
        aria-pressed={shown}
        title={`${shown ? "Hide" : "Show"} ${noun}`}
        onClick={() => setShown((value) => !value)}
      >
        <Icon name={shown ? "ic-eye-off" : "ic-eye"} />
      </button>
    </div>
  );
});
