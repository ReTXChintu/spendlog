import { useState } from "react";
import { formatMoney, formatMoneyShort } from "../../lib/format";

export interface DonutSlice {
  key: string;
  name: string;
  amountMinor: number;
  color: string;
  /** Uncategorised spending: drawn hatched-grey, never given a hue of its own. */
  muted?: boolean;
}

const SIZE = 168;
const STROKE = 22;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** The surface gap between segments, in px along the ring. */
const GAP = 2;

/**
 * Category share as a ring, with the list beside it doing the reading.
 *
 * The ring is for "how lopsided is this month" at a glance; the list
 * carries every name and figure, so nothing depends on matching a colour.
 * Hovering or focusing either side lights up the same slice.
 */
export function Donut({ slices, total }: { slices: DonutSlice[]; total: number }) {
  const [active, setActive] = useState<string | null>(null);
  const activeSlice = slices.find((slice) => slice.key === active) ?? null;

  let offset = 0;
  const arcs = slices.map((slice) => {
    const length = total > 0 ? (slice.amountMinor / total) * CIRCUMFERENCE : 0;
    const arc = { slice, start: offset, length };
    offset += length;
    return arc;
  });

  return (
    <div className="donut">
      <svg
        className="donut-svg"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`Share by category: ${slices
          .slice(0, 4)
          .map((slice) => `${slice.name} ${Math.round((slice.amountMinor / Math.max(1, total)) * 100)}%`)
          .join(", ")}`}
      >
        <circle className="donut-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} strokeWidth={STROKE} />
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {arcs.map(({ slice, start, length }) => {
            const drawn = Math.max(0, length - (slices.length > 1 ? GAP : 0));
            if (drawn <= 0) return null;
            return (
              <circle
                key={slice.key}
                className={`donut-arc${active && active !== slice.key ? " is-dim" : ""}`}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={slice.muted ? "var(--muted-light)" : slice.color}
                strokeWidth={STROKE}
                strokeDasharray={`${drawn} ${CIRCUMFERENCE - drawn}`}
                strokeDashoffset={-start}
                onMouseEnter={() => setActive(slice.key)}
                onMouseLeave={() => setActive(null)}
              >
                <title>
                  {slice.name}: {formatMoney(slice.amountMinor)}
                </title>
              </circle>
            );
          })}
        </g>
        <text className="donut-centre-label" x={SIZE / 2} y={SIZE / 2 - 6} textAnchor="middle">
          {activeSlice ? truncate(activeSlice.name, 14) : "Spent"}
        </text>
        <text className="donut-centre-value" x={SIZE / 2} y={SIZE / 2 + 14} textAnchor="middle">
          {formatMoneyShort(activeSlice ? activeSlice.amountMinor : total)}
        </text>
      </svg>

      <ul className="donut-legend">
        {slices.map((slice) => {
          const pct = total > 0 ? Math.round((slice.amountMinor / total) * 100) : 0;
          return (
            <li
              key={slice.key}
              tabIndex={0}
              className={active === slice.key ? "is-active" : ""}
              onMouseEnter={() => setActive(slice.key)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(slice.key)}
              onBlur={() => setActive(null)}
            >
              <i
                className={`donut-swatch${slice.muted ? " is-muted" : ""}`}
                style={slice.muted ? undefined : { background: slice.color }}
              />
              <span className="donut-name">{slice.name}</span>
              <span className="donut-val num">{formatMoneyShort(slice.amountMinor)}</span>
              <span className="donut-pct num">{pct}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
