import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Account, Category, Perk, PerkKind, accountLabel } from "../types";
import { Icon } from "./Icon";

/**
 * Add or edit one perk.
 *
 * The form leads with the kind because it changes what the rest means. A
 * card offer is attached to a card and stands until the bank changes it; a
 * coupon has a code, an expiry, and is gone once used.
 */
export function PerkModal({
  perk,
  accounts,
  categories,
  onSaved,
  onClose,
}: {
  /** null means "add a new one". */
  perk: Perk | null;
  accounts: Account[];
  categories: Category[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const isNew = perk === null;

  const [kind, setKind] = useState<PerkKind>(perk?.kind ?? "COUPON");
  const [title, setTitle] = useState(perk?.title ?? "");
  const [merchants, setMerchants] = useState(perk?.merchants.join(", ") ?? "");
  const [accountId, setAccountId] = useState(idOf(perk?.accountId));
  const [categoryId, setCategoryId] = useState(idOf(perk?.categoryId));
  const [worthKind, setWorthKind] = useState<"percent" | "flat">(perk?.flatMinor ? "flat" : "percent");
  const [percent, setPercent] = useState(perk?.percent?.toString() ?? "");
  const [flat, setFlat] = useState(perk?.flatMinor != null ? (perk.flatMinor / 100).toFixed(0) : "");
  const [maxDiscount, setMaxDiscount] = useState(
    perk?.maxDiscountMinor != null ? (perk.maxDiscountMinor / 100).toFixed(0) : ""
  );
  const [minSpend, setMinSpend] = useState(
    perk?.minSpendMinor != null ? (perk.minSpendMinor / 100).toFixed(0) : ""
  );
  const [expiresOn, setExpiresOn] = useState(perk?.expiresOn?.slice(0, 10) ?? "");
  const [code, setCode] = useState(perk?.code ?? "");
  const [notes, setNotes] = useState(perk?.notes ?? "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const cards = accounts.filter((account) => account.accountType === "CARD");

  async function save() {
    setSaving(true);
    setError(null);

    const body = {
      kind,
      title: title.trim(),
      merchants: merchants
        .split(",")
        .map((merchant) => merchant.trim())
        .filter(Boolean),
      accountId: accountId || null,
      categoryId: categoryId || null,
      percent: worthKind === "percent" ? numberOrNull(percent) : null,
      flatMinor: worthKind === "flat" ? minorOrNull(flat) : null,
      maxDiscountMinor: worthKind === "percent" ? minorOrNull(maxDiscount) : null,
      minSpendMinor: minorOrNull(minSpend),
      expiresOn: expiresOn || null,
      code: code.trim() || null,
      notes: notes.trim() || null,
    };

    try {
      if (isNew) await api.post("/perks", body);
      else await api.patch(`/perks/${perk.id}`, body);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that");
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

        <h3>{isNew ? "Add a perk" : "Edit perk"}</h3>
        <div className="modal-sub">
          Anything that makes a purchase cheaper, so this page can answer before you pay.
        </div>

        <div className="seg" style={{ marginBottom: 16 }}>
          <button className={kind === "COUPON" ? "on" : ""} onClick={() => setKind("COUPON")}>
            Coupon
          </button>
          <button className={kind === "CARD_OFFER" ? "on" : ""} onClick={() => setKind("CARD_OFFER")}>
            Card offer
          </button>
        </div>

        <div className="form-grid">
          <label className="field field-wide">
            <span>What it is</span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === "COUPON" ? "20% off" : "5% NeuCoins"}
            />
          </label>

          <label className="field field-wide">
            <span>Where it works</span>
            <input
              value={merchants}
              onChange={(e) => setMerchants(e.target.value)}
              placeholder="Gucci, Croma — or leave empty for anywhere"
            />
            <span className="field-hint">
              Separate several with commas. Matching is forgiving, so "amazon" finds "AMAZON PAY IN
              UTILITY".
            </span>
          </label>

          <label className="field">
            <span>{kind === "CARD_OFFER" ? "On which card" : "Card (optional)"}</span>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{kind === "CARD_OFFER" ? "Pick one…" : "Any card"}</option>
              {cards.map((card) => (
                <option key={card.id} value={card.id}>
                  {accountLabel(card)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Category (optional)</span>
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Any</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <span className="field-hint">Use this for "5% on all dining" instead of naming shops.</span>
          </label>

          <label className="field">
            <span>Worth</span>
            <div className="seg seg-sm">
              <button className={worthKind === "percent" ? "on" : ""} onClick={() => setWorthKind("percent")}>
                Percentage
              </button>
              <button className={worthKind === "flat" ? "on" : ""} onClick={() => setWorthKind("flat")}>
                Flat ₹
              </button>
            </div>
          </label>

          {worthKind === "percent" ? (
            <>
              <label className="field">
                <span>Percent off</span>
                <input value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="5" inputMode="decimal" />
              </label>
              <label className="field">
                <span>Capped at (₹)</span>
                <input
                  value={maxDiscount}
                  onChange={(e) => setMaxDiscount(e.target.value)}
                  placeholder="500"
                  inputMode="numeric"
                />
              </label>
            </>
          ) : (
            <label className="field">
              <span>Amount off (₹)</span>
              <input value={flat} onChange={(e) => setFlat(e.target.value)} placeholder="500" inputMode="numeric" />
            </label>
          )}

          <label className="field">
            <span>Minimum spend (₹)</span>
            <input
              value={minSpend}
              onChange={(e) => setMinSpend(e.target.value)}
              placeholder="5000"
              inputMode="numeric"
            />
          </label>

          {kind === "COUPON" && (
            <>
              <label className="field">
                <span>Code</span>
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="GUCCI20" />
              </label>
              <label className="field">
                <span>Expires</span>
                <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
              </label>
            </>
          )}

          <label className="field field-wide">
            <span>Notes</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything the small print says"
            />
          </label>
        </div>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !title.trim()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A field that may arrive populated or as a bare id. */
function idOf(value: string | { id: string } | null | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.id;
}

function numberOrNull(raw: string): number | null {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function minorOrNull(raw: string): number | null {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}
