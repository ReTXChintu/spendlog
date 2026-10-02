import { useState } from "react";
import { formatMoney, formatShortDate, istToday } from "../../lib/format";
import { DailySpend } from "../../types";
import { ChartTip, formatCompact, niceMax, stepKeys, useWidth } from "./chartKit";

const SPEND_HEIGHT = 170;
const INCOME_HEIGHT = 44;
const GAP = 22;
const PAD_LEFT = 48;
const PAD_RIGHT = 10;
const PAD_TOP = 8;
const AXIS = 20;

/**
 * Spending day by day, with money in as a strip of its own underneath.
 *
 * Two panels on one shared day axis rather than one chart with two
 * scales: a salary credit is a hundred times a normal day's spending, and
 * on a shared scale it would flatten every day of spending into the floor.
 * Days still to come are left off rather than drawn as zero, so the line
 * doesn't dive at the end of a month that isn't over.
 */
export function DailyChart({ days }: { days: DailySpend[] }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const today = istToday();
  const shown = days.filter((day) => day.day <= today);
  const count = days.length;
  const plotWidth = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const step = count > 1 ? plotWidth / (count - 1) : 0;
  const xAt = (index: number) => PAD_LEFT + (count > 1 ? index * step : plotWidth / 2);

  const spendMax = niceMax(Math.max(0, ...shown.map((day) => day.spendMinor)));
  const incomeMax = Math.max(0, ...shown.map((day) => day.incomeMinor));
  const spendBase = PAD_TOP + SPEND_HEIGHT;
  const yAt = (value: number) => spendBase - (value / spendMax) * SPEND_HEIGHT;
  const incomeTop = spendBase + AXIS + GAP;
  const incomeBase = incomeTop + INCOME_HEIGHT;
  const totalHeight = incomeBase + 4;

  const line = shown.map((day, index) => `${index === 0 ? "M" : "L"}${xAt(index)},${yAt(day.spendMinor)}`).join(" ");
  const area = shown.length
    ? `${line} L${xAt(shown.length - 1)},${spendBase} L${xAt(0)},${spendBase} Z`
    : "";

  // A label every few days, chosen so they never crowd at phone width.
  const labelEvery = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotWidth / 46))));
  const ticks = [0, spendMax / 2, spendMax];
  const incomeBar = Math.max(2, Math.min(10, step - 2));

  const total = shown.reduce((sum, day) => sum + day.spendMinor, 0);
  const peak = shown.reduce<DailySpend | null>((best, day) => (!best || day.spendMinor > best.spendMinor ? day : best), null);
  const activeDay = active !== null ? days[active] : null;

  function pick(clientX: number, element: SVGSVGElement) {
    const box = element.getBoundingClientRect();
    const x = clientX - box.left - PAD_LEFT;
    const index = Math.round(count > 1 ? x / step : 0);
    setActive(index >= 0 && index < shown.length ? index : null);
  }

  return (
    <div className="viz" ref={wrapRef}>
      {width > 0 && count > 0 && (
        <svg
          width={width}
          height={totalHeight}
          role="img"
          tabIndex={0}
          className="viz-svg"
          aria-label={`Spending by day: ${formatMoney(total)} over ${shown.length} days${
            peak && peak.spendMinor > 0 ? `, most on ${formatShortDate(peak.day)} at ${formatMoney(peak.spendMinor)}` : ""
          }. Use the arrow keys to read each day.`}
          onMouseMove={(event) => pick(event.clientX, event.currentTarget)}
          onMouseLeave={() => setActive(null)}
          onKeyDown={(event) => stepKeys(event, shown.length, active, setActive)}
          onBlur={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="viz-grid" x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={yAt(tick)} y2={yAt(tick)} />
              <text className="viz-axis" x={PAD_LEFT - 8} y={yAt(tick) + 4} textAnchor="end">
                {formatCompact(tick)}
              </text>
            </g>
          ))}

          <path className="viz-area" d={area} />
          <path className="viz-line" d={line} />

          {days.map((day, index) =>
            index % labelEvery === 0 ? (
              <text key={day.day} className="viz-axis" x={xAt(index)} y={spendBase + 15} textAnchor="middle">
                {Number(day.day.slice(8))}
              </text>
            ) : null
          )}

          {/* Money in: its own small panel and its own scale. */}
          <text className="viz-axis viz-axis-title" x={PAD_LEFT - 8} y={incomeTop + 10} textAnchor="end">
            In
          </text>
          <line className="viz-base" x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={incomeBase} y2={incomeBase} />
          {incomeMax > 0 &&
            shown.map((day, index) => {
              if (day.incomeMinor <= 0) return null;
              const height = Math.max(3, (day.incomeMinor / incomeMax) * INCOME_HEIGHT);
              return (
                <rect
                  key={day.day}
                  className="viz-income"
                  x={xAt(index) - incomeBar / 2}
                  y={incomeBase - height}
                  width={incomeBar}
                  height={height}
                  rx={Math.min(2, incomeBar / 2)}
                />
              );
            })}
          {incomeMax === 0 && (
            <text className="viz-axis" x={PAD_LEFT} y={incomeBase - 8}>
              Nothing came in this month
            </text>
          )}

          {activeDay && active !== null && (
            <g>
              <line className="viz-cross" x1={xAt(active)} x2={xAt(active)} y1={PAD_TOP} y2={incomeBase} />
              <circle className="viz-dot" cx={xAt(active)} cy={yAt(activeDay.spendMinor)} r={4.5} />
            </g>
          )}
        </svg>
      )}

      {activeDay && active !== null && (
        <ChartTip x={xAt(active)} width={width}>
          <div className="viz-tip-title">{formatShortDate(`${activeDay.day}T12:00:00+05:30`)}</div>
          <div className="viz-tip-row">
            <i className="viz-key is-spend" /> Spent <b className="num">{formatMoney(activeDay.spendMinor)}</b>
          </div>
          {activeDay.incomeMinor > 0 && (
            <div className="viz-tip-row">
              <i className="viz-key is-income" /> In <b className="num">{formatMoney(activeDay.incomeMinor)}</b>
            </div>
          )}
        </ChartTip>
      )}

      <div className="viz-legend">
        <span>
          <i className="viz-key is-spend" /> Spent each day
        </span>
        <span>
          <i className="viz-key is-income" /> Money in (own scale)
        </span>
      </div>
    </div>
  );
}
