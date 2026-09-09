import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { LedgerSkeleton, StateBlock } from "../components/States";
import { RawMessageModal } from "../components/RawMessageModal";
import { TransactionRow } from "../components/TransactionRow";
import { api } from "../lib/api";
import { currentMonth, formatDayLabel, formatMoney } from "../lib/format";
import { AnalyticsSummary, Category, DayGroup, EmailConnectionStatus, Transaction } from "../types";

export function TodayPage() {
  const navigate = useNavigate();
  const [days, setDays] = useState<DayGroup[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [connections, setConnections] = useState<EmailConnectionStatus[] | null>(null);
  const [error, setError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [rawFor, setRawFor] = useState<Transaction | null>(null);

  const load = useCallback(async () => {
    try {
      const [dayGroups, cats, monthSummary, emails] = await Promise.all([
        api.get<DayGroup[]>("/transactions/by-day"),
        api.get<Category[]>("/categories"),
        api.get<AnalyticsSummary>(`/analytics/summary?month=${currentMonth()}`),
        api.get<EmailConnectionStatus[]>("/ingestion/email/status"),
      ]);
      setDays(dayGroups);
      setCategories(cats);
      setSummary(monthSummary);
      setConnections(emails);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function syncNow() {
    setSyncing(true);
    try {
      await api.post("/ingestion/email/sync");
      await load();
    } catch {
      // A failed sync isn't fatal — the ledger on screen is still valid.
    } finally {
      setSyncing(false);
    }
  }

  function handleUpdated(dayIndex: number, updated: Transaction) {
    setDays((prev) => {
      if (!prev) return prev;
      const next = [...prev];
      next[dayIndex] = {
        ...next[dayIndex],
        transactions: next[dayIndex].transactions.map((t) => (t.id === updated.id ? updated : t)),
      };
      return next;
    });
  }

  const uncategorized = summary?.byCategory.find((c) => c.categoryId === null);

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Today</h1>
        <div className="screen-actions">
          <button className="btn btn-ghost btn-sm" onClick={syncNow} disabled={syncing}>
            <Icon name="ic-sync" /> {syncing ? "Syncing…" : "Sync now"}
          </button>
        </div>
      </div>

      <div className="layout-2">
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
            <EmptyLedger hasGmail={(connections?.length ?? 0) > 0} onSettings={() => navigate("/settings")} onSync={syncNow} />
          ) : (
            days.map((day, dayIndex) => (
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
                    onUpdated={(updated) => handleUpdated(dayIndex, updated)}
                    onShowRaw={setRawFor}
                  />
                ))}
              </div>
            ))
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
                href="/transactions"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("/transactions");
                }}
              >
                Review them <Icon name="ic-arrow-right" />
              </a>
            </div>
          )}
        </div>
      </div>

      {rawFor && <RawMessageModal transaction={rawFor} onClose={() => setRawFor(null)} />}
    </section>
  );
}

/** Which "nothing here" story to tell depends on what's actually connected. */
function EmptyLedger({
  hasGmail,
  onSettings,
  onSync,
}: {
  hasGmail: boolean;
  onSettings: () => void;
  onSync: () => void;
}) {
  if (!hasGmail) {
    return (
      <StateBlock
        icon="ic-receipt"
        title="Nothing here yet"
        body={
          "SpendLog fills in on its own once a bank message arrives — there's no \"add transaction\" button because " +
          "there's nothing to type. Connect Gmail or turn on SMS access and today's spending will show up here automatically."
        }
        actions={
          <button className="btn btn-primary" onClick={onSettings}>
            Go to Settings
          </button>
        }
      />
    );
  }

  return (
    <StateBlock
      icon="ic-mail"
      title="No bank emails found yet"
      body={
        "Your Gmail is connected and we've checked it, but no transaction email from your bank has turned up. Many " +
        "Indian banks only send SMS for card and UPI payments, not email — if that's yours, the Android app can catch those automatically."
      }
      actions={
        <>
          <button className="btn btn-primary" onClick={onSettings}>
            Get the Android app
          </button>
          <button className="btn btn-ghost" onClick={onSync}>
            Sync Gmail now
          </button>
        </>
      }
    />
  );
}
