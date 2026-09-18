import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { formatMoney } from "../lib/format";
import { Icon } from "./Icon";

/**
 * One statement, opened.
 *
 * Everything the app made of a statement used to be a count on a list row —
 * "38 lines, 12 added" — with no way to see which twelve, or to disagree.
 * The three tabs here are the three questions actually asked of a
 * statement: what is on it, what the reader saw, and what the page itself
 * says.
 */

interface Line {
  id: string;
  date: string;
  description: string;
  amountMinor: number;
  type: "DEBIT" | "CREDIT";
  kind: string;
  resolution: "MATCHED" | "ADDED" | "UNCERTAIN" | "SKIPPED";
  transaction: { id: string; merchant: string; amountMinor: number } | null;
}

interface Detail {
  id: string;
  status: string;
  issuer: string | null;
  subject: string | null;
  fileName: string | null;
  statementDate: string | null;
  dueDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  totalDueMinor: number | null;
  totalDueIsManual: boolean;
  minimumDueMinor: number | null;
  waivedMinor: number | null;
  waivedNote: string | null;
  statementSpendMinor: number;
  knownSpendMinor: number;
  hasFile: boolean;
  rows: string[];
  lines: Line[];
}

const RESOLUTION_LABEL: Record<Line["resolution"], string> = {
  MATCHED: "Already known",
  ADDED: "Added",
  UNCERTAIN: "Not sure",
  SKIPPED: "Not counted",
};

type Pane = "lines" | "text" | "file";

