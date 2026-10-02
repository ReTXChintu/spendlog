import { Account, accountLabel } from "../../types";

/**
 * The picker's value for cash. "No account" and the user's CASH account
 * are the same place to the balances, so they are one option here; it is
 * sent as the cash account's id when there is one.
 */
export const CASH = "__cash";

/** What the picker shows for an account id from the server. */
export function toPickerValue(id: string | null | undefined, cash: Account | undefined): string {
  if (!id) return CASH;
  if (cash && id === cash.id) return CASH;
  return id;
}

/** What the server is sent for a picker value. "" is "not chosen". */
export function fromPickerValue(value: string, cash: Account | undefined): string | null {
  if (value === CASH) return cash?.id ?? null;
  return value || null;
}

export function pickerValueName(value: string, accounts: Account[]): string | null {
  if (value === CASH) return "Cash";
  const account = accounts.find((a) => a.id === value);
  return account ? accountLabel(account) : null;
}

export function AccountSelect({
  id,
  label,
  value,
  onChange,
  accounts,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  accounts: Account[];
  /** Offers "not chosen" - only for the far side of an old transfer. */
  placeholder?: string;
}) {
  const listed = accounts.filter(
    (account) => account.accountType !== "CASH" && (account.isActive || account.id === value)
  );

  return (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="filter-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {placeholder && <option value="">{placeholder}</option>}
        <option value={CASH}>Cash</option>
        {listed.map((account) => (
          <option key={account.id} value={account.id}>
            {accountLabel(account)}
          </option>
        ))}
      </select>
    </div>
  );
}
