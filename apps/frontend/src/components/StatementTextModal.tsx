import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Icon } from "./Icon";

interface StatementText {
  rows: string[];
  /** What every reader makes of those rows, not only the one that was used. */
  readers: { name: string; lines: number }[];
}

/**
 * What a statement actually extracts to, and what each reader makes of it.
 *
 * For when one opens but nothing is found in it. "No transaction table
 * could be found" is a true statement about the readers and a useless one
 * about the file — this is the file.
 *
 * The reader counts are the diagnosis. All of them at zero means the rows
 * are a shape nothing here handles yet. One of them well above zero while
 * the statement still failed means the build being run is older than the
 * fallback that would have used it.
 */
export function StatementTextModal({ statementId, onClose }: { statementId: string; onClose: () => void }) {
  const [text, setText] = useState<StatementText | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<StatementText>(`/statements/${statementId}/text`)
      .then(setText)
      .catch((err) => setError(err instanceof Error ? err.message : "Couldn't fetch it."));
  }, [statementId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const best = text?.readers.reduce((a, b) => (b.lines > a.lines ? b : a), { name: "", lines: 0 });

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal modal-wide">
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>

        <h3>What this statement says</h3>
        <div className="modal-sub">
          The text the PDF extracts to, and how many rows each reader can make of it.
        </div>

        {error && <p className="modal-error">{error}</p>}
        {!text && !error && <p className="desc">Fetching it from Gmail…</p>}

        {text && (
          <>
            <div className="reader-tally">
              {text.readers.map((reader) => (
                <span
                  className={`reader-chip${reader.lines > 0 ? " is-live" : ""}`}
                  key={reader.name}
                >
                  {reader.name}
                  <b>{reader.lines}</b>
                </span>
              ))}
            </div>

            <p className="field-hint">
              {best && best.lines === 0
                ? "No reader finds anything in these rows — the layout is one nothing here handles yet. Send a few of the lines below and it can be fitted."
                : `The "${best?.name}" reader finds ${best?.lines} rows. If the statement still failed, the running build is older than the fallback that would have used it.`}
            </p>

            <pre className="statement-text">
              {text.rows.map((row, index) => `${String(index).padStart(4)}  ${row}`).join("\n")}
            </pre>

            <div className="modal-actions">
              <button
                className="btn btn-sm"
                onClick={() => navigator.clipboard?.writeText(text.rows.join("\n"))}
              >
                Copy the text
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
