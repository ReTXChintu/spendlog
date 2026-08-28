import { useEffect, useState } from "react";
import { TransactionRow } from "../components/TransactionRow";
import { api } from "../lib/api";
import { Category, Transaction } from "../types";

interface ListResponse {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
}

export function TransactionsPage() {
  const [items, setItems] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const pageSize = 50;

  useEffect(() => {
    api.get<Category[]>("/categories").then(setCategories);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) params.set("q", q);
    if (categoryId) params.set("categoryId", categoryId);

    api.get<ListResponse>(`/transactions?${params.toString()}`).then((res) => {
      setItems(res.items);
      setTotal(res.total);
    });
  }, [page, q, categoryId]);

  function handleUpdated(updated: Transaction) {
    setItems((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div className="filters">
        <input
          placeholder="Search merchant or note…"
          value={q}
          onChange={(e) => {
            setPage(1);
            setQ(e.target.value);
          }}
        />
        <select
          value={categoryId}
          onChange={(e) => {
            setPage(1);
            setCategoryId(e.target.value);
          }}
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="day-list">
        {items.map((t) => (
          <TransactionRow key={t.id} transaction={t} categories={categories} onUpdated={handleUpdated} />
        ))}
        {items.length === 0 && <p className="empty-state">No transactions match these filters.</p>}
      </div>

      <div className="pagination">
        <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {totalPages}
        </span>
        <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
