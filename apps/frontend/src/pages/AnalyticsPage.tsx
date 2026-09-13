import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { currentMonth, formatMoney, formatMoneyShort, formatMonthLabel, shiftMonth } from "../lib/format";
import {
  AnalyticsSummary,
  Category,
  MerchantSpend,
  MonthComparison,
  TrendPoint,
} from "../types";

const TREND_MAX_HEIGHT = 110;

type View = "categories" | "merchants" | "compare";

/**
 * What happened.
 *
 * Only that. The spending pace, the card limits, the EMIs and the split
 * balances all moved to the dashboard, because each of them is something
 * you might act on before closing the app — and this page had become a
 * dumping ground for anything with a number in it.
 */
export function AnalyticsPage() {
  const navigate = useNavigate();
  const [month, setMonth] = useState(currentMonth());
  const [view, setView] = useState<View>("categories");

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [merchants, setMerchants] = useState<MerchantSpend[]>([]);
  const [comparison, setComparison] = useState<MonthComparison | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    api.get<AnalyticsSummary>(`/analytics/summary?month=${month}`).then(setSummary);
    api.get<MerchantSpend[]>(`/analytics/merchants?month=${month}`).then(setMerchants).catch(() => setMerchants([]));
    api
      .get<MonthComparison>(`/analytics/compare?month=${month}`)
      .then(setComparison)
      .catch(() => setComparison(null));
  }, [month]);

  useEffect(() => {
    api.get<TrendPoint[]>("/analytics/trend?months=6").then(setTrend);
    api.get<Category[]>("/categories").then(setCategories);
  }, []);

  const colorFor = (categoryId: string | null) =>
    categoryId ? (categories.find((c) => c.id === categoryId)?.color ?? "var(--muted)") : "var(--muted-light)";

  const totalSpend = summary?.totalSpendMinor ?? 0;
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
          title="Nothing to analyse yet"
          body="Charts need transactions first. Once a few payments come in from SMS or Gmail, this page fills in on its own — no setup required here."
          actions={
            <button className="btn btn-primary" onClick={() => navigate("/")}>
              Back to the dashboard
            </button>
          }
        />
      ) : (
        <div className="layout-2">
          <div>
            <div className="seg" style={{ marginBottom: 18 }}>
              <button className={view === "categories" ? "on" : ""} onClick={() => setView("categories")}>
                By category
              </button>
              <button className={view === "merchants" ? "on" : ""} onClick={() => setView("merchants")}>
                By merchant
              </button>
              <button className={view === "compare" ? "on" : ""} onClick={() => setView("compare")}>
                Against last month
              </button>
            </div>

            {view === "categories" && (
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
                    return (
                      <div className="hbar-row" key={entry.categoryId ?? "none"}>
                        <div className="hbar-label">
                          <span
                            className="hbar-dot"
                            style={
                              entry.categoryId === null
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
            )}

            {view === "merchants" && (
              <div className="section-block">
                <h3>Spend by merchant</h3>
                <p className="section-sub">
                  Where the money actually went. "Food" is not a thing to cut back on; ordering from one
                  delivery app eleven times is.
                </p>
                {merchants.length === 0 ? (
                  <p className="desc">
                    Nothing this month has a merchant name on it yet. They arrive with the message, or you
                    can add one when editing a payment.
                  </p>
                ) : (
                  <div className="hbars">
                    {merchants.map((entry) => {
                      const pct =
                        merchants[0].amountMinor > 0
                          ? Math.round((entry.amountMinor / merchants[0].amountMinor) * 100)
                          : 0;
                      return (
                        <div className="hbar-row" key={entry.merchant}>
                          <div className="hbar-label" title={entry.merchant}>
                            {entry.merchant}
                          </div>
                          <div className="hbar-track">
                            <div
                              className="hbar-fill"
                              style={{ width: `${pct}%`, background: "var(--brand)" }}
                            />
                          </div>
                          <div className="hbar-val num">
                            {formatMoneyShort(entry.amountMinor)}
                            <span className="hbar-pct">×{entry.count}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {view === "compare" && comparison && (
              <div className="section-block">
                <h3>Against {formatMonthLabel(comparison.previousMonthLabel)}</h3>
                <p className="section-sub">
                  Per category as well as in total — a month that came out level overall can still have
                  doubled on one thing and halved on another.
                </p>

                <div className={`compare-headline is-${comparison.changeMinor > 0 ? "up" : "down"}`}>
                  <div>
                    <span className="emi-preview-label">This month</span>
                    <span className="budget-figure num">{formatMoney(comparison.totalSpendMinor)}</span>
                  </div>
                  <div>
                    <span className="emi-preview-label">Last month</span>
                    <span className="budget-figure num">{formatMoney(comparison.previousSpendMinor)}</span>
                  </div>
                  <div>
                    <span className="emi-preview-label">Change</span>
                    <span className="budget-figure num">
                      {comparison.changeMinor > 0 ? "+" : ""}
                      {formatMoney(comparison.changeMinor)}
                    </span>
                  </div>
                </div>

                <div className="compare-list">
                  {comparison.categories.map((entry) => {
                    const biggest = Math.max(
                      1,
                      ...comparison.categories.map((c) => Math.abs(c.changeMinor))
                    );
                    const width = Math.round((Math.abs(entry.changeMinor) / biggest) * 100);
                    const up = entry.changeMinor > 0;

                    return (
                      <div className="compare-row" key={entry.categoryId ?? "none"}>
                        <div className="compare-name">{entry.name}</div>
                        <div className="compare-track">
                          <div className={`compare-bar${up ? " is-up" : " is-down"}`} style={{ width: `${width}%` }} />
                        </div>
                        <div className="compare-val num">
                          {entry.changeMinor === 0 ? (
                            <span className="compare-flat">no change</span>
                          ) : (
                            <>
                              {up ? "+" : "−"}
                              {formatMoneyShort(Math.abs(entry.changeMinor))}
                            </>
                          )}
                          <span className="hbar-pct">
                            {entry.previousMinor === 0
                              ? "new"
                              : entry.amountMinor === 0
                                ? "stopped"
                                : formatMoneyShort(entry.amountMinor)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

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
              {merchants.length > 0 && (
                <div className="stat-tile">
                  <div className="label">Most spent at</div>
                  <div className="value num" style={{ fontSize: 15 }}>
                    {merchants[0].merchant}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
