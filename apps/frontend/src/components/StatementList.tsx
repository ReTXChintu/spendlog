import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatMoneyShort } from "../lib/format";
import { Account, accountLabel } from "../types";
import { Icon } from "./Icon";

/**
 * Every statement the mailbox has offered, and what became of it.
 *
 * The engine recorded a reason against each failure from the day it was
 * written, and nothing ever showed one — so "5 statements could not be
 * read" was the whole of what anybody knew. This is that list.
 */

interface StatementRow {
  id: string;
  accountId: string | null;
  status: "PARSED" | "LOCKED" | "UNIDENTIFIED" | "UNREADABLE";
  problem: string | null;
  subject: string | null;
  fileName: string | null;
  issuer: string | null;
  statementDate: string | null;
  statementSpendMinor: number;
  knownSpendMinor: number;
  lineCount: number;
  counts: { matched: number; added: number; uncertain: number; skipped: number };
}

const STATUS_LABEL: Record<StatementRow["status"], string> = {
  PARSED: "Read",
  LOCKED: "Locked",
  UNIDENTIFIED: "Unknown card",
  UNREADABLE: "Could not open",
};

export function StatementList({ accounts }: { accounts: Account[] }) {
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<StatementRow[]>("/statements")
      .then(setStatements)
      .catch(() => setStatements([]));
  }, []);

  useEffect(load, [load]);

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await run();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  if (statements.length === 0) return null;

  const cards = accounts.filter((account) => account.accountType === "CARD");
  const stuck = statements.filter((statement) => statement.status !== "PARSED");

  return (
    <div className="card set-card set-card-wide">
      <div className="set-card-head">
        <div className="set-card-icon">
          <Icon name="ic-receipt" />
        </div>
        <div>
          <h4>Statements found</h4>
          <p className="set-card-sub">
            {stuck.length === 0
              ? `${statements.length} read`
              : `${stuck.length} of ${statements.length} need something doing`}
          </p>
        </div>
      </div>

      {error && <p className="desc set-warn">{error}</p>}

      <div className="statement-list">
        {statements.map((statement) => (
          <div className={`statement-row is-${statement.status.toLowerCase()}`} key={statement.id}>
            <div className="statement-main">
              <div className="statement-title">
                <span className={`statement-pill is-${statement.status.toLowerCase()}`}>
                  {STATUS_LABEL[statement.status]}
                </span>
                {statement.subject ?? statement.fileName ?? "A statement"}
              </div>

              <div className="statement-sub">
                {statement.status === "PARSED" ? (
                  <>
                    {statement.issuer} · {statement.lineCount} lines · {statement.counts.added} added,{" "}
                    {statement.counts.matched + statement.counts.uncertain} already known
                    {statement.statementSpendMinor > 0 && (
                      <>
                        {" "}
                        · statement says {formatMoneyShort(statement.statementSpendMinor)}, SpendLog had{" "}
                        {formatMoneyShort(statement.knownSpendMinor)}
                      </>
                    )}
                  </>
                ) : (
                  (statement.problem ?? "No reason was recorded.")
                )}
              </div>
            </div>

            <div className="statement-actions">
              {/* The card number printed inside is not always the one an SMS
                  taught SpendLog, so saying which card it is by hand is the
                  fix for most of these. */}
              {statement.status === "UNIDENTIFIED" && cards.length > 0 && (
                <select
                  className="filter-select"
                  defaultValue=""
                  disabled={busy === statement.id}
                  onChange={(event) => {
                    const accountId = event.target.value;
                    if (accountId) {
                      act(statement.id, () => api.patch(`/statements/${statement.id}`, { accountId }));
                    }
                  }}
                >
                  <option value="">Which card?</option>
                  {cards.map((card) => (
                    <option key={card.id} value={card.id}>
                      {accountLabel(card)}
                    </option>
                  ))}
                </select>
              )}

              {statement.status !== "PARSED" && (
                <button
                  className="btn btn-sm"
                  disabled={busy === statement.id}
                  onClick={() => act(statement.id, () => api.post(`/statements/${statement.id}/reread`))}
                >
                  <Icon name="ic-sync" /> Read again
                </button>
              )}

              {statement.status === "PARSED" && statement.counts.added > 0 && (
                <button
                  className="btn btn-sm btn-ghost btn-danger-text"
                  disabled={busy === statement.id}
                  onClick={() => act(statement.id, () => api.delete(`/statements/${statement.id}/added`))}
                >
                  Undo {statement.counts.added}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {stuck.some((statement) => statement.status === "LOCKED") && (
        <p className="field-hint" style={{ marginTop: 12 }}>
          A locked statement needs its password set on the card, under Accounts and cards. Every card's
          password is tried against every statement, so one is often enough for all of them.
        </p>
      )}
    </div>
  );
}
