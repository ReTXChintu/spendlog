import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { formatMoney, formatMoneyShort, formatShortDate } from "../../lib/format";
import { CategoryBudget, MonthPace, MonthlyBudgetStatus } from "../../types";
import { Icon } from "../Icon";
import "../../styles/budget.css";

/**
 * The month against its budget: the "Free to spend" hero on Home.
 *
 * One amount, everything counted against it, and the pace bar under it -
 * spent in ink, the fixed costs still to go out hatched as promised, the
 * rest free, and a tick for where spending would be today if the month
 * went to plan. Then a plain sentence about the pace: whether carrying on
 * like this lasts the month, and if not, what a day can cost from here.
 *
 * The category limits follow as bars with the same today tick, the over
 * ones flagged, with "everything else" as the pool they leave. Underneath,
 * the savings bucket - every month's leftover, added up - and what this
 * month would add to it if it ended today.
 */
export function MonthlyBudgetCard({
  budget,
  onEdit,
  onSaved,
}: {
  budget: MonthlyBudgetStatus;
  /** Opens the editor, starting from this total when there is none yet. */
  onEdit: (startFromMinor?: number | null) => void;
  onSaved: () => void;
}) {
  if (!budget.configured || budget.budgetMinor === null) {
    return <SetUp budget={budget} onEdit={onEdit} onSaved={onSaved} />;
  }

  const { pace, month } = budget;
  const total = budget.budgetMinor;
  const left = budget.leftMinor ?? total - budget.spentMinor;
  const promised = pace && month.isCurrent ? Math.max(0, Math.min(pace.fixedStillDueMinor, Math.max(0, left))) : 0;
  // Free: what is left once the fixed costs still to go out are held back.
  const free = Math.max(0, left - promised);
  const spentShare = Math.min(100, (budget.spentMinor / Math.max(1, total)) * 100);
  const promisedShare = Math.min(100 - spentShare, (promised / Math.max(1, total)) * 100);
  const expectedShare = pace ? Math.min(100, (pace.expectedSpentMinor / Math.max(1, total)) * 100) : null;
  const dayLine =
    month.isCurrent && month.dayOfMonth !== null ? ` · day ${month.dayOfMonth} of ${month.daysInMonth}` : "";
  const limitsTotal = budget.categories.reduce((sum, category) => sum + category.limitMinor, 0);

  return (
    <section className="card card-hero hero" aria-labelledby="mbudget-title">
      <div className="hero-top">
        <div className="hero-main">
          <div className="hero-eyebrow num">
            {month.label}
            {dayLine}
          </div>
          <h2 className="hero-title" id="mbudget-title">
            {budget.isOver ? "Over budget by" : month.isCurrent ? "Free to spend" : "Left"}
          </h2>
          <div className={`hero-figure num${budget.isOver ? " is-over" : ""}`}>
            {formatMoneyShort(budget.isOver ? Math.abs(left) : month.isCurrent ? free : left)}
          </div>
          {pace && month.isCurrent && !budget.isOver && (
            <p className="hero-explain">
              {pace.daysLeft} {pace.daysLeft === 1 ? "day" : "days"} left · about{" "}
              <b className="num">{formatMoneyShort(pace.safeDailyMinor)}/day</b>
            </p>
          )}
        </div>

        <dl className="kpis hero-kpis">
          <div className="kpi">
            <dt className="kpi-label">Budget</dt>
            <dd className="kpi-value num">{formatMoneyShort(total)}</dd>
          </div>
          <div className="kpi">
            <dt className="kpi-label">{budget.isOver ? "Over by" : "Left"}</dt>
            <dd className={`kpi-value num${budget.isOver ? " is-crit" : ""}`}>{formatMoneyShort(Math.abs(left))}</dd>
          </div>
          {pace && month.isCurrent && (
            <div className="kpi">
              <dt className="kpi-label">Average so far</dt>
              <dd className="kpi-value num">
                {formatMoneyShort(pace.dailyAverageMinor)}
                <small>/day</small>
              </dd>
            </div>
          )}
        </dl>
      </div>

      <div className="pace hero-pace">
        <div
          className="pace-track"
          role="img"
          aria-label={`Spent ${formatMoney(budget.spentMinor)}${
            promised > 0 ? `, ${formatMoney(promised)} promised to fixed costs` : ""
          }, ${formatMoney(Math.max(0, free))} free, of a ${formatMoney(total)} budget${
            expectedShare !== null && month.isCurrent && pace
              ? `. On plan, about ${formatMoney(pace.expectedSpentMinor)} would be spent by today`
              : ""
          }`}
        >
          <span className={`seg-spent${spentShare >= 100 ? " is-full" : ""}`} style={{ width: `${spentShare}%` }} />
          {promisedShare > 0 && <span className="seg-promised" style={{ width: `${promisedShare}%` }} />}
          {/* Where spending would be today if the month were going to plan. */}
          {expectedShare !== null && month.isCurrent && pace && (
            <span className="pace-tick" style={{ left: `${expectedShare}%` }}>
              <span className="pace-tick-label num">Today · {formatMoneyShort(pace.expectedSpentMinor)}</span>
            </span>
          )}
        </div>
        <div className="pace-legend">
          <span>
            <span className="swatch swatch-spent" /> Spent <b>{formatMoneyShort(budget.spentMinor)}</b>
          </span>
          {promised > 0 && (
            <span>
              <span className="swatch swatch-promised" /> Promised <b>{formatMoneyShort(promised)}</b>
              <span className="tx3">fixed costs still to go out</span>
            </span>
          )}
          <span>
            <span className="swatch swatch-free" /> Free <b>{formatMoneyShort(free)}</b>
          </span>
          {expectedShare !== null && month.isCurrent && (
            <span>
              <span className="swatch swatch-tick" /> Where you should be today
            </span>
          )}
        </div>
      </div>

      {pace && month.isCurrent && <PaceLine pace={pace} isOver={budget.isOver} left={left} />}

      <div className="hero-limits">
        <div className="hero-limits-head">
          <h3>Category limits</h3>
          <span className="spacer" />
          {budget.categories.length > 0 && (
            <span className="hero-limits-meta num">
              Limits add to {formatMoneyShort(limitsTotal)}
              {budget.unassigned ? ` · ${formatMoneyShort(budget.unassigned.amountMinor)} for everything else` : ""}
            </span>
          )}
          <button className="btn-link" onClick={() => onEdit()}>
            Edit budget
          </button>
        </div>

        {budget.categories.length === 0 ? (
          <div className="empty-inline hero-limits-empty">
            <span>
              No category has a limit of its own. Give dining, groceries or transport a share of the budget and each
              gets its own bar here.
            </span>
            <button className="btn btn-sm" onClick={() => onEdit()}>
              <Icon name="ic-plus" /> Add category limits
            </button>
          </div>
        ) : (
          <ul className="hero-limit-list">
            {budget.categories.map((category) => (
              <CategoryBar key={category.categoryId} category={category} showTick={month.isCurrent} />
            ))}
            {budget.unassigned && (
              <CategoryBar
                unplanned
                showTick={month.isCurrent}
                category={{
                  categoryId: "unassigned",
                  name: "Everything else",
                  icon: null,
                  color: null,
                  limitMinor: budget.unassigned.amountMinor,
                  spentMinor: budget.unassigned.spentMinor,
                  leftMinor: budget.unassigned.leftMinor,
                  isOver: budget.unassigned.isOver,
                  pace: budget.unassigned.pace,
                }}
                note={budget.unassigned.categories
                  .slice(0, 3)
                  .map((category) => category.name)
                  .join(", ")}
              />
            )}
          </ul>
        )}
      </div>

      {budget.bucket.configured && (
        <div className="hero-bucket">
          <span className="icon-tile tile-good sm" aria-hidden="true">
            <Icon name="ic-piggy-bank" />
          </span>
          <span className="hero-bucket-text num">
            Savings bucket <b>{formatMoneyShort(budget.bucket.balanceMinor)}</b>
            {month.isCurrent && (
              <>
                {" · "}
                <b
                  className={
                    budget.bucket.balanceIfMonthEndedNowMinor < budget.bucket.balanceMinor ? "is-crit" : "is-good"
                  }
                >
                  {signed(budget.bucket.balanceIfMonthEndedNowMinor - budget.bucket.balanceMinor)}
                </b>{" "}
                if the month ended now
              </>
            )}
          </span>
          <Link className="btn-link" to="/?tab=analytics#ai">
            Savings plan
          </Link>
        </div>
      )}
    </section>
  );
}

