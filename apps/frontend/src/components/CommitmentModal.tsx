import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Category, FixedCommitment } from "../types";
import { Icon } from "./Icon";

/**
 * Add or edit one fixed monthly cost.
 *
 * The merchant and category are here rather than only on the payment
 * because a fixed cost is the same merchant and the same category every
 * month — recording them once means a payment marked against it arrives
 * already filled in.
 */
export function CommitmentModal({
  commitment,
  categories,
  onSaved,
  onClose,
}: {
  /** null means "add a new one". */
  commitment: FixedCommitment | null;
  categories: Category[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const isNew = commitment === null;

  const [name, setName] = useState(commitment?.name ?? "");
  const [amount, setAmount] = useState(
    commitment ? (commitment.amountMinor / 100).toFixed(0) : ""
  );
  const [dayOfMonth, setDayOfMonth] = useState(commitment?.dayOfMonth?.toString() ?? "");
  const [merchant, setMerchant] = useState(commitment?.merchant ?? "");
  const [categoryId, setCategoryId] = useState(
    typeof commitment?.categoryId === "string"
      ? commitment.categoryId
      : (commitment?.categoryId?.id ?? "")
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

  async function save() {
    const rupees = Number.parseFloat(amount);
    if (!name.trim() || !Number.isFinite(rupees)) return;

    setSaving(true);
    setError(null);

    const body = {
      name: name.trim(),
      amountMinor: Math.round(rupees * 100),
      dayOfMonth: Number.parseInt(dayOfMonth, 10) || 1,
      merchant: merchant.trim() || null,
      categoryId: categoryId || null,
    };

    try {
      if (isNew) await api.post("/budget/commitments", body);
      else await api.patch(`/budget/commitments/${commitment.id}`, body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
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
      <div className="modal">
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>

        <h3>{isNew ? "Add a fixed cost" : "Edit fixed cost"}</h3>
        <div className="modal-sub">
          Rent, a SIP, insurance — anything that goes out every month whatever else happens.
        </div>

        <div className="form-grid">
          <label className="field field-wide">
            <span>What it is</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Rent" />
          </label>

          <label className="field">
            <span>Amount a month (₹)</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="4000"
              inputMode="decimal"
            />
            <span className="field-hint">
              What it costs <em>you</em>. On a bill you pay whole and split with others, that is your
              share, not the whole cheque.
            </span>
          </label>

          <label className="field">
            <span>Day of the month</span>
            <input
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(e.target.value)}
              placeholder="5"
              inputMode="numeric"
            />
          </label>

          <label className="field">
            <span>Usually paid to</span>
            <input
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              placeholder="Landlord"
            />
          </label>

          <label className="field">
            <span>Usual category</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">None</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>

          <div className="field field-wide">
            <span className="field-hint">
              The last two fill themselves in on a payment marked against this, so a fixed cost needs
              typing once rather than every month.
            </span>
          </div>
        </div>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