export function StatementDetailModal({
  statementId,
  onClose,
  onChanged,
}: {
  statementId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [pane, setPane] = useState<Pane>("lines");
  const [error, setError] = useState<string | null>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Detail>(`/statements/${statementId}`)
      .then(setDetail)
      .catch((err: ApiError) => setError(err.message));
  }, [statementId]);

  useEffect(load, [load]);

  /**
   * Overrule one line by hand.
   *
   * The matcher goes on amount, type, card and date, and never on the
   * merchant's name — which is right, because a name in SpendLog may have
   * been edited into something the bank never printed. That makes it
   * confident and occasionally wrong, and this is where it is told so.
   */
  async function resolve(line: Line, action: "add" | "ignore" | "reset") {
    setBusyLine(line.id);
    setError(null);
    try {
      await api.patch(`/statements/${statementId}/lines/${line.id}`, { action });
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusyLine(null);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal modal-statement" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h3>{detail?.subject ?? detail?.fileName ?? "Statement"}</h3>
            <p className="modal-sub">{summaryLine(detail)}</p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <Icon name="ic-x" />
          </button>
        </div>

        {error && <p className="desc set-warn">{error}</p>}

        {detail && <BillEditor detail={detail} onChanged={() => { load(); onChanged(); }} />}
        {detail?.totalDueMinor ? <WaiveRow detail={detail} onChanged={() => { load(); onChanged(); }} /> : null}

        <div className="tabs tabs-inline" role="tablist">
          <button
            role="tab"
            aria-selected={pane === "lines"}
            className={`tab${pane === "lines" ? " on" : ""}`}
            onClick={() => setPane("lines")}
          >
            Transactions {detail ? `(${detail.lines.length})` : ""}
          </button>
          <button
            role="tab"
            aria-selected={pane === "text"}
            className={`tab${pane === "text" ? " on" : ""}`}
            onClick={() => setPane("text")}
          >
            What the reader saw
          </button>
          <button
            role="tab"
            aria-selected={pane === "file"}
            className={`tab${pane === "file" ? " on" : ""}`}
            onClick={() => setPane("file")}
          >
            The PDF
          </button>
        </div>

        {!detail && !error && <p className="desc">Opening…</p>}

        {detail && pane === "lines" && (
          <LinesPane detail={detail} busyLine={busyLine} onResolve={resolve} />
        )}

        {detail && pane === "text" && (
          <div className="statement-text">
            {detail.rows.length === 0 ? (
              <p className="desc">
                This statement was read before SpendLog kept the text. Read it again to store it.
              </p>
            ) : (
              <ol className="statement-rows">
                {detail.rows.map((row, index) => (
                  <li key={index}>
                    <span className="statement-row-n">{index}</span>
                    <code>{row}</code>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {detail && pane === "file" && <FilePane statementId={statementId} hasFile={detail.hasFile} />}
      </div>
    </div>
  );
}

function LinesPane({
  detail,
  busyLine,
  onResolve,
}: {
  detail: Detail;
  busyLine: string | null;
  onResolve: (line: Line, action: "add" | "ignore" | "reset") => void;
}) {
  if (detail.lines.length === 0) {
    return <p className="desc">Nothing was read off this statement.</p>;
  }

  return (
    <div className="statement-lines">
      <table className="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th className="num">Amount</th>
            <th>In SpendLog</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {detail.lines.map((line) => (
            <tr key={line.id} className={`line-${line.resolution.toLowerCase()}`}>
              <td className="nowrap">{shortDay(line.date)}</td>
              <td>
                <span className="line-desc">{line.description || "—"}</span>
                {line.kind !== "SPEND" && <span className="line-kind">{line.kind.toLowerCase()}</span>}
              </td>
              <td className={`num ${line.type === "CREDIT" ? "amount-in" : ""}`}>
                {line.type === "CREDIT" ? "+" : ""}
                {formatMoney(line.amountMinor)}
              </td>
              <td>
                <span className={`statement-pill is-${line.resolution.toLowerCase()}`}>
                  {RESOLUTION_LABEL[line.resolution]}
                </span>
                {line.transaction && <span className="line-match">{line.transaction.merchant}</span>}
              </td>
              <td className="statement-line-actions">
                {/* A line SpendLog thinks it already has, that it does not.
                    The usual cause is a merchant renamed by hand, which the
                    matcher deliberately never looks at. */}
                {(line.resolution === "MATCHED" || line.resolution === "SKIPPED") && (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busyLine === line.id}
                    onClick={() => onResolve(line, "add")}
                    title="SpendLog does not have this one — add it"
                  >
                    Add it
                  </button>
                )}
                {line.resolution !== "SKIPPED" && (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busyLine === line.id}
                    onClick={() => onResolve(line, "ignore")}
                    title="Leave this line out of the ledger"
                  >
                    Ignore
                  </button>
                )}
                {line.resolution !== "MATCHED" && (
                  <button
                    className="btn btn-sm btn-ghost"
                    disabled={busyLine === line.id}
                    onClick={() => onResolve(line, "reset")}
                    title="Work this line out again"
                  >
                    Redo
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The statement itself.
 *
 * Fetched as a blob rather than linked to: the session is a bearer token,
 * and a new tab would arrive without it and be turned away.
 */
function FilePane({ statementId, hasFile }: { statementId: string; hasFile: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasFile) return;

    let objectUrl: string | null = null;
    let cancelled = false;

    api
      .blob(`/statements/${statementId}/file`)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err: ApiError) => !cancelled && setError(err.message));

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [statementId, hasFile]);

  if (!hasFile) {
    return (
      <p className="desc">
        This statement was read before SpendLog kept the file. Read it again to store one.
      </p>
    );
  }

  if (error) return <p className="desc set-warn">{error}</p>;
  if (!url) return <p className="desc">Opening…</p>;

  return (
    <div className="statement-pdf">
      <object data={url} type="application/pdf" aria-label="The statement">
        {/* No PDF viewer. Nothing to do but hand the file over. */}
        <p className="desc">
          Your browser will not show a PDF here.{" "}
          <a href={url} target="_blank" rel="noreferrer">
            Open it in a new tab
          </a>
          .
        </p>
      </object>
    </div>
  );
}

/**
 * The bill total, typed in or corrected by hand.
 *
 * A reader is a best guess at a layout it has never proved it
 * understands, and the two ways that guess fails are the same failure
 * from here: nothing at all, or the wrong number. Both are fixed the
 * same way — by being told the real one.
 */
function BillEditor({ detail, onChanged }: { detail: Detail; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(detail.totalDueMinor ? String(detail.totalDueMinor / 100) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(totalDueMinor: number | null) {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/statements/${detail.id}/bill`, { totalDueMinor });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing && detail.totalDueMinor === null) {
    return (
      <button className="btn btn-sm btn-ghost waive-toggle" onClick={() => setEditing(true)}>
        <Icon name="ic-pencil" /> This statement's bill total wasn't read — enter it
      </button>
    );
  }

  if (!editing) {
    return (
      <div className="waive-row">
        <Icon name={detail.totalDueIsManual ? "ic-pencil" : "ic-receipt"} />
        <span>
          {formatMoney(detail.totalDueMinor!)} bill total
          {detail.totalDueIsManual ? ", entered by hand" : ", read from the statement"}
        </span>
        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
          {detail.totalDueIsManual ? "Change" : "Not right?"}
        </button>
      </div>
    );
  }

  return (
    <div className="waive-editor">
      <p className="field-hint">
        {detail.totalDueMinor === null
          ? "Nothing here was found in the statement's own summary. Type the total from the bill."
          : "Overrides what was read, on this statement only. Worth checking against the PDF itself " +
            "first — open it from The PDF tab."}
      </p>
      <div className="waive-editor-fields">
        <label className="field">
          <span>Bill total (₹)</span>
          <input
            className="filter-input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="13920.89"
          />
        </label>
      </div>
      {error && <p className="desc set-warn">{error}</p>}
      <div className="waive-editor-actions">
        <button
          className="btn btn-sm btn-primary"
          disabled={saving || !amount.trim()}
          onClick={() => {
            const rupees = Number.parseFloat(amount);
            if (Number.isFinite(rupees) && rupees >= 0) save(Math.round(rupees * 100));
          }}
        >
          Save
        </button>
        {detail.totalDueIsManual ? (
          <button className="btn btn-sm btn-ghost btn-danger-text" disabled={saving} onClick={() => save(null)}>
            Forget it
          </button>
        ) : null}
        <button className="btn btn-sm btn-ghost" disabled={saving} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The bill, less what a payment actually covered, is a real and permanent
 * gap whenever part of it was cashback or points rather than money - and
 * SpendLog, which only ever sees money that moved, has no way to notice
 * the difference on its own. This is where it is told.
 */
function WaiveRow({ detail, onChanged }: { detail: Detail; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(detail.waivedMinor ? String(detail.waivedMinor / 100) : "");
  const [note, setNote] = useState(detail.waivedNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(waivedMinor: number | null) {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/statements/${detail.id}/waive`, { waivedMinor, note: note.trim() || null });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setSaving(false);
    }
  }

  if (!editing && !detail.waivedMinor) {
    return (
      <button className="btn btn-sm btn-ghost waive-toggle" onClick={() => setEditing(true)}>
        <Icon name="ic-percent" /> Part of this was cashback or points, not money
      </button>
    );
  }

  if (!editing) {
    return (
      <div className="waive-row">
        <Icon name="ic-check" />
        <span>
          {formatMoney(detail.waivedMinor!)} covered{detail.waivedNote ? ` — ${detail.waivedNote}` : ""},
          not still owed
        </span>
        <button className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="waive-editor">
      <p className="field-hint">
        The amount covered by cashback, reward points, or a fee the bank waived — the part of the bill
        that a payment was never going to cover, because it was never money.
      </p>
      <div className="waive-editor-fields">
        <label className="field">
          <span>Covered (₹)</span>
          <input
            className="filter-input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="50"
          />
        </label>
        <label className="field field-wide">
          <span>Note</span>
          <input
            className="filter-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Cashback used at checkout"
          />
        </label>
      </div>
      {error && <p className="desc set-warn">{error}</p>}
      <div className="waive-editor-actions">
        <button
          className="btn btn-sm btn-primary"
          disabled={saving || !amount.trim()}
          onClick={() => {
            const rupees = Number.parseFloat(amount);
            if (Number.isFinite(rupees) && rupees >= 0) save(Math.round(rupees * 100));
          }}
        >
          Save
        </button>
        {detail.waivedMinor ? (
          <button className="btn btn-sm btn-ghost btn-danger-text" disabled={saving} onClick={() => save(null)}>
            Remove
          </button>
        ) : null}
        <button className="btn btn-sm btn-ghost" disabled={saving} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function summaryLine(detail: Detail | null): string {
  if (!detail) return "";

  const parts: string[] = [];
  if (detail.issuer) parts.push(detail.issuer);
  if (detail.periodStart && detail.periodEnd) {
    parts.push(`${shortDay(detail.periodStart)} – ${shortDay(detail.periodEnd)}`);
  }
  if (detail.totalDueMinor) parts.push(`${formatMoney(detail.totalDueMinor)} due`);
  if (detail.dueDate) parts.push(`by ${shortDay(detail.dueDate)}`);

  return parts.join(" · ");
}

function shortDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "2-digit" });
}
