import { useCallback, useEffect, useState } from "react";
import { Account, accountLabel } from "../types";
import { api } from "../lib/api";
import { formatMoneyShort } from "../lib/format";
import { Icon } from "./Icon";
import { StatementDetailModal } from "./StatementDetailModal";
import { StatementResetCard } from "./StatementResetCard";
import { StatementTextModal } from "./StatementTextModal";

/**
 * Every statement, filed under the card it belongs to and the month it is
 * for.
 *
 * The flat list this replaces was fine at five statements and unusable at
 * fifty — every card's interleaved, and finding June's HDFC bill meant
 * reading subjects. The grouping comes from the server rather than being
 * worked out here, so the ordering rules are written once.
 */

interface StatementRow {
  id: string;
  accountId: string | null;
  status: "PARSED" | "LOCKED" | "UNIDENTIFIED" | "UNREADABLE";
  kind: "CARD" | "BANK";
  problem: string | null;
  subject: string | null;
  fileName: string | null;
  issuer: string | null;
  statementDate: string | null;
  receivedAt: string | null;
  totalDueMinor: number | null;
  statementSpendMinor: number;
  knownSpendMinor: number;
  hasFile: boolean;
  lineCount: number;
  counts: {
    matched: number;
    added: number;
    uncertain: number;
    skipped: number;
  };
}

interface MonthGroup {
  month: string;
  statements: StatementRow[];
}

interface AccountGroup {
  accountId: string;
  name: string;
  last4: string;
  accountType: string;
  network: string | null;
  months: MonthGroup[];
}

const STATUS_LABEL: Record<StatementRow["status"], string> = {
  PARSED: "Read",
  LOCKED: "Locked",
  UNIDENTIFIED: "Unknown card",
  UNREADABLE: "Could not open",
};

