import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { LedgerSkeleton, StateBlock } from "../components/States";
import { RawMessageModal } from "../components/RawMessageModal";
import { TransactionRow } from "../components/TransactionRow";
import { api } from "../lib/api";
import { Account, Category, Transaction } from "../types";

interface ListResponse {
  items: Transaction[];
  total: number;
  page: number;
  pageSize: number;
}

type Direction = "" | "DEBIT" | "CREDIT";

const PAGE_SIZE = 50;

export function TransactionsPage() {
  const [response, setResponse] = useState<ListResponse | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState(false);
  const [rawFor, setRawFor] = useState<Transaction | null>(null);

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState<Direction>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    Promise.all([api.get<Category[]>("/categories"), api.get<Account[]>("/accounts")])
      .then(([cats, accs]) => {
        setCategories(cats);
        setAccounts(accs);
      })
      .catch(() => setError(true));
  }, []);

  // Typing shouldn't fire a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (categoryId) params.set("categoryId", categoryId);
    if (accountId) params.set("accountId", accountId);
    if (direction) params.set("type", direction);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params.toString();
  }, [page, debouncedSearch, categoryId, accountId, direction, from, to]);

  useEffect(() => {
    setResponse(null);
    api
      .get<ListResponse>(`/transactions?${query}`)
      .then((result) => {
        setResponse(result);
        setError(false);
      })
      .catch(() => setError(true));
  }, [query]);

  // Any filter change invalidates the current page number.
  function changeFilter<T>(setter: (value: T) => void) {
    return (value: T) => {
      setPage(1);
      setter(value);
    };
  }

  function handleUpdated(updated: Transaction) {
    setResponse((prev) =>
      prev ? { ...prev, items: prev.items.map((t) => (t.id === updated.id ? updated : t)) } : prev
    );
  }

  const totalPages = response ? Math.max(1, Math.ceil(response.total / response.pageSize)) : 1;

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Transactions</h1>
      </div>

      <div className="layout-filters">
        <div className="filters-panel">
          <div className="filter-group">
            <label htmlFor="f-search">Search</label>
            <div className="filter-input-icon">
              <Icon name="ic-search" />
              <input
                id="f-search"
                className="filter-input"
                placeholder="Merchant or note"
                value={search}
                onChange={(e) => changeFilter(setSearch)(e.target.value)}
              />
            </div>
          </div>

          <div className="filter-group">
            <label htmlFor="f-category">Category</label>
            <select
              id="f-category"
              className="filter-select"
              value={categoryId}
              onChange={(e) => changeFilter(setCategoryId)(e.target.value)}
            >
              <option value="">All categories</option>
              <option value="none">Uncategorized</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label htmlFor="f-from">Date range</label>
            <div className="filter-daterange">
              <input
                id="f-from"
                type="date"
                className="filter-input"
                value={from}
                onChange={(e) => changeFilter(setFrom)(e.target.value)}
              />
              <span style={{ color: "var(--muted-light)" }}>–</span>
              <input
                type="date"
                className="filter-input"
                value={to}
                onChange={(e) => changeFilter(setTo)(e.target.value)}
              />
            </div>
          </div>

          <div className="filter-group">
            <label htmlFor="f-account">Account</label>
            <select
              id="f-account"
              className="filter-select"
              value={accountId}
              onChange={(e) => changeFilter(setAccountId)(e.target.value)}
            >
              <option value="">All accounts</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.bankName}
                  {account.last4 ? ` ••${account.last4}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="filter-group">
            <label>Direction</label>
            <div className="filter-radio-row">
              {(
                [
                  ["", "All"],
                  ["DEBIT", "Debit"],
                  ["CREDIT", "Credit"],
                ] as [Direction, string][]
              ).map(([value, label]) => (
                <button
                  key={label}
                  className={`filter-radio${direction === value ? " on" : ""}`}
                  onClick={() => changeFilter(setDirection)(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div>
          {error ? (
            <StateBlock
              warn
              icon="ic-wifioff"
              title="Couldn't load your transactions"
              body="The connection to SpendLog's server failed. Your data is safe — this is just a connection problem. Check your internet and try again."
            />
          ) : !response ? (
            <LedgerSkeleton />
          ) : response.items.length === 0 ? (
            <StateBlock
              icon="ic-search"
              title="Nothing matches those filters"
              body="No transaction fits this combination. Widen the date range, or clear a filter to see more."
            />
          ) : (
            <>
              <div className="txn-list-head">
                <span>
                  {response.total} result{response.total === 1 ? "" : "s"}
                </span>
                <span>Sorted by newest first</span>
              </div>

              {response.items.map((transaction) => (
                <TransactionRow
                  key={transaction.id}
                  transaction={transaction}
                  categories={categories}
                  onUpdated={handleUpdated}
                  onShowRaw={setRawFor}
                />
              ))}

              {totalPages > 1 && (
                <div className="pagination">
                  <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1} aria-label="Previous page">
                    <Icon name="ic-chevron-left" />
                  </button>
                  <span>
                    Page {page} of {totalPages}
                  </span>
                  <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages} aria-label="Next page">
                    <Icon name="ic-chevron-right" />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {rawFor && <RawMessageModal transaction={rawFor} onClose={() => setRawFor(null)} />}
    </section>
  );
}
