import { useState } from "react";
import { Link } from "react-router-dom";
import { AccountOverview } from "../types";
import { api, ApiError } from "../lib/api";
import { formatMoney } from "../lib/format";
import { BalancePanel } from "./BalancePanel";
import { CardVaultPanel } from "./CardVaultPanel";
import { Icon } from "./Icon";
import { PocketMoneyPanel } from "./PocketMoneyPanel";

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
  const month = account.month ?? { spentMinor: 0 };
  const debitCards = account.debitCards ?? [];

  /// Null until Remove is pressed, then the number of transactions that
  /// would be left without an account. Deleting one is refused while
  /// history points at it, and that refusal is the useful half - it says
  /// how much history there is before anything happens to it.
  const [removing, setRemoving] = useState<{ inUse: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);

  const [savingBusy, setSavingBusy] = useState(false);
  const [savingsError, setSavingsError] = useState<string | null>(null);

  // Marking one account as savings unmarks any other, on the server.
  async function toggleSavings(isSavings: boolean) {
    setSavingBusy(true);
    setSavingsError(null);
    try {
      await api.patch(`/accounts/${account.id}`, { isSavings });
      onChanged();
    } catch (err) {
      setSavingsError(err instanceof Error ? err.message : "That didn't save.");
    } finally {
      setSavingBusy(false);
    }
  }

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
          {/* Opens on this account's current statement cycle. */}
          <Link className="btn btn-sm btn-ghost" to={`/transactions?account=${account.id}`}>
            <Icon name="ic-receipt" /> Transactions
          </Link>
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
        {isCard && cycle?.cycleKnown ? (
          <Meter cycle={cycle} />
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

      {/* The emergency account: its money stays out of "money on hand" on
          Home, so an ordinary month never looks richer than it is. */}
      {account.accountType === "BANK" && (
        <label className="checkbox-row savings-toggle">
          <input
            type="checkbox"
            checked={account.isSavings ?? false}
            disabled={savingBusy}
            onChange={(e) => toggleSavings(e.target.checked)}
          />
          <span>
            This is my savings account (kept out of money on hand)
            {savingsError && <span className="set-warn"> {savingsError}</span>}
          </span>
        </label>
      )}

      {account.tracksBalance && <BalancePanel account={account} onChanged={onChanged} />}

      {/* Anything that holds money can be someone's allowance; a credit
          card is borrowing, not a purse to hand over. */}
      {!isCard && <PocketMoneyPanel account={account} onChanged={onChanged} />}

      {(isCard || isDebit || account.accountType === "BANK") && (
        <CardVaultPanel
          accountId={account.id}
          last4={account.last4}
          hasDetails={account.hasCardDetails}
          isBank={account.accountType === "BANK"}
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
        <button className="btn btn-sm btn-ghost" onClick={() => setPasswordOpen((open) => !open)}>
          {passwordOpen ? "Cancel" : account.hasStatementPassword ? "Change" : "Add"}
        </button>
      </div>
      )}
      {!isDebit && passwordOpen && (
        <StatementPasswordForm
          accountId={account.id}
          hasPassword={Boolean(account.hasStatementPassword)}
          onDone={() => {
            setPasswordOpen(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/**
 * The statement password, set right where it is shown rather than inside
 * the whole edit form - it is the one setting people come here to change.
 */
function StatementPasswordForm({
  accountId,
  hasPassword,
  onDone,
}: {
  accountId: string;
  hasPassword: boolean;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(value: string) {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/statements/password/${accountId}`, { password: value });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
      setBusy(false);
    }
  }

  return (
    <form
      className="statement-password-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (password.trim()) save(password.trim());
      }}
    >
      <input
        autoFocus
        className="filter-input"
        type="password"
        autoComplete="off"
        placeholder={hasPassword ? "Type the new password" : "The password that opens this account's statement PDF"}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-label="Statement password"
      />
      <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !password.trim()}>
        {busy ? "Saving…" : "Save"}
      </button>
      {hasPassword && (
        <button className="btn btn-sm btn-ghost btn-danger-text" type="button" disabled={busy} onClick={() => save("")}>
          Remove
        </button>
      )}
      <p className="field-hint">
        Usually built from your date of birth and name — the statement email says the format. It's stored
        encrypted and never shown again.
      </p>
      {error && <p className="form-error">{error}</p>}
    </form>
  );
}

/** What this account is, for anything that has no cycle to show instead. */
function standingNote(account: AccountOverview, isCard: boolean, isDebit: boolean): string {
  if (isDebit && account.linkedAccount) {
    return `Spends ${account.linkedAccount} money, and is counted there too`;
  }

  return isCard
    ? "Set a statement day to track this card's own cycle"
    : "Salary day to salary day";
}

/**
 * What a card owes and how much of its credit limit that is: the unpaid
 * part of the last bill and everything charged since, on the card's own
 * cycle. Coloured by the server's state - close from 70%, over from 90%.
 */
function Meter({ cycle }: { cycle: NonNullable<AccountOverview["cycle"]> }) {
  const owed = cycle.outstandingMinor ?? 0;
  const used = cycle.usedMinor ?? owed;
  const limit = cycle.creditLimitMinor;
  const share = limit && limit > 0 ? Math.min(1, used / limit) : null;
  const billed = cycle.billedUnpaidMinor ?? 0;
  const notes = [
    cycle.availableMinor !== null
      ? `${formatMoney(cycle.availableMinor)} available`
      : "Set a credit limit to see what is left",
    billed > 0 ? `${cycle.outstandingIsEstimate ? "about " : ""}${formatMoney(billed)} of the last bill unpaid` : null,
    `${formatMoney(cycle.unbilledMinor ?? 0)} spent since statement`,
  ].filter(Boolean);

  return (
    <div className={`figure-card is-meter ${cycle.state === "over" ? "is-over" : cycle.state === "close" ? "is-close" : ""}`}>
      <span className="figure-label">Owed on this card</span>
      <span className="figure-value">
        {formatMoney(owed)}
        {limit != null && <span className="figure-of">of {formatMoney(limit)} limit</span>}
      </span>
      {share != null && (
        <div className="meter" role="img" aria-label={`${Math.round(share * 100)}% of the credit limit used`}>
          <div className="meter-fill" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
      )}
      <span className="figure-note">{notes.join(" · ")}</span>
    </div>
  );
}

function ordinal(day: number): string {
  const suffix = day > 3 && day < 21 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}
