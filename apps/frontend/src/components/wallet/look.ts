import { CardNetwork } from "../../types";

/**
 * What a card or an account looks like: its colours, worked out from what
 * is known about it.
 *
 * A colour picked for the account wins. Without one, the bank's own colour
 * where it is one people would recognise, then the network's, then a
 * plain slate - so two cards from different banks rarely come out the
 * same, and nothing is ever left white-on-white.
 */

export interface Look {
  /** The card's background. */
  background: string;
  /** One solid colour for the same thing, for an accent or a monogram. */
  base: string;
  /** Whether the background is light enough to need dark text on it. */
  light: boolean;
}

/** Two stops per bank, matched on the name as typed. First match wins. */
const BANKS: [RegExp, string, string][] = [
  [/hdfc/i, "#0b2c63", "#1f56b0"],
  [/icici/i, "#7a1d1d", "#c2502a"],
  [/\bsbi\b|state bank/i, "#0b3a86", "#2a86d9"],
  [/axis/i, "#5e0f33", "#a51b55"],
  [/kotak/i, "#9c0f1d", "#e2353f"],
  [/idfc/i, "#6b1825", "#a3303f"],
  [/indusind/i, "#4a2615", "#94552c"],
  [/\byes\b/i, "#0a3570", "#1d6fc4"],
  [/\bau\b|au small/i, "#3c1659", "#d2691e"],
  [/hsbc/i, "#6e0000", "#d10a14"],
  [/standard chartered|\bsc\b/i, "#0a5c3a", "#1f9d5c"],
  [/citi/i, "#003a6c", "#0b73c9"],
  [/american express|\bamex\b/i, "#1e5b85", "#6f9fc2"],
  [/rbl/i, "#13325f", "#2c5e9e"],
  [/federal/i, "#0c3b6e", "#e8a317"],
  [/bank of baroda|\bbob\b/i, "#a53a14", "#e26a2c"],
  [/canara/i, "#0a5a8a", "#f0b323"],
  [/\bpnb\b|punjab national/i, "#7e1530", "#c2862b"],
  [/union bank/i, "#a0122a", "#1d4e9e"],
  [/onecard|one card/i, "#141414", "#3b3b3b"],
  [/slice/i, "#3a1a7a", "#7c4ddb"],
];

const NETWORKS: Record<CardNetwork, [string, string]> = {
  VISA: ["#141e5c", "#2c48a8"],
  MASTERCARD: ["#1d1d1f", "#4a4a4f"],
  RUPAY: ["#0e3d6b", "#1b7a5a"],
  AMEX: ["#1e5b85", "#6f9fc2"],
  DINERS: ["#22303f", "#4f6378"],
};

const PLAIN: [string, string] = ["#1e293b", "#475569"];

/** How light a #rrggbb colour is, 0 to 1. Anything else counts as dark. */
function lightness(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 0;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function lookFor(item: { color: string | null; bankName: string; issuer?: string | null; network?: CardNetwork | null }): Look {
  const own = item.color?.trim();
  if (own) {
    // A sheen across one colour, darkening towards the far corner, the way
    // light falls on a real card.
    return {
      background: `linear-gradient(135deg, ${own} 0%, color-mix(in srgb, ${own} 62%, #000) 100%)`,
      base: own,
      light: lightness(own) > 0.72,
    };
  }

  const name = `${item.issuer ?? ""} ${item.bankName}`;
  const bank = BANKS.find(([pattern]) => pattern.test(name));
  const [from, to] = bank ? [bank[1], bank[2]] : item.network ? NETWORKS[item.network] : PLAIN;
  return { background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)`, base: to, light: false };
}

/** "HD" for HDFC Bank, "SB" for SBI: two letters for a monogram. */
export function monogram(name: string): string {
  const words = name.replace(/\bbank\b/gi, "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "₹";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
