import { useEffect } from "react";
import { formatDateTime } from "../lib/format";
import { Transaction } from "../types";
import { Icon } from "./Icon";

/**
 * Shows the SMS or email a transaction was parsed from. Rows appear without
 * the user entering them, so being able to check where a figure came from is
 * what makes the automatic ledger trustworthy rather than unsettling.
 */
export function RawMessageModal({
  transaction,
  onClose,
}: {
  transaction: Transaction;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Older rows predate the per-message list, so fall back to the single
  // message they carry at the top level.
  const sources =
    transaction.sources.length > 0
      ? transaction.sources
      : [
          {
            source: transaction.source,
            sourceRef: null,
            rawText: transaction.rawText,
            receivedAt: transaction.occurredAt,
          },
        ];

  function labelFor(source: string): string {
    if (source === "MANUAL") return "Added by hand";
    return source === "EMAIL" ? "Email" : "SMS";
  }

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal">
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>
        <h3>{sources.length > 1 ? "Original messages" : "Original message"}</h3>
        <div className="modal-sub">
          <Icon name="ic-receipt" />
          <span>
            {sources.length > 1
              ? `This transaction was reported ${sources.length} times`
              : `${labelFor(sources[0].source)} · ${formatDateTime(sources[0].receivedAt)}`}
          </span>
        </div>

        {sources.map((entry, i) => (
          <div key={entry.sourceRef ?? `${entry.source}-${i}`} className="raw-source">
            {sources.length > 1 && (
              <div className="raw-source-head">
                <Icon name={entry.source === "EMAIL" ? "ic-mail" : "ic-message"} />
                <span>
                  {labelFor(entry.source)} · {formatDateTime(entry.receivedAt)}
                </span>
              </div>
            )}
            <div className="raw-block">
              {entry.rawText ?? "No original message stored for this transaction."}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
