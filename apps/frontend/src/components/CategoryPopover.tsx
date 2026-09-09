import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Category, Transaction } from "../types";
import { Icon } from "./Icon";

export function CategoryPopover({
  categories,
  transaction,
  onPicked,
  onClose,
}: {
  categories: Category[];
  transaction: Transaction;
  onPicked: (category: Category, updated: Transaction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);

  // Dismiss on an outside click or Escape, the way a popover is expected to.
  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    // Deferred so the click that opened the popover doesn't immediately close it.
    const id = window.setTimeout(() => document.addEventListener("mousedown", onPointerDown));
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  async function pick(category: Category) {
    if (saving) return;
    setSaving(true);
    try {
      const updated = await api.patch<Transaction>(`/transactions/${transaction.id}`, {
        categoryId: category.id,
      });
      onPicked(category, updated);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="cat-popover" ref={ref}>
      <div className="cat-popover-title">Set category</div>
      <div className="cat-grid">
        {categories.map((category) => (
          <button
            key={category.id}
            className="cat-opt"
            onClick={() => pick(category)}
            disabled={saving}
          >
            <span className="cat-opt-chip" style={{ background: category.color ?? "var(--muted)" }}>
              <Icon name={category.icon ?? "ic-dots"} />
            </span>
            {category.name}
          </button>
        ))}
      </div>
    </div>
  );
}
