import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { ColumnChart } from "../components/charts/ColumnChart";
import { DailyChart } from "../components/charts/DailyChart";
import { Donut, DonutSlice } from "../components/charts/Donut";
import { AiInsightsCard } from "../components/home/AiInsightsCard";
import { SavingsPlanCard } from "../components/home/SavingsPlanCard";
import { Icon } from "../components/Icon";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { formatMoney, formatMoneyShort, istToday } from "../lib/format";
import {
  Account,
  AccountSpend,
  AnalyticsMonths,
  AnalyticsSummary,
  Category,
  DailySpend,
  MerchantSpend,
  MonthComparison,
  TrendPoint,
  WeekdaySpend,
  accountLabel,
} from "../types";

/** Fallback hues for categories with no colour of their own, in a fixed order. */
const FALLBACK = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)", "var(--viz-7)", "var(--viz-8)"];
/** Slices past this fold into "Other": a ring of twelve colours reads as noise. */
const DONUT_SLICES = 6;
const WEEK_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The Analytics tab of Home: what happened.
 *
 * Only that, plus what the AI makes of it. The pace, card limits, EMIs
 * and splits live on the Dashboard tab, because each is something you
 * might act on before closing the app.
 *
 * Filters sit in one row above everything they change. Account and
 * category narrow the totals, merchants, days and weekdays; the
 * comparison and the six months stay whole, and say so, because a
 * comparison of one filtered slice against an unfiltered last month would
 * be quietly wrong.
 */
