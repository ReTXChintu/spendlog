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
export function LedgerSkeleton() {
  const widths = [
    ["70%", "45%"],
    ["55%", "35%"],
    ["60%", "40%"],
  ];
  return (
    <div>
      <div className="day-header" style={{ borderBottomColor: "var(--line)" }}>
        <span className="skel skel-line" style={{ width: 70 }} />
        <span className="skel skel-line" style={{ width: 60 }} />
      </div>
      {widths.map(([top, bottom], i) => (
        <div className="skel-row" key={i}>
          <span className="skel skel-circle" />
          <div>
            <span className="skel skel-line" style={{ width: top, display: "block", marginBottom: 7 }} />
            <span className="skel skel-line" style={{ width: bottom, display: "block" }} />
          </div>
          <span className="skel skel-line" style={{ width: "100%" }} />
        </div>
      ))}
    </div>
  );
}
