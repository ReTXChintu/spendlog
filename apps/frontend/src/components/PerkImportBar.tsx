import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { ImportJob, importPerkImages } from "../lib/perkImage";
import { Icon } from "./Icon";

/**
 * A pile of screenshots, being read.
 *
 * The reading happens on the server and takes tens of seconds a picture,
 * so this is a progress line rather than a wait. It picks up a job that
 * was already running when the page loaded, which is the point of the job
 * being a document: close the tab, come back, and it is still going.
 *
 * Polled rather than pushed. One request every few seconds for a few
 * minutes is nothing next to a socket to maintain for a thing that
 * happens occasionally.
 */

/** Often enough to feel live, rarely enough to be free. */
const POLL_MS = 3000;

export function PerkImportBar({ onFinished }: { onFinished: () => void }) {
  const [job, setJob] = useState<ImportJob | null>(null);
  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Held so the "all done" callback fires once, on the edge, rather than
  // on every poll after it.
  const wasRunning = useRef(false);

  const check = useCallback(() => {
    api
      .get<ImportJob | null>("/perks/import")
      .then(setJob)
      .catch(() => undefined);
  }, []);

  useEffect(check, [check]);

  useEffect(() => {
    if (!job || job.status === "DONE" || job.status === "FAILED") {
      if (wasRunning.current) {
        wasRunning.current = false;
        onFinished();
      }
      return;
    }

    wasRunning.current = true;
    const timer = setTimeout(check, POLL_MS);
    return () => clearTimeout(timer);
  }, [job, check, onFinished]);

  async function send(files: File[]) {
    setError(null);
    setPreparing({ done: 0, total: files.length });
    try {
      const started = await importPerkImages(files, (done, total) => setPreparing({ done, total }));
      setJob(started);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Those pictures could not be sent.");
    } finally {
      setPreparing(null);
    }
  }

  const running = job !== null && job.status !== "DONE" && job.status !== "FAILED";
  const read = job ? job.counts.done + job.counts.failed : 0;

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
          // Cleared so the same folder can be picked twice, which is what
          // you do after a batch half worked.
          event.target.value = "";
          if (files.length > 0) send(files);
        }}
      />

      <button
        className="btn btn-sm"
        disabled={running || preparing !== null}
        onClick={() => picker.current?.click()}
      >
        <Icon name="ic-search" />
        {preparing
          ? `Preparing ${preparing.done} of ${preparing.total}…`
          : running
            ? "Reading…"
            : "Read screenshots"}
      </button>

      {error && <p className="desc set-warn">{error}</p>}

      {job && (
        <div className={`import-bar${running ? " is-running" : ""}`}>
          <div className="import-head">
            <span>
              {running ? (
                <>
                  Reading your screenshots — <b>{read}</b> of <b>{job.total}</b> done.
                </>
              ) : job.status === "FAILED" ? (
                <>{job.problem ?? "That batch did not finish."}</>
              ) : (
                <>{summary(job)}</>
              )}
            </span>
            {!running && (
              <button className="btn btn-sm btn-ghost" onClick={() => setJob(null)}>
                <Icon name="ic-x" />
              </button>
            )}
          </div>

          {job.total > 0 && (
            <div className="import-meter">
              <div
                className="import-fill"
                style={{ width: `${Math.round((read / job.total) * 100)}%` }}
              />
            </div>
          )}

          {running && (
            <p className="field-hint">
              The model is on your own server and runs on its processor, so this is roughly half a
              minute a picture. You can leave this page — it carries on without you.
            </p>
          )}

          {job.failures.length > 0 && (
            <ul className="import-failures">
              {job.failures.map((failure) => (
                <li key={failure.fileName}>
                  <b>{failure.fileName}</b> — {failure.problem ?? "could not be read"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** What happened, in the order somebody would want to hear it. */
function summary(job: ImportJob): string {
  const parts = [`${job.added} added`];

  if (job.duplicates > 0) parts.push(`${job.duplicates} you already had`);
  if (job.counts.failed > 0) parts.push(`${job.counts.failed} could not be read`);

  return `${parts.join(", ")}. Check them over below.`;
}
