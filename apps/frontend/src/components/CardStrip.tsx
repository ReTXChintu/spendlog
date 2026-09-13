import { formatMoney, formatMoneyShort } from "../lib/format";
import { BudgetPace, CardStatus } from "../types";
import { Icon } from "./Icon";

/**
 * A single line above the ledger: which card to reach for today, and
 * anything that needs saying before the next payment rather than after it.
 *
 * Deliberately quiet when there is nothing wrong. A warning that is always
 * on screen stops being read, and then so does the real one.
 */
export function CardStrip({ cards, pace }: { cards: CardStatus[]; pace: BudgetPace | null }) {
  const warnings = cards.filter((card) => card.state === "over" || card.state === "close");
  const best = cards.find((card) => card.state !== "over" && card.floatDays !== null);
  const runnerUp = cards.find(
    (card) => card !== best && card.state !== "over" && card.floatDays !== null
  );

  const paceWarning = pace?.configured && pace.state !== "ok" ? pace : null;

  if (warnings.length === 0 && !best && !paceWarning) return null;

  return (
    <div className="card-strip">
      {warnings.map((card) => (
        <div className={`card-strip-row is-${card.state}`} key={card.accountId}>
          <Icon name="ic-alert" />
          <span>
            <b>{card.name}</b>{" "}
            {card.state === "over"
              ? `is past its ${formatMoneyShort(card.limitMinor ?? 0)} limit for this cycle`
              : `has ${formatMoney(card.remainingMinor ?? 0)} left of its limit this cycle`}
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

      {best?.floatDays != null && (
        <div className="card-strip-row is-tip">
          <Icon name="ic-wallet" />
          <span>
            Paying by card today? <b>{best.name}</b> gives {best.floatDays} days before it has to be
            paid
            {runnerUp?.floatDays != null && `, against ${runnerUp.floatDays} on ${runnerUp.name}`}.
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
