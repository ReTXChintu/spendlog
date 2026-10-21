import { useRef, useState, useSyncExternalStore } from "react";
import { ImportJob, importPerkImages } from "../lib/perkImage";
import {
  askToNotify,
  finishedDetail,
  finishedHeadline,
  getImportState,
  setLastFinished,
  subscribeImports,
  trackImport,
} from "../lib/perkImports";
import { Icon } from "./Icon";
import "../styles/perks.css";

/**
 * The one way in for coupon screenshots, one or forty.
 *
 * Reading is ~30 s a picture on the server, so nothing here waits for it:
 * the pictures are shrunk and sent (a few seconds), the server says it has
 * them, and the page is yours again. PerkImportWatcher, mounted in the
 * layout, does the waiting and tells you when they are done.
 */
export function PerkImportBar({
  onStarted,
  onError,
}: {
  onStarted: (job: ImportJob) => void;
  onError: (message: string) => void;
}) {
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  async function send(files: File[]) {
    setSending({ done: 0, total: files.length });
    try {
      const job = await importPerkImages(files, (done, total) => setSending({ done, total }));
      trackImport(job);
      onStarted(job);
    } catch (problem) {
      onError(problem instanceof Error ? problem.message : "Those screenshots could not be sent.");
    } finally {
      setSending(null);
    }
  }

  return (
    <>
      <input
        ref={picker}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          // Cleared so the same pictures can be picked again after a bad read.
          event.target.value = "";
          if (files.length > 40) {
            onError("That's more than 40 screenshots. Send them in a few smaller batches.");
            return;
          }
          if (files.length > 0) send(files);
        }}
      />

      <button
        className="btn btn-lg"
        disabled={sending !== null}
        onClick={() => {
          // Asked here, when "tell me when it's done" is the obvious next
          // thought, and inside the click so browsers allow the prompt.
          askToNotify();
          picker.current?.click();
        }}
      >
        {sending ? <span className="spinner sm" aria-hidden="true" /> : <Icon name="ic-upload" />}
        {sending ? `Sending ${sending.done} of ${sending.total}…` : "Choose files"}
      </button>
    </>
  );
}

/**
 * The quiet line on the perks page while a batch is being read, and the
 * summary of the last one once it is done (with what could not be read).
 */
export function PerkImportStatus() {
  const { running, lastFinished } = useSyncExternalStore(subscribeImports, getImportState);

  if (running.length > 0) {
    const total = running.reduce((sum, job) => sum + job.total, 0);
    const read = running.reduce((sum, job) => sum + job.counts.done + job.counts.failed, 0);
    // The one in hand, counted from one: "Reading 1 of 5" as soon as it starts.
    const current = Math.min(read + 1, total);

    return (
      <div className="card import-card" role="status" aria-live="polite" aria-busy="true">
        <div className="import-head">
          <span className="spinner" aria-hidden="true" />
          <div className="import-head-main">
            <div className="import-title">
              Reading {total} {total === 1 ? "screenshot" : "screenshots"}…
            </div>
            <div className="import-sub">
              We’ll notify you when your coupons are ready. You can leave this page.
            </div>
          </div>
          <span className="import-count num">
            {current} of {total}
          </span>
        </div>
        <div className="meter import-meter" aria-hidden="true">
          <div className="meter-fill" style={{ width: `${total ? Math.round((read / total) * 100) : 0}%` }} />
        </div>
      </div>
    );
  }

  if (!lastFinished) return null;

  const detail = finishedDetail(lastFinished);
  return (
    <div className="card import-card">
      <div className="import-head">
        <span className={`icon-tile ${lastFinished.failures.length > 0 ? "tile-warn" : "tile-good"}`}>
          <Icon name={lastFinished.failures.length > 0 ? "ic-alert-triangle" : "ic-check"} />
        </span>
        <div className="import-head-main">
          <div className="import-title">{finishedHeadline(lastFinished)}</div>
          {detail && <div className="import-sub">{detail}.</div>}
        </div>
        <button className="icon-btn" onClick={() => setLastFinished(null)} aria-label="Dismiss">
          <Icon name="ic-x" />
        </button>
      </div>
      {lastFinished.failures.length > 0 && (
        <ul className="import-failures">
          {lastFinished.failures.map((failure, index) => (
            <li key={`${failure.fileName}-${index}`}>
              <span className="mono import-file">{failure.fileName}</span>
              <span className="import-problem">{failure.problem ?? "Couldn’t be read"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
