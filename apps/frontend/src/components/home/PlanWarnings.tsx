import { Link } from "react-router-dom";
import { formatMoney, formatMoneyShort } from "../../lib/format";
import { PlanRule } from "../../types";
import { Icon } from "../Icon";

/**
 * The savings-plan rules being broken this month, near the top of Home.
 *
 * This is the "again and again": the plan lives in Analytics, but a rule
 * only helps if it is in front of you while there is still time to keep
 * it, so every rule that is over or running ahead of pace shows here each
 * time the app opens, until it isn't.
 */
export function PlanWarnings({ warnings }: { warnings: PlanRule[] }) {
  if (warnings.length === 0) return null;
  const over = warnings.filter((warning) => warning.state === "over").length;

  return (
    <section className={`card plan-warn${over > 0 ? " is-over" : ""}`} aria-labelledby="plan-warn-title">
      <div className="plan-warn-head">
        <span className={`icon-tile ${over > 0 ? "tile-crit" : "tile-warn"}`} aria-hidden="true">
          <Icon name="ic-alert-triangle" />
        </span>
        <h2 id="plan-warn-title">
          {warnings.length === 1 ? "One savings rule needs you" : `${warnings.length} savings rules need you`}
        </h2>
        <Link className="btn-link plan-warn-link" to="/?tab=analytics#ai">
          See the plan <Icon name="ic-chevron-right" />
        </Link>
      </div>
      <ul className="plan-warn-list">
        {warnings.map((warning, index) => (
          <li key={`${warning.text}-${index}`}>
            <RuleLine rule={warning} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One rule: its words, a status pill, and spent against cap when it has one. */
export function RuleLine({ rule }: { rule: PlanRule }) {
  const cap = rule.monthlyCapMinor;
  const spent = rule.spentMinor ?? 0;
  const pct = cap && cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const pace = cap && cap > 0 && rule.expectedSoFarMinor != null ? Math.min(100, (rule.expectedSoFarMinor / cap) * 100) : null;

  return (
    <div className={`rule is-${rule.state}`}>
      <div className="rule-top">
        <span className="rule-text">{rule.text}</span>
        <span
          className={`badge ${rule.state === "ok" ? "badge-good" : rule.state === "over" ? "badge-crit" : "badge-warn"}`}
        >
          <Icon name={rule.state === "ok" ? "ic-check" : "ic-alert-triangle"} />
          {rule.state === "ok" ? "On track" : rule.state === "over" ? "Over" : "Ahead of pace"}
        </span>
      </div>
      {cap != null && (
        <>
          <div
            className="limit-bar rule-bar"
            role="img"
            aria-label={`${formatMoney(spent)} spent of a ${formatMoney(cap)} cap`}
          >
            <span className={`fill${rule.state === "ok" ? "" : rule.state === "over" ? " is-over" : " is-warn"}`} style={{ width: `${pct}%` }} />
            {/* Where spending should be by today, if it were spread evenly. */}
            {pace !== null && <span className="pace-tick" style={{ left: `${pace}%` }} />}
          </div>
          <div className="rule-sub num">
            {formatMoneyShort(spent)} of {formatMoneyShort(cap)}
            {rule.category && <> · {rule.category}</>}
            {rule.expectedSoFarMinor != null && rule.state !== "over" && (
              <> · about {formatMoneyShort(rule.expectedSoFarMinor)} by now</>
            )}
          </div>
        </>
      )}
    </div>
  );
}
