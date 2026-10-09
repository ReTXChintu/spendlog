import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { formatMoney } from "../../lib/format";
import { Category, MonthlyBudgetStatus, PEOPLE_CATEGORY_NAME, categoriesFor } from "../../types";
import { Icon } from "../Icon";
import "../../styles/budget.css";

/**
 * Setting the monthly budget: one amount, and the share of it some
 * categories get.
 *
 * The limits are parts of the amount, never extra on top of it, so they
 * are added up as they are typed and saving is refused while they come to
 * more - lowering a limit or raising the total is the only way out, and
 * nothing quietly raises the total for you. What they leave over is the
 * pool every other category spends from.
 *
 * Opened from the dashboard's budget card and from Settings, so it lives
 * on its own rather than in either.
 */

interface Row {
  key: number;
  categoryId: string;
  amount: string;
}

let nextKey = 1;

/** Rupees typed, as paise. Blank or nonsense is null. */
function toMinor(text: string): number | null {
  const value = Number.parseFloat(text.replace(/,/g, ""));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

function rupees(minor: number): string {
  return String(Math.round(minor / 100));
}

export function BudgetEditor({
  status,
  initialAmountMinor,
  onSaved,
  onClose,
}: {
  /** The month as it stands, to start from. Null when it hasn't loaded. */
  status: MonthlyBudgetStatus | null;
  /** A starting total, when there is no budget yet. */
  initialAmountMinor?: number | null;
  onSaved: (next: MonthlyBudgetStatus) => void;
  onClose: () => void;
}) {
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [total, setTotal] = useState(() => {
    const start = status?.budgetMinor ?? initialAmountMinor ?? status?.suggestedMonthlyMinor ?? null;
    return start ? rupees(start) : "";
  });
  const [rows, setRows] = useState<Row[]>(() =>
    (status?.categories ?? []).map((category) => ({
      key: nextKey++,
      categoryId: category.categoryId,
      amount: rupees(category.limitMinor),
    }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Category[]>("/categories")
      .then(setCategories)
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Only what money going out can be filed under. Money lent to people
  // is not spending, so it has nothing to limit.
  const spendable = useMemo(
    () => categoriesFor(categories ?? [], "DEBIT").filter((category) => category.name !== PEOPLE_CATEGORY_NAME),
    [categories]
  );

  // What each category has cost this month, to set a limit against.
  const spentByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const category of status?.categories ?? []) map.set(category.categoryId, category.spentMinor);
    for (const category of status?.unassigned?.categories ?? []) {
      if (category.categoryId) map.set(category.categoryId, category.spentMinor);
    }
    return map;
  }, [status]);

  const totalMinor = toMinor(total);
  const assignedMinor = rows.reduce((sum, row) => sum + (toMinor(row.amount) ?? 0), 0);
  const unassignedMinor = (totalMinor ?? 0) - assignedMinor;
  const over = totalMinor !== null && unassignedMinor < 0;
  const used = new Set(rows.map((row) => row.categoryId));
  const unused = spendable.filter((category) => !used.has(category.id));
  const incomplete = rows.some((row) => !row.categoryId || toMinor(row.amount) === null);
  const canSave = totalMinor !== null && totalMinor > 0 && !over && !incomplete && !saving;

  function addRow() {
    // Start from the category that has cost the most this month without a limit.
    const next =
      [...unused].sort((a, b) => (spentByCategory.get(b.id) ?? 0) - (spentByCategory.get(a.id) ?? 0))[0] ?? null;
    setRows((current) => [...current, { key: nextKey++, categoryId: next?.id ?? "", amount: "" }]);
  }

  function update(key: number, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setError(null);
  }

  async function save() {
    if (!canSave || totalMinor === null) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.put<MonthlyBudgetStatus>("/budget/monthly", {
        amountMinor: totalMinor,
        categoryLimits: rows.map((row) => ({ categoryId: row.categoryId, amountMinor: toMinor(row.amount) ?? 0 })),
      });
      onSaved(next);
    } catch (err) {
      // The server's own words when it has them: it names the overshoot.
      setError(
        err instanceof ApiError && !err.message.startsWith("[object")
          ? err.message
          : "Couldn't save the budget. Check the amounts and try again."
      );
      setSaving(false);
    }
  }

  const assignedShare = totalMinor ? Math.min(100, Math.round((assignedMinor / totalMinor) * 100)) : 0;

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal budget-editor" role="dialog" aria-modal="true" aria-labelledby="budget-editor-title">
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>
        <h3 id="budget-editor-title">Monthly budget</h3>
        <div className="modal-sub">
          Everything counts against it — rent, EMIs, SIPs and the day to day. Whatever is left at the end of the
          month goes to savings.
        </div>

        <label className="field budget-editor-total">
          <span>For the whole month</span>
          <div className="amount-input">
            <span className="prefix">₹</span>
            <input
              autoFocus
              className="filter-input"
              inputMode="decimal"
              value={total}
              onChange={(event) => {
                setTotal(event.target.value);
                setError(null);
              }}
              placeholder="20000"
            />
          </div>
          {status?.suggestedMonthlyMinor && !status.budgetMinor ? (
            <span className="field-hint">
              Your old daily budget comes to {formatMoney(status.suggestedMonthlyMinor)} over this month.
            </span>
          ) : null}
        </label>

        <div className="budget-editor-section">
          <div className="budget-editor-head">
            <span className="trip-settle-title">Category limits</span>
            <span className="field-hint">Optional. They share out the total; they never add to it.</span>
          </div>

          {rows.length > 0 && (
            <ul className="budget-limit-rows">
              {rows.map((row) => {
                const spent = row.categoryId ? spentByCategory.get(row.categoryId) : undefined;
                return (
                  <li className="budget-limit-row" key={row.key}>
                    <select
                      className="filter-select"
                      aria-label="Category"
                      value={row.categoryId}
                      onChange={(event) => update(row.key, { categoryId: event.target.value })}
                    >
                      <option value="" disabled>
                        Pick a category
                      </option>
                      {spendable
                        .filter((category) => category.id === row.categoryId || !used.has(category.id))
                        .map((category) => (
                          <option key={category.id} value={category.id}>
                            {category.name}
                          </option>
                        ))}
                    </select>
                    <div className="amount-input">
                      <span className="prefix">₹</span>
                      <input
                        className="filter-input"
                        inputMode="decimal"
                        aria-label="Limit"
                        value={row.amount}
                        onChange={(event) => update(row.key, { amount: event.target.value })}
                        placeholder="0"
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm budget-limit-remove"
                      aria-label="Remove this limit"
                      onClick={() => setRows((current) => current.filter((other) => other.key !== row.key))}
                    >
                      <Icon name="ic-x" />
                    </button>
                    {spent !== undefined && spent > 0 && (
                      <span className="budget-limit-spent">{formatMoney(spent)} spent this month</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <button
            type="button"
            className="btn btn-sm"
            onClick={addRow}
            disabled={categories !== null && unused.length === 0}
          >
            <Icon name="ic-plus" /> Add a category limit
          </button>
        </div>

        {/* Kept in view as the limits are typed: how much of the total they take. */}
        <div className={`budget-meter${over ? " is-over" : ""}`} aria-live="polite">
          <div className="budget-meter-bar">
            <div className="budget-meter-fill" style={{ width: `${over ? 100 : assignedShare}%` }} />
          </div>
          <div className="budget-meter-text">
            {totalMinor === null || totalMinor === 0 ? (
              "Set the total first."
            ) : over ? (
              <>
                <Icon name="ic-alert" />
                Limits come to {formatMoney(assignedMinor)}, {formatMoney(-unassignedMinor)} more than the{" "}
                {formatMoney(totalMinor)} budget. Lower a limit or raise the budget.
              </>
            ) : (
              <>
                <b>{formatMoney(assignedMinor)}</b> of {formatMoney(totalMinor)} assigned ·{" "}
                <b>{formatMoney(unassignedMinor)}</b> unassigned, for everything else
              </>
            )}
          </div>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          <span className="field-hint">
            Applies from {status?.month.label ?? "this month"} on. Months already over keep the budget they had.
          </span>
          <span className="modal-actions-spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={!canSave}>
            {saving ? "Saving…" : "Save budget"}
          </button>
        </div>
      </div>
    </div>
  );
}
