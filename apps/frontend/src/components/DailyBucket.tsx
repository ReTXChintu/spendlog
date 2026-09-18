import { DailyBudget } from "../types";
import { formatMoney } from "../lib/format";
import { Icon } from "./Icon";

/**
 * The daily allowance, and the pot filling or draining behind it.
 *
 * Answers a question the pace card next to it cannot: when the salary
 * lands, how much of it can go straight into savings. The pace divides
 * what is left by the days remaining and moves every time anything is
 * spent — it is a forecast. This keeps score against what you decided a
 * day should cost, and a day that came in under is banked whatever
 * happens afterwards.
 *
 * The strip is the part worth having. One number cannot say whether a
 * bucket was drained by one bad Saturday or by leaking every day, and
 * those two call for different things being done about them.
 */

/** How tall a day's bar gets, as a share of the row. */
const TALLEST = 0.9;

export function DailyBucket({ daily }: { daily: DailyBudget }) {
  if (!daily.configured) return null;

  const saved = daily.bucketMinor >= 0;

  // Scaled against the largest single day either way, so the shape of the
  // period is visible rather than one enormous day flattening the rest.
  const biggest = Math.max(1, ...daily.days.map((day) => Math.abs(day.deltaMinor)));

  return (
    <div className="section-block">
      <h3>Daily budget</h3>
      <p className="section-sub">
        {formatMoney(daily.dailyBudgetMinor)} a day, over {daily.daysCounted}{" "}
        {daily.daysCounted === 1 ? "day" : "days"} so far. Starts again{" "}
        {daily.resetsOnSalary ? "when you are paid" : "on the 1st"}.
      </p>

      <div className={`bucket-headline is-${saved ? "saved" : "burnt"}`}>
        <div>
          <span className="emi-preview-label">{saved ? "Put by" : "Out of savings"}</span>
          <span className="budget-figure num">{formatMoney(Math.abs(daily.bucketMinor))}</span>
        </div>
        <div>
          <span className="emi-preview-label">Spent</span>
          <span className="budget-figure num">{formatMoney(daily.spentMinor)}</span>
          <span className="bucket-of">of {formatMoney(daily.allowedMinor)} allowed</span>
        </div>
        <div>
          <span className="emi-preview-label">Today</span>
          <span className="budget-figure num">{formatMoney(daily.todaySpentMinor)}</span>
          <span className="bucket-of">
            {daily.todayLeftMinor >= 0
              ? `${formatMoney(daily.todayLeftMinor)} left`
              : `${formatMoney(-daily.todayLeftMinor)} over`}
          </span>
        </div>
      </div>

      {/* A day each, above the line for what it put by and below for what
          it took back. */}
      <div className="bucket-strip" role="img" aria-label={`${daily.daysOver} of ${daily.daysCounted} days went over`}>
        {daily.days.map((day) => {
          const share = (Math.abs(day.deltaMinor) / biggest) * TALLEST;
          const under = day.deltaMinor >= 0;

          return (
            <span className="bucket-day" key={day.day} title={`${day.day}: ${formatMoney(day.spentMinor)}`}>
              <span className="bucket-half">
                {under && <i className="bucket-bar is-saved" style={{ height: `${share * 100}%` }} />}
              </span>
              <span className="bucket-half is-lower">
                {!under && <i className="bucket-bar is-over" style={{ height: `${share * 100}%` }} />}
              </span>
            </span>
          );
        })}
      </div>

      <p className="budget-verdict">
        <Icon name={saved ? "ic-check" : "ic-alert"} />
        {saved
          ? `${formatMoney(daily.bucketMinor)} to move into savings when your salary lands` +
            (daily.daysOver > 0
              ? `, despite ${daily.daysOver} ${daily.daysOver === 1 ? "day" : "days"} over.`
              : ", with every day inside what you allowed.")
          : `${daily.daysOver} of ${daily.daysCounted} days went over. At this rate the next salary ` +
            `starts ${formatMoney(-daily.bucketMinor)} down rather than up.`}
      </p>

      {/* Said out loud, so the bucket never looks as though it simply
          lost a purchase. */}
      {(daily.keptOutMinor ?? 0) > 0 && (
        <p className="field-hint">
          {formatMoney(daily.keptOutMinor!)} across {daily.keptOutCount}{" "}
          {daily.keptOutCount === 1 ? "one-off or trip payment" : "one-off and trip payments"} kept
          out of the score. It still counts in the month.
        </p>
      )}
    </div>
  );
}
