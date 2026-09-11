import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Account, AccountType, accountLabel } from "../types";
import { Icon } from "./Icon";

const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: "BANK", label: "Bank" },
  { value: "CARD", label: "Card" },
  { value: "UPI", label: "UPI" },
  { value: "CASH", label: "Cash" },
];

/**
 * Add or edit one account.
 *
 * Most accounts appear on their own the first time a bank texts, named
 * however that bank writes it. This is where they get a name worth reading,
 * and where the card details EMIs need are filled in.
 */
export function AccountModal({
  account,
  accounts,
  onSaved,
  onClose,
}: {
  /** null means "add a new one". */
  account: Account | null;
  /** The rest, for the merge picker. */
  accounts: Account[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const isNew = account === null;

  const [bankName, setBankName] = useState(account?.bankName ?? "");
  const [nickname, setNickname] = useState(account?.nickname ?? "");
  const [last4, setLast4] = useState(account?.last4 ?? "");
  const [accountType, setAccountType] = useState<AccountType>(account?.accountType ?? "BANK");
  const [issuer, setIssuer] = useState(account?.issuer ?? "");
  const [cardNetwork, setCardNetwork] = useState(account?.cardNetwork ?? "");
  const [creditLimit, setCreditLimit] = useState(
    account?.creditLimitMinor != null ? (account.creditLimitMinor / 100).toFixed(0) : ""
  );
  const [statementDay, setStatementDay] = useState(account?.statementDay?.toString() ?? "");
  const [dueDay, setDueDay] = useState(account?.dueDay?.toString() ?? "");
  const [isActive, setIsActive] = useState(account?.isActive ?? true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mergeInto, setMergeInto] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function numberOrNull(value: string): number | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function save() {
    if (!bankName.trim()) {
      setError("The bank or card issuer needs a name.");
      return;
    }
    if (last4.trim() && !/^\d{2,6}$/.test(last4.trim())) {
      setError("Last digits should be 2 to 6 numbers, or left blank.");
      return;
    }

    setSaving(true);
    setError(null);
    const limit = numberOrNull(creditLimit);
    const body = {
      bankName: bankName.trim(),
      nickname: nickname.trim() || null,
      last4: last4.trim() || null,
      accountType,
      issuer: issuer.trim() || null,
      cardNetwork: cardNetwork.trim() || null,
      creditLimitMinor: limit === null ? null : limit * 100,
      statementDay: numberOrNull(statementDay),
      dueDay: numberOrNull(dueDay),
      isActive,
    };

    try {
      if (isNew) await api.post("/accounts", body);
      else await api.patch(`/accounts/${account.id}`, body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that account.");
      setSaving(false);
    }
  }

  async function remove(unassign: boolean) {
    if (!account) return;
    setSaving(true);
    setError(null);
    try {
      await api.delete(`/accounts/${account.id}${unassign ? "?unassign=true" : ""}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that account.");
      setSaving(false);
      setConfirmDelete(false);
    }
  }

  async function merge() {
    if (!account || !mergeInto) return;
    setSaving(true);
    setError(null);
    try {
      // The chosen account survives, so this one is the source.
      await api.post(`/accounts/${mergeInto}/merge`, { fromId: account.id });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't merge those accounts.");
      setSaving(false);
    }
  }

  const others = accounts.filter((a) => a.id !== account?.id);
  const isCard = accountType === "CARD";
  // Cash has no issuer and no last four digits; asking for them would only
  // invite a wrong answer.
  const isCash = accountType === "CASH";

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal modal-wide">
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>
        <h3>{isNew ? "Add an account" : "Edit account"}</h3>
        <div className="modal-sub">
          <Icon name="ic-lock" />
          <span>
            {isNew
              ? "For anything your bank doesn't text you about — cash, or an account that never sends alerts."
              : "The name is yours to choose; the bank name is what incoming messages are matched against."}
          </span>
        </div>

        <div className="form-grid">
          <label className="field">
            <span>Name it</span>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Salary account"
              autoFocus
            />
          </label>

          <label className="field">
            <span>Type</span>
            <select value={accountType} onChange={(e) => setAccountType(e.target.value as AccountType)}>
              {ACCOUNT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {!isCash && (
            <>
              <label className="field">
                <span>Bank name</span>
                <input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  placeholder="HDFC Bank"
                />
              </label>

              <label className="field">
                <span>Last digits</span>
                <input
                  value={last4}
                  onChange={(e) => setLast4(e.target.value)}
                  placeholder="1377"
                  inputMode="numeric"
                />
              </label>
            </>
          )}

          {isCard && (
            <>
              <label className="field">
                <span>Network</span>
                <input
                  value={cardNetwork}
                  onChange={(e) => setCardNetwork(e.target.value)}
                  placeholder="Visa, Mastercard, RuPay"
                />
              </label>

              <label className="field">
                <span>Credit limit (₹)</span>
                <input
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  placeholder="200000"
                  inputMode="numeric"
                />
              </label>

              <label className="field">
                <span>Statement day</span>
                <input
                  value={statementDay}
                  onChange={(e) => setStatementDay(e.target.value)}
                  placeholder="18"
                  inputMode="numeric"
                />
              </label>

              <label className="field">
                <span>Payment due day</span>
                <input
                  value={dueDay}
                  onChange={(e) => setDueDay(e.target.value)}
                  placeholder="7"
                  inputMode="numeric"
                />
              </label>
            </>
          )}
        </div>

        <label className="checkbox-row">
          <input type="checkbox" checked={!isActive} onChange={(e) => setIsActive(!e.target.checked)} />
          <span>Closed — keep its history, but hide it when picking an account</span>
        </label>

        {!isNew && account.aliases.length > 0 && (
          <p className="modal-footnote">
            <Icon name="ic-info" />
            Also recognised as {account.aliases.map((a) => a.bankName).join(", ")}
          </p>
        )}

        {!isNew && others.length > 0 && (
          <div className="merge-row">
            <label className="field">
              <span>Same account as</span>
              <select value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
                <option value="">Merge this into…</option>
                {others.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountLabel(a)}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-sm" disabled={!mergeInto || saving} onClick={merge}>
              Merge
            </button>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}

        <div className="modal-actions">
          {!isNew &&
            (confirmDelete ? (
              <>
                <button className="btn btn-sm btn-danger" disabled={saving} onClick={() => remove(true)}>
                  Delete anyway
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
              </>
            ) : (
              <button className="btn btn-sm btn-ghost btn-danger-text" onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            ))}
          <span className="modal-actions-spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={saving} onClick={save}>
            {saving ? "Saving…" : isNew ? "Add account" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
