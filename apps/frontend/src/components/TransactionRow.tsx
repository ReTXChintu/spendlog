import { useState } from "react";
import { formatMoney, formatTime } from "../lib/format";
import { Category, Transaction, accountLabel } from "../types";
import { CategoryPopover } from "./CategoryPopover";
import { Icon } from "./Icon";
import { RememberBanner } from "./RememberBanner";

/**
 * One transaction. The category is set from the round chip on the left
 * rather than a permanently visible dropdown, so a long list reads as a
 * ledger instead of a wall of form controls.
 */
export function TransactionRow({
  transaction,
  categories,
  onUpdated,
  onShowRaw,
  onEdit,
  selectable = false,
  selected = false,
  onToggleSelected,
}: {
  transaction: Transaction;
  categories: Category[];
  onUpdated: (updated: Transaction) => void;
  onShowRaw: (transaction: Transaction) => void;
  onEdit: (transaction: Transaction) => void;
  /** While picking rows to merge, the whole row becomes the checkbox. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelected?: (transaction: Transaction) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Set after a category is chosen, offering to remember the merchant.
  const [justCategorized, setJustCategorized] = useState<Category | null>(null);

  const isDebit = transaction.type === "DEBIT";
  const category = transaction.category;
  const account = transaction.account;

  function handlePicked(picked: Category, updated: Transaction) {
    onUpdated(updated);
    setPickerOpen(false);
    // Only worth remembering when there's a merchant to match on later.
    if (transaction.merchant) setJustCategorized(picked);
  }

  // Distinct source kinds, in the order they first arrived.
  const sourceIcons = Array.from(
    new Set((transaction.sources.length > 0 ? transaction.sources : [transaction]).map((s) => s.source))
  ).map((source) => (source === "EMAIL" ? "ic-mail" : source === "MANUAL" ? "ic-pencil" : "ic-message"));

  const meta = [
    account ? accountLabel(account) : null,
    account?.accountType === "CARD" ? "Card" : account ? "Bank" : null,
    formatTime(transaction.occurredAt),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="row-wrap">
        <div
          className={`row${transaction.isTransfer ? " is-transfer" : ""}${selectable ? " is-selectable" : ""}${
            selected ? " is-selected" : ""
          }`}
          onClick={selectable ? () => onToggleSelected?.(transaction) : undefined}
        >
          {selectable && (
            <input type="checkbox" className="row-select" checked={selected} readOnly tabIndex={-1} />
          )}
          {transaction.isTransfer ? (
            <div className="row-cat-chip" style={{ background: "#F1F5F9", color: "var(--transfer)" }}>
              <Icon name="ic-arrow-right" />
            </div>
          ) : (
            <button
              className={`row-cat-chip${category ? "" : " uncat"}`}
              style={category?.color ? { background: category.color } : undefined}
              onClick={() => setPickerOpen((open) => !open)}
              title={category ? `Category: ${category.name}` : "Set category"}
            >
              <Icon name={category?.icon ?? "ic-plus"} />
            </button>
          )}

          <div className="row-main">
            <div className="row-merchant">
              <span className="txt">{transaction.merchant ?? "Unknown"}</span>
              <button className="row-info-btn" onClick={() => onEdit(transaction)} title="Edit transaction">
                <Icon name="ic-pencil" />
              </button>
              {transaction.rawText && (
                <button className="row-info-btn" onClick={() => onShowRaw(transaction)} title="View original message">
                  <Icon name="ic-info" />
                </button>
              )}
            </div>
            <div className="row-meta">
              {/* One icon per message that reported this, so a row seen by
                  both SMS and email says so without being opened. */}
              {sourceIcons.map((name, i) => (
                <Icon key={`${name}-${i}`} name={name} />
              ))}
              {meta}
            </div>
            {transaction.isTransfer && (
              <div className="row-badges">
                <span className="badge badge-transfer">
                  <Icon name="ic-arrow-right" />
                  Between your accounts · not counted
                </span>
              </div>
            )}
            {transaction.refundOf.length > 0 && (
              <div className="row-badges">
                <span className="badge badge-refund">Refund · not income</span>
              </div>
            )}
            {transaction.refundedMinor > 0 && (
              <div className="row-badges">
                <span className="badge badge-refunded">
                  {formatMoney(transaction.refundedMinor, transaction.currency)} refunded ·{" "}
                  {formatMoney(
                    Math.max(0, transaction.amountMinor - transaction.refundedMinor),
                    transaction.currency
                  )}{" "}
                  lost
                </span>
              </div>
            )}
            {transaction.emiRole === "PARENT" && (
              <div className="row-badges">
                <span className="badge badge-emi">On EMI · not counted here</span>
              </div>
            )}
            {transaction.emiRole === "INSTALMENT" && (
              <div className="row-badges">
                <span className="badge badge-emi">EMI payment</span>
              </div>
            )}
            {transaction.split && (
              <div className="row-badges">
                <span className="badge badge-split">
                  My share {formatMoney(transaction.split.myShareMinor, transaction.currency)}
                  {transaction.split.groupLabel ? ` · ${transaction.split.groupLabel}` : ""}
                </span>
              </div>
            )}
            {transaction.isSettlement && (
              <div className="row-badges">
                <span className="badge badge-settlement">Settling up · not counted</span>
              </div>
            )}
            {transaction.editedAt && !transaction.isTransfer && (
              <div className="row-badges">
                <span className="badge badge-edited">Edited</span>
              </div>
            )}
            {transaction.pending && (
              <div className="row-badges">
                <span className="badge badge-pending">Pending</span>
              </div>
            )}
          </div>

          <div className="row-amount-wrap">
            <div
              className={`row-amount num ${transaction.isTransfer ? "transfer-amt" : isDebit ? "debit" : "credit"}`}
              style={transaction.isTransfer ? { color: "var(--transfer)" } : undefined}
            >
              {isDebit ? "−" : "+"}
              {formatMoney(transaction.amountMinor, transaction.currency)}
            </div>
          </div>
        </div>

        {pickerOpen && (
          <CategoryPopover
            categories={categories}
            transaction={transaction}
            onPicked={handlePicked}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>

      {justCategorized && transaction.merchant && (
        <RememberBanner
          merchant={transaction.merchant}
          category={justCategorized}
          onDone={() => setJustCategorized(null)}
        />
      )}
    </>
  );
}
