import { IpoRow } from "./ipos.guru";

/**
 * What one lot costs, and what it would be worth at today's grey market
 * premium.
 *
 * Arithmetic and nothing more: GMP is an unofficial number that moves
 * daily, and this is what it implies for one lot, not a forecast. The app
 * words it that way too.
 */
export interface PerLot {
  costMinor: number;
  atGmpMinor: number;
  /// Negative when the grey market is below the issue price.
  gainMinor: number;
  gainPercent: number;
}

/**
 * Null when any of lot size, upper price or GMP is missing - an IPO with no
 * GMP yet has no figure, which is different from a GMP of 0 (no premium).
 */
export function perLot(row: Pick<IpoRow, "lotSize" | "priceMaxMinor" | "gmp">): PerLot | null {
  const { lotSize, priceMaxMinor, gmp } = row;
  if (!lotSize || !priceMaxMinor || !gmp) return null;
  const costMinor = lotSize * priceMaxMinor;
  const gainMinor = lotSize * gmp.premiumMinor;
  return {
    costMinor,
    atGmpMinor: costMinor + gainMinor,
    gainMinor,
    gainPercent: Math.round((gainMinor / costMinor) * 10_000) / 100,
  };
}
