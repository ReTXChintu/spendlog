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

  const isEmail = transaction.source === "EMAIL";
  const sourceLabel = transaction.source === "MANUAL" ? "Added by hand" : isEmail ? "Email" : "SMS";

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
        <h3>Original message</h3>
        <div className="modal-sub">
          <Icon name={isEmail ? "ic-mail" : "ic-message"} />
          <span>
            {sourceLabel} · {formatDateTime(transaction.occurredAt)}
          </span>
        </div>
        <div className="raw-block">{transaction.rawText ?? "No original message stored for this transaction."}</div>
        <div className="modal-footnote">
          <Icon name="ic-pencil" />
          Editing the merchant name from here is coming soon.
        </div>
      </div>
    </div>
  );
}
