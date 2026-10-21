import { ReactNode } from "react";
import { Icon } from "./Icon";

export function StateBlock({
  icon,
  title,
  body,
  actions,
  warn = false,
}: {
  icon: string;
  title: string;
  body: string;
  actions?: ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="state-block">
      <div className={`state-icon${warn ? " warn" : ""}`}>
        <Icon name={icon} />
      </div>
      <h3 className="state-title">{title}</h3>
      <p className="state-body">{body}</p>
      {actions && <div className="state-actions">{actions}</div>}
    </div>
  );
}

/** Placeholder rows matching the ledger's shape, shown while loading. */
export function LedgerSkeleton({ caption = "Loading your payments…" }: { caption?: string }) {
  const widths = [
    ["40%", "24%"],
    ["32%", "20%"],
    ["36%", "22%"],
    ["28%", "18%"],
  ];
  return (
    <div className="ledger-skeleton" aria-busy="true" aria-live="polite">
      <p className="skel-caption">{caption}</p>
      {widths.map(([top, bottom], i) => (
        <div className="skel-row" key={i}>
          <span className="skel skel-circle" />
          <div>
            <span className="skel skel-line" style={{ width: top, marginBottom: 8 }} />
            <span className="skel skel-line sm" style={{ width: bottom }} />
          </div>
          <span className="skel skel-line" style={{ width: 72, justifySelf: "end" }} />
        </div>
      ))}
    </div>
  );
}
