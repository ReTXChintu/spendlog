import { useState } from "react";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";
import { Category, Transaction } from "../types";

export function TransactionRow({
  transaction,
  categories,
  onUpdated,
}: {
  transaction: Transaction;
  categories: Category[];
  onUpdated: (updated: Transaction) => void;
}) {
  const [saving, setSaving] = useState(false);

  async function handleCategoryChange(categoryId: string) {
    setSaving(true);
    try {
      const updated = await api.patch<Transaction>(`/transactions/${transaction.id}`, {
        categoryId: categoryId || null,
      });
      onUpdated(updated);
    } finally {
      setSaving(false);
    }
  }

  const sign = transaction.type === "DEBIT" ? "-" : "+";
  const amountClass = transaction.type === "DEBIT" ? "amount debit" : "amount credit";

  return (
    <div className={`transaction-row${transaction.isTransfer ? " transfer" : ""}`}>
      <div className="transaction-main">
        <div className="transaction-merchant">
          {transaction.merchant ?? "Unknown"}
          {transaction.isTransfer && <span className="badge">Transfer</span>}
          {transaction.pending && <span className="badge">Pending</span>}
        </div>
        <div className="transaction-meta">
          {transaction.account ? `${transaction.account.bankName} ••${transaction.account.last4 ?? "----"}` : transaction.source}
          {" · "}
          {new Date(transaction.occurredAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
      <select
        className="category-select"
        value={transaction.category?.id ?? ""}
        disabled={saving}
        onChange={(e) => handleCategoryChange(e.target.value)}
      >
        <option value="">Uncategorized</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className={amountClass}>
        {sign}
        {formatMoney(transaction.amountMinor, transaction.currency)}
      </div>
    </div>
  );
}
