import { Link } from "react-router-dom";
import { CardStatus } from "../types";
import { formatMoney } from "../lib/format";
import { Icon } from "./Icon";

/**
 * Where every credit card stands, as a bar each.
 *
 * Two different limits sit on one bar, and keeping them apart is the whole
 * point of it. The bar's length is spending against the *credit* limit,
 * which is the bank's answer to how far the card goes. The mark on it is
 * your own budget, which is the answer that actually changes what you do
 * at a till — being 30% through a credit limit tells you nothing, and
 * being 90% through what you meant to spend tells you to stop.
 *
 * So the colour follows the budget, not the credit limit: a card can be
 * comfortably inside what the bank allows and well past what you allowed.
 */

/** Where a budget stops being a number and starts being a warning. */
const CLOSE_FRACTION = 0.8;

export function CardLimits({ cards }: { cards: CardStatus[] }) {
  if (cards.length === 0) return null;

  const overBudget = cards.filter((card) => card.limitMinor !== null && card.spentMinor > card.limitMinor);
  const noBudget = cards.filter((card) => card.limitMinor === null);

  return (
    <div className="section-block">
      <h3>Where the cards stand</h3>
      <p className="section-sub">
        {overBudget.length > 0
          ? `${overBudget.length === 1 ? `${overBudget[0].name} is` : `${overBudget.length} cards are`} past what you meant to spend this month.`
          : "Spending this cycle against what the bank allows, with your own limit marked."}
      </p>

      <div className="card-limits">
        {cards.map((card) => (
          <CardBar key={card.accountId} card={card} />
        ))}
      </div>

      {noBudget.length > 0 && (
        <p className="field-hint">
          {noBudget.length === 1
            ? `${noBudget[0].name} has no monthly limit set, so nothing can warn you about it.`
            : `${noBudget.length} cards have no monthly limit set, so nothing can warn you about them.`}{" "}
          <Link to="/settings?tab=accounts">Set one</Link>.
        </p>
      )}
    </div>
  );
}

function CardBar({ card }: { card: CardStatus }) {
  const { spentMinor, creditLimitMinor, limitMinor } = card;

  // Against the credit limit where there is one, and against your own
  // budget where there is not. A bar needs something to be a fraction of,
  // and the budget is the more useful of the two to fall back on.
  const scaleMinor = creditLimitMinor ?? limitMinor;
  const usedFraction = scaleMinor && scaleMinor > 0 ? Math.min(1, spentMinor / scaleMinor) : null;
  const percent = scaleMinor && scaleMinor > 0 ? Math.round((spentMinor / scaleMinor) * 100) : null;

  const over = limitMinor !== null && spentMinor > limitMinor;
  const close = limitMinor !== null && !over && spentMinor >= limitMinor * CLOSE_FRACTION;
  const state = over ? "over" : close ? "close" : "ok";

  // Where your own budget falls along the bar. Only worth drawing when it
  // sits inside it — a budget above the credit limit is not a mark, it is
  // a mistake, and a line pinned to the far end would look like neither.
  const budgetAt =
    limitMinor !== null && scaleMinor && scaleMinor > 0 && limitMinor < scaleMinor
      ? (limitMinor / scaleMinor) * 100
      : null;

  return (
    <div className={`card-limit is-${state}`}>
      <div className="card-limit-head">
        <span className="card-limit-name">
          {card.name}
          {card.last4 && <span className="card-limit-last4">•••• {card.last4}</span>}
          {card.network && <span className="card-limit-network">{card.network}</span>}
        </span>
        <span className="card-limit-figures">
          <b className="num">{formatMoney(spentMinor)}</b>
          {scaleMinor ? (
            <>
              <span className="card-limit-of">of {formatMoney(scaleMinor)}</span>
              <span className="card-limit-percent num">{percent}%</span>
            </>
          ) : (
            <span className="card-limit-of">no limit set</span>
          )}
        </span>
      </div>

      <div
        className="card-limit-bar"
        role="img"
        aria-label={
          percent === null
            ? `${formatMoney(spentMinor)} spent, no limit set`
            : `${formatMoney(spentMinor)} of ${formatMoney(scaleMinor!)}, ${percent} percent`
        }
      >
        <div className="card-limit-fill" style={{ width: `${(usedFraction ?? 0) * 100}%` }} />
        {budgetAt !== null && (
          <span
            className="card-limit-mark"
            style={{ left: `${budgetAt}%` }}
            title={`Your limit: ${formatMoney(limitMinor!)}`}
          />
        )}
      </div>

      <div className="card-limit-foot">
        {limitMinor === null ? (
          <span className="card-limit-note">
            {card.periodIsCycle ? "This cycle" : "This month"} · no limit of your own
          </span>
        ) : over ? (
          <span className="card-limit-note is-warn">
            <Icon name="ic-alert" />
            {formatMoney(spentMinor - limitMinor)} over your {formatMoney(limitMinor)} limit
          </span>
        ) : (
          <span className="card-limit-note">
            {formatMoney(limitMinor - spentMinor)} left of your {formatMoney(limitMinor)} limit
            {close && " — worth slowing down"}
          </span>
        )}
      </div>
    </div>
  );
}
