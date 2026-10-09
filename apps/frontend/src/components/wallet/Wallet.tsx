import { Link } from "react-router-dom";
import { formatMoney, formatMoneyShort } from "../../lib/format";
import { BankFace, CardFace as CardFaceData, MoneyOnHand } from "../../types";
import { Icon } from "../Icon";
import { BankTile } from "./BankTile";
import { CardFace } from "./CardFace";
import "../../styles/wallet.css";

/**
 * Every card and account, at the top of Home, without going looking.
 *
 * The headline is bank plus cash and nothing else: the savings account is
 * for emergencies, and a total that included it would make an ordinary
 * month look richer than it is. Cards come first, drawn as cards; the
 * accounts follow as tiles, the savings account last.
 *
 * Both are grids that fill the width, a card never stretched past the size
 * it reads well at: a wide screen gets more to a row, not bigger cards.
 */
export function Wallet({
  money,
  cards,
  banks,
}: {
  money: MoneyOnHand | undefined;
  cards: CardFaceData[];
  banks: BankFace[];
}) {
  const savings = banks.some((bank) => bank.isSavings);
  const untracked = money?.untracked ?? 0;

  const limited = cards.filter((card) => card.creditLimitMinor !== null && card.availableMinor !== null);
  // A shared limit is one limit: counted once, from the first card on it.
  const counted = limited.filter(
    (card, index) =>
      card.sharesLimitWith.length === 0 ||
      !limited.slice(0, index).some((other) => card.sharesLimitWith.includes(other.name))
  );
  const creditFree = counted.reduce((sum, card) => sum + (card.availableMinor ?? 0), 0);
  const creditTotal = counted.reduce((sum, card) => sum + (card.creditLimitMinor ?? 0), 0);
  const billsOwed = cards.reduce(
    (sum, card) => sum + (card.lastStatement && card.lastStatement.isPaid === false ? (card.lastStatement.owedMinor ?? 0) : 0),
    0
  );

  return (
    <section className="wallet" aria-labelledby="wallet-title">
      <div className="wallet-head">
        <div>
          <h2 className="money-label" id="wallet-title">
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

        {cards.length > 0 && (
          <dl className="wallet-totals">
            {creditTotal > 0 && (
              <div>
                <dt>Credit free</dt>
                <dd className="num">
                  {formatMoneyShort(creditFree)} <small>of {formatMoneyShort(creditTotal)}</small>
                </dd>
              </div>
            )}
            {billsOwed > 0 && (
              <div>
                <dt>Card bills to pay</dt>
                <dd className="num">{formatMoneyShort(billsOwed)}</dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {cards.length > 0 && (
        <>
          <h3 className="wallet-label">
            Cards <span>{cards.length}</span>
          </h3>
          <div className="wallet-cards" role="list">
            {cards.map((card) => (
              <div role="listitem" key={card.accountId}>
                <CardFace card={card} />
              </div>
            ))}
          </div>
        </>
      )}

      <h3 className="wallet-label">
        Accounts <span>{banks.length}</span>
      </h3>
      <div className="wallet-banks" role="list">
        {banks.map((bank) => (
          <div role="listitem" key={bank.accountId}>
            <BankTile bank={bank} />
          </div>
        ))}
        {/* Always there, and the only tile when there is nothing yet. */}
        <Link className="btile btile-add" to="/settings?tab=accounts" role="listitem">
          <Icon name="ic-plus" /> Add an account or card
        </Link>
      </div>
    </section>
  );
}
