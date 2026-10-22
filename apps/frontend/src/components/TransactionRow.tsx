import { CSSProperties, MouseEvent, useState } from "react";
import { formatMoney, formatTime } from "../lib/format";
import { Category, Transaction, accountLabel, groupOf } from "../types";
import { CategoryPopover } from "./CategoryPopover";
import { Icon } from "./Icon";
import { RememberBanner } from "./RememberBanner";
import "../styles/pocket.css";

/** Rupees without paise when there are none: "₹486", "₹486.50". */
export function formatAmount(amountMinor: number, currency = "INR"): string {
  const full = formatMoney(amountMinor, currency);
  return amountMinor % 100 === 0 ? full.replace(/\.00$/, "") : full;
}

/** Two letters for a merchant's monogram: "Third Wave Coffee" → "TW". */
function monogramOf(name: string | null): string {
  const words = (name ?? "").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Whether a row moves the totals at all. Transfers between own accounts,
 * card bills, settling up and an EMI's original purchase are recorded but
 * not counted, so they read in --tx3 with no sign (design-system.md §3.2).
 */
export function isNotCounted(transaction: Transaction): boolean {
  // Being paid back is money in (§3.2); paying someone back is not spending.
  return (
    transaction.isTransfer ||
    (transaction.isSettlement && transaction.type === "DEBIT") ||
    transaction.emiRole === "PARENT" ||
    !!transaction.cardPaymentFor
  );
}

/**
 * One transaction, as a row of the day-grouped ledger: time, merchant with
 * its badges, category, account, amount. Clicking the row opens it in the
 * editor beside the list; the category cell sets the category in place,
 * and the info button shows the message it was read from.
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
  active = false,
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
  /** The row open in the editor. */
  active?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Set after a category is chosen, offering to remember the merchant.
  const [justCategorized, setJustCategorized] = useState<Category | null>(null);

  const isDebit = transaction.type === "DEBIT";
  const category = transaction.category;
  const account = transaction.account;
  const neutral = isNotCounted(transaction);
  const needsCategory = !category && !transaction.isTransfer && !transaction.cardPaymentFor;

  function handlePicked(picked: Category, updated: Transaction) {
    onUpdated(updated);
    setPickerOpen(false);
    // Only worth remembering when there's a merchant to match on later.
    if (transaction.merchant) setJustCategorized(picked);
  }

  // Distinct source kinds, in the order they first arrived.
  const sourceIcons = Array.from(
    new Set((transaction.sources.length > 0 ? transaction.sources : [transaction]).map((s) => s.source))
  ).map((source) =>
    source === "EMAIL" ? "ic-mail" : source === "MANUAL" ? "ic-pencil" : source === "STATEMENT" ? "ic-list" : "ic-message"
  );

  // A payment someone else made touched none of the user's accounts.
  const paidByName = transaction.offLedger ? (transaction.paidByContact?.name ?? "someone else") : null;
  const accountText = paidByName ? `Paid by ${paidByName}` : account ? accountLabel(account) : "Cash";
  const group = groupOf(transaction);
  const categoryText = transaction.isTransfer
    ? isDebit
      ? "To my own account"
      : "From my own account"
    : transaction.cardPaymentFor
      ? "Card bill"
      : category?.name ?? "No category";

  // Badges, in the design's vocabulary: accent for state the app added,
  // neutral for "not counted", outline for edits, good for money back.
  const badges: { text: string; tone: string }[] = [];
  if (transaction.isTransfer) badges.push({ text: "Transfer", tone: "badge-neutral" }, { text: "Not counted", tone: "badge-outline" });
  if (transaction.pending) badges.push({ text: "Pending", tone: "badge-warn" });
  if (account?.pocketMoney) badges.push({ text: `Pocket money · ${account.pocketMoney.holder}`, tone: "badge-pocket" });
  if (transaction.byKidName) badges.push({ text: `by ${transaction.byKidName}`, tone: "badge-kid" });
  if (group) badges.push({ text: group.name, tone: "badge-group" });
  if (transaction.refundOf.length > 0) badges.push({ text: "Refund · not income", tone: "badge-refund" });
  if (transaction.refundedMinor > 0)
    badges.push({
      text: `${formatAmount(transaction.refundedMinor, transaction.currency)} refunded · ${formatAmount(
        Math.max(0, transaction.amountMinor - transaction.refundedMinor),
        transaction.currency
      )} lost`,
      tone: "badge-refunded",
    });
  if (transaction.emiRole === "PARENT") badges.push({ text: "On EMI · not counted here", tone: "badge-emi" });
  if (transaction.emiRole === "INSTALMENT") badges.push({ text: "EMI payment", tone: "badge-emi" });
  if (transaction.split && transaction.groupSplit)
    badges.push({
      text: `My share ${formatAmount(transaction.split.myShareMinor, transaction.currency)}`,
      tone: "badge-split",
    });
  else if (transaction.split)
    badges.push({
      text: `Split · my share ${formatAmount(transaction.split.myShareMinor, transaction.currency)}${
        transaction.split.groupLabel ? ` · ${transaction.split.groupLabel}` : ""
      }`,
      tone: "badge-split",
    });
  if (transaction.isSettlement) badges.push({ text: isDebit ? "Settling up · not counted" : "Paid back", tone: "badge-settlement" });
  if (transaction.editedAt) badges.push({ text: "Edited", tone: "badge-edited" });

  const tone = neutral ? "money-neutral" : isDebit ? "money-out" : "money-in";
  const sign = neutral ? "" : isDebit ? "−" : "+";

  function openRow(event: MouseEvent<HTMLDivElement>) {
    if (selectable) {
      onToggleSelected?.(transaction);
      return;
    }
    // Buttons inside the row do their own thing.
    if ((event.target as HTMLElement).closest("button, a, input, .cat-popover")) return;
    onEdit(transaction);
  }

  const monoStyle = category?.color ? ({ "--cat": category.color } as CSSProperties) : undefined;

  return (
    <>
      <div className="txn-row-wrap">
        <div
          className={`txn-row${neutral ? " is-neutral" : ""}${needsCategory && !selected && !active ? " is-attention" : ""}${
            selectable ? " is-selectable" : ""
          }${selected ? " is-selected" : ""}${active ? " is-active" : ""}`}
          onClick={openRow}
          aria-current={active ? "true" : undefined}
        >
          <div className="txn-cell txn-time num">
            {selectable && <input type="checkbox" className="row-select" checked={selected} readOnly tabIndex={-1} />}
            <span>{formatTime(transaction.occurredAt)}</span>
          </div>

          <div className="txn-cell txn-merchant">
            {transaction.isTransfer ? (
              <span className="icon-tile sm tile-neutral txn-lead" aria-hidden="true">
                <Icon name="ic-transfer" />
              </span>
            ) : (
              <span className={`monogram txn-lead${category ? " has-cat" : ""}`} style={monoStyle} aria-hidden="true">
                {monogramOf(transaction.merchant)}
              </span>
            )}
            <div className="txn-merchant-main">
              <div className="txn-merchant-line">
                <button
                  type="button"
                  className="txn-name"
                  onClick={() => (selectable ? onToggleSelected?.(transaction) : onEdit(transaction))}
                  title="Open in the editor"
                >
                  {transaction.merchant ?? "Unknown"}
                </button>
                {transaction.rawText && (
                  <button
                    type="button"
                    className="txn-info"
                    onClick={() => onShowRaw(transaction)}
                    title="View original message"
                    aria-label="View original message"
                  >
                    <Icon name="ic-info" />
                  </button>
                )}
              </div>
              {badges.length > 0 && (
                <div className="txn-badges">
                  {badges.map((badge) => (
                    <span key={badge.text} className={`badge ${badge.tone}`}>
                      {badge.text}
                    </span>
                  ))}
                </div>
              )}
              {/* The phone row's second line; hidden while the columns show. */}
              <div className="txn-sub">
                {categoryText} · {accountText} · {formatTime(transaction.occurredAt)}
              </div>
            </div>
          </div>

          <div className="txn-cell txn-category">
            {transaction.isTransfer || transaction.cardPaymentFor ? (
              <span>{categoryText}</span>
            ) : category ? (
              <button
                type="button"
                className="txn-cat-btn"
                onClick={() => setPickerOpen((open) => !open)}
                title={`Category: ${category.name}. Click to change.`}
              >
                {category.name}
              </button>
            ) : (
              <button type="button" className="btn btn-md txn-pick" onClick={() => setPickerOpen((open) => !open)}>
                Pick category
                <Icon name="ic-chevron-down" />
              </button>
            )}
          </div>

          <div className="txn-cell txn-account">
            <span className="txn-account-name">{accountText}</span>
            <span className="txn-sources" aria-label="Reported by">
              {sourceIcons.map((name, i) => (
                <Icon key={`${name}-${i}`} name={name} />
              ))}
            </span>
          </div>

          <div className={`txn-cell txn-amount num ${tone}`}>
            {sign}
            {formatAmount(transaction.amountMinor, transaction.currency)}
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
