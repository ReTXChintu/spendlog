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
}: {
  transaction: Transaction;
  categories: Category[];
  onUpdated: (updated: Transaction) => void;
  onShowRaw: (transaction: Transaction) => void;
  onEdit: (transaction: Transaction) => void;
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
        <div className={`row${transaction.isTransfer ? " is-transfer" : ""}`}>
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
              <Icon name={transaction.source === "EMAIL" ? "ic-mail" : "ic-message"} />
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
