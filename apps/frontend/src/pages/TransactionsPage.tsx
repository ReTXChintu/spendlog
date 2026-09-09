import { useCallback, useEffect, useMemo, useState } from "react";
import { EditTransactionModal } from "../components/EditTransactionModal";
import { Icon } from "../components/Icon";
import { LedgerSkeleton, StateBlock } from "../components/States";
import { RawMessageModal } from "../components/RawMessageModal";
import { TransactionRow } from "../components/TransactionRow";
import { api } from "../lib/api";
import { currentMonth, formatDayLabel, formatMoney } from "../lib/format";
import {
  Account,
  AnalyticsSummary,
  Category,
  DayGroup,
  EmailConnectionStatus,
  Transaction,
  TransactionType,
} from "../types";

interface ByDayResponse {
  days: DayGroup[];
  hasMore: boolean;
  nextBefore: string | null;
}

const DAYS_PER_PAGE = 30;

/**
 * The ledger — the app's main screen. Browsing by day and searching used to
 * be two pages showing the same list; they're one now, with the filters
 * narrowing the same day-grouped view.
 */
export function TransactionsPage() {
  const [days, setDays] = useState<DayGroup[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [hasGmail, setHasGmail] = useState(false);
  const [error, setError] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const [rawFor, setRawFor] = useState<Transaction | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [adding, setAdding] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [direction, setDirection] = useState<TransactionType | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (categoryId) params.set("categoryId", categoryId);
    if (accountId) params.set("accountId", accountId);
    if (direction) params.set("type", direction);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    return params;
  }, [debouncedSearch, categoryId, accountId, direction, from, to]);

  const load = useCallback(async () => {
    setDays(null);
    const params = new URLSearchParams(filterQuery);
    params.set("days", String(DAYS_PER_PAGE));
    try {
      const result = await api.get<ByDayResponse>(`/transactions/by-day?${params}`);
      setDays(result.days);
      setHasMore(result.hasMore);
      setNextBefore(result.nextBefore);
      setError(false);
    } catch {
      setError(true);
    }
  }, [filterQuery]);

  useEffect(() => {
    load();
  }, [load]);

  // Context for the rail, independent of the filters.
  const loadContext = useCallback(async () => {
    try {
      const [cats, accs, monthSummary, emails] = await Promise.all([
        api.get<Category[]>("/categories"),
        api.get<Account[]>("/accounts"),
        api.get<AnalyticsSummary>(`/analytics/summary?month=${currentMonth()}`),
        api.get<EmailConnectionStatus[]>("/ingestion/email/status"),
      ]);
      setCategories(cats);
      setAccounts(accs);
      setSummary(monthSummary);
      setHasGmail(emails.length > 0);
    } catch {
      // The ledger still works without the rail populated.
    }
  }, []);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    const params = new URLSearchParams(filterQuery);
    params.set("days", String(DAYS_PER_PAGE));
    params.set("before", nextBefore);
    try {
      const result = await api.get<ByDayResponse>(`/transactions/by-day?${params}`);
      setDays((prev) => [...(prev ?? []), ...result.days]);
      setHasMore(result.hasMore);
      setNextBefore(result.nextBefore);
    } finally {
      setLoadingMore(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    try {
      await api.post("/ingestion/email/sync");
      await Promise.all([load(), loadContext()]);
    } catch {
      // Nothing to do — the ledger on screen is still valid.
    } finally {
      setSyncing(false);
    }
  }

  function replaceTransaction(updated: Transaction) {
    setDays((prev) =>
      prev
        ? prev.map((day) => ({
            ...day,
            transactions: day.transactions.map((t) => (t.id === updated.id ? updated : t)),
          }))
        : prev
    );
  }

  // An edit can change the amount, the date or the direction, so the day
  // totals and grouping have to be recomputed from the server.
  const reloadAfterEdit = () => {
    load();
    loadContext();
  };

  function changeFilter<T>(setter: (value: T) => void) {
    return (value: T) => setter(value);
  }

  const uncategorized = summary?.byCategory.find((c) => c.categoryId === null);
  const filtersActive = Array.from(filterQuery.keys()).length > 0;

  function clearFilters() {
    setSearch("");
    setCategoryId("");
    setAccountId("");
    setDirection("");
    setFrom("");
    setTo("");
  }

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Transactions</h1>
        <div className="screen-actions">
          <button className="btn btn-ghost btn-sm" onClick={syncNow} disabled={syncing}>
            <Icon name="ic-sync" /> {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
            <Icon name="ic-plus" /> Add
          </button>
        </div>
      </div>

      <div className="layout-ledger">
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
                onChange={(e) => setSearch(e.target.value)}
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
                ] as [TransactionType | "", string][]
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

          {filtersActive && (
            <button className="btn btn-sm btn-ghost" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>

        <div>
          {error ? (
            <StateBlock
              warn
              icon="ic-wifioff"
              title="Couldn't load your transactions"
              body="The connection to SpendLog's server failed. Your data is safe — this is just a connection problem. Check your internet and try again."
              actions={
                <button className="btn btn-primary" onClick={load}>
                  <Icon name="ic-sync" /> Retry
                </button>
              }
            />
          ) : !days ? (
            <LedgerSkeleton />
          ) : days.length === 0 ? (
            filtersActive ? (
              <StateBlock
                icon="ic-search"
                title="Nothing matches those filters"
                body="No transaction fits this combination. Widen the date range, or clear a filter to see more."
                actions={
                  <button className="btn btn-primary" onClick={clearFilters}>
                    Clear filters
                  </button>
                }
              />
            ) : hasGmail ? (
              <StateBlock
                icon="ic-mail"
                title="No bank emails found yet"
                body="Your Gmail is connected and we've checked it, but no transaction email from your bank has turned up. Many Indian banks only send SMS for card and UPI payments — the Android app can catch those."
                actions={
                  <button className="btn btn-primary" onClick={() => setAdding(true)}>
                    Add one by hand
                  </button>
                }
              />
            ) : (
              <StateBlock
                icon="ic-receipt"
                title="Nothing here yet"
                body="SpendLog fills in on its own once a bank message arrives. Connect Gmail or install the Android app from Settings — or add a transaction by hand."
                actions={
                  <button className="btn btn-primary" onClick={() => setAdding(true)}>
                    Add one by hand
                  </button>
                }
              />
            )
          ) : (
            <>
              {days.map((day) => (
                <div className="day-group" key={day.date}>
                  <div className="day-header">
                    <span className="day-label">{formatDayLabel(day.date)}</span>
                    <span className="day-totals">
                      {day.spendMinor > 0 && <span className="spend num">− {formatMoney(day.spendMinor)}</span>}
                      {day.spendMinor > 0 && day.incomeMinor > 0 && <span className="dsep">·</span>}
                      {day.incomeMinor > 0 && <span className="income num">+ {formatMoney(day.incomeMinor)}</span>}
                    </span>
                  </div>
                  {day.transactions.map((transaction) => (
                    <TransactionRow
                      key={transaction.id}
                      transaction={transaction}
                      categories={categories}
                      onUpdated={replaceTransaction}
                      onShowRaw={setRawFor}
                      onEdit={setEditing}
                    />
                  ))}
                </div>
              ))}

              {hasMore && (
                <div className="load-more">
                  <button className="btn" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? "Loading…" : "Load earlier days"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="rail">
          <div className="card">
            <div className="rail-title">This month</div>
            <div className="stat-line">
              <span className="label">Spent</span>
              <span className="value num" style={{ color: "var(--debit)" }}>
                {formatMoney(summary?.totalSpendMinor ?? 0)}
              </span>
            </div>
            <div className="stat-line">
              <span className="label">Received</span>
              <span className="value num" style={{ color: "var(--credit)" }}>
                {formatMoney(summary?.totalIncomeMinor ?? 0)}
              </span>
            </div>
          </div>

          {uncategorized && (
            <div className="nudge">
              <div className="nudge-title">
                <Icon name="ic-question" />
                Needs a category
              </div>
              <p>
                {formatMoney(uncategorized.amountMinor)} of spending this month has no category yet — mostly UPI
                codes and person-to-person payments, which nothing can guess from the message alone.
              </p>
              <a
                href="#uncategorized"
                onClick={(event) => {
                  event.preventDefault();
                  setCategoryId("none");
                }}
              >
                Show them <Icon name="ic-arrow-right" />
              </a>
            </div>
          )}
        </div>
      </div>

      {rawFor && <RawMessageModal transaction={rawFor} onClose={() => setRawFor(null)} />}

      {(editing || adding) && (
        <EditTransactionModal
          transaction={editing}
          categories={categories}
          accounts={accounts}
          onSaved={reloadAfterEdit}
          onDeleted={reloadAfterEdit}
          onClose={() => {
            setEditing(null);
            setAdding(false);
          }}
        />
      )}
    </section>
  );
}
