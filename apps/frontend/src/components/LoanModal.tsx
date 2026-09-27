import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";
import { Loan } from "../types";
import { Icon } from "./Icon";

/** The calendar day an instant falls on here, as YYYY-MM-DD. Read locally
    rather than off the UTC string, so loans saved at IST midnight - the
    previous day in UTC - still show the day they were given. */
function localDay(instant: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

/**
 * Add a loan, or change one already added.
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
  /** null means "add a new one". A new term, start or monthly figure
      re-lays the schedule; whatever was already paid stays paid. */
  loan: Loan | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const isNew = loan === null;

  const [label, setLabel] = useState(loan?.label ?? "");
  const [principal, setPrincipal] = useState(
    loan ? (loan.principalMinor / 100).toFixed(loan.principalMinor % 100 === 0 ? 0 : 2) : ""
  );
  const [months, setMonths] = useState(loan ? String(loan.months) : "12");
  const [monthly, setMonthly] = useState(loan ? (loan.monthlyAmountMinor / 100).toFixed(2) : "");
  const [rate, setRate] = useState(loan?.interestRatePctAnnual?.toString() ?? "");
  const [startDate, setStartDate] = useState(localDay(loan ? new Date(loan.startDate) : new Date()));
  const [paid, setPaid] = useState(loan ? String(loan.paidCount) : "0");
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
  const paidNum = Number.parseInt(paid, 10) || 0;

  async function save() {
    if (!label.trim()) {
      setError("Give it a name — who it's from, or what it's for.");
      return;
    }
    if (!Number.isFinite(principalMinor) || principalMinor <= 0) {
      setError("Enter the amount borrowed.");
      return;
    }
    if (monthsNum < 1) {
      setError("A loan runs for at least one month.");
      return;
    }
    if (!Number.isFinite(monthlyMinor) || monthlyMinor <= 0) {
      setError("The monthly amount needs to be more than zero.");
      return;
    }
    if (paidNum < 0 || paidNum > monthsNum) {
      setError(`Instalments paid has to be between 0 and ${monthsNum}.`);
      return;
    }

    setSaving(true);
    setError(null);

    const rateValue = rate.trim() ? Number.parseFloat(rate) : null;
    // Midnight UTC on the chosen day, the same as the phone sends: the
    // schedule steps month to month in UTC, and IST midnight is the day
    // before there, which the month-end clamp would then act on.
    const startIso = `${startDate}T00:00:00.000Z`;

    try {
      if (isNew) {
        await api.post("/loans", {
          label: label.trim(),
          principalMinor,
          months: monthsNum,
          monthlyAmountMinor: monthlyMinor,
          interestRatePctAnnual: rateValue,
          startDate: startIso,
          alreadyPaidCount: paidNum,
        });
      } else {
        // Only what changed, so an untouched start date is never re-sent
        // and quietly re-lays a schedule nobody asked to move.
        const changes: Record<string, unknown> = {};
        if (label.trim() !== loan.label) changes.label = label.trim();
        if (principalMinor !== loan.principalMinor) changes.principalMinor = principalMinor;
        if (monthsNum !== loan.months) changes.months = monthsNum;
        if (monthlyMinor !== loan.monthlyAmountMinor) changes.monthlyAmountMinor = monthlyMinor;
        if (rateValue !== (loan.interestRatePctAnnual ?? null)) changes.interestRatePctAnnual = rateValue;
        if (startDate !== localDay(new Date(loan.startDate))) changes.startDate = startIso;
        if (paidNum !== loan.paidCount) changes.paidCount = paidNum;
        if (Object.keys(changes).length > 0) await api.patch(`/loans/${loan.id}`, changes);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that loan.");
      setSaving(false);
    }
  }

  async function reopen() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/loans/${loan!.id}`, { status: "ACTIVE" });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reopen that loan.");
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
        <h3>{isNew ? "Add a loan" : "Edit loan"}</h3>
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
            <span>First repayment on</span>
            <input
              type="date"
              className="filter-input"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>

          <label className="field">
            <span>Instalments already paid</span>
            <input
              className="filter-input"
              inputMode="numeric"
              value={paid}
              onChange={(e) => setPaid(e.target.value)}
              placeholder="0"
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
            <p className="field-hint">
              Already running before you added it? Put the first repayment's date and how many have
              been paid — those are marked paid without needing a transaction for each.
            </p>
          </div>
        </div>

        {monthsNum > 0 && (
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
            {loan.status === "ACTIVE"
              ? `${loan.paidCount} of ${loan.months} paid, ${formatMoney(loan.remainingMinor)} left.`
              : `Closed, with ${loan.paidCount} of ${loan.months} paid.`}{" "}
            Changing the term, monthly figure or first date re-lays the schedule; anything already paid stays
            paid.
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          {!isNew && loan.status === "ACTIVE" && (
            <button className="btn btn-sm btn-ghost" onClick={closeEarly} disabled={saving}>
              Close early
            </button>
          )}
          {!isNew && loan.status === "CLOSED" && (
            <button className="btn btn-sm btn-ghost" onClick={reopen} disabled={saving}>
              Reopen
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
