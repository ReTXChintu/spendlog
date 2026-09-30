import { useState } from "react";
import { api } from "../lib/api";
import { formatDateTime, formatMoney } from "../lib/format";
import { AccountOverview } from "../types";
import { Icon } from "./Icon";

/**
 * What a bank or cash account should hold, and a way to check it.
 *
 * SpendLog only ever sees messages about money moving, never a balance. So
 * the balance is typed in once, off the bank's app, and every transaction
 * after it is added or taken away. When the bank's figure and this one
 * disagree, the gap is a payment SpendLog never saw - or one entered twice
 * - which is the whole reason to keep it.
 */

type Mode = "idle" | "set" | "check";

function rupeesToMinor(text: string): number | null {
  const value = Number.parseFloat(text.replace(/[₹,\s]/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

export function BalancePanel({ account, onChanged }: { account: AccountOverview; onChanged: () => void }) {
  const balance = account.balance ?? null;
  const [mode, setMode] = useState<Mode>("idle");
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState<"now" | "day">("now");
  const [day, setDay] = useState(() => new Date().toISOString().slice(0, 10));
  const [bankSays, setBankSays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(body: { openingBalanceMinor: number | null; openingBalanceAt?: string }) {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/accounts/${account.id}`, body);
      setMode("idle");
      setAmount("");
      setBankSays("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  function saveStarting() {
    const minor = rupeesToMinor(amount);
    if (minor === null) {
      setError("Enter the balance, like 25000 or -1200 if it's overdrawn.");
      return;
    }
    // The end of a chosen day, in IST - a statement's closing balance -
    // or now, when it was read off the bank's app a moment ago.
    save(
      asOf === "day"
        ? { openingBalanceMinor: minor, openingBalanceAt: `${day}T23:59:59.999+05:30` }
        : { openingBalanceMinor: minor }
    );
  }

  const bankMinor = rupeesToMinor(bankSays);
  const gap = balance && bankMinor !== null ? bankMinor - balance.expectedMinor : null;

  return (
    <div className="balance-panel">
      <div className="balance-head">
        <span className="figure-label">Balance</span>
        {balance && mode === "idle" && (
          <span className="balance-actions">
            <button className="btn btn-sm" onClick={() => setMode("check")}>
              Check against bank
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => {
                setAmount((balance.openingMinor / 100).toFixed(2));
                setMode("set");
              }}
            >
              Change
            </button>
            <button
              className="btn btn-sm btn-ghost btn-danger-text"
              disabled={busy}
              onClick={() => save({ openingBalanceMinor: null })}
            >
              Remove
            </button>
          </span>
        )}
      </div>

      {!balance && mode === "idle" && (
        <div className="balance-empty">
          <p className="desc">
            Add the balance your bank shows, and SpendLog will keep track of what it should be from then on —
            so a missing transaction shows up as a gap.
          </p>
          <button className="btn btn-sm btn-primary" onClick={() => setMode("set")}>
            Add starting balance
          </button>
        </div>
      )}

      {balance && mode !== "set" && (
        <div className="balance-figure">
          <span className="figure-value num">{formatMoney(balance.expectedMinor)}</span>
          <span className="figure-note">
            Should hold now · from {formatMoney(balance.openingMinor)} on {formatDateTime(balance.since)}
            {" · "}+{formatMoney(balance.inMinor)} in · −{formatMoney(balance.outMinor)} out ·{" "}
            {balance.transactionCount} {balance.transactionCount === 1 ? "transaction" : "transactions"}
          </span>
        </div>
      )}

      {mode === "set" && (
        <div className="balance-form">
          <label className="field">
            <span>Balance (₹)</span>
            <input
              autoFocus
              className="filter-input"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="25000"
            />
          </label>
          <fieldset className="balance-asof">
            <legend>As of</legend>
            <label>
              <input type="radio" checked={asOf === "now"} onChange={() => setAsOf("now")} /> Right now — it
              already includes everything so far
            </label>
            <label>
              <input type="radio" checked={asOf === "day"} onChange={() => setAsOf("day")} /> The end of
              <input
                type="date"
                className="filter-input"
                value={day}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => {
                  setDay(e.target.value);
                  setAsOf("day");
                }}
              />
            </label>
          </fieldset>
          <div className="set-card-actions">
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={saveStarting}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setMode("idle")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "check" && balance && (
        <div className="balance-form">
          <label className="field">
            <span>What the bank shows now (₹)</span>
            <input
              autoFocus
              className="filter-input"
              inputMode="decimal"
              value={bankSays}
              onChange={(e) => setBankSays(e.target.value)}
              placeholder={(balance.expectedMinor / 100).toFixed(2)}
            />
          </label>
          {gap !== null && (
            <p className={`balance-verdict ${gap === 0 ? "is-match" : "is-gap"}`}>
              <Icon name={gap === 0 ? "ic-check" : "ic-alert"} />
              {gap === 0
                ? "Matches — nothing missing."
                : gap < 0
                  ? `${formatMoney(-gap)} less than expected — likely a payment SpendLog hasn't seen. Add it, and this closes.`
                  : `${formatMoney(gap)} more than expected — likely money in that hasn't been recorded, or a payment counted twice.`}
            </p>
          )}
          <div className="set-card-actions">
            {gap !== null && gap !== 0 && (
              <button
                className="btn btn-sm"
                disabled={busy}
                onClick={() => save({ openingBalanceMinor: bankMinor! })}
              >
                Use {formatMoney(bankMinor!)} as the new starting balance
              </button>
            )}
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setMode("idle")}>
              Done
            </button>
          </div>
        </div>
      )}

      {error && <p className="form-error">{error}</p>}
    </div>
  );
}