export function StatementShelf({
  accounts,
  onChanged,
  /// Which account the page is about. Only its statements are shown -
  /// this sits under one account's panel, and the others belong under
  /// theirs. Null shows every group, which is how the unfiled pile is
  /// listed.
  focusAccountId = null,
}: {
  accounts: Account[];
  onChanged?: () => void;
  focusAccountId?: string | null;
}) {
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showing, setShowing] = useState<string | null>(null);
  const [explaining, setExplaining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    api
      .get<AccountGroup[]>("/statements/filed")
      .then((next) => {
        setGroups(next);
        // Open by default. A group is one account's own statements now,
        // so there is nothing to collapse it away from.
        setOpen((current) =>
          Object.keys(current).length > 0
            ? current
            : Object.fromEntries(next.map((group) => [group.accountId, true])),
        );
      })
      .catch(() => setGroups([]))
      .finally(() => setLoaded(true));
  }, [focusAccountId]);

  useEffect(load, [load]);

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    setError(null);
    try {
      await run();
      load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }

  if (!loaded) return null;

  const shown = focusAccountId
    ? groups.filter((group) => group.accountId === focusAccountId)
    : groups;

  if (shown.length === 0) {
    return (
      <div className="card set-card set-card-wide">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-receipt" />
          </div>
          <div>
            <h4>Statements</h4>
            <p className="set-card-sub">None for this one yet</p>
          </div>
        </div>
        <p className="desc">
          Statements arrive from the same mailbox as everything else. Scan for
          them under Connections, and they will be filed here under the card
          they belong to.
        </p>
      </div>
    );
  }

  // A statement can be pointed at any account that holds one - a bank
  // statement belongs to a bank account, and offering only cards was why
  // there was no way to file one.
  const cards = accounts.filter(
    (account) => account.accountType === "CARD" || account.accountType === "BANK",
  );
  const anyLocked = shown.some((group) =>
    group.months.some((month) =>
      month.statements.some((row) => row.status === "LOCKED"),
    ),
  );

  return (
    <>
      <StatementResetCard onDone={load} />

      <div className="card set-card set-card-wide">
        <div className="set-card-head">
          <div className="set-card-icon">
            <Icon name="ic-receipt" />
          </div>
          <div>
            <h4>Statements</h4>
            <p className="set-card-sub">{shelfSummary(shown)}</p>
          </div>
        </div>

        {error && <p className="desc set-warn">{error}</p>}

        <div className="shelf">
          {shown.map((group) => {
            const count = group.months.reduce(
              (sum, month) => sum + month.statements.length,
              0,
            );
            const stuck = countStuck(group);
            const isOpen = open[group.accountId] ?? false;

            return (
              <section className="shelf-account" key={group.accountId}>
                <button
                  className="shelf-head"
                  aria-expanded={isOpen}
                  onClick={() =>
                    setOpen((current) => ({
                      ...current,
                      [group.accountId]: !isOpen,
                    }))
                  }
                >
                  <Icon
                    name={isOpen ? "ic-chevron-down" : "ic-chevron-right"}
                  />
                  <span className="shelf-name">
                    {group.name}
                    {group.last4 && (
                      <span className="shelf-last4">•••• {group.last4}</span>
                    )}
                    {group.network && (
                      <span className="shelf-network">{group.network}</span>
                    )}
                  </span>
                  <span className="shelf-count">
                    {count} statement{count === 1 ? "" : "s"}
                    {stuck > 0 && (
                      <span className="shelf-stuck">
                        {stuck} need attention
                      </span>
                    )}
                  </span>
                </button>

                {isOpen &&
                  group.months.map((month) => (
                    <div className="shelf-month" key={month.month}>
                      <h5 className="shelf-month-name">
                        {monthLabel(month.month)}
                      </h5>

                      <div className="statement-list">
                        {month.statements.map((statement) => (
                          <div
                            className={`statement-row is-${statement.status.toLowerCase()}`}
                            key={statement.id}
                          >
                            <div className="statement-main">
                              <div className="statement-title">
                                <span
                                  className={`statement-pill is-${statement.status.toLowerCase()}`}
                                >
                                  {STATUS_LABEL[statement.status]}
                                </span>
                                {statement.subject ??
                                  statement.fileName ??
                                  "A statement"}
                                {statement.kind === "BANK" && (
                                  <span className="statement-kind">bank</span>
                                )}
                              </div>

                              <div className="statement-sub">
                                {statementDay(statement) && (
                                  <>{statementDay(statement)} · </>
                                )}
                                {statement.status === "PARSED" ? (
                                  <>
                                    {statement.lineCount} transactions ·{" "}
                                    {statement.counts.added} added,{" "}
                                    {statement.counts.matched +
                                      statement.counts.uncertain}{" "}
                                    already known
                                    {statement.totalDueMinor ? (
                                      <>
                                        {" "}
                                        ·{" "}
                                        {formatMoneyShort(
                                          statement.totalDueMinor,
                                        )}{" "}
                                        due
                                      </>
                                    ) : null}
                                  </>
                                ) : (
                                  (statement.problem ??
                                  "No reason was recorded.")
                                )}
                              </div>
                            </div>

                            <div className="statement-actions">
                              {statement.status === "PARSED" && (
                                <button
                                  className="btn btn-sm"
                                  onClick={() => setShowing(statement.id)}
                                >
                                  Open
                                </button>
                              )}

                              {/* The card number printed inside is not always
                                the one an SMS taught SpendLog, so saying
                                which card it is by hand fixes most of these. */}
                              {statement.status === "UNIDENTIFIED" &&
                                cards.length > 0 && (
                                  <select
                                    className="filter-select"
                                    defaultValue=""
                                    disabled={busy === statement.id}
                                    onChange={(event) => {
                                      const accountId = event.target.value;
                                      if (accountId) {
                                        act(statement.id, () =>
                                          api.patch(
                                            `/statements/${statement.id}`,
                                            { accountId },
                                          ),
                                        );
                                      }
                                    }}
                                  >
                                    <option value="">
                                      {statement.kind === "BANK"
                                        ? "Which account?"
                                        : "Which card?"}
                                    </option>
                                    {/* The sort puts the right sort first
                                        without hiding the other: a bank
                                        statement is usually a bank
                                        account's, and occasionally the
                                        statement is wrong about which it
                                        is. */}
                                    {sortedForKind(cards, statement.kind).map((card) => (
                                      <option key={card.id} value={card.id}>
                                        {accountLabel(card)}
                                        {card.accountType === "BANK" ? " — bank" : ""}
                                      </option>
                                    ))}
                                  </select>
                                )}

                              {statement.status !== "PARSED" && (
                                <button
                                  className="btn btn-sm"
                                  disabled={busy === statement.id}
                                  onClick={() =>
                                    act(statement.id, () =>
                                      api.post(
                                        `/statements/${statement.id}/reread`,
                                      ),
                                    )
                                  }
                                >
                                  <Icon name="ic-sync" /> Read again
                                </button>
                              )}

                              {statement.status === "UNREADABLE" && (
                                <button
                                  className="btn btn-sm btn-ghost"
                                  onClick={() => setExplaining(statement.id)}
                                >
                                  Why?
                                </button>
                              )}

                              {statement.status === "PARSED" &&
                                statement.counts.added > 0 && (
                                  <button
                                    className="btn btn-sm btn-ghost"
                                    disabled={busy === statement.id}
                                    onClick={() =>
                                      act(statement.id, () =>
                                        api.delete(
                                          `/statements/${statement.id}/added`,
                                        ),
                                      )
                                    }
                                  >
                                    Undo {statement.counts.added}
                                  </button>
                                )}

                              {/* Forgetting a statement takes back what it
                                added on the way out, or the ledger keeps
                                rows pointing at something gone. */}
                              <button
                                className="btn btn-sm btn-ghost btn-danger-text"
                                title="Forget this statement"
                                disabled={busy === statement.id}
                                onClick={() => {
                                  if (confirming === statement.id) {
                                    act(statement.id, () =>
                                      api.delete(`/statements/${statement.id}`),
                                    );
                                    setConfirming(null);
                                  } else {
                                    setConfirming(statement.id);
                                  }
                                }}
                              >
                                {confirming === statement.id ? (
                                  "Really?"
                                ) : (
                                  <Icon name="ic-x" />
                                )}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
              </section>
            );
          })}
        </div>

        {anyLocked && (
          <p className="field-hint" style={{ marginTop: 12 }}>
            A locked statement needs its password set on the card above. Every
            card's password is tried against every statement, so one is often
            enough for all of them.
          </p>
        )}

        {explaining && (
          <StatementTextModal
            statementId={explaining}
            onClose={() => setExplaining(null)}
          />
        )}

        {showing && (
          <StatementDetailModal
            statementId={showing}
            onClose={() => setShowing(null)}
            onChanged={() => {
              load();
              onChanged?.();
            }}
          />
        )}
      </div>
    </>
  );
}

/** The kind of account a statement of this kind usually belongs to, first. */
function sortedForKind(accounts: Account[], kind: "CARD" | "BANK"): Account[] {
  const wanted = kind === "BANK" ? "BANK" : "CARD";

  return [
    ...accounts.filter((account) => account.accountType === wanted),
    ...accounts.filter((account) => account.accountType !== wanted),
  ];
}

function countStuck(group: AccountGroup): number {
  return group.months.reduce(
    (sum, month) =>
      sum + month.statements.filter((row) => row.status !== "PARSED").length,
    0,
  );
}

function needsWork(group: AccountGroup): boolean {
  return countStuck(group) > 0;
}

function shelfSummary(groups: AccountGroup[]): string {
  const total = groups.reduce(
    (sum, group) =>
      sum +
      group.months.reduce((inner, month) => inner + month.statements.length, 0),
    0,
  );
  const stuck = groups.reduce((sum, group) => sum + countStuck(group), 0);

  return stuck === 0
    ? `${total} across ${groups.length} card${groups.length === 1 ? "" : "s"}`
    : `${stuck} of ${total} need something doing`;
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

function statementDay(statement: StatementRow): string | null {
  const iso = statement.statementDate ?? statement.receivedAt;
  if (!iso) return null;

  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}
