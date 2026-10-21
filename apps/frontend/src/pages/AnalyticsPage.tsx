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

/**
 * The chart palette, in series order (design-system §3.3): the biggest
 * category takes c1, the next c2 and so on; "Other" is always the grey.
 */
const PALETTE = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)"];
/** Slices past this fold into "Other": five hues and a grey is all the palette has. */
const DONUT_SLICES = 5;
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

  const totalSpend = summary?.totalSpendMinor ?? 0;
  const totalIncome = summary?.totalIncomeMinor ?? 0;
  const net = totalIncome - totalSpend;
  const today = istToday();
  const daysSoFar = daily.filter((day) => day.day <= today).length || daily.length || 1;
  const perDay = Math.round(totalSpend / daysSoFar);
  const hasData = summary !== null && summary.transactionCount > 0;

  // Change against last month per category, from the (unfiltered)
  // comparison. Only offered when nothing is filtered, so a delta never
  // compares a slice with a whole.
  const deltaFor = useMemo(() => {
    const map = new Map((comparison?.categories ?? []).map((entry) => [entry.categoryId ?? "none", entry.changeMinor]));
    return (key: string) => (filtered || !comparison ? null : map.get(key) ?? null);
  }, [comparison, filtered]);

  const slices = useMemo<DonutSlice[]>(() => {
    if (!summary) return [];
    const sorted = [...summary.byCategory].sort((a, b) => b.amountMinor - a.amountMinor);
    let hue = 0;
    const head = sorted.slice(0, DONUT_SLICES).map((entry) => {
      const muted = entry.categoryId === null;
      return {
        key: entry.categoryId ?? "none",
        name: entry.name,
        amountMinor: entry.amountMinor,
        color: muted ? "var(--c-other)" : PALETTE[hue++ % PALETTE.length],
        muted,
        deltaMinor: deltaFor(entry.categoryId ?? "none"),
      };
    });
    const rest = sorted.slice(DONUT_SLICES).reduce((sum, entry) => sum + entry.amountMinor, 0);
    return rest > 0
      ? [
          ...head,
          {
            key: "other",
            name: `Other (${sorted.length - DONUT_SLICES})`,
            amountMinor: rest,
            color: "var(--c-other)",
            muted: true,
            deltaMinor: null,
          },
        ]
      : head;
  }, [summary, deltaFor]);

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
  const currentTrend = trendGroups.findIndex((group) => group.key === months?.current);

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
  const monthLabel = months?.months[index]?.label ?? "…";

  // The comparison tiles: totals stay whole (all accounts and categories).
  const change = comparison?.changeMinor ?? 0;
  const changePct =
    comparison && comparison.previousSpendMinor > 0
      ? Math.round((comparison.changeMinor / comparison.previousSpendMinor) * 100)
      : null;
  const driver = comparison
    ? [...comparison.categories]
        .filter((entry) => (change > 0 ? entry.changeMinor > 0 : entry.changeMinor < 0))
        .sort((a, b) => Math.abs(b.changeMinor) - Math.abs(a.changeMinor))[0] ?? null
    : null;
  const sparkValues = daily.filter((day) => day.day <= today).map((day) => day.spendMinor);

  return (
    <div className="an">
      {/* Every control that changes the charts, in one row above them. */}
      <div className="an-filters" role="group" aria-label="Filters">
        <label className="an-filter">
          <span className="chip-group-label">Account</span>
          <select
            className={`an-select${accountFilter ? " on" : ""}`}
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
          >
            <option value="">All accounts</option>
            <option value="cash">Cash</option>
            {accountOptions.map((account) => (
              <option key={account.id} value={account.id}>
                {accountLabel(account)}
              </option>
            ))}
          </select>
        </label>

        <label className="an-filter">
          <span className="chip-group-label">Category</span>
          <select
            className={`an-select${categoryFilter ? " on" : ""}`}
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="">All categories</option>
            <option value="none">No category</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>

        <div className="an-filter">
          <span className="chip-group-label">{bySalary ? "Pay month" : "Month"}</span>
          <div className="an-stepper">
            <button
              className="icon-btn"
              onClick={() => setIndex((current) => current + 1)}
              disabled={!months || index >= months.months.length - 1}
              aria-label={`Previous ${monthWord}`}
            >
              <Icon name="ic-chevron-left" />
            </button>
            <span className="num" aria-live="polite">
              {monthLabel}
            </span>
            <button
              className="icon-btn"
              onClick={() => setIndex((current) => current - 1)}
              disabled={index === 0}
              aria-label={`Next ${monthWord}`}
            >
              <Icon name="ic-chevron-right" />
            </button>
          </div>
        </div>

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
      <p className="an-note">Transfers, settlements and the part of a split bill that wasn't yours are not counted.</p>

      {summary === null ? (
        <div className="an-loading" aria-busy="true">
          <p className="skel-caption">Loading this {monthWord}…</p>
          <div className="stat-tiles">
            {[0, 1, 2, 3].map((n) => (
              <div className="stat-tile" key={n}>
                <span className="skel skel-line" style={{ width: "50%" }} />
                <span className="skel" style={{ width: "70%", height: 22 }} />
                <span className="skel skel-line sm" style={{ width: "40%" }} />
              </div>
            ))}
          </div>
          <div className="skel an-loading-chart" />
        </div>
      ) : !hasData && !filtered ? (
        <StateBlock
          icon="ic-bar-chart"
          title="Nothing to analyse yet"
          body="Charts need transactions first. Once a few payments come in from SMS or Gmail, this fills in on its own — no setup required here."
        />
      ) : (
        <>
          <div className="stat-tiles an-tiles">
            <div className="stat-tile">
              <div className="label">{index === 0 ? `This ${monthWord} so far` : `Spent this ${monthWord}`}</div>
              <div className="value">{formatMoneyShort(totalSpend)}</div>
              <div className="foot num">
                {monthLabel} · {summary.transactionCount} {summary.transactionCount === 1 ? "payment" : "payments"}
              </div>
            </div>

            {comparison && (
              <div className="stat-tile">
                <div className="label">Last {monthWord}</div>
                <div className="value">{formatMoneyShort(comparison.previousSpendMinor)}</div>
                <div className="foot">
                  {comparison.previousMonthLabel}
                  {filtered ? " · all accounts and categories" : ""}
                </div>
              </div>
            )}

            {comparison && (
              <div className="stat-tile">
                <div className="label">Difference</div>
                <div className={`value${change > 0 ? " is-crit" : change < 0 ? " is-good" : ""}`}>
                  {change > 0 ? "+" : change < 0 ? "−" : ""}
                  {formatMoneyShort(Math.abs(change))}
                  {changePct !== null && change !== 0 && (
                    <span className="an-pct">
                      {" "}
                      ({change > 0 ? "+" : "−"}
                      {Math.abs(changePct)}%)
                    </span>
                  )}
                </div>
                {driver ? (
                  <span className={`badge ${change > 0 ? "badge-crit" : "badge-good"} an-tile-badge`}>
                    <Icon name={change > 0 ? "ic-arrow-up-right" : "ic-arrow-down-left"} />
                    Mostly {driver.name} ({change > 0 ? "+" : "−"}
                    {formatMoneyShort(Math.abs(driver.changeMinor))})
                  </span>
                ) : (
                  <div className="foot">{change === 0 ? "Same as last time" : `Against ${comparison.previousMonthLabel}`}</div>
                )}
              </div>
            )}

            <div className="stat-tile">
              <div className="label">Daily average</div>
              <div className="an-tile-row">
                <div className="value">{formatMoneyShort(perDay)}</div>
                <Sparkline values={sparkValues} />
              </div>
              <div className="foot">over {daysSoFar} {daysSoFar === 1 ? "day" : "days"}</div>
            </div>

            <div className="stat-tile">
              <div className="label">Money in</div>
              <div className={`value${totalIncome > 0 ? " is-good" : ""}`}>
                {totalIncome > 0 ? "+" : ""}
                {formatMoneyShort(totalIncome)}
              </div>
              <div className="foot num">
                Net {net > 0 ? "+" : net < 0 ? "−" : ""}
                {formatMoneyShort(Math.abs(net))} · {net >= 0 ? "kept" : "more out than in"}
              </div>
            </div>
          </div>

          {!hasData ? (
            <div className="empty-inline an-empty">
              <span className="icon-tile tile-neutral">
                <Icon name="ic-filter" />
              </span>
              Nothing this {monthWord} matches these filters.
            </div>
          ) : (
            <>
              <div className="flow an-row">
                <section className="card span-8">
                  <div className="card-head">
                    <h2>Spending by day</h2>
                    <span className="spacer" />
                    <span className="meta">Hover or use the arrow keys for a day's figures</span>
                  </div>
                  <DailyChart days={daily} />
                </section>

                <section className="card span-4">
                  <div className="card-head">
                    <h2>By category</h2>
                    <span className="spacer" />
                    {!filtered && comparison && <span className="meta">vs {comparison.previousMonthLabel}</span>}
                  </div>
                  <Donut slices={slices} total={totalSpend} />
                </section>
              </div>

              <div className="flow an-row">
                <section className="card span-8">
                  <div className="card-head">
                    <h2>Last 6 {bySalary ? "pay months" : "months"}</h2>
                    <span className="spacer" />
                    <span className="meta">
                      {monthsWithData <= 1
                        ? "Less than a month of history so far — the earlier months are still empty, and that's expected."
                        : `Spending and money in side by side${filtered ? " · all accounts and categories" : ""}`}
                    </span>
                  </div>
                  <ColumnChart
                    groups={trendGroups}
                    series={[
                      { name: "Spent", tone: "is-spend" },
                      { name: "Money in", tone: "is-income" },
                    ]}
                    current={currentTrend >= 0 ? currentTrend : undefined}
                    height={160}
                    ariaLabel={`Spending and money in over the last ${trendGroups.length} months.`}
                    tooltip={(group) => {
                      const point = trendGroups.find((entry) => entry.key === group.key)!;
                      return (
                        <>
                          <div className="chart-tip-title">{point.full}</div>
                          {point.empty ? (
                            <div className="chart-tip-row">Nothing recorded</div>
                          ) : (
                            <>
                              <div className="chart-tip-row">
                                <i className="chart-key is-spend" /> Spent <b className="num">{formatMoney(point.values[0])}</b>
                              </div>
                              <div className="chart-tip-row">
                                <i className="chart-key is-income" /> In <b className="num">{formatMoney(point.values[1])}</b>
                              </div>
                            </>
                          )}
                        </>
                      );
                    }}
                  />
                </section>

                <section className="card span-4 an-merchants">
                  <div className="card-head">
                    <h2>Top merchants</h2>
                  </div>
                  {merchantTop.length === 0 ? (
                    <p className="an-sub">Nothing here has a merchant name yet.</p>
                  ) : (
                    <table className="data-table is-inset">
                      <thead>
                        <tr>
                          <th>Merchant</th>
                          <th className="num">Times</th>
                          <th className="num">Spent</th>
                        </tr>
                      </thead>
                      <tbody>
                        {merchantTop.map((entry) => (
                          <tr
                            key={entry.merchant}
                            title={`${entry.merchant}: ${formatMoney(entry.amountMinor)} over ${entry.count} payments`}
                          >
                            <td>
                              <div className="an-merchant">
                                <span className="monogram" aria-hidden="true">
                                  {initials(entry.merchant)}
                                </span>
                                <span className="an-merchant-name">{entry.merchant}</span>
                              </div>
                            </td>
                            <td className="num an-times">{entry.count}</td>
                            <td className="num">{formatMoneyShort(entry.amountMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              </div>

              <div className="flow an-row">
                {comparison && (
                  <section className="card span-4">
                    <div className="card-head">
                      <h2>Against {comparison.previousMonthLabel}</h2>
                    </div>
                    <p className="an-sub">
                      Per category, more spend in red, less in green{filtered ? " · all accounts and categories" : ""}.
                    </p>
                    <div className="an-bars">
                      {comparison.categories.slice(0, 8).map((entry) => {
                        const biggest = Math.max(1, ...comparison.categories.map((c) => Math.abs(c.changeMinor)));
                        const width = Math.round((Math.abs(entry.changeMinor) / biggest) * 100);
                        const up = entry.changeMinor > 0;
                        return (
                          <div className="an-bar-row" key={entry.categoryId ?? "none"}>
                            <div className="an-bar-name">{entry.name}</div>
                            <div className="an-bar-track">
                              <div className={`an-bar-fill${up ? " is-up" : " is-down"}`} style={{ width: `${width}%` }} />
                            </div>
                            <div className={`an-bar-val num${entry.changeMinor === 0 ? "" : up ? " is-up" : " is-down"}`}>
                              {entry.changeMinor === 0 ? (
                                <span className="an-bar-sub">no change</span>
                              ) : (
                                <>
                                  {up ? "+" : "−"}
                                  {formatMoneyShort(Math.abs(entry.changeMinor))}
                                </>
                              )}
                              <span className="an-bar-sub">
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
                  </section>
                )}

                <section className="card span-4">
                  <div className="card-head">
                    <h2>By day of the week</h2>
                  </div>
                  <p className="an-sub">
                    Average spent on each weekday this {monthWord}
                    {busiestDay && busiestDay.averageMinor > 0 ? ` — ${fullDay(busiestDay.day)}s cost the most` : ""}.
                  </p>
                  <ColumnChart
                    groups={weekOrdered.map((day) => ({ key: day.day, label: day.day, values: [day.averageMinor] }))}
                    series={[{ name: "Average a day", tone: "is-spend" }]}
                    height={140}
                    ariaLabel={`Average spending by weekday${
                      busiestDay && busiestDay.averageMinor > 0
                        ? `; highest on ${fullDay(busiestDay.day)} at ${formatMoney(busiestDay.averageMinor)}`
                        : ""
                    }.`}
                    tooltip={(group) => {
                      const day = weekOrdered.find((entry) => entry.day === group.key)!;
                      return (
                        <>
                          <div className="chart-tip-title">{fullDay(day.day)}s</div>
                          <div className="chart-tip-row">
                            Average <b className="num">{formatMoney(day.averageMinor)}</b>
                          </div>
                          <div className="chart-tip-row">
                            In all <b className="num">{formatMoney(day.amountMinor)}</b>
                          </div>
                          <div className="chart-tip-row">
                            Payments <b className="num">{day.count}</b>
                          </div>
                        </>
                      );
                    }}
                  />
                </section>

                <section className="card span-4">
                  <div className="card-head">
                    <h2>By card and account</h2>
                  </div>
                  <p className="an-sub">
                    Which card or account the spending went through
                    {accountFilter ? " — the account filter doesn't apply here" : ""}.
                  </p>
                  {byAccount.length === 0 ? (
                    <p className="an-sub">Nothing to show.</p>
                  ) : (
                    <div className="an-bars">
                      {byAccount.map((entry) => {
                        const pct = accountTotal > 0 ? Math.round((entry.amountMinor / accountTotal) * 100) : 0;
                        const top = byAccount[0].amountMinor || 1;
                        return (
                          <div
                            className="an-bar-row"
                            key={entry.accountId}
                            title={`${entry.name}: ${formatMoney(entry.amountMinor)} over ${entry.count} payments`}
                          >
                            <div className="an-bar-name">{entry.name}</div>
                            <div className="an-bar-track">
                              <div className="an-bar-fill" style={{ width: `${(entry.amountMinor / top) * 100}%` }} />
                            </div>
                            <div className="an-bar-val num">
                              {formatMoneyShort(entry.amountMinor)}
                              <span className="an-bar-sub">{pct}%</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </>
      )}

      {/* The AI section: always shown, whatever the filters, since it reads
          the whole month rather than a slice of it. */}
      <h2 className="an-section" id="ai">
        <Icon name="ic-sparkles" /> AI
      </h2>
      <div className="flow flow-stretch">
        <div className="span-6 an-ai-col">
          <AiInsightsCard />
        </div>
        <div className="span-6 an-ai-col">
          <SavingsPlanCard />
        </div>
      </div>
    </div>
  );
}

/** An 80×24 sparkline in the accent (design-system §7.13). */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const width = 80;
  const height = 24;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const points = values
    .map((value, i) => `${(i * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="an-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

/** Two letters for a merchant's monogram: "Third Wave Coffee" → "TW". */
function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function fullDay(short: string): string {
  return (
    { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" }[
      short
    ] ?? short
  );
}
