import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { Icon } from "./Icon";

/**
 * Starting the statement ledger over.
 *
 * Shown only while there is something to start over from — a mailbox with
 * duplicate statements in it. For a while every sync read every statement
 * again, because a statement was identified by Gmail's attachment id and
 * Gmail mints one of those per fetch. Three syncs, three copies of every
 * transaction.
 *
 * The counts come first and the button second. This deletes several
 * hundred rows, and that is not a thing to discover afterwards.
 */

interface ResetPlan {
  statements: number;
  addedTransactions: number;
  matchedTransactions: number;
  categorisedAmongThem: number;
  duplicateGroups: number;
}

export function StatementResetCard({ onDone }: { onDone: () => void }) {
  const [plan, setPlan] = useState<ResetPlan | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<ResetPlan>("/statements/reset")
      .then(setPlan)
      .catch(() => setPlan(null));
  }, []);

  useEffect(load, [load]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ statementsDeleted: number; transactionsDeleted: number }>(
        "/statements/reset",
        { confirm: "start over" }
      );
      setDone(
        `Removed ${result.statementsDeleted} statements and ${result.transactionsDeleted} ` +
          "transactions they had added. Read the statements again when you're ready."
      );
      setConfirming(false);
      load();
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (!plan || plan.statements === 0) return null;

  // Nothing to fix. The card is for a mess, not for a working mailbox.
  if (plan.duplicateGroups === 0 && !done) return null;

  return (
    <div className="card set-card set-card-wide is-warning">
      <div className="set-card-head">
        <div className="set-card-icon is-warn">
          <Icon name="ic-alert" />
        </div>
        <div>
          <h4>Statements were read more than once</h4>
          <p className="set-card-sub">
            {plan.duplicateGroups} of {plan.statements} are copies
          </p>
        </div>
      </div>

      {done ? (
        <p className="desc">{done}</p>
      ) : (
        <>
          <p className="desc">
            A statement used to be identified by Gmail's attachment id, which Gmail makes up fresh on
            every fetch — so each sync treated every statement as new and added its transactions
            again. That's fixed, but the rows it left behind are still here.
          </p>

          <dl className="reset-figures">
            <div>
              <dt>Statements</dt>
              <dd>{plan.statements}</dd>
            </div>
            <div>
              <dt>Transactions they added</dt>
              <dd className="is-going">{plan.addedTransactions} will go</dd>
            </div>
            <div>
              <dt>Of those, categorised by hand</dt>
              <dd className={plan.categorisedAmongThem > 0 ? "is-going" : ""}>
                {plan.categorisedAmongThem}
              </dd>
            </div>
            <div>
              <dt>Rows from SMS and email</dt>
              <dd className="is-staying">{plan.matchedTransactions} stay</dd>
            </div>
          </dl>

          {error && <p className="desc set-warn">{error}</p>}

          <div className="set-card-actions">
            {confirming ? (
              <>
                <button className="btn btn-sm btn-danger" disabled={busy} onClick={run}>
                  {busy ? "Removing…" : `Yes — remove ${plan.addedTransactions} transactions`}
                </button>
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => setConfirming(true)}>
                Start over
              </button>
            )}
          </div>

          <p className="field-hint">
            Nothing read from an SMS or an email is touched. Afterwards, read the statements again
            under Connections — once, and it will stay once.
          </p>
        </>
      )}
    </div>
  );
}
