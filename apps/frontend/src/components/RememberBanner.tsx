import { useState } from "react";
import { api } from "../lib/api";
import { Category } from "../types";

/**
 * Offered right after a category is set by hand. Saying yes stores a rule
 * matching the merchant, so the next payment to it categorizes itself —
 * without this, a Paytm QR code or a person's name has to be re-filed every
 * single time it appears.
 */
export function RememberBanner({
  merchant,
  category,
  onDone,
}: {
  merchant: string;
  category: Category;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function remember() {
    setSaving(true);
    try {
      await api.post("/categories/rules", {
        categoryId: category.id,
        matchType: "MERCHANT_CONTAINS",
        pattern: merchant,
        // Beats the built-in keyword rules, which are all priority 0.
        priority: 10,
      });
    } finally {
      onDone();
    }
  }

  const shown = merchant.length > 26 ? `${merchant.slice(0, 26)}…` : merchant;

  return (
    <div className="remember-banner">
      <span>
        Categorized as <b>{category.name}</b>. Apply to future "{shown}" payments too?
      </span>
      <span className="remember-actions">
        <button className="btn btn-sm btn-primary" onClick={remember} disabled={saving}>
          {saving ? "Saving…" : "Yes"}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={onDone} disabled={saving}>
          Just this one
        </button>
      </span>
    </div>
  );
}
