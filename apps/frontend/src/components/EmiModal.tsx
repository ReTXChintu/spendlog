import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";
import { Transaction } from "../types";
import { Icon } from "./Icon";

const TERMS = [3, 6, 9, 12, 18, 24];

/**
 * Turns a purchase into an EMI plan.
 *
 * The month count and the amount billed are what the statement will show;
 * the rate is only a way to arrive at an amount when the statement isn't
 * to hand, so anything typed into the amount field stands.
 */
export function EmiModal({
  transaction,
  onSaved,
  onClose,
}: {
  transaction: Transaction;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [months, setMonths] = useState(12);
  const [monthly, setMonthly] = useState("");
  const [rate, setRate] = useState("");
  const [fee, setFee] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /** The same reducing-balance formula the server uses, for the preview. */
  function computedMonthlyMinor(): number {
    const annual = Number.parseFloat(rate);
    if (!Number.isFinite(annual) || annual <= 0) {
      return Math.round(transaction.amountMinor / months);
    }
    const r = annual / 12 / 100;
    const growth = Math.pow(1 + r, months);
    return Math.round((transaction.amountMinor * r * growth) / (growth - 1));
  }

  function useComputed() {
    setMonthly((computedMonthlyMinor() / 100).toFixed(2));
  }

  const monthlyMinor = monthly.trim()
    ? Math.round(Number.parseFloat(monthly) * 100)
    : computedMonthlyMinor();
  const totalMinor = monthlyMinor * months;
  const interestMinor = Math.max(0, totalMinor - transaction.amountMinor);

  async function save() {
    if (!Number.isFinite(monthlyMinor) || monthlyMinor <= 0) {
      setError("The monthly amount needs to be more than zero.");
      return;
    }

    setSaving(true);
    setError(null);
    const feeRupees = Number.parseFloat(fee);
    try {
      await api.post(`/emi/from/${transaction.id}`, {
        months,
        monthlyAmountMinor: monthlyMinor,
        interestRatePctAnnual: rate.trim() ? Number.parseFloat(rate) : null,
        processingFeeMinor: Number.isFinite(feeRupees) ? Math.round(feeRupees * 100) : null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't set up that EMI.");
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
        <h3>Convert to EMI</h3>
        <div className="modal-sub">
          <Icon name="ic-calendar" />
          <span>
            {transaction.merchant ?? "This purchase"} · {formatMoney(transaction.amountMinor)}
          </span>
        </div>

        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="emi-months">Months</label>
            <select
              id="emi-months"
              className="filter-select"
              value={months}
              onChange={(e) => setMonths(Number.parseInt(e.target.value, 10))}
            >
              {TERMS.map((term) => (
                <option key={term} value={term}>
                  {term} months
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label htmlFor="emi-monthly">Monthly amount</label>
            <div className="amount-input">
              <span className="prefix">₹</span>
              <input
                id="emi-monthly"
                className="filter-input"
                inputMode="decimal"
                placeholder={(computedMonthlyMinor() / 100).toFixed(2)}
                value={monthly}
                onChange={(e) => setMonthly(e.target.value)}
              />
            </div>
          </div>

          <div className="form-row">
            <label htmlFor="emi-rate">Interest rate (% a year)</label>
            <input
              id="emi-rate"
              className="filter-input"
              inputMode="decimal"
              placeholder="14"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>

          <div className="form-row">
            <label htmlFor="emi-fee">Processing fee</label>
            <div className="amount-input">
              <span className="prefix">₹</span>
              <input
                id="emi-fee"
                className="filter-input"
                inputMode="decimal"
                placeholder="Optional"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
              />
            </div>
          </div>

          <div className="form-row form-row-wide">
            <p className="field-hint">
              Take the monthly amount off your statement if you can — card EMIs are quoted flat with GST
              on the interest, so a calculated figure usually lands a few rupees out.{" "}
              {rate.trim() && (
                <button className="link-button" onClick={useComputed} type="button">
                  Use {formatMoney(computedMonthlyMinor())} from the rate
                </button>
              )}
            </p>
          </div>
        </div>

        <div className="emi-preview">
          <div>
            <span className="emi-preview-label">Each month</span>
            <span className="emi-preview-value num">{formatMoney(monthlyMinor)}</span>
          </div>
          <div>
            <span className="emi-preview-label">Total over {months} months</span>
            <span className="emi-preview-value num">{formatMoney(totalMinor)}</span>
          </div>
          <div>
            <span className="emi-preview-label">Extra over the price</span>
            <span className="emi-preview-value num">{formatMoney(interestMinor)}</span>
          </div>
        </div>

        <div className="modal-footnote">
          <Icon name="ic-info" />
          The purchase stops counting as this month's spending. Each payment counts instead, as it is
          billed.
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <span className="modal-actions-spacer" />
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Set up EMI"}
          </button>
        </div>
      </div>
    </div>
  );
}
