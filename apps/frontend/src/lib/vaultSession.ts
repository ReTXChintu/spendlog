import { useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * One PIN entry, every card and bank account.
 *
 * The server still checks the PIN on the request that reveals - there is
 * no token that stays unlocked. What changes is that one request brings
 * back everything, and this page holds it in memory for a few minutes, so
 * reading three card numbers is one prompt rather than three. Nothing is
 * written to storage; a reload, a sign-out or the timer drops it.
 */

export interface OpenedDetails {
  accountId: string;
  number: string;
  expiry: string | null;
  nameOnCard: string | null;
  ifsc: string | null;
  note: string | null;
  last4: string;
}

export interface VaultSession {
  details: Map<string, OpenedDetails>;
  /** Kept so saving or replacing details needs no second prompt. */
  pin: string;
  locksAt: number;
}

const UNLOCKED_FOR_MS = 5 * 60 * 1000;

let session: VaultSession | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: VaultSession | null) {
  session = next;
  if (timer) clearTimeout(timer);
  timer = next ? setTimeout(() => publish(null), Math.max(0, next.locksAt - Date.now())) : null;
  listeners.forEach((listener) => listener());
}

/** Checks the PIN and opens everything. Throws the server's message on a wrong one. */
export async function unlockVault(pin: string): Promise<void> {
  const rows = await api.post<OpenedDetails[]>("/vault/reveal", { pin });
  publish({
    details: new Map(rows.map((row) => [row.accountId, row])),
    pin,
    locksAt: Date.now() + UNLOCKED_FOR_MS,
  });
}

export function lockVault(): void {
  publish(null);
}

/** Refreshes one account's copy after its details were saved or removed. */
export function replaceDetails(accountId: string, details: OpenedDetails | null): void {
  if (!session) return;
  const map = new Map(session.details);
  if (details) map.set(accountId, details);
  else map.delete(accountId);
  publish({ ...session, details: map });
}

export function useVaultSession(): VaultSession | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => session
  );
}
