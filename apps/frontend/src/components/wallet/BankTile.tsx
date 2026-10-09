import { CSSProperties, useState } from "react";
import { Link } from "react-router-dom";
import { formatMoney, formatMoneyShort, formatShortDate } from "../../lib/format";
import { BankFace, NETWORK_LABELS } from "../../types";
import { Icon } from "../Icon";
import { possessive } from "../PocketMoneyPanel";
import { lookFor, monogram } from "./look";

/**
 * A bank account or cash, as a tile beside the cards.
 *
 * Deliberately not a card: an account is a balance, not a thing you hand
 * over at a till, and drawing it as one would make the wallet harder to
 * read at a glance. Its colour is a stripe and a monogram instead.
 *
 * The savings account is the emergency fund. Its balance stays behind a
 * tap, as it always has, so an ordinary month never looks richer than it
 * is just because the app was opened.
 */
export function BankTile({ bank }: { bank: BankFace }) {
  const [showSavings, setShowSavings] = useState(false);
  const look = lookFor(bank);
  const cash = bank.accountType === "CASH";
  const style = { "--btile-accent": look.base } as CSSProperties;
  const pocket = bank.pocket;

  const kind = cash ? "Cash in hand" : bank.isSavings ? "Savings · not counted" : "Bank balance";
  const sub = [cash ? null : bank.name !== bank.bankName ? bank.bankName : null, bank.last4 ? `••${bank.last4}` : null]
    .filter(Boolean)
    .join(" · ");

  const used = pocket ? Math.min(100, Math.round((pocket.spentMinor / Math.max(1, pocket.limitMinor)) * 100)) : 0;
  const pocketState = pocket ? (pocket.leftMinor < 0 ? "over" : used >= 80 ? "close" : "ok") : null;

  return (
    <article className={`btile${bank.isSavings ? " is-savings" : ""}${cash ? " is-cash" : ""}`} style={style}>
      <Link
        className="wcard-hit"
        to={`/transactions?account=${bank.accountId}`}
        aria-label={`${bank.name}: this month's transactions`}
      />

      <div className="btile-top">
        <span className="btile-mark" aria-hidden="true">
          {cash ? <Icon name="ic-wallet" /> : bank.isSavings ? <Icon name="ic-lock" /> : monogram(bank.bankName)}
        </span>
        <div className="btile-who">
          <span className="btile-name">{bank.name}</span>
          {sub && <span className="btile-sub">{sub}</span>}
        </div>
        {pocket && <span className="badge badge-pocket">{possessive(pocket.holder)} pocket money</span>}
      </div>

      <div className="btile-balance-row">
        {bank.balanceMinor === null ? (
          <Link className="btile-set" to={`/settings?tab=accounts&account=${bank.accountId}`}>
            Set balance <Icon name="ic-arrow-right" />
          </Link>
        ) : bank.isSavings ? (
          <button
            type="button"
            className="money-reveal btile-reveal"
            aria-pressed={showSavings}
            aria-label={showSavings ? "Hide savings balance" : "Show savings balance"}
            onClick={() => setShowSavings((shown) => !shown)}
          >
            {showSavings ? formatMoney(bank.balanceMinor) : "Tap to show"}
          </button>
        ) : (
          <span className={`btile-balance${bank.balanceMinor < 0 ? " is-negative" : ""}`}>
            {formatMoney(bank.balanceMinor)}
          </span>
        )}
        <span className="btile-kind">{kind}</span>
      </div>

      {pocket && (
        <div className={`btile-pocket is-${pocketState}`}>
          <div className="btile-pocket-text">
            <span>
              {pocket.leftMinor < 0
                ? `${formatMoneyShort(-pocket.leftMinor)} over`
                : `${formatMoneyShort(pocket.leftMinor)} left`}{" "}
              of {formatMoneyShort(pocket.limitMinor)}
            </span>
            <span>{pocket.renewsToday ? "renews today" : `renews ${formatShortDate(pocket.renewsOn)}`}</span>
          </div>
          <div className="meter" role="img" aria-label={`${used}% of the pocket money used`}>
            <div className="meter-fill" style={{ width: `${used}%` }} />
          </div>
        </div>
      )}

      {bank.debitCards.length > 0 && (
        <div className="btile-debits" aria-label="Debit cards">
          {bank.debitCards.map((debit) => (
            <span className="btile-debit" key={debit.accountId}>
              <span className="btile-debit-card" aria-hidden="true" />
              {debit.network ? NETWORK_LABELS[debit.network] : "Debit"} ••{debit.last4 ?? "••••"}
              {debit.hasCardDetails && <Icon name="ic-lock" />}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
