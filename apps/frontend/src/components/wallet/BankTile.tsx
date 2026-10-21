import { useState } from "react";
import { Link } from "react-router-dom";
import { formatMoney, formatMoneyShort, formatShortDate } from "../../lib/format";
import { BankFace, NETWORK_LABELS } from "../../types";
import { Icon } from "../Icon";
import { possessive } from "../PocketMoneyPanel";
import { monogram } from "./look";

/**
 * A bank account or cash, as a tile beside the cards (design-system.md
 * §7.5, inner tile).
 *
 * Deliberately not a card: an account is a balance, not a thing you hand
 * over at a till, and drawing it as one would make the wallet harder to
 * read at a glance. A monogram, the balance, and what is known about it.
 *
 * The savings account is the emergency fund. Its balance stays behind the
 * eye, as it always has, so an ordinary month never looks richer than it
 * is just because the app was opened.
 */
export function BankTile({ bank }: { bank: BankFace }) {
  const [showSavings, setShowSavings] = useState(false);
  const cash = bank.accountType === "CASH";
  const pocket = bank.pocket;

  const kind = cash ? "Cash in hand" : bank.isSavings ? "Savings · not counted" : "Bank balance";
  const sub = [cash ? null : bank.name !== bank.bankName ? bank.bankName : null, bank.last4 ? `••${bank.last4}` : null]
    .filter(Boolean)
    .join(" · ");

  const used = pocket ? Math.min(100, Math.round((pocket.spentMinor / Math.max(1, pocket.limitMinor)) * 100)) : 0;
  const pocketState = pocket ? (pocket.leftMinor < 0 ? "over" : used >= 80 ? "close" : "ok") : null;

  return (
    <article
      className={`btile${bank.isSavings ? " is-savings" : ""}${cash ? " is-cash" : ""}${
        bank.balanceMinor === null ? " is-unset" : ""
      }`}
    >
      <Link
        className="btile-hit"
        to={`/transactions?account=${bank.accountId}`}
        aria-label={`${bank.name}: this month's transactions`}
      />

      <div className="btile-top">
        <span className="monogram btile-mark" aria-hidden="true">
          {cash ? <Icon name="ic-banknote" /> : bank.isSavings ? <Icon name="ic-piggy-bank" /> : monogram(bank.bankName)}
        </span>
        <div className="btile-who">
          <span className="btile-name">{bank.name}</span>
          {sub && <span className="btile-sub">{sub}</span>}
        </div>
      </div>

      <div className="btile-balance-row">
        {bank.balanceMinor === null ? (
          <Link className="btile-set" to={`/settings?tab=accounts&account=${bank.accountId}`}>
            Set balance <Icon name="ic-chevron-right" />
          </Link>
        ) : bank.isSavings ? (
          <span className="btile-masked">
            <span className="btile-balance num">{showSavings ? formatMoney(bank.balanceMinor) : "₹ ••••••"}</span>
            <button
              type="button"
              className="btile-reveal"
              aria-pressed={showSavings}
              aria-label={showSavings ? "Hide savings balance" : "Show savings balance"}
              onClick={() => setShowSavings((shown) => !shown)}
            >
              <Icon name={showSavings ? "ic-eye-off" : "ic-eye"} />
            </button>
          </span>
        ) : (
          <span className="btile-balance num">{formatMoney(bank.balanceMinor)}</span>
        )}
      </div>

      <div className="btile-badges">
        <span className="btile-kind">{kind}</span>
        {pocket && <span className="badge badge-warn">{possessive(pocket.holder)} pocket money</span>}
      </div>

      {pocket && (
        <div className={`btile-pocket is-${pocketState}`}>
          <div className="meter" role="img" aria-label={`${used}% of the pocket money used`}>
            <div
              className={`meter-fill ${pocketState === "over" ? "is-crit" : pocketState === "close" ? "is-warn" : "is-ink"}`}
              style={{ width: `${used}%` }}
            />
          </div>
          <div className="btile-pocket-text num">
            <span>
              {pocket.leftMinor < 0
                ? `${formatMoneyShort(-pocket.leftMinor)} over`
                : `${formatMoneyShort(pocket.leftMinor)} left`}{" "}
              of {formatMoneyShort(pocket.limitMinor)}
            </span>
            <span>{pocket.renewsToday ? "renews today" : `renews ${formatShortDate(pocket.renewsOn)}`}</span>
          </div>
        </div>
      )}

      {bank.debitCards.length > 0 && (
        <div className="btile-debits" aria-label="Debit cards">
          {bank.debitCards.map((debit) => (
            <span className="btile-debit" key={debit.accountId}>
              <Icon name="ic-credit-card" />
              {debit.network ? NETWORK_LABELS[debit.network] : "Debit"} ••{debit.last4 ?? "••••"}
              {debit.hasCardDetails && <Icon name="ic-lock" />}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
