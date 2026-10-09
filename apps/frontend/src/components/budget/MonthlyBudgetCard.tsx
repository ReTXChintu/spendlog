import { useState } from "react";
import { api, ApiError } from "../../lib/api";
import { formatMoney, formatMoneyShort, formatShortDate } from "../../lib/format";
import { CategoryBudget, MonthPace, MonthlyBudgetStatus } from "../../types";
import { Icon } from "../Icon";
import "../../styles/budget.css";

/**
 * The month against its budget, on the dashboard.
 *
 * One amount, everything counted against it, and a plain sentence about
 * the pace: whether carrying on like this lasts the month, and if not,
 * what a day can cost from here so that it does. The category limits sit
 * beside it as small bars, the over ones flagged, with "everything else"
 * as the pool they leave.
 *
 * Underneath, the savings bucket - every month's leftover, added up - and
 * what this month would add to it if it ended today.
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
  const status = budget.isOver ? "over" : (pace?.status ?? "on_track");
  const spentShare = Math.min(100, Math.round((budget.spentMinor / Math.max(1, total)) * 100));
  const expectedShare = pace ? Math.min(100, Math.round((pace.expectedSpentMinor / Math.max(1, total)) * 100)) : null;

  return (
    <section className="home-card is-wide mbudget" aria-labelledby="mbudget-title">
      <div className="home-card-head">
        <h3 className="home-card-title" id="mbudget-title">
          <Icon name="ic-calendar" /> Budget · {month.label}
        </h3>
        <button className="btn btn-sm" onClick={() => onEdit()}>
          <Icon name="ic-pencil" /> Edit budget
        </button>
      </div>

      <div className="mbudget-body">
        <div className="mbudget-main">
          <div className="mbudget-figures">
            <div>
              <span className="mbudget-label">Spent</span>
              <span className="mbudget-figure num">{formatMoney(budget.spentMinor)}</span>
            </div>
            <div>
              <span className="mbudget-label">{budget.isOver ? "Over by" : "Left"}</span>
              <span className={`mbudget-figure num is-${budget.isOver ? "over" : "left"}`}>
                {formatMoney(Math.abs(left))}
              </span>
            </div>
            <div className="mbudget-of">
              of {formatMoney(total)}
              {month.isCurrent && (
                <>
                  {" · "}
                  {month.daysLeft} {month.daysLeft === 1 ? "day" : "days"} to go
                </>
              )}
            </div>
          </div>

          <div
            className={`mbudget-bar is-${status}`}
            role="img"
            aria-label={`${spentShare}% of the budget spent${
              expectedShare !== null ? `; ${expectedShare}% would be on plan by today` : ""
            }`}
          >
            <div className="mbudget-bar-fill" style={{ width: `${spentShare}%` }} />
            {/* Where spending would be today if the month were going to plan. */}
            {expectedShare !== null && month.isCurrent && (
              <span className="mbudget-bar-plan" style={{ left: `${expectedShare}%` }} />
            )}
          </div>

          {pace && month.isCurrent && <PaceLine pace={pace} isOver={budget.isOver} left={left} />}

          {budget.bucket.configured && (
            <div className="mbudget-bucket">
              <span className="mbudget-bucket-icon">
                <Icon name="ic-wallet" />
              </span>
              <div>
                <span className="mbudget-label">Savings bucket</span>
                <span className="mbudget-bucket-figure num">{formatMoney(budget.bucket.balanceMinor)}</span>
              </div>
              {month.isCurrent && (
                <span
                  className={`mbudget-bucket-delta${
                    budget.bucket.balanceIfMonthEndedNowMinor < budget.bucket.balanceMinor ? " is-down" : ""
                  }`}
                >
                  {signed(budget.bucket.balanceIfMonthEndedNowMinor - budget.bucket.balanceMinor)} if the month ended
                  now
                </span>
              )}
            </div>
          )}
        </div>

        <div className="mbudget-cats">
          <div className="trip-settle-title">Category limits</div>
          {budget.categories.length === 0 ? (
            <div className="mbudget-cats-empty">
              <p className="field-hint">
                No category has a limit of its own. Give dining, groceries or transport a share of the budget and
                each gets its own bar here.
              </p>
              <button className="btn btn-sm" onClick={() => onEdit()}>
                <Icon name="ic-plus" /> Add category limits
              </button>
            </div>
          ) : (
            <ul className="mbudget-cat-list">
              {budget.categories.map((category) => (
                <CategoryBar key={category.categoryId} category={category} />
              ))}
              {budget.unassigned && (
                <CategoryBar
                  unplanned
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
      </div>
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
    pace.fixedStillDueMinor > 0 ? ` That already allows for ${formatMoneyShort(pace.fixedStillDueMinor)} of fixed costs still to go out.` : "";

  if (isOver || pace.status === "over") {
    return (
      <p className="mbudget-pace is-over">
        <Icon name="ic-alert" />
        <span>
          <b>Over budget by {formatMoneyShort(Math.abs(left))}.</b> Anything more this month comes out of savings —
          hold off on whatever can wait.
        </span>
      </p>
    );
  }

  if (pace.status === "high") {
    return (
      <p className="mbudget-pace is-high">
        <Icon name="ic-alert" />
        <span>
          <b>Pace is high — slow down.</b> Keep to {perDay}/day
          {pace.runOutOn ? ` or you'll run out by ${formatShortDate(pace.runOutOn)}` : " to make it to the end of the month"}.
          {fixed}
        </span>
      </p>
    );
  }

  return (
    <p className="mbudget-pace is-on_track">
      <Icon name="ic-check" />
      <span>
        <b>On track.</b> {perDay}/day is safe for the next {days} {days === 1 ? "day" : "days"}.{fixed}
        {pace.runOutOn ? ` At your average so far it runs out on ${formatShortDate(pace.runOutOn)}, so go easy.` : ""}
      </span>
    </p>
  );
}

function CategoryBar({
  category,
  unplanned = false,
  note,
}: {
  category: CategoryBudget;
  unplanned?: boolean;
  note?: string;
}) {
  const share = Math.min(100, Math.round((category.spentMinor / Math.max(1, category.limitMinor)) * 100));
  const state = category.isOver ? "over" : category.pace?.status === "high" ? "high" : "ok";

  return (
    <li className={`mbudget-cat is-${state}${unplanned ? " is-unplanned" : ""}`}>
      <div className="mbudget-cat-top">
        <span className="mbudget-cat-name">
          {category.color && !unplanned && (
            <span className="mbudget-cat-dot" style={{ background: category.color }} aria-hidden="true" />
          )}
          {category.name}
          {category.isOver && <span className="rule-pill is-over">Over</span>}
        </span>
        <span className="mbudget-cat-figure num">
          {formatMoneyShort(category.spentMinor)} <small>/ {formatMoneyShort(category.limitMinor)}</small>
        </span>
      </div>
      <div className="mbudget-cat-bar">
        <div className="mbudget-cat-fill" style={{ width: `${share}%` }} />
      </div>
      <div className="mbudget-cat-sub">
        {category.isOver
          ? `${formatMoneyShort(-category.leftMinor)} over`
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
    <section className="home-card is-wide mbudget is-setup" aria-labelledby="mbudget-title">
      <h3 className="home-card-title" id="mbudget-title">
        <Icon name="ic-calendar" /> Set a monthly budget
      </h3>
      <p className="section-sub">
        One amount for {budget.month.label}, with everything held against it — rent, EMIs, SIPs and the day to day.
        SpendLog keeps an eye on the pace, says when to slow down, and puts whatever is left into savings at the end of
        the month. {formatMoney(budget.spentMinor)} has gone out so far.
      </p>
      <form
        className="mbudget-setup"
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
        <button className="btn btn-primary" type="submit" disabled={!amountMinor || saving}>
          {saving ? "Saving…" : "Set budget"}
        </button>
        <button className="btn btn-ghost" type="button" onClick={() => onEdit(amountMinor)}>
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
