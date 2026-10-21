import { Link } from "react-router-dom";
import { formatMoney, formatMoneyShort } from "../../lib/format";
import { BankFace, CardFace as CardFaceData, MoneyOnHand } from "../../types";
import { Icon } from "../Icon";
import { BankTile } from "./BankTile";
import { CardFace } from "./CardFace";
import "../../styles/wallet.css";

/**
 * Every card and account on Home, without going looking: the Wallet card.
 *
 * The headline is bank plus cash and nothing else: the savings account is
 * for emergencies, and a total that included it would make an ordinary
 * month look richer than it is. Cards come first, drawn as cards; the
 * accounts follow as tiles, the savings account last.
 *
 * Both fill the width: a wide screen gets more to a row, not bigger cards.
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
    <section className="card wallet" aria-labelledby="wallet-title">
      <div className="card-head wallet-head">
        <h2 id="wallet-title">Wallet</h2>
        <span className="badge badge-neutral">
          {cards.length} {cards.length === 1 ? "card" : "cards"} · {banks.length}{" "}
          {banks.length === 1 ? "account" : "accounts"}
        </span>
        <span className="spacer" />
        <Link className="btn-link" to="/settings?tab=accounts">
          All accounts
        </Link>
      </div>

      <div className="wallet-summary">
        <div className="kpi">
          <span className="kpi-label" id="wallet-onhand">
            Money on hand
          </span>
          <span className="wallet-onhand num">{money ? formatMoneyShort(money.onHandMinor) : "—"}</span>
          <span className="wallet-onhand-sub">
            {money ? (
              <>
                {formatMoneyShort(money.inBankMinor)} in the bank
                {money.cashMinor !== null && <> · {formatMoneyShort(money.cashMinor)} cash</>}
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
          </span>
        </div>

        {cards.length > 0 && (creditTotal > 0 || billsOwed > 0) && (
          <dl className="kpis wallet-totals">
            {creditTotal > 0 && (
              <div className="kpi">
                <dt className="kpi-label">Credit free</dt>
                <dd className="kpi-value num">
                  {formatMoneyShort(creditFree)} <small>of {formatMoneyShort(creditTotal)}</small>
                </dd>
              </div>
            )}
            {billsOwed > 0 && (
              <div className="kpi">
                <dt className="kpi-label">Card bills to pay</dt>
                <dd className="kpi-value num">{formatMoneyShort(billsOwed)}</dd>
              </div>
            )}
          </dl>
        )}
      </div>

      {cards.length > 0 && (
        <div className="wallet-cards" role="list" aria-label="Cards">
          {cards.map((card) => (
            <div role="listitem" key={card.accountId}>
              <CardFace card={card} />
            </div>
          ))}
        </div>
      )}

      <div className="wallet-banks" role="list" aria-label="Accounts">
        {banks.map((bank) => (
          <div role="listitem" key={bank.accountId}>
            <BankTile bank={bank} />
          </div>
        ))}
        {/* Always there, and the only tile when there is nothing yet. */}
        <Link className="btile-add" to="/settings?tab=accounts" role="listitem">
          <Icon name="ic-plus" /> Add an account or card
        </Link>
      </div>
    </section>
  );
}
