import { useState } from "react";
import { Link } from "react-router-dom";
import { AccountOverview, PocketMoneySettings, PocketMoneyStatus } from "../types";
import { api } from "../lib/api";
import { formatMoney, formatShortDate } from "../lib/format";
import { Icon } from "./Icon";
import "../styles/pocket.css";

/**
 * Pocket money: an account that is really someone else's allowance (a
 * child without UPI of their own). It gets a monthly limit, topped back up
 * on a set day, and everything spent from it is marked as theirs.
 */

export function possessive(name: string): string {
  return `${name}’s`;
}

export function PocketMoneyPanel({
  account,
  onChanged,
}: {
  account: AccountOverview;
  onChanged: () => void;
}) {
  const settings = account.pocketMoney ?? null;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(pocketMoney: PocketMoneySettings | null) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/accounts/${account.id}`, { pocketMoney });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pocket-panel" aria-labelledby={`pocket-${account.id}`}>
      <div className="pocket-head">
        <span className="figure-label" id={`pocket-${account.id}`}>
          {settings ? `${possessive(settings.holder)} pocket money` : "Pocket money"}
        </span>
        {settings && !editing && (
          <span className="pocket-actions">
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setEditing(true)}>
              <Icon name="ic-pencil" /> Edit
            </button>
            <button
              className="btn btn-sm btn-ghost btn-danger-text"
              disabled={busy}
              onClick={() => save(null)}
            >
              <Icon name="ic-x" /> Stop being pocket money
            </button>
          </span>
        )}
      </div>

      {editing ? (
        <PocketMoneyForm
          initial={settings}
          busy={busy}
          onSave={(next) => save(next)}
          onCancel={() => {
            setEditing(false);
            setError(null);
          }}
        />
      ) : settings ? (
        // Settings without a status means the server predates it; show what we can.
        account.pocket ? (
          <PocketMoneyStatusView pocket={account.pocket} />
        ) : (
          <p className="desc pocket-desc">
            {formatMoney(settings.limitMinor)} a month, renewed on the {ordinal(settings.renewDay)}.
          </p>
        )
      ) : (
        <div className="pocket-empty">
          <p className="desc pocket-desc">
            Is this money someone else spends — a child without UPI of their own? Give it a monthly limit
            and a renewal day. Everything spent from it gets marked as theirs, and on that day you'll be told
            how much to put back.
          </p>
          <button className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>
            Make this pocket money
          </button>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

/** Spent against the limit, what's left, and the top-up when it's due. */
export function PocketMoneyStatusView({ pocket }: { pocket: PocketMoneyStatus }) {
  const used = pocket.limitMinor > 0 ? Math.min(1, pocket.spentMinor / pocket.limitMinor) : 0;
  const over = pocket.spentMinor > pocket.limitMinor;
  const close = !over && used >= 0.8;

  return (
    <div className={`pocket-status${over ? " is-over" : close ? " is-close" : ""}`}>
      <span className="figure-value num">
        {formatMoney(pocket.spentMinor)}
        <span className="figure-of">spent of {formatMoney(pocket.limitMinor)}</span>
      </span>
      <div
        className="meter pocket-meter"
        role="progressbar"
        aria-label="Pocket money used this month"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(used * 100)}
      >
        <div className="meter-fill" style={{ width: `${Math.round(used * 100)}%` }} />
      </div>
      <span className="figure-note">
        {over
          ? `${formatMoney(pocket.spentMinor - pocket.limitMinor)} over the limit`
          : `${formatMoney(pocket.leftMinor)} left`}
        {" · "}
        {pocket.transactionCount} {pocket.transactionCount === 1 ? "payment" : "payments"}
        {" · "}
        {pocket.renewsToday ? "renews today" : `renews on ${formatShortDate(pocket.renewsOn)}`}
      </span>

      {/* The one thing to do on renewal day: put back what last month used,
          which brings the account back up to the limit. */}
      {pocket.renewsToday && (
        <p className={`pocket-topup${pocket.toppedUpMinor > 0 ? " is-done" : ""}`}>
          <Icon name={pocket.toppedUpMinor > 0 ? "ic-check" : "ic-wallet"} />
          {pocket.toppedUpMinor > 0
            ? `Topped up ${formatMoney(pocket.toppedUpMinor)}`
            : pocket.lastMonthSpentMinor > 0
              ? `Top up ${formatMoney(pocket.lastMonthSpentMinor)} today`
              : "Nothing to top up today — last month used none of it"}
        </p>
      )}
    </div>
  );
}

/** A dashboard card for one pocket-money account. */
export function PocketMoneyCard({
  pocket,
}: {
  pocket: PocketMoneyStatus & { accountId: string; name: string };
}) {
  return (
    <div className="home-card">
      <h3 className="home-card-title">{possessive(pocket.holder)} pocket money</h3>
      <p className="section-sub">
        From {pocket.name}. Spending here counts in the month, but not in your daily bucket.
      </p>
      <PocketMoneyStatusView pocket={pocket} />
      <Link className="home-card-link" to={`/transactions?account=${pocket.accountId}`}>
        See what it went on <Icon name="ic-arrow-right" />
      </Link>
    </div>
  );
}

function PocketMoneyForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: PocketMoneySettings | null;
  busy: boolean;
  onSave: (settings: PocketMoneySettings) => void;
  onCancel: () => void;
}) {
  const [holder, setHolder] = useState(initial?.holder ?? "");
  const [limit, setLimit] = useState(initial ? String(initial.limitMinor / 100) : "");
  const [renewDay, setRenewDay] = useState(String(initial?.renewDay ?? 1));

  const limitRupees = Number(limit.replace(/,/g, ""));
  const day = Number(renewDay);
  const valid =
    holder.trim().length > 0 &&
    Number.isFinite(limitRupees) &&
    limitRupees > 0 &&
    Number.isInteger(day) &&
    day >= 1 &&
    day <= 31;

  return (
    <form
      className="pocket-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onSave({ holder: holder.trim(), limitMinor: Math.round(limitRupees * 100), renewDay: day });
      }}
    >
      <div className="pocket-form-fields">
        <label className="field">
          <span>Whose is it</span>
          <input
            autoFocus
            className="filter-input"
            value={holder}
            onChange={(e) => setHolder(e.target.value)}
            placeholder="Rahul"
            maxLength={40}
          />
        </label>
        <label className="field">
          <span>Monthly limit (₹)</span>
          <input
            className="filter-input"
            inputMode="decimal"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="2000"
          />
        </label>
        <label className="field">
          <span>Renews on day</span>
          <input
            className="filter-input"
            type="number"
            min={1}
            max={31}
            value={renewDay}
            onChange={(e) => setRenewDay(e.target.value)}
          />
        </label>
      </div>
      <p className="field-hint">
        On that day each month you'll be reminded to top it back up to the limit.
      </p>
      <div className="set-card-actions">
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy || !valid}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-sm btn-ghost" type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ordinal(day: number): string {
  const suffix = day > 3 && day < 21 ? "th" : (["th", "st", "nd", "rd"][day % 10] ?? "th");
  return `${day}${suffix}`;
}
