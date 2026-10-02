import { useState } from "react";
import { Link } from "react-router-dom";
import { formatMoney } from "../../lib/format";
import { CardStatus, MoneyOnHand } from "../../types";
import { Icon } from "../Icon";

/**
 * What there is to spend, account by account, across the top of Home.
 *
 * The headline is bank plus cash and nothing else: the savings account is
 * for emergencies, and a total that included it would make an ordinary
 * month look richer than it is. That account still appears, last and
 * muted, with its figure behind a tap, so it is there when needed and not
 * staring back every time the app opens.
 */
export function MoneyCarousel({ money, cards }: { money: MoneyOnHand | undefined; cards: CardStatus[] }) {
  const [showSavings, setShowSavings] = useState(false);

  const everyday = money?.accounts.filter((account) => !account.isSavings) ?? [];
  const savings = money?.accounts.find((account) => account.isSavings) ?? null;
  const untracked = money?.untracked ?? 0;

  return (
    <section className="money" aria-labelledby="money-title">
      <div className="money-head">
        <div>
          <h2 className="money-label" id="money-title">
            Money on hand
          </h2>
          <div className="money-figure">{money ? formatMoney(money.onHandMinor) : "—"}</div>
          <p className="money-sub">
            {money ? (
              <>
                {formatMoney(money.inBankMinor)} in the bank
                {money.cashMinor !== null && <> · {formatMoney(money.cashMinor)} cash</>}
                {savings && " · savings left out"}
                {untracked > 0 && (
                  <>
                    {" · "}
                    {untracked === 1 ? "1 account has" : `${untracked} accounts have`} no starting balance yet
                  </>
                )}
              </>
            ) : (
              "Balances arrive with a newer server."
            )}
          </p>
        </div>
      </div>

      {/* One row that scrolls sideways and snaps to each card, so a dozen
          accounts cost one line of the page rather than a dozen. */}
      {/* Focusable so the row can be scrolled from the keyboard. */}
      <div className="money-row" role="list" aria-label="Accounts and cards" tabIndex={0}>
        {everyday.map((account) => (
          <div className="money-card" role="listitem" key={account.id}>
            <div className="money-card-top">
              <Icon name={account.accountType === "CASH" ? "ic-wallet" : "ic-bank"} />
              <span className="money-card-name">{account.name}</span>
              {account.last4 && <span className="money-card-last4">••{account.last4}</span>}
            </div>
            {account.balanceMinor === null ? (
              <Link className="money-card-set" to={`/settings?tab=accounts&account=${account.id}`}>
                Set balance <Icon name="ic-arrow-right" />
              </Link>
            ) : (
              <div className={`money-card-figure${account.balanceMinor < 0 ? " is-negative" : ""}`}>
                {formatMoney(account.balanceMinor)}
              </div>
            )}
            <div className="money-card-sub">{account.accountType === "CASH" ? "Cash in hand" : "Bank balance"}</div>
          </div>
        ))}

        {cards.map((card) => {
          const limit = card.creditLimitMinor ?? null;
          const available = card.availableMinor ?? null;
          const used = limit && available !== null ? Math.min(1, Math.max(0, (limit - available) / limit)) : null;
          return (
            <div className={`money-card is-credit is-${card.state}`} role="listitem" key={card.accountId}>
              <div className="money-card-top">
                <Icon name="ic-wallet" />
                <span className="money-card-name">{card.name}</span>
                {card.last4 && <span className="money-card-last4">••{card.last4}</span>}
              </div>
              {limit && available !== null ? (
                <>
                  <div className="money-card-figure">{formatMoney(available)}</div>
                  <div className="money-card-sub">available of {formatMoney(limit)}</div>
                  <div
                    className="money-meter"
                    role="img"
                    aria-label={`${Math.round((used ?? 0) * 100)}% of the credit limit in use`}
                  >
                    <div className="money-meter-fill" style={{ width: `${Math.round((used ?? 0) * 100)}%` }} />
                  </div>
                </>
              ) : (
                <>
                  <div className="money-card-figure">{formatMoney(card.spentMinor)}</div>
                  <div className="money-card-sub">
                    spent this cycle · <Link to={`/settings?tab=accounts&account=${card.accountId}`}>add limit</Link>
                  </div>
                </>
              )}
            </div>
          );
        })}

        {savings && (
          <div className="money-card is-savings" role="listitem">
            <div className="money-card-top">
              <Icon name="ic-lock" />
              <span className="money-card-name">{savings.name}</span>
              {savings.last4 && <span className="money-card-last4">••{savings.last4}</span>}
            </div>
            {savings.balanceMinor === null ? (
              <Link className="money-card-set" to={`/settings?tab=accounts&account=${savings.id}`}>
                Set balance <Icon name="ic-arrow-right" />
              </Link>
            ) : (
              <button
                type="button"
                className="money-reveal"
                aria-pressed={showSavings}
                onClick={() => setShowSavings((shown) => !shown)}
              >
                {showSavings ? formatMoney(savings.balanceMinor) : "Tap to show"}
              </button>
            )}
            <div className="money-card-sub">Savings · not counted</div>
          </div>
        )}

        {everyday.length === 0 && cards.length === 0 && !savings && (
          <div className="money-card is-empty" role="listitem">
            <div className="money-card-sub">
              No accounts yet. <Link to="/settings?tab=accounts">Add one</Link>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