export function AnalyticsTab() {
  const location = useLocation();
  // The user's own months - salary day to salary day - newest first, and
  // which of them is showing. A calendar month is only what they get with
  // no pay day set.
  const [months, setMonths] = useState<AnalyticsMonths | null>(null);
  const [index, setIndex] = useState(0);
  const [accountFilter, setAccountFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [merchants, setMerchants] = useState<MerchantSpend[]>([]);
  const [daily, setDaily] = useState<DailySpend[]>([]);
  const [weekday, setWeekday] = useState<WeekdaySpend[]>([]);
  const [byAccount, setByAccount] = useState<AccountSpend[]>([]);
  const [comparison, setComparison] = useState<MonthComparison | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [failed, setFailed] = useState(false);

  const month = months?.months[index]?.month ?? null;
  const filtered = accountFilter !== "" || categoryFilter !== "";

  useEffect(() => {
    api.get<AnalyticsMonths>("/analytics/months").then(setMonths).catch(() => setFailed(true));
    api.get<TrendPoint[]>("/analytics/trend?months=6").then(setTrend).catch(() => setTrend([]));
    api.get<Category[]>("/categories").then(setCategories).catch(() => setCategories([]));
    api.get<Account[]>("/accounts").then(setAccounts).catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    if (!month) return;
    // A later choice wins: a slow answer for the previous filter must not
    // land on top of the one now showing.
    let current = true;
    const keep = <T,>(set: (value: T) => void) => (value: T) => {
      if (current) set(value);
    };

    const filters = new URLSearchParams({ month });
    if (accountFilter) filters.set("account", accountFilter);
    if (categoryFilter) filters.set("category", categoryFilter);
    const q = filters.toString();
    const byCategory = new URLSearchParams({ month });
    if (categoryFilter) byCategory.set("category", categoryFilter);

    api.get<AnalyticsSummary>(`/analytics/summary?${q}`).then(keep(setSummary)).catch(() => current && setFailed(true));
    api.get<MerchantSpend[]>(`/analytics/merchants?${q}`).then(keep(setMerchants)).catch(() => keep(setMerchants)([]));
    api.get<DailySpend[]>(`/analytics/daily?${q}`).then(keep(setDaily)).catch(() => keep(setDaily)([]));
    api.get<WeekdaySpend[]>(`/analytics/weekday?${q}`).then(keep(setWeekday)).catch(() => keep(setWeekday)([]));
    api
      .get<AccountSpend[]>(`/analytics/accounts?${byCategory.toString()}`)
      .then(keep(setByAccount))
      .catch(() => keep(setByAccount)([]));
    return () => {
      current = false;
    };
  }, [month, accountFilter, categoryFilter]);

  useEffect(() => {
    if (!month) return;
    api
      .get<MonthComparison>(`/analytics/compare?month=${month}`)
      .then(setComparison)
      .catch(() => setComparison(null));
  }, [month]);

  // The Dashboard's plan warnings link here; bring the AI section into view.
  useEffect(() => {
    if (location.hash !== "#ai") return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const id = window.setTimeout(
      () => document.getElementById("ai")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }),
      50
    );
    return () => window.clearTimeout(id);
  }, [location.hash]);

  const bySalary = months?.bySalary ?? false;
  const monthWord = bySalary ? "pay month" : "month";

  const colorFor = useMemo(() => {
    const order = new Map(categories.map((category, i) => [category.id, i]));
    return (categoryId: string | null) => {
      if (!categoryId) return "var(--muted-light)";
      const category = categories.find((c) => c.id === categoryId);
      return category?.color ?? FALLBACK[(order.get(categoryId) ?? 0) % FALLBACK.length];
    };
  }, [categories]);

  const totalSpend = summary?.totalSpendMinor ?? 0;
  const totalIncome = summary?.totalIncomeMinor ?? 0;
  const net = totalIncome - totalSpend;
  const today = istToday();
  const daysSoFar = daily.filter((day) => day.day <= today).length || daily.length || 1;
  const perDay = Math.round(totalSpend / daysSoFar);
  const hasData = summary !== null && summary.transactionCount > 0;

  const slices = useMemo<DonutSlice[]>(() => {
    if (!summary) return [];
    const sorted = [...summary.byCategory].sort((a, b) => b.amountMinor - a.amountMinor);
    const head = sorted.slice(0, DONUT_SLICES).map((entry) => ({
      key: entry.categoryId ?? "none",
      name: entry.name,
      amountMinor: entry.amountMinor,
      color: colorFor(entry.categoryId),
      muted: entry.categoryId === null,
    }));
    const rest = sorted.slice(DONUT_SLICES).reduce((sum, entry) => sum + entry.amountMinor, 0);
    return rest > 0
      ? [...head, { key: "other", name: `Other (${sorted.length - DONUT_SLICES})`, amountMinor: rest, color: "var(--muted)", muted: true }]
      : head;
  }, [summary, colorFor]);

  const weekOrdered = WEEK_ORDER.map(
    (day) => weekday.find((entry) => entry.day === day) ?? { day, amountMinor: 0, count: 0, averageMinor: 0 }
  );
  const busiestDay = weekOrdered.reduce((best, day) => (day.averageMinor > best.averageMinor ? day : best), weekOrdered[0]);

  const trendGroups = trend.map((point) => ({
    key: point.month,
    // A pay month is named by the day it starts, "15 Sep"; a calendar
    // month by its name alone.
    label:
      bySalary && point.from
        ? new Date(`${point.from}T12:00:00+05:30`).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
            timeZone: "Asia/Kolkata",
          })
        : new Date(`${point.month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }),
    values: [point.spendMinor, point.incomeMinor],
    empty: point.spendMinor === 0 && point.incomeMinor === 0,
    full: point.label ?? point.month,
  }));
  const monthsWithData = trend.filter((p) => p.spendMinor > 0 || p.incomeMinor > 0).length;

  if (failed && !summary) {
    return (
      <StateBlock
        icon="ic-wifioff"
        title="Couldn't reach the server"
        body="Try again in a moment."
        actions={
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        }
      />
    );
  }

  const accountOptions = accounts.filter((account) => account.accountType !== "CASH" && account.isActive);
  const merchantTop = merchants.slice(0, 8);
  const accountTotal = byAccount.reduce((sum, entry) => sum + entry.amountMinor, 0);

  return (
    <>
      {/* Every control that changes the charts, in one row above them. */}
      <div className="viz-filters" role="group" aria-label="Filters">
        <div className="month-picker">
          <button
            onClick={() => setIndex((current) => current + 1)}
            disabled={!months || index >= months.months.length - 1}
            aria-label={`Previous ${monthWord}`}
          >
            <Icon name="ic-chevron-left" />
          </button>
          <span aria-live="polite">{months?.months[index]?.label ?? "…"}</span>
          <button
            onClick={() => setIndex((current) => current - 1)}
            disabled={index === 0}
            aria-label={`Next ${monthWord}`}
          >
            <Icon name="ic-chevron-right" />
          </button>
        </div>

        <label className="viz-filter">
          <span>Account</span>
          <select className="filter-select" value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
            <option value="">All accounts</option>
            <option value="cash">Cash</option>
            {accountOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>

        <label className="viz-filter">
          <span>Category</span>
          <select className="filter-select" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            <option value="none">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>

        {filtered && (
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setAccountFilter("");
              setCategoryFilter("");
            }}
          >
            <Icon name="ic-x" /> Clear filters
          </button>
        )}
      </div>

      {summary === null ? (
        <div className="home-loading" aria-busy="true" />
      ) : !hasData && !filtered ? (
        <StateBlock
          icon="ic-trend"
          title="Nothing to analyse yet"
          body="Charts need transactions first. Once a few payments come in from SMS or Gmail, this fills in on its own — no setup required here."
        />
      ) : (
        <>
          <div className="kpi-row">
            <Kpi label="Spent" value={formatMoneyShort(totalSpend)} />
            <Kpi label="Received" value={formatMoneyShort(totalIncome)} />
            <Kpi
              label="Net"
              value={`${net > 0 ? "+" : net < 0 ? "−" : ""}${formatMoneyShort(Math.abs(net))}`}
              tone={net > 0 ? "credit" : net < 0 ? "debit" : undefined}
              note={net >= 0 ? "kept" : "more out than in"}
            />
            <Kpi label="Average a day" value={formatMoneyShort(perDay)} note={`over ${daysSoFar} days`} />
            <Kpi label="Transactions" value={String(summary.transactionCount)} />
          </div>

          {!hasData ? (
            <div className="home-card">
              <p className="section-sub">Nothing this {monthWord} matches these filters.</p>
            </div>
          ) : (
            <div className="home-grid">
              <div className="home-card is-wide">
                <h3 className="home-card-title">Day by day</h3>
                <p className="section-sub">
                  What went out each day, with money in underneath on its own scale. Hover or use the arrow keys
                  for a day's figures.
                </p>
                <DailyChart days={daily} />
              </div>

              <div className="home-card">
                <h3 className="home-card-title">Share by category</h3>
                <p className="section-sub">
                  Transfers, settlements and the part of a split bill that wasn't yours are left out.
                </p>
                <Donut slices={slices} total={totalSpend} />
              </div>

              <div className="home-card">
                <h3 className="home-card-title">Top merchants</h3>
                <p className="section-sub">
                  Where it actually went. "Food" isn't a thing to cut back on; one delivery app eleven times is.
                </p>
                {merchantTop.length === 0 ? (
                  <p className="desc">Nothing here has a merchant name yet.</p>
                ) : (
                  <div className="hbars">
                    {merchantTop.map((entry) => {
                      const pct = merchantTop[0].amountMinor > 0 ? (entry.amountMinor / merchantTop[0].amountMinor) * 100 : 0;
                      return (
                        <div
                          className="hbar-row"
                          key={entry.merchant}
                          title={`${entry.merchant}: ${formatMoney(entry.amountMinor)} over ${entry.count} payments`}
                        >
                          <div className="hbar-label">{entry.merchant}</div>
                          <div className="hbar-track">
                            <div className="hbar-fill viz-fill" style={{ width: `${pct}%` }} />
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

              <div className="home-card">
                <h3 className="home-card-title">By day of the week</h3>
                <p className="section-sub">
                  Average spent on each weekday this {monthWord}
                  {busiestDay && busiestDay.averageMinor > 0 ? ` — ${fullDay(busiestDay.day)}s cost the most` : ""}.
                </p>
                <ColumnChart
                  groups={weekOrdered.map((day) => ({ key: day.day, label: day.day, values: [day.averageMinor] }))}
                  series={[{ name: "Average a day", tone: "is-spend" }]}
                  height={150}
                  ariaLabel={`Average spending by weekday${
                    busiestDay && busiestDay.averageMinor > 0
                      ? `; highest on ${fullDay(busiestDay.day)} at ${formatMoney(busiestDay.averageMinor)}`
                      : ""
                  }.`}
                  tooltip={(group) => {
                    const day = weekOrdered.find((entry) => entry.day === group.key)!;
                    return (
                      <>
                        <div className="viz-tip-title">{fullDay(day.day)}s</div>
                        <div className="viz-tip-row">
                          Average <b className="num">{formatMoney(day.averageMinor)}</b>
                        </div>
                        <div className="viz-tip-row">
                          In all <b className="num">{formatMoney(day.amountMinor)}</b>
                        </div>
                        <div className="viz-tip-row">
                          Payments <b className="num">{day.count}</b>
                        </div>
                      </>
                    );
                  }}
                />
              </div>

              <div className="home-card">
                <h3 className="home-card-title">By card and account</h3>
                <p className="section-sub">
                  Which card or account the spending went through{accountFilter ? " — the account filter doesn't apply here" : ""}.
                </p>
                {byAccount.length === 0 ? (
                  <p className="desc">Nothing to show.</p>
                ) : (
                  <div className="hbars">
                    {byAccount.map((entry) => {
                      const pct = accountTotal > 0 ? Math.round((entry.amountMinor / accountTotal) * 100) : 0;
                      const top = byAccount[0].amountMinor || 1;
                      return (
                        <div
                          className="hbar-row"
                          key={entry.accountId}
                          title={`${entry.name}: ${formatMoney(entry.amountMinor)} over ${entry.count} payments`}
                        >
                          <div className="hbar-label">{entry.name}</div>
                          <div className="hbar-track">
                            <div className="hbar-fill viz-fill" style={{ width: `${(entry.amountMinor / top) * 100}%` }} />
                          </div>
                          <div className="hbar-val num">
                            {formatMoneyShort(entry.amountMinor)}
                            <span className="hbar-pct">{pct}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {comparison && (
                <div className="home-card">
                  <h3 className="home-card-title">Against {comparison.previousMonthLabel}</h3>
                  <p className="section-sub">
                    Per category as well as in total{filtered ? " · all accounts and categories" : ""}.
                  </p>
                  <div className={`compare-headline is-${comparison.changeMinor > 0 ? "up" : "down"}`}>
                    <div>
                      <span className="emi-preview-label">This {monthWord}</span>
                      <span className="budget-figure num">{formatMoneyShort(comparison.totalSpendMinor)}</span>
                    </div>
                    <div>
                      <span className="emi-preview-label">Last</span>
                      <span className="budget-figure num">{formatMoneyShort(comparison.previousSpendMinor)}</span>
                    </div>
                    <div>
                      <span className="emi-preview-label">Change</span>
                      <span className="budget-figure num">
                        {comparison.changeMinor > 0 ? "+" : comparison.changeMinor < 0 ? "−" : ""}
                        {formatMoneyShort(Math.abs(comparison.changeMinor))}
                      </span>
                    </div>
                  </div>
                  <div className="compare-list">
                    {comparison.categories.slice(0, 8).map((entry) => {
                      const biggest = Math.max(1, ...comparison.categories.map((c) => Math.abs(c.changeMinor)));
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

              <div className="home-card">
                <h3 className="home-card-title">Last 6 {bySalary ? "pay months" : "months"}</h3>
                <p className="section-sub">
                  {monthsWithData <= 1
                    ? "Less than a month of history so far — the earlier months are still empty, and that's expected."
                    : `Spending and money in side by side${filtered ? " · all accounts and categories" : ""}.`}
                </p>
                <ColumnChart
                  groups={trendGroups}
                  series={[
                    { name: "Spent", tone: "is-spend" },
                    { name: "Money in", tone: "is-income" },
                  ]}
                  height={150}
                  ariaLabel={`Spending and money in over the last ${trendGroups.length} months.`}
                  tooltip={(group) => {
                    const point = trendGroups.find((entry) => entry.key === group.key)!;
                    return (
                      <>
                        <div className="viz-tip-title">{point.full}</div>
                        {point.empty ? (
                          <div className="viz-tip-row">Nothing recorded</div>
                        ) : (
                          <>
                            <div className="viz-tip-row">
                              <i className="viz-key is-spend" /> Spent <b className="num">{formatMoney(point.values[0])}</b>
                            </div>
                            <div className="viz-tip-row">
                              <i className="viz-key is-income" /> In <b className="num">{formatMoney(point.values[1])}</b>
                            </div>
                          </>
                        )}
                      </>
                    );
                  }}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* The AI section: always shown, whatever the filters, since it reads
          the whole month rather than a slice of it. */}
      <h2 className="home-section" id="ai">
        AI
      </h2>
      <div className="home-grid">
        <AiInsightsCard />
        <SavingsPlanCard />
      </div>
    </>
  );
}

function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "credit" | "debit" }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value${tone ? ` ${tone}` : ""}`}>{value}</div>
      {note && <div className="kpi-note">{note}</div>}
    </div>
  );
}

function fullDay(short: string): string {
  return (
    { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" }[
      short
    ] ?? short
  );
}
