import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { currentMonth, formatMoney, formatMoneyShort, formatMonthLabel, shiftMonth } from "../lib/format";
import { AnalyticsSummary, Category, OwedSummary, TrendPoint } from "../types";

const TREND_MAX_HEIGHT = 110;

export function AnalyticsPage() {
  const navigate = useNavigate();
  const [month, setMonth] = useState(currentMonth());
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [owed, setOwed] = useState<OwedSummary | null>(null);

  useEffect(() => {
    api.get<AnalyticsSummary>(`/analytics/summary?month=${month}`).then(setSummary);
  }, [month]);

  useEffect(() => {
    api.get<TrendPoint[]>("/analytics/trend?months=6").then(setTrend);
    api.get<Category[]>("/categories").then(setCategories);
    // Not month-scoped: what people owe each other does not reset in January.
    api.get<OwedSummary>("/analytics/owed").then(setOwed).catch(() => setOwed(null));
  }, []);

  const colorFor = (categoryId: string | null) =>
    categoryId ? categories.find((c) => c.id === categoryId)?.color ?? "var(--muted)" : "var(--muted-light)";

  const totalSpend = summary?.totalSpendMinor ?? 0;
  // Bars scale against the largest single month so the tallest fills the plot.
  const trendMax = Math.max(1, ...trend.flatMap((p) => [p.spendMinor, p.incomeMinor]));
  const monthsWithData = trend.filter((p) => p.spendMinor > 0 || p.incomeMinor > 0).length;

  const hasData = summary !== null && summary.transactionCount > 0;

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Analytics</h1>
        <div className="month-picker">
          <button onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
            <Icon name="ic-chevron-left" />
          </button>
          <span>{formatMonthLabel(month)}</span>
          <button
            onClick={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= currentMonth()}
            aria-label="Next month"
          >
            <Icon name="ic-chevron-right" />
          </button>
        </div>
      </div>

      {!hasData ? (
        <StateBlock
          icon="ic-trend"
          title="Nothing to analyze yet"
          body="Charts need transactions first. Once a few payments come in from SMS or Gmail, this page fills in on its own — no setup required here."
          actions={
            <button className="btn btn-primary" onClick={() => navigate("/")}>
              Back to Today
            </button>
          }
        />
      ) : (
        <div className="layout-2">
          <div>
            {owed && owed.splitCount > 0 && (
              <div className="section-block">
                <h3>Split bills</h3>
                <p className="section-sub">
                  Across all time, not just this month — what people owe each other doesn't reset in January.
                </p>
                <div className="owed-card">
                  <div
                    className={`owed-figure ${owed.balanceMinor >= 0 ? "is-positive" : "is-negative"}`}
                  >
                    {formatMoney(Math.abs(owed.balanceMinor))}
                  </div>
                  <div className="section-sub">
                    {owed.balanceMinor > 0
                      ? "owed to you"
                      : owed.balanceMinor < 0
                        ? "you owe"
                        : "all settled up"}
                  </div>
                  <div className="owed-breakdown">
                    <span>
                      Paid for others <b>{formatMoneyShort(owed.lentMinor)}</b>
                    </span>
                    <span>
                      Paid back to you <b>{formatMoneyShort(owed.settledInMinor)}</b>
                    </span>
                    <span>
                      You paid back <b>{formatMoneyShort(owed.settledOutMinor)}</b>
                    </span>
                  </div>
                  <p className="field-hint" style={{ marginTop: 10 }}>
                    Compare this with Splitwise. It counts every bill you marked as split, so a gap
                    usually means one of them needs its share correcting.
                  </p>
                </div>
              </div>
            )}

            <div className="section-block">
              <h3>Spend by category</h3>
              <p className="section-sub">
                Transfers, settlements and the part of a split bill that wasn't yours are excluded from
                every figure below.
              </p>
              <div className="hbars">
                {summary!.byCategory.map((entry) => {
                  const pct = totalSpend > 0 ? Math.round((entry.amountMinor / totalSpend) * 100) : 0;
                  const color = colorFor(entry.categoryId);
                  const isUncategorized = entry.categoryId === null;
                  return (
                    <div className="hbar-row" key={entry.categoryId ?? "none"}>
                      <div className="hbar-label">
                        <span
                          className="hbar-dot"
                          style={
                            isUncategorized
                              ? { background: "transparent", border: "1.5px dashed var(--muted-light)" }
                              : { background: color }
                          }
                        />
                        {entry.name}
                      </div>
                      <div className="hbar-track">
                        <div className="hbar-fill" style={{ width: `${pct}%`, background: color }} />
                      </div>
                      <div className="hbar-val num">
                        {formatMoneyShort(entry.amountMinor)}
                        <span className="hbar-pct">{pct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="section-block">
              <h3>Last 6 months</h3>
              <p className="section-sub">
                {monthsWithData <= 1
                  ? "You've been using SpendLog for less than a month — the earlier bars are still empty, and that's expected."
                  : "Spending and income side by side, month by month."}
              </p>
              <div className="trend-wrap">
                {trend.map((point) => {
                  const empty = point.spendMinor === 0 && point.incomeMinor === 0;
                  const label = new Date(`${point.month}-01T00:00:00Z`).toLocaleDateString("en-IN", {
                    month: "short",
                    timeZone: "UTC",
                  });
                  return (
                    <div className="trend-col" key={point.month}>
                      <div className="trend-bars">
                        {empty ? (
                          <div className="trend-bar placeholder" />
                        ) : (
                          <>
                            <div
                              className="trend-bar spend"
                              style={{ height: (point.spendMinor / trendMax) * TREND_MAX_HEIGHT }}
                              title={`Spent ${formatMoney(point.spendMinor)}`}
                            />
                            <div
                              className="trend-bar income"
                              style={{ height: (point.incomeMinor / trendMax) * TREND_MAX_HEIGHT }}
                              title={`Received ${formatMoney(point.incomeMinor)}`}
                            />
                          </>
                        )}
                      </div>
                      <span className="trend-month">{label}</span>
                    </div>
                  );
                })}
              </div>
              <div className="trend-legend">
                <span>
                  <span className="legend-dot" style={{ background: "var(--debit)" }} />
                  Spend
                </span>
                <span>
                  <span className="legend-dot" style={{ background: "var(--credit)" }} />
                  Income
                </span>
                <span>
                  <span
                    className="legend-dot"
                    style={{
                      background:
                        "repeating-linear-gradient(135deg,#E7E7E2,#E7E7E2 3px,#EFEFEA 3px,#EFEFEA 6px)",
                    }}
                  />
                  No data yet
                </span>
              </div>
            </div>
          </div>

          <div className="rail">
            <div className="stat-tiles">
              <div className="stat-tile">
                <div className="label">Total spent</div>
                <div className="value debit num">{formatMoney(summary!.totalSpendMinor)}</div>
              </div>
              <div className="stat-tile">
                <div className="label">Total received</div>
                <div className="value credit num">{formatMoney(summary!.totalIncomeMinor)}</div>
              </div>
              <div className="stat-tile">
                <div className="label">Transactions</div>
                <div className="value num">{summary!.transactionCount}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
