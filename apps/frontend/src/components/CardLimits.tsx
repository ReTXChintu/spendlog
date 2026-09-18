import { Link } from "react-router-dom";
import { CardStatus } from "../types";
import { formatMoney, formatShortDate } from "../lib/format";
import { Icon } from "./Icon";

/**
 * Where every credit card stands.
 *
 * Two questions, and they are genuinely different: how much of the card is
 * left, and how much of what you meant to spend is left. They used to
 * share one bar, the second as a mark on the first, and the second is the
 * one that changes what you do at a till — being 30% through a credit
 * limit tells you nothing, being 90% through your own budget tells you to
 * stop. As a mark it read as a footnote. So: a bar each.
 *
 * The bank's bar has two pieces, because a credit limit is not spent only
 * by spending. Last month's bill is still holding part of it until it is
 * paid, and a card that showed the whole limit as free on the morning the
 * bill arrives was wrong by the size of the bill.
 *
 * The colour follows the budget throughout: a card can sit comfortably
 * inside what the bank allows and well past what you allowed.
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
          : "What is left on each card, and what is left of your own limit for this cycle."}
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
  // Undefined rather than null where the server predates the field, so a
  // page talking to an older one degrades to the old picture rather than
  // drawing a bar as a fraction of nothing.
  const { spentMinor, limitMinor } = card;
  const creditLimitMinor = card.creditLimitMinor ?? null;
  const outstandingMinor = card.outstandingMinor ?? 0;
  const availableMinor = card.availableMinor ?? null;

  const over = limitMinor !== null && spentMinor > limitMinor;
  const close = limitMinor !== null && !over && spentMinor >= limitMinor * CLOSE_FRACTION;
  const state = over ? "over" : close ? "close" : "ok";

  // The bank's bar, in two pieces: what last month's bill is still
  // holding, then what this cycle has added on top of it. Clamped as a
  // pair so a card that is over its credit limit fills the bar rather
  // than overflowing it.
  const scale = creditLimitMinor && creditLimitMinor > 0 ? creditLimitMinor : null;
  const billPct = scale ? Math.min(100, (outstandingMinor / scale) * 100) : 0;
  const spendPct = scale ? Math.min(100 - billPct, (spentMinor / scale) * 100) : 0;

  const budgetPct = limitMinor && limitMinor > 0 ? Math.min(100, (spentMinor / limitMinor) * 100) : 0;

  return (
    <div className={`card-limit is-${state}`}>
      <div className="card-limit-head">
        <span className="card-limit-name">
          {card.name}
          {card.last4 && <span className="card-limit-last4">•••• {card.last4}</span>}
          {card.network && <span className="card-limit-network">{card.network}</span>}
        </span>
        <span className="card-limit-figures">
          {availableMinor !== null && scale ? (
            <>
              <b className="num">{formatMoney(availableMinor)}</b>
              <span className="card-limit-of">left of {formatMoney(scale)}</span>
            </>
          ) : (
            <>
              <b className="num">{formatMoney(spentMinor)}</b>
              <span className="card-limit-of">this cycle</span>
            </>
          )}
        </span>
      </div>

      {/* What the bank allows. The unpaid bill is part of the answer and
          used not to be on the bar at all — a card showing its whole limit
          as free on the morning the bill lands is wrong by the size of the
          bill, which is the largest it is ever wrong by. */}
      {scale && (
        <>
          <div
            className="card-limit-bar"
            role="img"
            aria-label={
              `${formatMoney(outstandingMinor)} still owed, ${formatMoney(spentMinor)} spent this ` +
              `cycle, ${formatMoney(availableMinor ?? 0)} left of ${formatMoney(scale)}`
            }
          >
            <div className="card-limit-fill is-bill" style={{ width: `${billPct}%` }} />
            <div className="card-limit-fill is-spend" style={{ width: `${spendPct}%` }} />
          </div>

          <div className="card-limit-legend">
            {outstandingMinor > 0 && (
              <span className="card-limit-key">
                <i className="card-limit-dot is-bill" />
                {card.outstandingIsEstimate ? "about " : ""}
                {formatMoney(outstandingMinor)} bill pending
                {card.billDueOn && `, due ${formatShortDate(card.billDueOn)}`}
              </span>
            )}
            <span className="card-limit-key">
              <i className="card-limit-dot is-spend" />
              {formatMoney(spentMinor)} this cycle
            </span>
            {(card.sharesLimitWith?.length ?? 0) > 0 && (
              <span className="card-limit-key">
                <Icon name="ic-link" />
                limit shared with {card.sharesLimitWith!.join(", ")}
                {card.groupUsedMinor != null && ` · ${formatMoney(card.groupUsedMinor)} used between them`}
              </span>
            )}
          </div>
        </>
      )}

      {/* And what you allow yourself, which is the one that changes what
          you do at a till. Its own bar, because it is a different question
          with a different answer and sharing one made it a footnote. */}
      <div className="card-limit-foot">
        {limitMinor === null ? (
          <span className="card-limit-note">
            {card.periodIsCycle === false ? "This month" : "This cycle"} · no limit of your own
          </span>
        ) : (
          <>
            <div className="card-limit-bar is-budget" role="presentation">
              <div className="card-limit-fill is-spend" style={{ width: `${budgetPct}%` }} />
            </div>
            {over ? (
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
          </>
        )}

        {/* When the counter goes back to zero: the statement day, which
            opens a cycle rather than closing one. */}
        {card.periodIsCycle !== false && card.statementOn && (
          <span className="card-limit-reset">resets {formatShortDate(card.statementOn)}</span>
        )}
      </div>
    </div>
  );
}
