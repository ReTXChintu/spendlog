import { ReactNode, useState } from "react";
import { ChartTip, columnPath, formatCompact, niceMax, stepKeys, useWidth } from "./chartKit";

export interface ColumnSeries {
  name: string;
  /** A class on the column: is-spend, is-income. Colour lives in CSS so both themes are handled there. */
  tone: string;
}

export interface ColumnGroup {
  key: string;
  label: string;
  values: number[];
  /** Hatched instead of filled: a month with nothing recorded, not a zero. */
  empty?: boolean;
}

const PAD_LEFT = 44;
const PAD_RIGHT = 6;
const PAD_TOP = 18;
const AXIS = 22;

/**
 * Columns, one group per label, one column per series, all on one scale.
 *
 * Columns are capped at 20px and the rest of each slot is left as air;
 * touching columns in a group keep a 2px gap between them. One value gets
 * a direct label (the largest), the axis and the tooltip carry the rest.
 */
export function ColumnChart({
  groups,
  series,
  height = 170,
  ariaLabel,
  tooltip,
  current,
}: {
  groups: ColumnGroup[];
  series: ColumnSeries[];
  height?: number;
  ariaLabel: string;
  tooltip: (group: ColumnGroup) => ReactNode;
  /** The group that is "now": its first column is drawn in the accent. */
  current?: number;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const max = niceMax(Math.max(0, ...groups.flatMap((group) => group.values)));
  const plotWidth = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const slot = groups.length ? plotWidth / groups.length : 0;
  const columnWidth = Math.max(4, Math.min(20, (slot * 0.62 - 2 * (series.length - 1)) / series.length));
  const groupWidth = columnWidth * series.length + 2 * (series.length - 1);
  const baseline = PAD_TOP + height;
  const yAt = (value: number) => baseline - (value / max) * height;
  const ticks = [0, max / 2, max];

  // The single direct label: the largest column of the first series.
  let peak = -1;
  groups.forEach((group, index) => {
    if (!group.empty && group.values[0] > 0 && (peak < 0 || group.values[0] > groups[peak].values[0])) peak = index;
  });

  const centre = (index: number) => PAD_LEFT + slot * index + slot / 2;

  return (
    <div className="chart" ref={wrapRef}>
      {width > 0 && groups.length > 0 && (
        <svg
          width={width}
          height={baseline + AXIS}
          role="img"
          tabIndex={0}
          className="chart-svg"
          aria-label={`${ariaLabel} Use the arrow keys to read each one.`}
          onMouseLeave={() => setActive(null)}
          onKeyDown={(event) => stepKeys(event, groups.length, active, setActive)}
          onBlur={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="chart-grid" x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yAt(tick)} y2={yAt(tick)} />
              <text className="chart-axis" x={PAD_LEFT - 4} y={yAt(tick) + 4} textAnchor="end">
                {formatCompact(tick)}
              </text>
            </g>
          ))}

          {groups.map((group, index) => {
            const left = centre(index) - groupWidth / 2;
            return (
              <g key={group.key} className={active === index ? "chart-group is-active" : "chart-group"}>
                {group.empty ? (
                  <rect className="chart-empty" x={centre(index) - 12} y={baseline - 6} width={24} height={6} rx={2} />
                ) : (
                  series.map((one, s) => (
                    <path
                      key={one.name}
                      className={`chart-col ${one.tone}${s === 0 && index === current ? " is-current" : ""}`}
                      d={columnPath(left + s * (columnWidth + 2), baseline, columnWidth, baseline - yAt(group.values[s] ?? 0))}
                    />
                  ))
                )}
                <text className="chart-axis" x={centre(index)} y={baseline + 15} textAnchor="middle">
                  {group.label}
                </text>
                {index === peak && (
                  <text className="chart-value" x={left + columnWidth / 2} y={yAt(group.values[0]) - 5} textAnchor="middle">
                    {formatCompact(group.values[0])}
                  </text>
                )}
                {/* The hit target is the whole slot, far bigger than the column. */}
                <rect
                  className="chart-hit"
                  x={PAD_LEFT + slot * index}
                  y={PAD_TOP - 10}
                  width={slot}
                  height={height + 10 + AXIS}
                  onMouseEnter={() => setActive(index)}
                />
              </g>
            );
          })}
          <line className="chart-base" x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={baseline} y2={baseline} />
        </svg>
      )}

      {active !== null && groups[active] && (
        <ChartTip x={centre(active)} width={width}>
          {tooltip(groups[active])}
        </ChartTip>
      )}

      {series.length > 1 && (
        <div className="chart-legend">
          {series.map((one) => (
            <span key={one.name}>
              <i className={`chart-key ${one.tone}`} /> {one.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
