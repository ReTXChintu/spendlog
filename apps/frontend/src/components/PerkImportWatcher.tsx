import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import { ImportJob } from "../lib/perkImage";
import {
  announceFinished,
  finishedDetail,
  finishedHeadline,
  getImportState,
  isFinished,
  onImportStarted,
  savedIds,
  setLastFinished,
  setRunning,
} from "../lib/perkImports";
import { Icon } from "./Icon";
import "../styles/perks.css";

/**
 * Tells you when a batch of coupon screenshots has been read, wherever
 * you are in the app.
 *
 * Mounted once in the layout. It polls only while something is being
 * read — nothing at all otherwise — and picks a batch back up after a
 * reload, so "you'll be notified" stays true even if you wander off.
 */

/** About a third of one picture's reading time: prompt enough, nearly free. */
const POLL_MS = 10_000;

export function PerkImportWatcher() {
  const [toast, setToast] = useState<ImportJob | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const alive = useRef(true);

  const poll = useCallback(async (ids: string[]) => {
    window.clearTimeout(timer.current);
    if (ids.length === 0) return;
    if (busy.current) {
      // A look is already in flight; its result will schedule the next one.
      return;
    }
    busy.current = true;

    const known = new Map(getImportState().running.map((job) => [job.id, job]));
    const results = await Promise.all(
      ids.map((id) =>
        api.get<ImportJob>(`/perks/import/${id}`).catch((error) =>
          // Gone (or someone else's after a sign-out): stop asking. Any other
          // failure is a blip — keep the last thing we knew and try again.
          error instanceof ApiError && error.status === 404 ? null : (known.get(id) ?? null)
        )
      )
    );
    busy.current = false;
    if (!alive.current) return;

    const jobs = results.filter((job): job is ImportJob => job !== null);
    // Keep any batch started while this look was in flight.
    const startedMeanwhile = getImportState().running.filter((job) => !ids.includes(job.id));
    const running = [...jobs.filter((job) => !isFinished(job)), ...startedMeanwhile];
    const finished = jobs.filter(isFinished);

    setRunning(running);
    for (const job of finished) {
      announceFinished(job);
      setLastFinished(job);
      setToast(job);
      notifyBrowser(job);
    }

    if (running.length > 0) {
      timer.current = window.setTimeout(
        () => poll(getImportState().running.map((job) => job.id)),
        POLL_MS
      );
    }
  }, []);

  // On load: carry on with whatever this browser was waiting for, plus the
  // newest batch if it is still going (it may have been started on the phone).
  useEffect(() => {
    alive.current = true;
    const ids = new Set(savedIds());

    api
      .get<ImportJob | null>("/perks/import")
      .then((latest) => {
        if (latest && !isFinished(latest)) ids.add(latest.id);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive.current) poll([...ids]);
      });

    // A new batch was just accepted: nothing to read yet, so the first look
    // is one interval away.
    const stop = onImportStarted(() => {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(
        () => poll(getImportState().running.map((job) => job.id)),
        POLL_MS
      );
    });

    return () => {
      alive.current = false;
      stop();
      window.clearTimeout(timer.current);
    };
  }, [poll]);

  if (!toast) return null;

  const detail = finishedDetail(toast);
  const good = toast.status === "DONE" && toast.added > 0;

  return (
    <div className="perk-toast-wrap">
      <div className={`perk-toast${good ? "" : " is-quiet"}`} role="status" aria-live="polite">
        <Icon name={good ? "ic-check" : "ic-info"} />
        <div className="perk-toast-body">
          <b>{finishedHeadline(toast)}</b>
          {detail && <span>{detail}</span>}
        </div>
        {good && (
          <Link className="btn btn-sm btn-primary" to="/perks" onClick={() => setToast(null)}>
            Review
          </Link>
        )}
        <button
          className="btn btn-sm btn-ghost perk-toast-close"
          onClick={() => setToast(null)}
          aria-label="Dismiss"
        >
          <Icon name="ic-x" />
        </button>
      </div>
    </div>
  );
}

/**
 * A system notification, for when SpendLog is not the tab you are looking
 * at. Skipped while it is, because the toast is already on screen and two
 * of the same message is noise.
 */
function notifyBrowser(job: ImportJob): void {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;

    const detail = finishedDetail(job);
    const note = new Notification(`SpendLog: ${finishedHeadline(job)}`, {
      body: detail || "Open Perks to check them over.",
      tag: `perk-import-${job.id}`,
    });
    note.onclick = () => {
      window.focus();
      // A full navigation is fine here: the tab was in the background anyway.
      if (window.location.pathname !== "/perks") window.location.assign("/perks");
      note.close();
    };
  } catch {
    // Unsupported or blocked: the in-app toast is the fallback.
  }
}
