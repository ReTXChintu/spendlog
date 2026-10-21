import { Link } from "react-router-dom";
import { formatMoneyShort, formatShortDate } from "../../lib/format";
import { EarmarkSummary } from "../../types";

/**
 * Money that came in for something still to be bought — "Dad sent 8k for
 * next week". It sits in the bank looking spendable, so it gets its own
 * card saying how much of the balance is already spoken for.
 */
export function EarmarksCard({ earmarks }: { earmarks: EarmarkSummary }) {
  return (
    <section className="card earmarks" aria-labelledby="earmarks-title">
      <div className="card-head">
        <h2 id="earmarks-title">Earmarked</h2>
      </div>
      <div className="earmark-figure num">{formatMoneyShort(earmarks.totalMinor)}</div>
      <p className="home-meta">
        Across {earmarks.count === 1 ? "one amount" : `${earmarks.count} amounts`} received for something you haven't
        bought yet. Not counted as income, and already inside your bank balance.
      </p>
      <ul className="earmark-list">
        {earmarks.items.map((item) => (
          <li key={item.id}>
            <Link className="earmark-row" to="/transactions">
              <span className="earmark-main">
                <span className="earmark-who">{item.merchant || item.note || "Money in"}</span>
                <span className="earmark-when num">
                  {formatShortDate(item.occurredAt)}
                  {item.spentMinor > 0 && <> · {formatMoneyShort(item.spentMinor)} used</>}
                </span>
              </span>
              <span className="earmark-left num">{formatMoneyShort(item.leftMinor)} left</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
