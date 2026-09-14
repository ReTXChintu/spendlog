import { AccountOverview } from "../types";
import { formatMoney } from "../lib/format";
import { CardVaultPanel } from "./CardVaultPanel";
import { Icon } from "./Icon";

/**
 * One account, everything about it.
 *
 * The figures here were already being computed for the dashboard — what
 * was missing was anywhere to see them per card, alongside the settings
 * that produce them. A limit is much easier to choose next to the number
 * it is being compared against.
 */

const TYPE_LABEL: Record<string, string> = {
  CARD: "Credit card",
  BANK: "Bank account",
  WALLET: "Wallet",
  CASH: "Cash",
};

export function AccountPanel({
  account,
  onEdit,
  onChanged,
}: {
  account: AccountOverview;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const cycle = account.cycle;
  const isCard = account.accountType === "CARD";

  return (
    <div className="account-panel">
      <header className="account-panel-head">
        <div>
          <h3>
            {account.nickname || account.bankName}
            {account.last4 && <span className="account-last4">•••• {account.last4}</span>}
          </h3>
          <p className="account-panel-sub">
            {TYPE_LABEL[account.accountType] ?? account.accountType}
            {account.cardNetwork && <> · {account.cardNetwork}</>}
            {!account.isActive && <> · closed</>}
          </p>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={onEdit}>
          <Icon name="ic-pencil" /> Edit
        </button>
      </header>

      <div className="account-figures">
        {/* Only a card has a cycle. A savings account with an empty
            progress bar on it would be a figure that means nothing. */}
        {isCard && cycle ? (
          <Meter
            spentMinor={cycle.spentMinor}
            capMinor={account.spendLimitMinor ?? cycle.limitMinor}
            capIsMine={account.spendLimitMinor != null}
            bankLimitMinor={account.creditLimitMinor}
          />
        ) : (
          <div className="figure-card">
            <span className="figure-label">This account</span>
            <span className="figure-value">{TYPE_LABEL[account.accountType]}</span>
            <span className="figure-note">
              {isCard ? "Set a statement day to see a cycle" : "No billing cycle to track"}
            </span>
          </div>
        )}

        <div className="figure-card">
          <span className="figure-label">Dates</span>
          <dl className="figure-rows">
            <div>
              <dt>Statement</dt>
              <dd>{account.statementDay ? ordinal(account.statementDay) : "—"}</dd>
            </div>
            <div>
              <dt>Payment due</dt>
              <dd>{account.dueDay ? ordinal(account.dueDay) : "—"}</dd>
            </div>
            {cycle?.floatDays != null && (
              <div>
                <dt>Float today</dt>
                <dd>{cycle.floatDays} days</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="figure-card">
          <span className="figure-label">Latest bill</span>
          {account.bill ? (
            <>
              <span className={`figure-value ${account.bill.isPaid ? "is-paid" : ""}`}>
                {formatMoney(account.bill.totalDueMinor)}
              </span>
              <span className="figure-note">
                {account.bill.isPaid
                  ? "Paid"
                  : account.bill.daysUntilDue == null
                    ? "Read from a statement"
                    : account.bill.daysUntilDue < 0
                      ? `${Math.abs(account.bill.daysUntilDue)} days overdue`
                      : `Due in ${account.bill.daysUntilDue} days`}
              </span>
            </>
          ) : (
            <>
              <span className="figure-value is-none">—</span>
              <span className="figure-note">No statement read yet</span>
            </>
          )}
        </div>
      </div>

      {isCard && (
        <CardVaultPanel
          accountId={account.id}
          last4={account.last4}
          hasDetails={account.hasCardDetails}
          onChanged={onChanged}
        />
      )}

      <div className="account-row">
        <span className="account-row-label">
          <Icon name="ic-receipt" /> Statement password
        </span>
        <span className="account-row-value">
          {account.hasStatementPassword ? (
            <span className="status-pill status-on">
              <Icon name="ic-check" /> Set
            </span>
          ) : (
            <span className="status-pill status-off">Not set</span>
          )}
        </span>
        <button className="btn btn-sm btn-ghost" onClick={onEdit}>
          {account.hasStatementPassword ? "Change" : "Add"}
        </button>
      </div>
    </div>
  );
}

/**
 * How much of this cycle is gone.
 *
 * The bar is drawn against whichever limit the person actually set for
 * themselves, falling back to the bank's. Those are different things: one
 * is what you allow, the other is what you are allowed, and showing 40% of
 * a credit limit when you are already past your own budget would be
 * reassuring and wrong.
 */
function Meter({
  spentMinor,
  capMinor,
  capIsMine,
  bankLimitMinor,
}: {
  spentMinor: number;
  capMinor: number | null;
  capIsMine: boolean;
  bankLimitMinor: number | null;
}) {
  const used = capMinor && capMinor > 0 ? Math.min(1, spentMinor / capMinor) : null;
  const over = capMinor != null && spentMinor > capMinor;
  const close = used != null && used >= 0.8 && !over;

  return (
    <div className={`figure-card is-meter ${over ? "is-over" : close ? "is-close" : ""}`}>
      <span className="figure-label">This cycle</span>
      <span className="figure-value">
        {formatMoney(spentMinor)}
        {capMinor != null && <span className="figure-of">of {formatMoney(capMinor)}</span>}
      </span>

      {used != null ? (
        <>
          <div className="meter" role="img" aria-label={`${Math.round(used * 100)}% used`}>
            <div className="meter-fill" style={{ width: `${Math.round(used * 100)}%` }} />
          </div>
          <span className="figure-note">
            {over
              ? `${formatMoney(spentMinor - capMinor!)} over your ${capIsMine ? "own cap" : "limit"}`
              : `${formatMoney(capMinor! - spentMinor)} left${capIsMine ? " on your cap" : ""}`}
            {capIsMine && bankLimitMinor ? ` · bank allows ${formatMoney(bankLimitMinor)}` : ""}
          </span>
        </>
      ) : (
        <span className="figure-note">Set a limit to see how much is left</span>
      )}
    </div>
  );
}

function ordinal(day: number): string {
  const suffix = day > 3 && day < 21 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}
