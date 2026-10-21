import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { EditTransactionModal } from "../components/EditTransactionModal";
import { CardStrip } from "../components/CardStrip";
import { EmiModal } from "../components/EmiModal";
import { RefundModal } from "../components/RefundModal";
import { Icon } from "../components/Icon";
import { LedgerSkeleton, StateBlock } from "../components/States";
import { RawMessageModal } from "../components/RawMessageModal";
import { TransactionRow } from "../components/TransactionRow";
import { api } from "../lib/api";
import { formatDayLabel, formatMoney, formatMoneyShort } from "../lib/format";
import "../styles/budget.css";
import {
  Account,
  AnalyticsSummary,
  BudgetPace,
  CardStatus,
  Category,
  DayGroup,
  EmailConnectionStatus,
  MonthlyBudgetStatus,
  Transaction,
  TransactionType,
  AccountCycles,
  AnalyticsMonths,
  accountLabel,
} from "../types";

interface ByDayResponse {
  days: DayGroup[];
  hasMore: boolean;
  nextBefore: string | null;
}

/// A week of days at a time, more fetched as the list is scrolled - the
/// ledger grows every day, and loading all of it to show the top was going
/// to get slower for ever.
const DAYS_PER_PAGE = 7;

/**
 * The ledger. Browsing by day and searching used to be two pages showing
 * the same list; they're one now, with the filters narrowing the same
 * day-grouped view.
 */
