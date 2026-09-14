import { useState } from "react";
import { AccountOverview } from "../types";
import { api, ApiError } from "../lib/api";
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
  onDeleted,
}: {
  account: AccountOverview;
  onEdit: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const cycle = account.cycle;
  const isCard = account.accountType === "CARD";

  /// Null until Remove is pressed, then the number of transactions that
  /// would be left without an account. Deleting one is refused while
  /// history points at it, and that refusal is the useful half - it says
  /// how much history there is before anything happens to it.
  const [removing, setRemoving] = useState<{ inUse: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(unassign: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/accounts/${account.id}${unassign ? "?unassign=true" : ""}`);
      onDeleted();
    } catch (err) {
      // The server refuses while transactions use it and says how many.
      // That is the question worth asking, not an error to report.
      if (err instanceof ApiError && err.status === 409) {
        const inUse = Number(/^(\d+)/.exec(err.message)?.[1] ?? 0);
        setRemoving({ inUse });
      } else {
        setError(err instanceof Error ? err.message : "That didn't work.");
        setRemoving(null);
      }
    } finally {
      setBusy(false);
    }
  }

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
        <div className="account-panel-actions">
          <button className="btn btn-sm btn-ghost" onClick={onEdit}>
            <Icon name="ic-pencil" /> Edit
          </button>
          {/* Cash is a fixture rather than something that was added -
              every account needs somewhere to put a payment that came out
              of a pocket - so it is closed rather than deleted. */}
          {account.accountType !== "CASH" && (
            <button
              className="btn btn-sm btn-ghost btn-danger-text"
              disabled={busy}
              onClick={() => (removing ? setRemoving(null) : remove(false))}
            >
              <Icon name="ic-x" /> Remove
            </button>
          )}
        </div>
      </header>

      {removing && (
        <div className="account-remove">
          <p className="desc">
            {removing.inUse > 0 ? (
              <>
                <b>{removing.inUse}</b>{" "}
                {removing.inUse === 1 ? "transaction is" : "transactions are"} filed under{" "}
                {account.nickname || account.bankName}. Removing it keeps them and leaves them
                without an account — or merge it into another account instead, from Edit, to move
                them across.
              </>
            ) : (
              <>Nothing is filed under this account, so removing it loses nothing.</>
            )}
          </p>
          <div className="set-card-actions">
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove(true)}>
              {busy ? "Removing…" : removing.inUse > 0 ? "Remove it anyway" : "Remove it"}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setRemoving(null)}>
              Keep it
            </button>
          </div>
        </div>
      )}

      {error && <p className="desc set-warn">{error}</p>}

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
