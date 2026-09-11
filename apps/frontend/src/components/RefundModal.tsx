import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatMoney, formatDayLabel } from "../lib/format";
import { Transaction } from "../types";
import { Icon } from "./Icon";

/**
 * Points a credit at the payment it gives money back from.
 *
 * Refunds are rarely whole — tax, delivery and cancellation fees usually
 * stay gone — so the purchase keeps whatever did not come back as its real
 * cost, rather than disappearing from the month entirely.
 */
export function RefundModal({
  refund,
  onSaved,
  onClose,
}: {
  refund: Transaction;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [candidates, setCandidates] = useState<Transaction[] | null>(null);
  const [picked, setPicked] = useState<string | null>(refund.refundOfId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    api
      .get<Transaction[]>(`/transactions/${refund.id}/refund-candidates`)
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [refund.id]);

  async function save(purchaseId: string | null) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/transactions/${refund.id}/refund-of`, { purchaseId });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link that refund.");
      setSaving(false);
    }
  }

  const chosen = candidates?.find((c) => c.id === picked);
  const lossMinor = chosen ? Math.max(0, chosen.amountMinor - refund.amountMinor) : 0;

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
        <h3>What is this a refund of?</h3>
        <div className="modal-sub">
          <Icon name="ic-updown" />
          <span>
            {refund.merchant ?? "This credit"} · {formatMoney(refund.amountMinor)} back
          </span>
        </div>

        {candidates === null ? (
          <p className="field-hint">Looking for payments it could have come from…</p>
        ) : candidates.length === 0 ? (
          <p className="field-hint">
            No payment within the last six months is large enough to have produced this refund.
          </p>
        ) : (
          <div className="refund-list">
            {candidates.map((candidate) => (
              <button
                key={candidate.id}
                className={`refund-option${picked === candidate.id ? " is-picked" : ""}`}
                onClick={() => setPicked(candidate.id)}
              >
                <span className="refund-option-main">
                  <span className="refund-option-name">{candidate.merchant ?? "Unknown"}</span>
                  <span className="refund-option-sub">
                    {formatDayLabel(candidate.occurredAt.slice(0, 10))}
                    {candidate.account ? ` · ${candidate.account.bankName}` : ""}
                    {candidate.refundedMinor > 0
                      ? ` · ${formatMoney(candidate.refundedMinor)} already back`
                      : ""}
                  </span>
                </span>
                <span className="refund-option-amount num">{formatMoney(candidate.amountMinor)}</span>
              </button>
            ))}
          </div>
        )}

        {chosen && (
          <div className="refund-summary">
            <div>
              <span className="emi-preview-label">Paid</span>
              <span className="emi-preview-value num">{formatMoney(chosen.amountMinor)}</span>
            </div>
            <div>
              <span className="emi-preview-label">Coming back</span>
              <span className="emi-preview-value num">{formatMoney(refund.amountMinor)}</span>
            </div>
            <div>
              <span className="emi-preview-label">Never came back</span>
              <span className="emi-preview-value num">{formatMoney(lossMinor)}</span>
            </div>
          </div>
        )}

        <div className="modal-footnote">
          <Icon name="ic-info" />
          The credit stops counting as income, and the purchase costs whatever did not come back.
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          {refund.refundOfId && (
            <button className="btn btn-sm btn-ghost" onClick={() => save(null)} disabled={saving}>
              Not a refund
            </button>
          )}
          <span className="modal-actions-spacer" />
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => save(picked)}
            disabled={saving || !picked}
          >
            {saving ? "Saving…" : "Link refund"}
          </button>
        </div>
      </div>
    </div>
  );
}
