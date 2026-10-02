import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The few pieces every chart on Home shares: its measured width, a clean
 * axis maximum, compact rupee labels and the hover tooltip.
 *
 * Charts are drawn in real pixels at the measured width rather than
 * stretched from a viewBox, so axis text stays the size it was set at on
 * a phone and on a wide monitor alike.
 */

/** The element's content width, kept up to date as the layout changes. */
export function useWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0].contentRect.width);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** Rounds up to 1, 2, 2.5 or 5 times a power of ten, so ticks read cleanly. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * power) return step * power;
  }
  return 10 * power;
}

const compact = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  notation: "compact",
  maximumFractionDigits: 1,
});

/** ₹1.2K, ₹3.5L: axis ticks and tight labels. Paise in, rupees out. */
export function formatCompact(amountMinor: number): string {
  return compact.format(amountMinor / 100);
}

/**
 * A column with a 4px rounded top and a square foot on the baseline. A
 * zero-height value draws nothing rather than a dot.
 */
export function columnPath(x: number, baseline: number, width: number, height: number, radius = 4): string {
  if (height <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  const top = baseline - height;
  return [
    `M${x},${baseline}`,
    `V${top + r}`,
    `Q${x},${top} ${x + r},${top}`,
    `H${x + width - r}`,
    `Q${x + width},${top} ${x + width},${top + r}`,
    `V${baseline}`,
    "Z",
  ].join(" ");
}

/**
 * The hover card. Placed over the hovered x and kept inside the chart, so
 * it never hangs off the edge of a card on a narrow screen.
 */
export function ChartTip({ x, width, children }: { x: number; width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tipWidth, setTipWidth] = useState(140);

  useEffect(() => {
    if (ref.current) setTipWidth(ref.current.offsetWidth);
  });

  const left = Math.max(0, Math.min(width - tipWidth, x - tipWidth / 2));
  return (
    <div className="viz-tip" ref={ref} style={{ left }} role="status">
      {children}
    </div>
  );
}

/** Arrow keys step through the points of a chart; Escape lets go. */
export function stepKeys(
  event: React.KeyboardEvent,
  count: number,
  current: number | null,
  set: (next: number | null) => void
) {
  if (count === 0) return;
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    const from = current ?? (event.key === "ArrowRight" ? -1 : count);
    const next = from + (event.key === "ArrowRight" ? 1 : -1);
    set(Math.max(0, Math.min(count - 1, next)));
  } else if (event.key === "Escape") {
    set(null);
  }
}
