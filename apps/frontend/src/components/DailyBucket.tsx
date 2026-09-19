import { DailyBudget } from "../types";
import { formatMoney } from "../lib/format";

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
 * Kept to three numbers on purpose: spent, budget, and what that leaves
 * in savings. A chart of the days behind it is a second card someone can
 * ask for — this one answers "where do I stand" at a glance.
 */
export function DailyBucket({ daily }: { daily: DailyBudget }) {
  if (!daily.configured) return null;

  const saved = daily.bucketMinor >= 0;

  return (
    <div className="section-block">
      <h3>Daily budget</h3>

      <div className={`bucket-simple is-${saved ? "saved" : "burnt"}`}>
        <div className="bucket-simple-figure num">{formatMoney(Math.abs(daily.bucketMinor))}</div>
        <div className="bucket-simple-label">{saved ? "in savings" : "from savings"}</div>
        <div className="bucket-simple-sub">
          {formatMoney(daily.spentMinor)} spent of {formatMoney(daily.allowedMinor)} budget
        </div>
      </div>

      {/* Said out loud, so the bucket never looks as though it simply
          lost a purchase. */}
      {(daily.keptOutMinor ?? 0) > 0 && (
        <p className="field-hint">
          {formatMoney(daily.keptOutMinor!)} in one-offs and trips kept out of this — still counted
          in the month.
        </p>
      )}
    </div>
  );
}
