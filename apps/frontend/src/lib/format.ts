/** Amounts are stored in paise; always shown as ₹ with Indian grouping. */
export function formatMoney(amountMinor: number, currency = "INR"): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amountMinor / 100);
}

/** Compact form for tiles and rollups: ₹42,318 with no paise. */
export function formatMoneyShort(amountMinor: number, currency = "INR"): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

/**
 * Everything is shown in IST, whatever the browser's own timezone is.
 *
 * A ledger read from a laptop abroad should still say a payment happened on
 * the evening of the 11th, because that is when it happened. Relying on the
 * device's clock would quietly renumber the days.
 */
const IST = "Asia/Kolkata";
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Today's date in IST, as YYYY-MM-DD. */
export function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function formatDayLabel(isoDate: string): string {
  const today = istToday();
  if (isoDate === today) return "Today";

  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  if (isoDate === yesterday) return "Yesterday";

  // Read back at noon IST so the label can't slip a day either way.
  return new Date(`${isoDate}T12:00:00+05:30`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: IST,
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: IST,
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: IST,
  });
}

/** "September 2026" for the analytics month picker. */
export function formatMonthLabel(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Shifts a YYYY-MM string by a number of months. */
export function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, mon - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

export function currentMonth(): string {
  // The IST month: at 1am on the 1st, UTC still says last month.
  return istToday().slice(0, 7);
}
