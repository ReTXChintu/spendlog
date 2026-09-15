import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Icon } from "./Icon";

/**
 * Where the ledger starts.
 *
 * SpendLog imports nothing from before the month you joined. A mailbox
 * holds months of alerts and a phone holds years, and pulling all of it in
 * would fill the app with a half-remembered period nobody meant to track —
 * every total wrong, every screen full of rows from before it existed.
 *
 * So it starts at the 1st of the month you signed up, and this is where it
 * moves back: one month at a time, fetching that month as it goes, because
 * opening a month and showing it empty would look broken.
 */

interface Horizon {
  month: string;
  joined: string;
  previous: string;
  canGoBack: boolean;
}

interface PurgePlan {
  month: string;
  imported: number;
  manual: number;
  statements: number;
}

export function LedgerStartCard() {
  const [horizon, setHorizon] = useState<Horizon | null>(null);
  const [plan, setPlan] = useState<PurgePlan | null>(null);
  const [busy, setBusy] = useState<"back" | "purge" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Horizon>("/ledger")
      .then(setHorizon)
      .catch(() => setHorizon(null));
    api
      .get<PurgePlan>("/ledger/purge")
      .then(setPlan)
      .catch(() => setPlan(null));
  }, []);

  useEffect(load, [load]);

  async function goBack() {
    setBusy("back");
    setError(null);
    setNote(null);
    try {
      const result = await api.post<{ month: string; imported: number; statementsRead: number }>(
        "/ledger/earlier"
      );
      setNote(
        `${monthLabel(result.month)} is in. ${result.imported} transactions and ` +
          `${result.statementsRead} statements came back with it.`
      );
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  async function purge() {
    setBusy("purge");
    setError(null);
    try {
      const result = await api.post<{ transactionsDeleted: number; statementsDeleted: number }>(
        "/ledger/purge",
        { confirm: "clear the old months" }
      );
      setNote(
        `Removed ${result.transactionsDeleted} transactions and ${result.statementsDeleted} statements ` +
          "from before that month."
      );
      setConfirming(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  if (!horizon) return null;

  const hasOldStuff = plan !== null && plan.imported + plan.statements > 0;

  return (
    <div className="card set-card set-card-wide">
      <div className="set-card-head">
        <div className="set-card-icon">
          <Icon name="ic-calendar" />
        </div>
        <div>
          <h4>Start loading from</h4>
          <p className="set-card-sub">{monthLabel(horizon.month)}</p>
        </div>
      </div>

      <p className="desc">
        Nothing from before {monthLabel(horizon.month)} is imported.{" "}
        {horizon.month === horizon.joined
          ? `That is the month you joined — your mailbox and your phone hold plenty from before it, and none of it was ever yours to track here.`
          : `You joined in ${monthLabel(horizon.joined)}.`}
      </p>

      {note && <p className="desc">{note}</p>}
      {error && <p className="desc set-warn">{error}</p>}

      <div className="set-card-actions">
        {horizon.canGoBack && (
          <button className="btn btn-sm" disabled={busy !== null} onClick={goBack}>
            <Icon name="ic-chevron-left" />
            {busy === "back" ? `Fetching ${monthLabel(horizon.previous)}…` : `Load ${monthLabel(horizon.previous)} too`}
          </button>
        )}
      </div>

      <p className="field-hint">
        Loading a month goes back to the mailbox for it, so it may take a moment. A payment you
        typed in yourself is kept whatever this says — it only decides what SpendLog goes and
        fetches.
      </p>

      {hasOldStuff && (
        <div className="ledger-purge">
          <p className="desc">
            <b>{plan!.imported}</b> imported {plan!.imported === 1 ? "transaction" : "transactions"}
            {plan!.statements > 0 && <> and <b>{plan!.statements}</b> statements</>} sit before{" "}
            {monthLabel(plan!.month)}, from before this was set.
            {plan!.manual > 0 && (
              <>
                {" "}
                {plan!.manual} you entered by hand {plan!.manual === 1 ? "is" : "are"} also back
                there, and would be kept.
              </>
            )}
          </p>

          <div className="set-card-actions">
            {confirming ? (
              <>
                <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={purge}>
                  {busy === "purge" ? "Removing…" : `Yes — remove ${plan!.imported}`}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  disabled={busy !== null}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn btn-sm btn-ghost btn-danger-text" onClick={() => setConfirming(true)}>
                Clear them out
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "September 2026", from a YYYY-MM key. */
function monthLabel(month: string): string {
  const [year, index] = month.split("-").map(Number);
  if (!year || !index) return month;

  return new Date(Date.UTC(year, index - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
