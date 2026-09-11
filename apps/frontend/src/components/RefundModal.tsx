import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatDayLabel, formatMoney } from "../lib/format";
import { Transaction } from "../types";
import { Icon } from "./Icon";

/** How much of the credit is going to each purchase, by purchase id. */
type Allocations = Record<string, number>;

/**
 * Says which purchases a credit gives money back from, and how much of it
 * belongs to each.
 *
 * One credit routinely settles several cancelled orders at once, and it is
 * rarely the whole of what was paid — tax, delivery and cancellation fees
 * usually stay gone. What is left on each purchase is its real cost.
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
  const [picked, setPicked] = useState<Allocations>(() =>
    Object.fromEntries(refund.refundOf.map((a) => [a.transactionId, a.amountMinor]))
  );
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

  async function save(allocations: { transactionId: string; amountMinor: number }[]) {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/transactions/${refund.id}/refund-of`, { allocations });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't link that refund.");
      setSaving(false);
    }
  }

  const chosenIds = Object.keys(picked);
  const allocatedMinor = Object.values(picked).reduce((sum, amount) => sum + amount, 0);
  const unallocatedMinor = refund.amountMinor - allocatedMinor;

  // What never came back across everything ticked: the tax and delivery on
  // each order that the refund did not cover.
  const lostMinor = (candidates ?? [])
    .filter((candidate) => candidate.id in picked)
    .reduce((sum, candidate) => sum + Math.max(0, candidate.amountMinor - picked[candidate.id]), 0);

  /**
   * Ticking a purchase claims as much of what is left of the credit as that
   * purchase could account for — its whole cost, or whatever remains of the
   * credit when that is less.
   */
  function toggle(candidate: Transaction) {
    setPicked((current) => {
      if (candidate.id in current) {
        const next = { ...current };
        delete next[candidate.id];
        return next;
      }
      const remaining = refund.amountMinor - Object.values(current).reduce((s, a) => s + a, 0);
      if (remaining <= 0) return current;
      return { ...current, [candidate.id]: Math.min(candidate.amountMinor, remaining) };
    });
  }

  function setAmount(id: string, rupees: string) {
    const parsed = Math.round(Number.parseFloat(rupees || "0") * 100);
    setPicked((current) => ({ ...current, [id]: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 }));
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
        <h3>What is this a refund of?</h3>
        <div className="modal-sub">
          <Icon name="ic-updown" />
          <span>
            {refund.merchant ?? "This credit"} · {formatMoney(refund.amountMinor)} back · pick as many
            purchases as it covers
          </span>
        </div>

        {candidates === null ? (
          <p className="field-hint">Looking for payments it could have come from…</p>
        ) : candidates.length === 0 ? (
          <p className="field-hint">No payment in the six months before this credit to match it against.</p>
        ) : (
          <div className="refund-list">
            {candidates.map((candidate) => {
              const isPicked = candidate.id in picked;
              return (
                <div
                  key={candidate.id}
                  className={`refund-option${isPicked ? " is-picked" : ""}`}
                  onClick={() => toggle(candidate)}
                >
                  <input type="checkbox" checked={isPicked} readOnly tabIndex={-1} />
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
                  {isPicked ? (
                    <span className="amount-input refund-option-input" onClick={(e) => e.stopPropagation()}>
                      <span className="prefix">₹</span>
                      <input
                        inputMode="decimal"
                        value={(picked[candidate.id] / 100).toFixed(2)}
                        onChange={(e) => setAmount(candidate.id, e.target.value)}
                      />
                    </span>
                  ) : (
                    <span className="refund-option-amount num">{formatMoney(candidate.amountMinor)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {chosenIds.length > 0 && (
          <div className="refund-summary">
            <div>
              <span className="emi-preview-label">
                Covering {chosenIds.length === 1 ? "1 purchase" : `${chosenIds.length} purchases`}
              </span>
              <span className="emi-preview-value num">{formatMoney(allocatedMinor)}</span>
            </div>
            <div>
              <span className="emi-preview-label">Never came back</span>
              <span className="emi-preview-value num">{formatMoney(lostMinor)}</span>
            </div>
            <div>
              <span className="emi-preview-label">
                {unallocatedMinor < 0 ? "More than the credit" : "Left counting as income"}
              </span>
              <span className="emi-preview-value num">{formatMoney(Math.abs(unallocatedMinor))}</span>
            </div>
          </div>
        )}

        <div className="modal-footnote">
          <Icon name="ic-info" />
          Whatever is allocated stops counting as income, and each purchase costs whatever did not come
          back.
        </div>

        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          {refund.refundOf.length > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => save([])} disabled={saving}>
              Not a refund
            </button>
          )}
          <span className="modal-actions-spacer" />
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => save(chosenIds.map((id) => ({ transactionId: id, amountMinor: picked[id] })))}
            disabled={saving || chosenIds.length === 0 || unallocatedMinor < 0}
          >
            {saving ? "Saving…" : "Link refund"}
          </button>
        </div>
      </div>
    </div>
  );
}