/**
 * The pace, said as advice. Calm when it's fine, specific when it isn't:
 * the figure a day can cost from here, and the day the money runs out if
 * nothing changes.
 */
function PaceLine({ pace, isOver, left }: { pace: MonthPace; isOver: boolean; left: number }) {
  const days = pace.daysLeft;
  const perDay = formatMoneyShort(pace.safeDailyMinor);
  const fixed =
    pace.fixedStillDueMinor > 0
      ? ` That already allows for ${formatMoneyShort(pace.fixedStillDueMinor)} of fixed costs still to go out.`
      : "";

  if (isOver || pace.status === "over") {
    return (
      <div className="callout callout-crit hero-callout" role="status">
        <Icon name="ic-alert-triangle" />
        <span className="callout-body">
          Over budget by {formatMoneyShort(Math.abs(left))}. Anything more this month comes out of savings — hold off
          on whatever can wait.
        </span>
      </div>
    );
  }

  if (pace.status === "high") {
    return (
      <div className="callout callout-warn hero-callout" role="status">
        <Icon name="ic-alert-triangle" />
        <span className="callout-body">
          Pace is high — slow down. Keep to {perDay}/day
          {pace.runOutOn
            ? ` or you’ll run out by ${formatShortDate(pace.runOutOn)}`
            : " to make it to the end of the month"}
          .{fixed}
        </span>
        <Link to="/ask" className="hero-callout-link">
          Ask AI how
        </Link>
      </div>
    );
  }

  return (
    <div className="callout callout-good hero-callout" role="status">
      <Icon name="ic-check" />
      <span className="callout-body">
        On track. {perDay}/day is safe for the next {days} {days === 1 ? "day" : "days"}.{fixed}
        {pace.runOutOn ? ` At your average so far it runs out on ${formatShortDate(pace.runOutOn)}, so go easy.` : ""}
      </span>
    </div>
  );
}

