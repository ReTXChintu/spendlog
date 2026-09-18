import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";
import { Loan } from "../types";
import { Icon } from "./Icon";

/**
 * Add a loan, or rename one already added.
 *
 * Unlike an EMI, there is no purchase to read a principal off — the money
 * most often never arrived as a transaction SpendLog has ever seen, so
 * everything here is typed in rather than taken from a debit already on
 * the ledger.
 */
export function LoanModal({
  loan,
  onSaved,
  onClose,
}: {
  /** null means "add a new one". Editing an existing loan only renames it —
      changing the schedule of one already running is not offered, the same
      as an EMI plan cannot be re-amortised after the fact. */
  loan: Loan | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const isNew = loan === null;

  const [label, setLabel] = useState(loan?.label ?? "");
  const [principal, setPrincipal] = useState(loan ? (loan.principalMinor / 100).toFixed(0) : "");
  const [months, setMonths] = useState(loan ? String(loan.months) : "12");
  const [monthly, setMonthly] = useState(loan ? (loan.monthlyAmountMinor / 100).toFixed(2) : "");
  const [rate, setRate] = useState(loan?.interestRatePctAnnual?.toString() ?? "");
  const [startDate, setStartDate] = useState(
    loan ? loan.startDate.slice(0, 10) : new Date().toISOString().slice(0, 10)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const principalMinor = Math.round((Number.parseFloat(principal) || 0) * 100);
  const monthsNum = Number.parseInt(months, 10) || 0;

  /** The reducing-balance formula the server uses, for the preview. */
  function computedMonthlyMinor(): number {
    const annual = Number.parseFloat(rate);
    if (!Number.isFinite(annual) || annual <= 0 || monthsNum <= 0) {
      return monthsNum > 0 ? Math.round(principalMinor / monthsNum) : 0;
    }
    const r = annual / 12 / 100;
    const growth = Math.pow(1 + r, monthsNum);
    return Math.round((principalMinor * r * growth) / (growth - 1));
  }

  function useComputed() {
    setMonthly((computedMonthlyMinor() / 100).toFixed(2));
  }

  const monthlyMinor = monthly.trim() ? Math.round(Number.parseFloat(monthly) * 100) : computedMonthlyMinor();
  const totalMinor = monthlyMinor * monthsNum;
  const interestMinor = Math.max(0, totalMinor - principalMinor);

  async function save() {
    if (!label.trim()) {
      setError("Give it a name — who it's from, or what it's for.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isNew) {
        if (!Number.isFinite(principalMinor) || principalMinor <= 0) {
          setError("Enter the amount borrowed.");
          setSaving(false);
          return;
        }
        if (!Number.isFinite(monthlyMinor) || monthlyMinor <= 0) {
          setError("The monthly amount needs to be more than zero.");
          setSaving(false);
          return;
        }
        await api.post("/loans", {
          label: label.trim(),
          principalMinor,
          months: monthsNum,
          monthlyAmountMinor: monthlyMinor,
          interestRatePctAnnual: rate.trim() ? Number.parseFloat(rate) : null,
          startDate: new Date(`${startDate}T00:00:00`).toISOString(),
        });
      } else {
        await api.patch(`/loans/${loan.id}`, { label: label.trim() });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that loan.");
      setSaving(false);
    }
  }

  /** Settled outside the schedule - paid off in one go, forgiven, whatever
      the reason. What is left stops being due rather than sitting there
      forever. */
  async function closeEarly() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/loans/${loan!.id}`, { status: "CLOSED" });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't close that loan.");
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError(null);
    try {
      await api.delete(`/loans/${loan!.id}`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove that loan.");
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
        <h3>{isNew ? "Add a loan" : "Rename loan"}</h3>
        <div className="modal-sub">
          <Icon name="ic-wallet" />
          <span>A bank's personal loan, an employer advance, money from a relative — anything repaid on a schedule.</span>
        </div>

        <div className="form-grid">
          <label className="field field-wide">
            <span>Who it's from, or what it's for</span>
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="HDFC personal loan"
            />
          </label>

          {isNew && (
            <>
              <label className="field">
                <span>Amount borrowed (₹)</span>
                <input
                  className="filter-input"
                  inputMode="decimal"
                  value={principal}
                  onChange={(e) => setPrincipal(e.target.value)}
                  placeholder="500000"
                />
              </label>

              <label className="field">
                <span>Months</span>
                <input
                  className="filter-input"
                  inputMode="numeric"
                  value={months}
                  onChange={(e) => setMonths(e.target.value)}
                  placeholder="24"
                />
              </label>

              <label className="field">
                <span>Monthly repayment (₹)</span>
                <div className="amount-input">
                  <span className="prefix">₹</span>
                  <input
                    id="loan-monthly"
                    className="filter-input"
                    inputMode="decimal"
                    placeholder={monthsNum > 0 ? (computedMonthlyMinor() / 100).toFixed(2) : "0.00"}
                    value={monthly}
                    onChange={(e) => setMonthly(e.target.value)}
                  />
                </div>
              </label>

              <label className="field">
                <span>Interest rate (% a year)</span>
                <input
                  className="filter-input"
                  inputMode="decimal"
                  placeholder="Optional"
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                />
              </label>

              <label className="field">
                <span>Started on</span>
                <input
                  type="date"
                  className="filter-input"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </label>

              <div className="form-row form-row-wide">
                <p className="field-hint">
                  Take the monthly figure off the paperwork if you can — a calculated one rarely lands to
                  the rupee once the lender's own rounding is in it.{" "}
                  {rate.trim() && monthsNum > 0 && (
                    <button className="link-button" onClick={useComputed} type="button">
                      Use {formatMoney(computedMonthlyMinor())} from the rate
                    </button>
                  )}
                </p>
              </div>
            </>
          )}
        </div>

        {isNew && monthsNum > 0 && (
          <div className="emi-preview">
            <div>
              <span className="emi-preview-label">Each month</span>
              <span className="emi-preview-value num">{formatMoney(monthlyMinor)}</span>
            </div>
            <div>
              <span className="emi-preview-label">Total over {monthsNum} months</span>
              <span className="emi-preview-value num">{formatMoney(totalMinor)}</span>
            </div>
            <div>
              <span className="emi-preview-label">Extra over the principal</span>
              <span className="emi-preview-value num">{formatMoney(interestMinor)}</span>
            </div>
          </div>
        )}

        {!isNew && (
          <div className="modal-footnote">
            <Icon name="ic-info" />
            {loan.paidCount} of {loan.months} paid, {formatMoney(loan.remainingMinor)} left. The schedule
            itself can't be changed once a loan is added.
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          {!isNew && loan.status === "ACTIVE" && (
            <button className="btn btn-sm btn-ghost" onClick={closeEarly} disabled={saving}>
              Close early
            </button>
          )}
          {!isNew && (
            <button
              className={`btn btn-sm ${confirmDelete ? "btn-primary" : "btn-ghost btn-danger-text"}`}
              onClick={() => (confirmDelete ? remove() : setConfirmDelete(true))}
              disabled={saving}
            >
              {confirmDelete ? "Really delete?" : "Delete"}
            </button>
          )}
          <span className="modal-actions-spacer" />
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : isNew ? "Add loan" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
