import { useState } from "react";
import { formatMoney, formatMoneyShort, formatShortDate, istToday } from "../../lib/format";
import { DailySpend } from "../../types";
import { ChartTip, columnPath, formatCompact, niceMax, stepKeys, useWidth } from "./chartKit";

const SPEND_HEIGHT = 160;
const INCOME_HEIGHT = 36;
const GAP = 18;
const PAD_LEFT = 44;
const PAD_RIGHT = 4;
const PAD_TOP = 18;
const AXIS = 20;
const STUB = 14;

/**
 * Spending day by day as bars (design-system §7.13), with money in as a
 * strip of its own underneath.
 *
 * Past days are ink, today is the accent, and days still to come are
 * hollow stubs, so a month that isn't over doesn't read as one that went
 * quiet. Money in sits on its own small scale: a salary credit is a
 * hundred times a normal day's spending, and on a shared scale it would
 * flatten every day of spending into the floor.
 */
export function DailyChart({ days }: { days: DailySpend[] }) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const today = istToday();
  const shown = days.filter((day) => day.day <= today);
  const count = days.length;
  const plotWidth = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const slot = count > 0 ? plotWidth / count : 0;
  const bar = Math.max(3, Math.min(14, slot * 0.72));
  const xAt = (index: number) => PAD_LEFT + slot * index + slot / 2;

  const spendMax = niceMax(Math.max(0, ...shown.map((day) => day.spendMinor)));
  const incomeMax = Math.max(0, ...shown.map((day) => day.incomeMinor));
  const spendBase = PAD_TOP + SPEND_HEIGHT;
  const yAt = (value: number) => spendBase - (value / spendMax) * SPEND_HEIGHT;
  const incomeTop = spendBase + AXIS + GAP;
  const incomeBase = incomeTop + INCOME_HEIGHT;
  const totalHeight = incomeBase + 4;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * spendMax);

  const todayIndex = days.findIndex((day) => day.day === today);
  const total = shown.reduce((sum, day) => sum + day.spendMinor, 0);
  const peakIndex = shown.reduce(
    (best, day, index) => (day.spendMinor > 0 && (best < 0 || day.spendMinor > shown[best].spendMinor) ? index : best),
    -1
  );
  const peak = peakIndex >= 0 ? shown[peakIndex] : null;
  const activeDay = active !== null ? days[active] : null;

  // Axis labels: the first day, today, the last, and a few between that
  // keep clear of those, so they never crowd at any width.
  const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotWidth / 72))));
  const anchors = [0, todayIndex, count - 1].filter((index) => index >= 0);
  const labelled = new Set<number>(anchors);
  for (let index = every; index < count - 1; index += every) {
    if (anchors.every((anchor) => Math.abs(anchor - index) * slot > 52)) labelled.add(index);
  }

  function pick(clientX: number, element: SVGSVGElement) {
    const box = element.getBoundingClientRect();
    const index = Math.floor((clientX - box.left - PAD_LEFT) / (slot || 1));
    setActive(index >= 0 && index < shown.length ? index : null);
  }

  return (
    <div className="chart" ref={wrapRef}>
      <div className="chart-legend" aria-hidden="true">
        <span>
          <i className="chart-key is-spend" /> Spent each day
        </span>
        <span>
          <i className="chart-key is-today" /> Today
        </span>
        <span>
          <i className="chart-key is-future" /> Days to come
        </span>
        <span>
          <i className="chart-key is-income" /> Money in (own scale)
        </span>
      </div>

      {width > 0 && count > 0 && (
        <svg
          width={width}
          height={totalHeight}
          role="img"
          tabIndex={0}
          className={`chart-svg${active !== null ? " is-picking" : ""}`}
          aria-label={`Spending by day: ${formatMoney(total)} over ${shown.length} days${
            peak ? `, most on ${formatShortDate(`${peak.day}T12:00:00+05:30`)} at ${formatMoney(peak.spendMinor)}` : ""
          }. Use the arrow keys to read each day.`}
          onMouseMove={(event) => pick(event.clientX, event.currentTarget)}
          onMouseLeave={() => setActive(null)}
          onKeyDown={(event) => stepKeys(event, shown.length, active, setActive)}
          onBlur={() => setActive(null)}
        >
          {ticks.map((tick, index) => (
            <g key={index}>
              <line
                className={index === 0 ? "chart-base" : "chart-grid"}
                x1={PAD_LEFT}
                x2={width - PAD_RIGHT}
                y1={yAt(tick)}
                y2={yAt(tick)}
              />
              <text className="chart-axis" x={PAD_LEFT - 4} y={yAt(tick) + 4} textAnchor="end">
                {formatCompact(tick)}
              </text>
            </g>
          ))}

          {days.map((day, index) => {
            const x = xAt(index) - bar / 2;
            if (day.day > today) {
              return (
                <rect
                  key={day.day}
                  className="chart-future"
                  x={x + 0.5}
                  y={spendBase - STUB + 0.5}
                  width={Math.max(1, bar - 1)}
                  height={STUB - 1}
                  rx={2}
                />
              );
            }
            const height = spendBase - yAt(day.spendMinor);
            return (
              <path
                key={day.day}
                className={`chart-bar${index === todayIndex ? " is-today" : ""}${active === index ? " is-active" : ""}`}
                d={columnPath(x, spendBase, bar, height)}
              />
            );
          })}

          {peak && (
            <text className="chart-value" x={xAt(peakIndex)} y={yAt(peak.spendMinor) - 5} textAnchor="middle">
              {formatMoneyShort(peak.spendMinor)}
            </text>
          )}

          {days.map((day, index) =>
            labelled.has(index) ? (
              <text
                key={day.day}
                className={`chart-axis${index === todayIndex ? " is-today" : ""}`}
                x={xAt(index)}
                y={spendBase + 15}
                textAnchor={index === 0 ? "start" : index === count - 1 ? "end" : "middle"}
                dx={index === 0 ? -bar / 2 : index === count - 1 ? bar / 2 : 0}
              >
                {index === todayIndex ? "Today" : formatShortDate(`${day.day}T12:00:00+05:30`)}
              </text>
            ) : null
          )}

          {/* Money in: its own small panel and its own scale. */}
          <text className="chart-axis" x={PAD_LEFT - 4} y={incomeTop + 10} textAnchor="end">
            In
          </text>
          <line className="chart-base" x1={PAD_LEFT} x2={width - PAD_RIGHT} y1={incomeBase} y2={incomeBase} />
          {incomeMax > 0 &&
            shown.map((day, index) => {
              if (day.incomeMinor <= 0) return null;
              const height = Math.max(3, (day.incomeMinor / incomeMax) * INCOME_HEIGHT);
              return (
                <rect
                  key={day.day}
                  className="chart-income"
                  x={xAt(index) - bar / 2}
                  y={incomeBase - height}
                  width={bar}
                  height={height}
                  rx={Math.min(2, bar / 2)}
                />
              );
            })}
          {incomeMax === 0 && (
            <text className="chart-axis" x={PAD_LEFT + 4} y={incomeBase - 8}>
              Nothing came in this month
            </text>
          )}
        </svg>
      )}

      {activeDay && active !== null && (
        <ChartTip x={xAt(active)} width={width}>
          <div className="chart-tip-title">{formatShortDate(`${activeDay.day}T12:00:00+05:30`)}</div>
          <div className="chart-tip-row">
            <i className="chart-key is-spend" /> Spent <b className="num">{formatMoney(activeDay.spendMinor)}</b>
          </div>
          {activeDay.incomeMinor > 0 && (
            <div className="chart-tip-row">
              <i className="chart-key is-income" /> In <b className="num">{formatMoney(activeDay.incomeMinor)}</b>
            </div>
          )}
        </ChartTip>
      )}
    </div>
  );
}