export function TransactionsPage() {
  // The dashboard links here with a filter already chosen, so the job it
  // was nagging about is the first thing on screen rather than something
  // to go and find.
  const [searchParams] = useSearchParams();
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
  // Said, not swallowed: a mailbox Google stopped letting us read has to be
  // reconnected, and a sync that quietly did nothing looks like "no news".
  const [syncProblem, setSyncProblem] = useState<string | null>(null);

  const [rawFor, setRawFor] = useState<Transaction | null>(null);
  const [emiFor, setEmiFor] = useState<Transaction | null>(null);
  const [refundFor, setRefundFor] = useState<Transaction | null>(null);
  const [cards, setCards] = useState<CardStatus[]>([]);
  const [pace, setPace] = useState<BudgetPace | null>(null);
  // The month on screen against its budget, for the month bar.
  const [monthBudget, setMonthBudget] = useState<MonthlyBudgetStatus | null>(null);
  // Rows picked for merging. Empty means selection mode is off.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [adding, setAdding] = useState(false);

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryId, setCategoryId] = useState(searchParams.get("category") ?? "");
  const [accountId, setAccountId] = useState(searchParams.get("account") ?? "");
  // The chosen account's billing cycles: statement day to the day before
  // the next for a card, the user's own months for anything else.
  const [cycles, setCycles] = useState<AccountCycles | null>(null);
  const [direction, setDirection] = useState<TransactionType | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // The user's own months, salary day to salary day, newest first; the
  // list shows one at a time. Typed dates or an account's statement cycle
  // replace it with a range of their own until "Back to months".
  const [months, setMonths] = useState<AnalyticsMonths | null>(null);
  const [monthIndex, setMonthIndex] = useState(0);
  const [customRange, setCustomRange] = useState(false);
  const [monthsFailed, setMonthsFailed] = useState(false);
  const month = months?.months[monthIndex] ?? null;

  useEffect(() => {
    api
      .get<AnalyticsMonths>("/analytics/months")
      .then(setMonths)
      .catch(() => setMonthsFailed(true));
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  // Picking an account opens on its current cycle - "what's on this card's
  // bill so far" is nearly always the question - and the dates can then be
  // moved to an earlier cycle, all time, or anything typed.
  useEffect(() => {
    if (!accountId) {
      setCycles(null);
      return;
    }
    let live = true;
    api
      .get<AccountCycles>(`/accounts/${accountId}/cycles?count=12`)
      .then((next) => {
        if (!live) return;
        setCycles(next);
        const current = next.cycles[0];
        if (current) {
          setFrom(current.from);
          setTo(current.to);
          setCustomRange(true);
        }
      })
      .catch(() => live && setCycles(null));
    return () => {
      live = false;
    };
  }, [accountId]);

  const selectedCycle = cycles?.cycles.find((cycle) => cycle.from === from && cycle.to === to) ?? null;

  function pickCycle(value: string) {
    if (value === "all") {
      setFrom("");
      setTo("");
      setCustomRange(true);
    } else if (value !== "custom") {
      const [nextFrom, nextTo] = value.split("|");
      setFrom(nextFrom);
      setTo(nextTo);
      setCustomRange(true);
    }
  }

  const filterQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (categoryId) params.set("categoryId", categoryId);
    if (accountId) params.set("accountId", accountId);
    if (direction) params.set("type", direction);
    if (customRange) {
      if (from) params.set("from", from);
      if (to) params.set("to", to);
    } else if (month) {
      params.set("from", month.from);
      params.set("to", month.to);
    }
    return params;
  }, [debouncedSearch, categoryId, accountId, direction, from, to, customRange, month]);

  /// Nothing is fetched until it is known which month to fetch - otherwise
  /// the first load would be the whole ledger, the very thing this avoids.
  const ready = customRange || month !== null || monthsFailed;

  /**
   * Fetches the ledger.
   *
   * `keepVisible` refreshes in place, leaving the rows on screen until the
   * new ones arrive. Blanking the list first collapses the page to nothing,
   * at which point the browser clamps the scroll position to the top — so
   * editing a payment from the 1st would land you back at the 15th's rows
   * every time. Changing a filter still blanks it, because there the view
   * really is starting over.
   */
  const load = useCallback(async (options?: { keepVisible?: boolean }) => {
    if (!ready) return;
    if (!options?.keepVisible) setDays(null);
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
  }, [filterQuery, ready]);

  useEffect(() => {
    load();
  }, [load]);

  // Context for the rail, independent of the filters.
  const loadContext = useCallback(async () => {
    try {
      const [cats, accs, monthSummary, emails] = await Promise.all([
        api.get<Category[]>("/categories"),
        api.get<Account[]>("/accounts"),
        api.get<AnalyticsSummary>("/analytics/summary"),
        api.get<EmailConnectionStatus[]>("/ingestion/email/status"),
      ]);
      setCategories(cats);
      setAccounts(accs);
      setSummary(monthSummary);
      setHasGmail(emails.some((email) => !email.needsReconnect));
    } catch {
      // The ledger still works without the rail populated.
    }

    // Card cycles and the spending pace: both advisory, so neither is
    // allowed to stop the ledger loading.
    try {
      const [cardStatus, budgetPace] = await Promise.all([
        api.get<CardStatus[]>("/cards"),
        api.get<BudgetPace>("/budget/pace"),
      ]);
      setCards(cardStatus);
      setPace(budgetPace);
    } catch {
      setCards([]);
      setPace(null);
    }
  }, []);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  async function loadMore() {
    if (!nextBefore || loadingMore) return;
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

  // The next week loads as the bottom of the list comes into view.
  const sentinel = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreRef.current();
      },
      { rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, days]);

  // The rail's figures follow the month on screen.
  useEffect(() => {
    if (!month) return;
    api
      .get<AnalyticsSummary>(`/analytics/summary?month=${month.month}`)
      .then(setSummary)
      .catch(() => undefined);
  }, [month]);

  // So does the budget on the month bar. Refetched after an edit too,
  // since an edit can move a payment in or out of the month.
  const monthKey = month?.month ?? null;
  const loadMonthBudget = useCallback(() => {
    if (!monthKey) return;
    api
      .get<MonthlyBudgetStatus>(`/budget/monthly/${monthKey}`)
      .then(setMonthBudget)
      .catch(() => setMonthBudget(null));
  }, [monthKey]);
  useEffect(loadMonthBudget, [loadMonthBudget]);

  function backToMonths() {
    setFrom("");
    setTo("");
    setAccountId("");
    setCustomRange(false);
  }

  async function syncNow() {
    setSyncing(true);
    setSyncProblem(null);
    try {
      const result = await api.post<{ needsReconnect?: string[] }>("/ingestion/email/sync");
      if (result.needsReconnect?.length) {
        setSyncProblem(`${result.needsReconnect.join(", ")} needs connecting again.`);
      }
      await Promise.all([load({ keepVisible: true }), loadContext()]);
    } catch (err) {
      setSyncProblem(err instanceof Error ? err.message : "Couldn't sync just now.");
      loadContext();
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
    load({ keepVisible: true });
    loadContext();
    loadMonthBudget();
  };

  function toggleSelected(transaction: Transaction) {
    setMergeError(null);
    setSelectedIds((ids) =>
      ids.includes(transaction.id) ? ids.filter((id) => id !== transaction.id) : [...ids, transaction.id]
    );
  }

  function stopSelecting() {
    setSelecting(false);
    setSelectedIds([]);
    setMergeError(null);
  }

  /// The first row picked is the one that survives; the rest are absorbed
  /// into it, so their messages and any fields it lacks move across.
  async function mergeSelected() {
    if (selectedIds.length < 2) return;
    const [targetId, ...sourceIds] = selectedIds;

    setMerging(true);
    setMergeError(null);
    try {
      await api.post(`/transactions/${targetId}/merge`, { sourceIds });
      stopSelecting();
      reloadAfterEdit();
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : "Couldn't merge those transactions.");
    } finally {
      setMerging(false);
    }
  }

  function changeFilter<T>(setter: (value: T) => void) {
    return (value: T) => setter(value);
  }

  const uncategorized = summary?.byCategory.find((c) => c.categoryId === null);
  // The month itself is not a filter - it is where you are.
  const filtersActive =
    Boolean(debouncedSearch || categoryId || accountId || direction) || (customRange && Boolean(from || to));

  function clearFilters() {
    setSearch("");
    setCategoryId("");
    setAccountId("");
    setDirection("");
    setFrom("");
    setTo("");
    setCustomRange(false);
  }

  const editorOpen = Boolean(editing || adding);
  // The date inputs stay folded behind a chip until wanted.
  const [showDates, setShowDates] = useState(false);
  const allOn = !direction && categoryId !== "none";

  function openEditor(transaction: Transaction) {
    setAdding(false);
    setEditing(transaction);
  }

  return (
    <section className="screen txn-page">
      <div className="screen-header">
        <h1 className="screen-title">Transactions</h1>

        {customRange ? (
          <div className="txn-period is-custom" role="group" aria-label="Dates">
            <span className="txn-period-label num">
              {from || to ? `${from ? shortDay(from) : "The start"} – ${to ? shortDay(to) : "today"}` : "All time"}
            </span>
            <button className="btn btn-sm" onClick={backToMonths}>
              Back to months
            </button>
          </div>
        ) : (
          <div className="txn-period" role="group" aria-label="Month">
            <button
              className="icon-btn"
              onClick={() => setMonthIndex((index) => index + 1)}
              disabled={!months || monthIndex >= months.months.length - 1}
              aria-label="Previous month"
            >
              <Icon name="ic-chevron-left" />
            </button>
            <span className="txn-period-label num">
              {month ? `${shortDay(month.from)} – ${shortDay(month.to)}` : monthsFailed ? "All time" : "…"}
            </span>
            <button
              className="icon-btn"
              onClick={() => setMonthIndex((index) => Math.max(0, index - 1))}
              disabled={monthIndex === 0}
              aria-label="Next month"
            >
              <Icon name="ic-chevron-right" />
            </button>
          </div>
        )}
        {!customRange && monthIndex > 0 && (
          <button className="btn btn-sm btn-ghost" onClick={() => setMonthIndex(0)}>
            This month
          </button>
        )}

        <nav className="seg txn-views" aria-label="View">
          <Link to="/transactions" className="on" aria-current="page">
            List
          </Link>
          <Link to="/?tab=analytics">Analytics</Link>
        </nav>

        <div className="screen-actions">
          {selecting ? (
            <>
              <span className="select-count">
                {selectedIds.length === 0
                  ? "Pick the rows that are the same payment"
                  : `${selectedIds.length} selected`}
              </span>
              <button
                className="btn btn-primary"
                onClick={mergeSelected}
                disabled={selectedIds.length < 2 || merging}
              >
                {merging ? "Merging…" : "Merge"}
              </button>
              <button className="btn btn-ghost" onClick={stopSelecting}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={() => setSelecting(true)}>
                <Icon name="ic-link" /> Merge rows
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setEditing(null);
                  setAdding(true);
                }}
              >
                <Icon name="ic-plus" /> Add
              </button>
            </>
          )}
        </div>
      </div>

      <div className={`txn-layout${editorOpen ? " has-editor" : ""}`}>
        <div className="txn-main">
          <MonthSummary
            label={
              customRange
                ? from || to
                  ? `${from ? shortDay(from) : "The start"} – ${to ? shortDay(to) : "today"}`
                  : "All time"
                : month
                  ? `${shortDay(month.from)} – ${shortDay(month.to)}`
                  : "…"
            }
            isThisMonth={!customRange && monthIndex === 0 && !!month}
            budget={!customRange && monthBudget && monthBudget.month.key === month?.month ? monthBudget : null}
            summary={summary}
          />

          {syncProblem && (
            <div className="callout callout-warn sync-problem" role="alert">
              <Icon name="ic-alert-triangle" />
              <span className="callout-body">{syncProblem}</span>
              <Link to="/settings">Connect Gmail</Link>
            </div>
          )}

          <CardStrip cards={cards} pace={pace} />

          <div className="txn-toolbar">
            <div className="filter-input-icon txn-search">
              <Icon name="ic-search" />
              <input
                id="f-search"
                className="filter-input"
                placeholder="Search merchant, amount, note…"
                aria-label="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button className="btn txn-check" onClick={syncNow} disabled={syncing}>
              <Icon name="ic-refresh" /> {syncing ? "Checking…" : "Check messages"}
            </button>
          </div>

          <div className="txn-filters" role="group" aria-label="Filters">
            <div className="chip-row">
              <button
                type="button"
                className={`chip${allOn ? " on" : ""}`}
                aria-pressed={allOn}
                onClick={() => {
                  setDirection("");
                  if (categoryId === "none") setCategoryId("");
                }}
              >
                {allOn && <Icon name="ic-check" />}
                All
              </button>
              <button
                type="button"
                className={`chip${categoryId === "none" ? " on" : ""}`}
                aria-pressed={categoryId === "none"}
                onClick={() => setCategoryId(categoryId === "none" ? "" : "none")}
              >
                {categoryId === "none" && <Icon name="ic-check" />}
                Needs a category
              </button>
              {(
                [
                  ["DEBIT", "Money out"],
                  ["CREDIT", "Money in"],
                ] as [TransactionType, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`chip${direction === value ? " on" : ""}`}
                  aria-pressed={direction === value}
                  onClick={() => changeFilter(setDirection)(direction === value ? "" : value)}
                >
                  {direction === value && <Icon name="ic-check" />}
                  {label}
                </button>
              ))}
            </div>

            <div className="chip-row">
              <label className={`chip chip-select${accountId ? " on" : ""}`}>
                <span className="sr-only">Account</span>
                <select
                  id="f-account"
                  value={accountId}
                  onChange={(e) => changeFilter(setAccountId)(e.target.value)}
                >
                  <option value="">Accounts</option>
                  {accounts
                    .filter((account) => account.isActive || account.id === accountId)
                    .map((account) => (
                      <option key={account.id} value={account.id}>
                        {accountLabel(account)}
                      </option>
                    ))}
                </select>
                <Icon name="ic-chevron-down" />
              </label>

              <label className={`chip chip-select${categoryId && categoryId !== "none" ? " on" : ""}`}>
                <span className="sr-only">Category</span>
                <select
                  id="f-category"
                  value={categoryId}
                  onChange={(e) => changeFilter(setCategoryId)(e.target.value)}
                >
                  <option value="">Category</option>
                  <option value="none">Uncategorized</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <Icon name="ic-chevron-down" />
              </label>

              {cycles && cycles.cycles.length > 0 && (
                <label className={`chip chip-select${selectedCycle ? " on" : ""}`}>
                  <span className="sr-only">{cycles.byStatement ? "Statement cycle" : "Month"}</span>
                  <select
                    id="f-cycle"
                    value={selectedCycle ? `${selectedCycle.from}|${selectedCycle.to}` : from || to ? "custom" : "all"}
                    onChange={(e) => pickCycle(e.target.value)}
                  >
                    {cycles.cycles.map((cycle) => (
                      <option key={cycle.from} value={`${cycle.from}|${cycle.to}`}>
                        {cycleLabel(cycle.from, cycle.to)}
                        {cycle.current ? " (current)" : ""}
                      </option>
                    ))}
                    <option value="all">All time</option>
                    {!selectedCycle && (from || to) && <option value="custom">Dates chosen</option>}
                  </select>
                  <Icon name="ic-chevron-down" />
                </label>
              )}

              {!(showDates || from || to) ? (
                <button type="button" className="chip" onClick={() => setShowDates(true)}>
                  <Icon name="ic-calendar" />
                  Custom dates
                </button>
              ) : (
              <div className="txn-dates">
                <Icon name="ic-calendar" />
                <input
                  id="f-from"
                  type="date"
                  aria-label="From"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value);
                    setCustomRange(Boolean(e.target.value || to));
                  }}
                />
                <span aria-hidden="true">–</span>
                <input
                  type="date"
                  aria-label="To"
                  value={to}
                  onChange={(e) => {
                    setTo(e.target.value);
                    setCustomRange(Boolean(from || e.target.value));
                  }}
                />
              </div>
              )}

              {filtersActive && (
                <button className="btn btn-sm btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>

            {cycles && cycles.cycleKnown === false && (
              <p className="field-hint">No billing date set for this card — showing all of it.</p>
            )}
            {selectedCycle && (
              <p className="field-hint">
                {formatMoney(selectedCycle.spentMinor)} spent across {selectedCycle.count}{" "}
                {selectedCycle.count === 1 ? "payment" : "payments"}
                {cycles?.byStatement ? " — statement day to the day before the next" : ""}
              </p>
            )}
          </div>

          {uncategorized && categoryId !== "none" && (
            <div className="callout callout-info txn-nudge">
              <Icon name="ic-tag" />
              <div className="callout-body">
                <div className="callout-title">
                  <span className="num">{formatMoneyShort(uncategorized.amountMinor)}</span> of spending{" "}
                  {monthIndex === 0 ? "this month" : "that month"} has no category yet
                </div>
                <div className="callout-detail">
                  Mostly UPI codes and person-to-person payments, which nothing can guess from the message alone.
                </div>
              </div>
              <a
                href="#uncategorized"
                className="btn-link"
                onClick={(event) => {
                  event.preventDefault();
                  setCategoryId("none");
                }}
              >
                Show them <Icon name="ic-chevron-right" />
              </a>
            </div>
          )}

          {error ? (
            <StateBlock
              warn
              icon="ic-wifioff"
              title="Couldn't load your transactions"
              body="The connection to SpendLog's server failed. Your data is safe — this is just a connection problem. Check your internet and try again."
              actions={
                <button className="btn btn-primary" onClick={() => load()}>
                  <Icon name="ic-refresh" /> Retry
                </button>
              }
            />
          ) : !days ? (
            <div className="card txn-ledger-card">
              <LedgerSkeleton />
            </div>
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
                icon="ic-list"
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
              <div className="card card-flush txn-ledger-card">
                <div className="txn-ledger">
                  <div className="txn-head" aria-hidden="true">
                    <span>Time</span>
                    <span>Merchant</span>
                    <span className="txn-head-category">Category</span>
                    <span className="txn-head-account">Account</span>
                    <span className="txn-head-amount">Amount</span>
                  </div>
                  {days.map((day) => (
                    <div className="day-group" key={day.date} role="group" aria-label={formatDayLabel(day.date)}>
                      <div className="day-header">
                        <span className="day-label">{dayHeading(day.date)}</span>
                        <span className="day-totals num">
                          {day.spendMinor > 0 && <span className="spend">−{formatMoneyShort(day.spendMinor)}</span>}
                          {day.spendMinor > 0 && day.incomeMinor > 0 && <span className="dsep"> · </span>}
                          {day.incomeMinor > 0 && <span className="income">+{formatMoneyShort(day.incomeMinor)}</span>}
                        </span>
                      </div>
                      {day.transactions.map((transaction) => (
                        <TransactionRow
                          key={transaction.id}
                          transaction={transaction}
                          categories={categories}
                          onUpdated={replaceTransaction}
                          onShowRaw={setRawFor}
                          onEdit={openEditor}
                          selectable={selecting}
                          selected={selectedIds.includes(transaction.id)}
                          onToggleSelected={toggleSelected}
                          active={editing?.id === transaction.id}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {hasMore && (
                <div className="load-more" ref={sentinel}>
                  {loadingMore ? (
                    <div className="card txn-ledger-card txn-more-skel">
                      <LedgerSkeleton caption="Loading the week before…" />
                    </div>
                  ) : (
                    <button className="btn" onClick={loadMore}>
                      Load the week before
                    </button>
                  )}
                </div>
              )}
              {!hasMore && !customRange && month && months && monthIndex < months.months.length - 1 && (
                <div className="load-more">
                  <button className="btn btn-ghost" onClick={() => setMonthIndex((index) => index + 1)}>
                    That's all for {shortDay(month.from)} – {shortDay(month.to)}. Go to the month before
                  </button>
                </div>
              )}
            </>
          )}

          {mergeError && (
            <div className="callout callout-crit merge-error" role="alert">
              <Icon name="ic-alert-triangle" />
              <span className="callout-body">{mergeError}</span>
            </div>
          )}
        </div>

        {editorOpen && (
          <EditTransactionModal
            key={editing?.id ?? "new"}
            transaction={editing}
            categories={categories}
            accounts={accounts}
            onSaved={reloadAfterEdit}
            onDeleted={reloadAfterEdit}
            onConvertToEmi={(transaction) => {
              setEditing(null);
              setEmiFor(transaction);
            }}
            onMarkRefund={(transaction) => {
              setEditing(null);
              setRefundFor(transaction);
            }}
            onClose={() => {
              setEditing(null);
              setAdding(false);
            }}
          />
        )}
      </div>

      {rawFor && <RawMessageModal transaction={rawFor} onClose={() => setRawFor(null)} />}

      {refundFor && (
        <RefundModal
          refund={refundFor}
          onSaved={() => {
            setRefundFor(null);
            reloadAfterEdit();
          }}
          onClose={() => setRefundFor(null)}
        />
      )}

      {emiFor && (
        <EmiModal
          transaction={emiFor}
          onSaved={() => {
            setEmiFor(null);
            reloadAfterEdit();
          }}
          onClose={() => setEmiFor(null)}
        />
      )}
    </section>
  );
}

/**
 * The month on screen, summed up: where it is against the budget (a compact
 * pace bar with today's tick, when a budget is set) and what went out, came
 * in and how many payments there were.
 */
function MonthSummary({
  label,
  isThisMonth,
  budget,
  summary,
}: {
  label: string;
  isThisMonth: boolean;
  budget: MonthlyBudgetStatus | null;
  summary: AnalyticsSummary | null;
}) {
  const hasBudget = !!budget && budget.configured && budget.budgetMinor !== null;
  const budgetMinor = Math.max(1, budget?.budgetMinor ?? 1);
  const spentShare = hasBudget ? Math.min(100, (budget!.spentMinor / budgetMinor) * 100) : 0;
  const expected = hasBudget && budget!.month.isCurrent ? budget!.pace?.expectedSpentMinor ?? null : null;
  const tickAt = expected !== null ? Math.min(100, (expected / budgetMinor) * 100) : null;
  const left = hasBudget ? budget!.leftMinor ?? budget!.budgetMinor! - budget!.spentMinor : 0;
  const state = hasBudget ? (budget!.isOver ? "over" : budget!.month.isCurrent && budget!.pace?.status === "high" ? "high" : "ok") : "ok";
  const day = budget?.month.isCurrent && budget.month.dayOfMonth ? `day ${budget.month.dayOfMonth} of ${budget.month.daysInMonth}` : null;

  return (
    <div className="card txn-summary">
      <div className="txn-summary-main">
        <div className="txn-summary-title">
          <span className="t-title-card num">
            {label}
            {isThisMonth ? " · this month" : ""}
          </span>
          {day && <span className="t-caption">{day}</span>}
        </div>
        {hasBudget ? (
          <>
            <div
              className={`pace compact txn-pace is-${state}`}
              role="img"
              aria-label={`${formatMoneyShort(budget!.spentMinor)} spent of a ${formatMoneyShort(budget!.budgetMinor!)} budget${
                expected !== null ? `; ${formatMoneyShort(expected)} expected by today` : ""
              }`}
            >
              <div className="pace-track">
                <div className={`seg-spent${spentShare >= 100 ? " is-full" : ""}`} style={{ width: `${spentShare}%` }} />
                {tickAt !== null && <span className="pace-tick" style={{ left: `${tickAt}%` }} />}
              </div>
            </div>
            <p className="txn-summary-line">
              <b className="num">{formatMoneyShort(budget!.spentMinor)}</b> of{" "}
              <span className="num">{formatMoneyShort(budget!.budgetMinor!)}</span>
              {expected !== null ? (
                <>
                  {" "}
                  · should be <span className="num">{formatMoneyShort(expected)}</span> by today
                </>
              ) : (
                <>
                  {" "}
                  ·{" "}
                  <span className={`num${budget!.isOver ? " is-crit" : ""}`}>{formatMoneyShort(Math.abs(left))}</span>{" "}
                  {budget!.isOver ? "over" : budget!.month.isClosed ? "saved" : "left"}
                </>
              )}
            </p>
          </>
        ) : (
          <p className="txn-summary-line">Every payment in this range, newest first.</p>
        )}
      </div>
      <div className="kpis txn-summary-kpis">
        <div className="kpi">
          <span className="kpi-label">Money out</span>
          <span className="kpi-value num money-out">
            {summary && summary.totalSpendMinor > 0 ? "−" : ""}
            {formatMoneyShort(summary?.totalSpendMinor ?? 0)}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Money in</span>
          <span className="kpi-value num money-in">
            {summary && summary.totalIncomeMinor > 0 ? "+" : ""}
            {formatMoneyShort(summary?.totalIncomeMinor ?? 0)}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Payments</span>
          <span className="kpi-value num">{summary?.transactionCount ?? "—"}</span>
        </div>
      </div>
    </div>
  );
}

/** "Today · Wed 21 Oct", "Yesterday · Tue 20 Oct", "Mon 19 Oct". */
function dayHeading(day: string): string {
  const relative = formatDayLabel(day);
  const full = new Date(`${day}T12:00:00+05:30`)
    .toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
    .replace(",", "");
  return relative === "Today" || relative === "Yesterday" ? `${relative} · ${full}` : full;
}

/** "17 Sep – 16 Oct" for a billing cycle. */
function cycleLabel(from: string, to: string): string {
  const format = (day: string) =>
    new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      timeZone: "Asia/Kolkata",
    });
  return `${format(from)} – ${format(to)}`;
}

/** "15 Sep" from a YYYY-MM-DD day. */
function shortDay(day: string): string {
  return new Date(`${day}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    timeZone: "Asia/Kolkata",
  });
}
