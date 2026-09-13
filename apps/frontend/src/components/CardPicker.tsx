import { Link } from "react-router-dom";
import { formatMoney } from "../lib/format";
import { CardPicks, CardStatus, NETWORK_LABELS } from "../types";
import { Icon } from "./Icon";

/**
 * Which card to reach for, one answer per network.
 *
 * The question at a till is not "which card" but "which card that this
 * place takes", and in India that is mostly a question about networks — a
 * RuPay credit card pays over UPI and a Visa one does not. So a single
 * best card was always the wrong shape of answer.
 */
export function CardPicker({ picks }: { picks: CardPicks }) {
  const hasNetworks = picks.byNetwork.length > 0;

  if (!picks.best && !hasNetworks) {
    return (
      <div className="pick-empty">
        No card has a statement day set, so there is nothing to work out yet.{" "}
        <Link to="/settings?tab=accounts">Add one on the card</Link> and this fills in.
      </div>
    );
  }

  return (
    <div className="pick-block">
      {hasNetworks ? (
        <div className="pick-grid">
          {picks.byNetwork.map(({ network, card }) => (
            <PickTile
              key={network}
              label={NETWORK_LABELS[network]}
              card={card}
              isBest={card.accountId === picks.best?.accountId}
            />
          ))}
        </div>
      ) : (
        picks.best && <PickTile label="Best today" card={picks.best} isBest />
      )}

      {picks.unknownNetwork.length > 0 && (
        <p className="pick-note">
          {picks.unknownNetwork.length === 1
            ? `${picks.unknownNetwork[0].name} has no network set, so it is missing from the list above.`
            : `${picks.unknownNetwork.length} cards have no network set, so they are missing above.`}{" "}
          <Link to="/settings?tab=accounts">Set it</Link>.
        </p>
      )}
    </div>
  );
}

function PickTile({ label, card, isBest }: { label: string; card: CardStatus; isBest: boolean }) {
  return (
    <div className={`pick-tile${isBest ? " is-best" : ""}`}>
      <div className="pick-network">
        {label}
        {isBest && <span className="pick-flag">Best overall</span>}
      </div>
      <div className="pick-name">{card.name}</div>
      <div className="pick-float num">
        {card.floatDays} <span>days to pay</span>
      </div>
      {card.state === "close" && card.remainingMinor !== null && (
        <div className="pick-warn">
          <Icon name="ic-alert" />
          {formatMoney(card.remainingMinor)} left of its limit
        </div>
      )}
    </div>
  );
}
