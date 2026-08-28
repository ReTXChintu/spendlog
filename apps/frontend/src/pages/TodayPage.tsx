import { useEffect, useState } from "react";
import { TransactionRow } from "../components/TransactionRow";
import { api } from "../lib/api";
import { formatDayLabel, formatMoney } from "../lib/format";
import { Category, DayGroup, Transaction } from "../types";

export function TodayPage() {
  const [days, setDays] = useState<DayGroup[] | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.get<DayGroup[]>("/transactions/by-day"), api.get<Category[]>("/categories")])
      .then(([dayGroups, cats]) => {
        setDays(dayGroups);
        setCategories(cats);
      })
      .catch((err) => setError(err.message));
  }, []);

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

  if (error) return <p className="error-text">{error}</p>;
  if (!days) return <p>Loading…</p>;
  if (days.length === 0) {
    return (
      <div className="empty-state">
        <p>No transactions yet.</p>
        <p>Connect Gmail in Settings, or install the mobile app to start auto-importing from SMS.</p>
      </div>
    );
  }

  return (
    <div className="day-list">
      {days.map((day, index) => (
        <section key={day.date} className="day-group">
          <header className="day-group-header">
            <h2>{formatDayLabel(day.date)}</h2>
            <span className="day-group-totals">
              {day.spendMinor > 0 && <span className="amount debit">-{formatMoney(day.spendMinor)}</span>}
              {day.incomeMinor > 0 && <span className="amount credit">+{formatMoney(day.incomeMinor)}</span>}
            </span>
          </header>
          {day.transactions.map((t) => (
            <TransactionRow
              key={t.id}
              transaction={t}
              categories={categories}
              onUpdated={(updated) => handleUpdated(index, updated)}
            />
          ))}
        </section>
      ))}
    </div>
  );
}
