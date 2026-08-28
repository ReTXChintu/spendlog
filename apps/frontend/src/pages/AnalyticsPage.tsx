import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../lib/api";
import { formatMoney } from "../lib/format";
import { AnalyticsSummary, TrendPoint } from "../types";

const COLORS = ["#f97316", "#22c55e", "#0ea5e9", "#a855f7", "#eab308", "#ec4899", "#ef4444", "#8b5cf6", "#14b8a6", "#64748b"];

export function AnalyticsPage() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);

  useEffect(() => {
    api.get<AnalyticsSummary>(`/analytics/summary?month=${month}`).then(setSummary);
  }, [month]);

  useEffect(() => {
    api.get<TrendPoint[]>("/analytics/trend?months=6").then(setTrend);
  }, []);

  const trendInRupees = trend.map((p) => ({
    month: p.month,
    spend: p.spendMinor / 100,
    income: p.incomeMinor / 100,
  }));

  return (
    <div className="analytics-page">
      <div className="filters">
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </div>

      {summary && (
        <>
          <div className="summary-cards">
            <div className="card">
              <span>Spent</span>
              <strong>{formatMoney(summary.totalSpendMinor)}</strong>
            </div>
            <div className="card">
              <span>Received</span>
              <strong>{formatMoney(summary.totalIncomeMinor)}</strong>
            </div>
            <div className="card">
              <span>Transactions</span>
              <strong>{summary.transactionCount}</strong>
            </div>
          </div>

          <h3>Spend by category</h3>
          {summary.byCategory.length === 0 ? (
            <p className="empty-state">No spend recorded this month.</p>
          ) : (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie
                  data={summary.byCategory}
                  dataKey="amountMinor"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={(entry) => entry.name}
                >
                  {summary.byCategory.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value: number) => formatMoney(value)} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </>
      )}

      <h3>Last 6 months</h3>
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={trendInRupees}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="month" />
          <YAxis />
          <Tooltip formatter={(value: number) => `₹${value.toFixed(0)}`} />
          <Bar dataKey="spend" name="Spend" fill="#f97316" />
          <Bar dataKey="income" name="Income" fill="#22c55e" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
