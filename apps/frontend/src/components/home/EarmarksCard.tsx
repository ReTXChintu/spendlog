import { Link } from "react-router-dom";
import { formatMoney, formatShortDate } from "../../lib/format";
import { EarmarkSummary } from "../../types";

/**
 * Money that came in for something still to be bought — "Dad sent 8k for
 * next week". It sits in the bank looking spendable, so it gets its own
 * card saying how much of the balance is already spoken for.
 */
export function EarmarksCard({ earmarks }: { earmarks: EarmarkSummary }) {
  return (
    <div className="home-card">
      <h3 className="home-card-title">Set aside for later</h3>
      <p className="section-sub">
        Received for something you haven't bought yet. Not counted as income, and already inside your bank
        balance.
      </p>
      <div className="home-figure">{formatMoney(earmarks.totalMinor)}</div>
      <div className="home-figure-sub">
        across {earmarks.count === 1 ? "one amount" : `${earmarks.count} amounts`}
      </div>
      <ul className="earmark-list">
        {earmarks.items.map((item) => (
          <li key={item.id}>
            <Link className="earmark-row" to="/transactions">
              <span className="earmark-main">
                <span className="earmark-who">{item.merchant || item.note || "Money in"}</span>
                <span className="earmark-when">
                  {formatShortDate(item.occurredAt)}
                  {item.spentMinor > 0 && <> · {formatMoney(item.spentMinor)} used</>}
                </span>
              </span>
              <span className="earmark-left num">{formatMoney(item.leftMinor)} left</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
