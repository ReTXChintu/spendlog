import { AccountDoc } from "../../models";

/**
 * How an account and its money are written in a sentence - a to-do, a
 * notification, a reconciler's explanation. Kept apart from the modules
 * that write those sentences so they can share it without importing one
 * another.
 */

/** "HDFC ••8342", or the nickname when there is one. */
export function accountLabel(account: Pick<AccountDoc, "nickname" | "bankName" | "last4">): string {
  const name = account.nickname || account.bankName;
  return account.last4 ? `${name} ••${account.last4}` : name;
}

/** "₹5,000", always positive: the sentence says which way. */
export const rupees = (minor: number) =>
  `₹${(Math.abs(minor) / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** "12 Oct", in IST. */
export const shortDay = (at: Date) =>
  at.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/**
 * When something happened somewhere in a window, in IST: "on 12 Oct",
 * "between 10 and 12 Oct", "between 30 Sep and 2 Oct".
 */
export function windowText(from: Date, to: Date): string {
  const first = shortDay(from);
  const last = shortDay(to);
  if (first === last) return `on ${last}`;
  const month = (at: Date) => at.toLocaleDateString("en-IN", { month: "short", timeZone: "Asia/Kolkata" });
  if (month(from) === month(to)) {
    const dayOf = (at: Date) => at.toLocaleDateString("en-IN", { day: "numeric", timeZone: "Asia/Kolkata" });
    return `between ${dayOf(from)} and ${last}`;
  }
  return `between ${first} and ${last}`;
}
