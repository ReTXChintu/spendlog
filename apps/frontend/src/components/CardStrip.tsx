import { formatMoney } from "../lib/format";
import { BudgetPace, CardStatus } from "../types";
import { Icon } from "./Icon";

/**
 * Anything that needs saying before the next payment rather than after it.
 *
 * Only warnings. Which card to reach for is a decision, so it lives on the
 * dashboard with the other decisions — two screens answering the same
 * question in different words is worse than either answer.
 *
 * Deliberately quiet when there is nothing wrong. A warning that is always
 * on screen stops being read, and then so does the real one.
 *
 * A card is warned about by its credit limit, on its own cycle: 70% or
 * more of it used is close, 90% or more is over.
 */

/** What a warning about a card's credit says, after its name. */
export function creditWarning(card: CardStatus): string {
  const left = card.availableMinor;
  if (left === null) return "is close to its credit limit";
  if (left <= 0) return "is at its credit limit";
  return card.state === "over"
    ? `is nearly out of credit — ${formatMoney(left)} left`
    : `has ${formatMoney(left)} of its credit limit left`;
}
export function CardStrip({ cards, pace }: { cards: CardStatus[]; pace: BudgetPace | null }) {
  const warnings = cards.filter((card) => card.state === "over" || card.state === "close");
  const paceWarning = pace?.configured && pace.state !== "ok" ? pace : null;

  if (warnings.length === 0 && !paceWarning) return null;

  return (
    <div className="card-strip">
      {warnings.map((card) => (
        <div className={`card-strip-row is-${card.state}`} key={card.accountId}>
          <Icon name="ic-alert" />
          <span>
            <b>{card.name}</b>{" "}
            {creditWarning(card)}
            {card.statementOn && ` · bills ${new Date(card.statementOn).getDate()}${ordinal(
              new Date(card.statementOn).getDate()
            )}`}
          </span>
        </div>
      ))}

      {paceWarning && (
        <div className={`card-strip-row is-${paceWarning.state === "over" ? "over" : "close"}`}>
          <Icon name="ic-trend" />
          <span>
            {paceWarning.state === "over" ? (
              <>
                Past this period's salary by <b>{formatMoney(-paceWarning.remainingMinor)}</b>
              </>
            ) : (
              <>
                <b>{formatMoney(paceWarning.perDayMinor)}</b> a day left over{" "}
                {paceWarning.daysLeft} days — lately it has been{" "}
                {formatMoney(paceWarning.recentPerDayMinor)}
              </>
            )}
          </span>
        </div>
      )}

    </div>
  );
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
}
