import { ImportJob } from "./perkImage";

/**
 * Screenshot imports the app is waiting on, shared app-wide.
 *
 * The reading takes about half a minute a picture on the server, so the
 * upload hands the UI straight back and this remembers what is still
 * being read. The watcher (mounted once in the layout) polls and writes
 * here; the perks page only reads, so it can show "Reading 2 of 5…"
 * without a second poller of its own.
 *
 * The ids are also kept in localStorage: close the tab, come back after
 * the batch finished, and you still hear that it is done.
 */

const STORAGE_KEY = "spendlog-perk-imports";

export interface ImportState {
  /** Jobs still QUEUED or RUNNING, newest last. */
  running: ImportJob[];
  /** The batch that finished most recently in this session, for its summary. */
  lastFinished: ImportJob | null;
}

let state: ImportState = { running: [], lastFinished: null };
const listeners = new Set<() => void>();
const finishedListeners = new Set<(job: ImportJob) => void>();
const startedListeners = new Set<() => void>();

export function getImportState(): ImportState {
  return state;
}

export function subscribeImports(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setRunning(running: ImportJob[]): void {
  state = { ...state, running };
  saveIds(running.map((job) => job.id));
  listeners.forEach((listener) => listener());
}

export function setLastFinished(job: ImportJob | null): void {
  state = { ...state, lastFinished: job };
  listeners.forEach((listener) => listener());
}

/** Called by the uploader the moment the server accepts a batch. */
export function trackImport(job: ImportJob): void {
  if (!state.running.some((known) => known.id === job.id)) {
    setRunning([...state.running, job]);
  }
  startedListeners.forEach((listener) => listener());
}

/** Lets the watcher start polling straight away rather than on its next tick. */
export function onImportStarted(listener: () => void): () => void {
  startedListeners.add(listener);
  return () => startedListeners.delete(listener);
}

export function onImportFinished(listener: (job: ImportJob) => void): () => void {
  finishedListeners.add(listener);
  return () => finishedListeners.delete(listener);
}

export function announceFinished(job: ImportJob): void {
  finishedListeners.forEach((listener) => listener(job));
}

export function isFinished(job: ImportJob): boolean {
  return job.status === "DONE" || job.status === "FAILED";
}

export function savedIds(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function saveIds(ids: string[]): void {
  try {
    if (ids.length > 0) localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the watcher still works for this tab, it just
    // cannot pick a job back up after a reload.
  }
}

/** "3 coupons ready to review", or what went wrong instead. */
export function finishedHeadline(job: ImportJob): string {
  if (job.status === "FAILED") return job.problem ?? "That batch of screenshots did not finish.";
  if (job.added > 0) {
    return `${job.added} ${job.added === 1 ? "coupon" : "coupons"} ready to review`;
  }
  if (job.duplicates > 0) return "Done reading — you already had all of those";
  return "Done reading — no coupons found in those screenshots";
}

/** The smaller print under the headline. */
export function finishedDetail(job: ImportJob): string {
  const parts: string[] = [];
  if (job.status !== "FAILED" && job.added > 0 && job.duplicates > 0) {
    parts.push(`${job.duplicates} you already had`);
  }
  // Duplicates are recorded as DONE items, so "failed" here really is unreadable.
  if (job.counts.failed > 0) parts.push(`${job.counts.failed} could not be read`);
  return parts.join(", ");
}

/**
 * Ask once, at the moment somebody starts a batch — that is when "tell me
 * when it's done" makes sense, rather than as a prompt on page load.
 * Refused or unsupported is fine: the in-app toast still appears.
 */
export function askToNotify(): void {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission().catch(() => undefined);
    }
  } catch {
    // Some embedded browsers throw on the bare property access.
  }
}
