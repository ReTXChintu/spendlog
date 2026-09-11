import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Account, Category, Transaction, TransactionType, accountLabel } from "../types";
import { Icon } from "./Icon";

/** Splits an ISO instant into the two values the date/time inputs want. */
/**
 * The date and time pickers work in IST, not the browser's timezone.
 *
 * Typing "11 Sep, 7:21pm" has to mean that in India however the laptop is
 * set, or editing a transaction abroad would silently move it.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

function toIstParts(iso: string): { date: string; time: string } {
  const shifted = new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString();
  return { date: shifted.slice(0, 10), time: shifted.slice(11, 16) };
}

function fromIstParts(date: string, time: string): string {
  return new Date(`${date}T${time}:00.000+05:30`).toISOString();
}

/**
 * Full manual edit. Parsing gets most of a message right but not all of it,
 * and a wrong amount or direction is worse than none — so every field a
 * person might need to correct is editable here, including creating a
 * transaction that no message ever produced (cash).
 */
export function EditTransactionModal({
  transaction,
  categories,
  accounts,
  onSaved,
  onDeleted,
  onClose,
  onConvertToEmi,
  onMarkRefund,
}: {
  /** null means "create a new one". */
  transaction: Transaction | null;
  categories: Category[];
  accounts: Account[];
  onSaved: (saved: Transaction) => void;
  onDeleted?: (id: string) => void;
  onClose: () => void;
  /** Opens the EMI form for this purchase. */
  onConvertToEmi?: (transaction: Transaction) => void;
  /** Opens the refund picker for this credit. */
  onMarkRefund?: (transaction: Transaction) => void;
}) {
  const isNew = transaction === null;
  const initial = transaction ? toIstParts(transaction.occurredAt) : toIstParts(new Date().toISOString());

  const [amount, setAmount] = useState(
    transaction ? (transaction.amountMinor / 100).toFixed(2) : ""
  );
  const [type, setType] = useState<TransactionType>(transaction?.type ?? "DEBIT");
  const [merchant, setMerchant] = useState(transaction?.merchant ?? "");
  const [note, setNote] = useState(transaction?.note ?? "");
  const [categoryId, setCategoryId] = useState(transaction?.category?.id ?? "");
  const [accountId, setAccountId] = useState(transaction?.account?.id ?? "");
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [isTransfer, setIsTransfer] = useState(transaction?.isTransfer ?? false);
  const [isSplit, setIsSplit] = useState(transaction?.split != null);
  const [myShare, setMyShare] = useState(
    transaction?.split ? (transaction.split.myShareMinor / 100).toFixed(2) : ""
  );
  const [groupLabel, setGroupLabel] = useState(transaction?.split?.groupLabel ?? "");
  const [isSettlement, setIsSettlement] = useState(transaction?.isSettlement ?? false);
  // On a trip, an expense is everyone's unless it says otherwise. The only
  // narrowing worth a control is "this one was just mine".
  const [tripJustMine, setTripJustMine] = useState((transaction?.tripShareWith?.length ?? 0) > 0);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // More than one message means this row was merged, whether automatically
  // or by hand — and either can be wrong, so both can be taken apart.
  const mergedCount = transaction?.sources.length ?? 0;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Says what the split will do, in the same terms the balance uses.
  const shareMinor = Math.round(Number.parseFloat(myShare || "0") * 100);
  const totalMinor = Math.round(Number.parseFloat(amount || "0") * 100);
  const owedBackMinor = Math.max(0, totalMinor - shareMinor);
  const owedHint =
    owedBackMinor > 0
      ? `₹${(owedBackMinor / 100).toFixed(2)} counts as owed back to you, not as spending.`
      : "All of it counts as your own spending.";

  async function unmerge() {
    if (!transaction) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/transactions/${transaction.id}/unmerge`);
      onSaved(transaction);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't split that transaction.");
      setSaving(false);
    }
  }

  async function save() {
    const rupees = Number.parseFloat(amount);
    if (!Number.isFinite(rupees) || rupees <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }

    setSaving(true);
    setError(null);
    const body = {
      amountMinor: Math.round(rupees * 100),
      type,
      merchant: merchant.trim() || null,
      note: note.trim() || null,
      categoryId: categoryId || null,
      accountId: accountId || null,
      occurredAt: fromIstParts(date, time),
      isTransfer,
      isSettlement,
      // Narrowed to the payer alone, or widened back to everyone on the trip.
      ...(transaction?.tripId ? { tripShareWith: tripJustMine ? [transaction.userId] : null } : {}),
      split: isSplit ? { myShareMinor: Math.round(Number.parseFloat(myShare || "0") * 100), groupLabel: groupLabel.trim() || null } : null,
    };

    try {
      const saved = isNew
        ? await api.post<Transaction>("/transactions", { ...body, currency: "INR" })
        : await api.patch<Transaction>(`/transactions/${transaction!.id}`, body);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the change.");
      setSaving(false);
    }
  }

  async function remove() {
    if (!transaction) return;
    setSaving(true);
    try {
      await api.delete(`/transactions/${transaction.id}`);
      onDeleted?.(transaction.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete it.");
      setSaving(false);
    }
  }

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
        <h3>{isNew ? "Add a transaction" : "Edit transaction"}</h3>
        <div className="modal-sub">
          <Icon name={isNew ? "ic-plus" : "ic-pencil"} />
          <span>
            {isNew
              ? "For cash, or anything no message covered."
              : `From ${transaction!.source === "EMAIL" ? "an email" : transaction!.source === "SMS" ? "an SMS" : "manual entry"} — change anything that's wrong.`}
          </span>
        </div>

        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="e-amount">Amount</label>
            <div className="amount-input">
              <span className="prefix">₹</span>
              <input
                id="e-amount"
                className="filter-input"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          <div className="form-row">
            <label>Direction</label>
            <div className="filter-radio-row">
              {(
                [
                  ["DEBIT", "Money out"],
                  ["CREDIT", "Money in"],
                ] as [TransactionType, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={`filter-radio${type === value ? " on" : ""}`}
                  onClick={() => setType(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-row form-row-wide">
            <label htmlFor="e-merchant">Merchant</label>
            <input
              id="e-merchant"
              className="filter-input"
              placeholder="Who was paid"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
            />
          </div>

          <div className="form-row">
            <label htmlFor="e-date">Date</label>
            <input
              id="e-date"
              type="date"
              className="filter-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>

          <div className="form-row">
            <label htmlFor="e-time">Time</label>
            <input
              id="e-time"
              type="time"
              className="filter-input"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>

          <div className="form-row">
            <label htmlFor="e-category">Category</label>
            <select
              id="e-category"
              className="filter-select"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">Uncategorized</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="e-account">Account</label>
            <select
              id="e-account"
              className="filter-select"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Not set</option>
              {accounts
                .filter((account) => account.isActive || account.id === accountId)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountLabel(account)}
                  </option>
                ))}
            </select>
          </div>

          <div className="form-row form-row-wide">
            <label htmlFor="e-note">Note</label>
            <input
              id="e-note"
              className="filter-input"
              placeholder="Optional"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          <div className="form-row form-row-wide">
            <label className="checkbox-row">
              <input type="checkbox" checked={isTransfer} onChange={(e) => setIsTransfer(e.target.checked)} />
              <span>
                Between my own accounts — leave it out of spending and income totals
              </span>
            </label>
          </div>

          <div className="form-row form-row-wide">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={isSplit}
                onChange={(e) => {
                  setIsSplit(e.target.checked);
                  // Most of the time the point of splitting is that the
                  // share is less than the bill; starting from the full
                  // amount at least anchors it.
                  if (e.target.checked && !myShare) setMyShare(amount);
                }}
              />
              <span>Split — only part of this was mine</span>
            </label>
          </div>

          {isSplit && (
            <>
              <div className="form-row">
                <label htmlFor="e-share">My share</label>
                <div className="amount-input">
                  <span className="prefix">₹</span>
                  <input
                    id="e-share"
                    className="filter-input"
                    inputMode="decimal"
                    value={myShare}
                    onChange={(e) => setMyShare(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-row">
                <label htmlFor="e-group">What for</label>
                <input
                  id="e-group"
                  className="filter-input"
                  placeholder="Goa trip"
                  value={groupLabel}
                  onChange={(e) => setGroupLabel(e.target.value)}
                />
              </div>

              <div className="form-row form-row-wide">
                <p className="field-hint">
                  {owedHint}
                </p>
              </div>
            </>
          )}

          {transaction?.trip && (
            <div className="form-row form-row-wide">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={tripJustMine}
                  onChange={(e) => setTripJustMine(e.target.checked)}
                />
                <span>
                  On {transaction.trip.name}, this one was just mine — leave it out of who owes whom
                </span>
              </label>
            </div>
          )}

          <div className="form-row form-row-wide">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={isSettlement}
                onChange={(e) => setIsSettlement(e.target.checked)}
              />
              <span>
                Settling up — paying back, or being paid back, for bills already recorded
              </span>
            </label>
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          {!isNew && onDeleted && (
            <button
              className={`btn btn-sm ${confirmDelete ? "btn-primary" : "btn-ghost btn-danger-text"}`}
              onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
              disabled={saving}
            >
              {confirmDelete ? "Really delete?" : "Delete"}
            </button>
          )}
          {!isNew && onMarkRefund && type === "CREDIT" && (
            <button className="btn btn-sm btn-ghost" onClick={() => onMarkRefund(transaction)} disabled={saving}>
              {transaction.refundOf.length > 0 ? "Change refund link" : "It's a refund"}
            </button>
          )}
          {!isNew && onConvertToEmi && type === "DEBIT" && !transaction.emiPlanId && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => onConvertToEmi(transaction)}
              disabled={saving}
            >
              Convert to EMI
            </button>
          )}
          {mergedCount > 1 && (
            <button className="btn btn-sm btn-ghost" onClick={unmerge} disabled={saving}>
              Split into {mergedCount}
            </button>
          )}
          <span className="modal-actions-spacer" />
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : isNew ? "Add transaction" : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
