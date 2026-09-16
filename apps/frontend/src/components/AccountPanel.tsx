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
  DEBIT: "Debit card",
  BANK: "Bank account",
  UPI: "UPI",
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

  // A credit card, and only that. A debit card has no cycle, no limit, no
  // due date and no statement of its own - its spending is the account's,
  // and turns up on the account's statement - so every figure and control
  // below that assumes one would be an empty box on a debit card's page.
  const isCard = account.accountType === "CARD";
  const isDebit = account.accountType === "DEBIT";

  // Both of these arrived with a later version of the server than this
  // page may be talking to — a browser holds a cached bundle for a good
  // while, and a deployment restarts the two halves seconds apart. A
  // missing field threw here, and with nothing catching it React replaced
  // the whole app with a blank page. Neither is worth that.
  const month = account.month ?? { spentMinor: 0, limitMinor: null };
  const debitCards = account.debitCards ?? [];

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
            {isDebit && (
              <>
                {" · "}
                {account.linkedAccount
                  ? `draws on ${account.linkedAccount}`
                  : "not linked to an account"}
              </>
            )}
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
        {/* Only a credit card has a cycle. A savings account or a debit
            card with an empty progress bar on it would be a figure that
            means nothing. */}
        {/* A credit card's cycle where it has one; otherwise the month,
            which every account has. The two are different periods and the
            label says which, because a figure whose period is a guess is
            not a figure. */}
        {isCard && cycle ? (
          <Meter
            spentMinor={cycle.spentMinor}
            capMinor={account.spendLimitMinor ?? cycle.limitMinor}
            capIsMine={account.spendLimitMinor != null}
            bankLimitMinor={account.creditLimitMinor}
          />
        ) : month.limitMinor !== null ? (
          <Meter
            label="This month"
            spentMinor={month.spentMinor}
            capMinor={month.limitMinor}
            capIsMine
            bankLimitMinor={null}
          />
        ) : (
          <div className="figure-card">
            <span className="figure-label">This month</span>
            <span className="figure-value">{formatMoney(month.spentMinor)}</span>
            <span className="figure-note">{standingNote(account, isCard, isDebit)}</span>
          </div>
        )}

        {!isDebit && (
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
        )}

        {/* A bank account lists the cards that reach it, because its own
            spending includes theirs and a total does not say so. */}
        {debitCards.length > 0 && (
          <div className="figure-card">
            <span className="figure-label">Debit cards on it</span>
            <dl className="figure-rows">
              {debitCards.map((card) => (
                <div key={card.id}>
                  <dt>{card.name}</dt>
                  <dd>{card.last4 ? `••${card.last4}` : "—"}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {!isDebit && (
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
        )}
      </div>

      {(isCard || isDebit) && (
        <CardVaultPanel
          accountId={account.id}
          last4={account.last4}
          hasDetails={account.hasCardDetails}
          onChanged={onChanged}
        />
      )}

      {/* A debit card emails no statement, so there is no password for
          one. The account it draws on has both. */}
      {!isDebit && (
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
      )}
    </div>
  );
}

/** What this account is, for anything that has no cycle to show instead. */
function standingNote(account: AccountOverview, isCard: boolean, isDebit: boolean): string {
  if (isDebit && account.linkedAccount) {
    return `Spends ${account.linkedAccount} money, and is counted there too`;
  }

  return isCard
    ? "Set a limit and a statement day to track a cycle"
    : "Set a monthly limit to be warned as you approach it";
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
  label = "This cycle",
  spentMinor,
  capMinor,
  capIsMine,
  bankLimitMinor,
}: {
  label?: string;
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
      <span className="figure-label">{label}</span>
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
