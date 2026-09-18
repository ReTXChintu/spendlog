import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Account, AccountType, CardNetwork, NETWORK_LABELS, accountLabel } from "../types";
import { Icon } from "./Icon";

const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: "BANK", label: "Bank account" },
  { value: "CARD", label: "Credit card" },
  { value: "DEBIT", label: "Debit card" },
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
  const [linkedAccountId, setLinkedAccountId] = useState(account?.linkedAccountId ?? "");
  const [sharesLimitWith, setSharesLimitWith] = useState(account?.sharesLimitWith ?? "");
  const [issuer, setIssuer] = useState(account?.issuer ?? "");
  const [cardNetwork, setCardNetwork] = useState(account?.cardNetwork ?? "");
  const [creditLimit, setCreditLimit] = useState(
    account?.creditLimitMinor != null ? (account.creditLimitMinor / 100).toFixed(0) : ""
  );
  const [spendLimit, setSpendLimit] = useState(
    account?.spendLimitMinor != null ? (account.spendLimitMinor / 100).toFixed(0) : ""
  );
  const [statementDay, setStatementDay] = useState(account?.statementDay?.toString() ?? "");
  const [dueDay, setDueDay] = useState(account?.dueDay?.toString() ?? "");
  const [isActive, setIsActive] = useState(account?.isActive ?? true);
  // Never pre-filled: the stored value is not readable, by design.
  const [statementPassword, setStatementPassword] = useState("");

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
      // Only ever sent for a debit card, and null rather than "" so the
      // server stores an absence rather than rejecting an empty id.
      linkedAccountId: accountType === "DEBIT" ? linkedAccountId || null : null,
      // Likewise only ever sent for a credit card.
      sharesLimitWith: accountType === "CARD" ? sharesLimitWith || null : null,
      issuer: issuer.trim() || null,
      // Stored in the canonical spelling, so every screen reading it back
      // gets the same word whatever was typed before the picker existed.
      cardNetwork: normaliseNetwork(cardNetwork) || null,
      creditLimitMinor: limit === null ? null : limit * 100,
      spendLimitMinor: (() => {
        const own = numberOrNull(spendLimit);
        return own === null ? null : own * 100;
      })(),
      statementDay: numberOrNull(statementDay),
      dueDay: numberOrNull(dueDay),
      isActive,
    };

    try {
      const saved = isNew
        ? await api.post<Account>("/accounts", body)
        : await api.patch<Account>(`/accounts/${account.id}`, body);

      // Sent separately because it is encrypted before it is stored and
      // never comes back out, so it cannot travel with the rest of the
      // account the way an ordinary field would.
      if (statementPassword.trim()) {
        await api.put(`/statements/password/${saved.id}`, { password: statementPassword.trim() });
      }

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

  // A credit card. Everything below that is about a cycle, a limit or a
  // statement belongs to one of these and to nothing else: a debit card is
  // a way of reaching an account rather than a line of credit, so it has
  // no billing period, no limit to run up against, and no statement of its
  // own - its spending turns up on the account's.
  const isCard = accountType === "CARD";
  const isDebit = accountType === "DEBIT";
  const banks = others.filter((candidate) => candidate.accountType === "BANK");
  // Cards this one could share a limit with: another credit card, and one
  // that is not itself drawing on a third - the server flattens a chain,
  // but offering the head of it is clearer than offering a link in it.
  const limitHolders = others.filter(
    (candidate) => candidate.accountType === "CARD" && !candidate.sharesLimitWith
  );
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

          {!isCash && (
            <label className="field">
              <span>{isCard ? "My limit a cycle (₹)" : "My limit a month (₹)"}</span>
              <input
                value={spendLimit}
                onChange={(e) => setSpendLimit(e.target.value)}
                placeholder="30000"
                inputMode="numeric"
              />
              <span className="field-hint">
                What you mean to spend, as opposed to what the bank allows. The dashboard warns you
                as you approach it{isCard ? " and marks it on this card's bar" : ""}.
              </span>
            </label>
          )}

          {isDebit && (
            <label className="field field-wide">
              <span>Draws on</span>
              <select
                value={linkedAccountId}
                onChange={(e) => setLinkedAccountId(e.target.value)}
                disabled={banks.length === 0}
              >
                <option value="">Nothing — it stands on its own</option>
                {banks.map((bank) => (
                  <option key={bank.id} value={bank.id}>
                    {accountLabel(bank)}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                {banks.length === 0
                  ? "Add the bank account first, then come back and link this card to it."
                  : "What this card spends is that account's money, so it is counted there and shows on that account's statement. Leave it unlinked if SpendLog has never seen the account."}
              </span>
            </label>
          )}

          {isCard && limitHolders.length > 0 && (
            <label className="field field-wide">
              <span>Shares its limit with</span>
              <select value={sharesLimitWith} onChange={(e) => setSharesLimitWith(e.target.value)}>
                <option value="">Nothing — it has a limit of its own</option>
                {limitHolders.map((holder) => (
                  <option key={holder.id} value={holder.id}>
                    {accountLabel(holder)}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                Two cards from one bank often draw on a single limit: spend on either and the other
                has less. Pick the card that holds the limit, and the credit limit above is ignored
                for this one. Its cycle, statement and your own limit stay its own.
              </span>
            </label>
          )}

          {(isCard || isDebit) && (
            <>
              <label className="field">
                <span>Network</span>
                <select value={normaliseNetwork(cardNetwork)} onChange={(e) => setCardNetwork(e.target.value)}>
                  <option value="">Not set</option>
                  {(Object.keys(NETWORK_LABELS) as CardNetwork[]).map((network) => (
                    <option key={network} value={network}>
                      {NETWORK_LABELS[network]}
                    </option>
                  ))}
                </select>
                <span className="field-hint">
                  Decides which card is suggested where. A RuPay credit card pays over UPI; a Visa one
                  does not.
                </span>
              </label>
            </>
          )}

          {isCard && (
            <>
              <label className="field">
                <span>Credit limit (₹)</span>
                <input
                  value={creditLimit}
                  onChange={(e) => setCreditLimit(e.target.value)}
                  placeholder="200000"
                  inputMode="numeric"
                />
              </label>

              <label className="field field-wide">
                <span>Statement password</span>
                <input
                  type="password"
                  value={statementPassword}
                  onChange={(e) => setStatementPassword(e.target.value)}
                  placeholder={account?.hasStatementPassword ? "•••••••• (set)" : "Opens the PDF this card emails"}
                  autoComplete="off"
                />
                <span className="field-hint">
                  Stored encrypted and never sent back to this page. Issuers build it from a date of birth,
                  so it usually unlocks more than this one card's statements — {" "}
                  {account?.hasStatementPassword ? "leave blank to keep it, or type a new one." : "worth knowing before you save it."}
                </span>
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

/**
 * Whatever was stored, as one of the networks the picker offers.
 *
 * An account created before the picker existed may hold free text like
 * "rupay" or "Master", which would otherwise leave the select showing
 * "Not set" and quietly wipe the value on the next save.
 */
function normaliseNetwork(raw: string): string {
  const folded = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  if (folded === "MASTER" || folded === "MC") return "MASTERCARD";
  if (folded === "AMERICANEXPRESS") return "AMEX";
  if (folded === "DINERSCLUB") return "DINERS";
  return folded in NETWORK_LABELS ? folded : "";
}