function CategoryBar({
  category,
  unplanned = false,
  showTick,
  note,
}: {
  category: CategoryBudget;
  unplanned?: boolean;
  showTick: boolean;
  note?: string;
}) {
  const share = Math.min(100, Math.round((category.spentMinor / Math.max(1, category.limitMinor)) * 100));
  const exactShare = Math.round((category.spentMinor / Math.max(1, category.limitMinor)) * 100);
  const state = category.isOver ? "over" : category.pace?.status === "high" ? "high" : "ok";
  const tick =
    showTick && category.pace
      ? Math.min(100, (category.pace.expectedSpentMinor / Math.max(1, category.limitMinor)) * 100)
      : null;
  const days = category.pace?.daysLeft;

  return (
    <li className={`hero-limit is-${state}${unplanned ? " is-unplanned" : ""}`}>
      <div className="hero-limit-top">
        <span className="hero-limit-name">{category.name}</span>
        <span className="hero-limit-figure num">
          <b>{formatMoneyShort(category.spentMinor)}</b> of {formatMoneyShort(category.limitMinor)}
        </span>
      </div>
      <div className="limit-bar" role="img" aria-label={`${exactShare}% of the ${category.name} limit used`}>
        <span className={`fill${state !== "ok" ? " is-over" : ""}`} style={{ width: `${share}%` }} />
        {tick !== null && <span className="pace-tick" style={{ left: `${tick}%` }} />}
      </div>
      <div className={`limit-status num${state !== "ok" ? " is-over" : ""}`}>
        {exactShare}% used ·{" "}
        {category.isOver
          ? `${formatMoneyShort(-category.leftMinor)} over`
          : state === "high" && days
            ? `${formatMoneyShort(category.leftMinor)} left for ${days} ${days === 1 ? "day" : "days"}`
            : `${formatMoneyShort(category.leftMinor)} left`}
        {category.pace && !category.isOver && category.pace.status === "high"
          ? ` · keep to ${formatMoneyShort(category.pace.safeDailyMinor)}/day`
          : ""}
        {note ? ` · ${note}` : ""}
      </div>
    </li>
  );
}

/**
 * No budget yet: a total to start from, saved straight away, or taken
 * into the editor to split by category first.
 */
function SetUp({
  budget,
  onEdit,
  onSaved,
}: {
  budget: MonthlyBudgetStatus;
  onEdit: (startFromMinor?: number | null) => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState(
    budget.suggestedMonthlyMinor ? String(Math.round(budget.suggestedMonthlyMinor / 100)) : ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rupees = Number.parseFloat(amount.replace(/,/g, ""));
  const amountMinor = Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : null;

  async function save() {
    if (!amountMinor) return;
    setSaving(true);
    setError(null);
    try {
      await api.put("/budget/monthly", { amountMinor, categoryLimits: [] });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that.");
      setSaving(false);
    }
  }

  return (
    <section className="card card-hero hero is-setup" aria-labelledby="mbudget-title">
      <div className="hero-eyebrow">{budget.month.label}</div>
      <h2 className="hero-setup-title" id="mbudget-title">
        Set a monthly budget
      </h2>
      <p className="hero-explain">
        One amount for {budget.month.label}, with everything held against it — rent, EMIs, SIPs and the day to day.
        SpendLog keeps an eye on the pace, says when to slow down, and puts whatever is left into savings at the end of
        the month. <b className="num">{formatMoneyShort(budget.spentMinor)}</b> has gone out so far.
      </p>
      <form
        className="hero-setup"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label className="field">
          <span>For the whole month</span>
          <div className="amount-input">
            <span className="prefix">₹</span>
            <input
              className="filter-input"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="20000"
            />
          </div>
        </label>
        <button className="btn btn-primary btn-lg" type="submit" disabled={!amountMinor || saving}>
          {saving ? "Saving…" : "Set budget"}
        </button>
        <button className="btn btn-ghost btn-lg" type="button" onClick={() => onEdit(amountMinor)}>
          Split it by category…
        </button>
      </form>
      {budget.suggestedMonthlyMinor && (
        <p className="field-hint">Filled in from your old daily budget over this month's days.</p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** "+₹1,200" or "−₹300". */
function signed(minor: number): string {
  return `${minor < 0 ? "−" : "+"}${formatMoneyShort(Math.abs(minor))}`;
}
