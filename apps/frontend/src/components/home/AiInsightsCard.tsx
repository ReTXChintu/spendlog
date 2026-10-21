import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { AiInsight } from "../../types";
import { Icon } from "../Icon";
import { Markdown } from "../Markdown";

type InsightResponse = { insight: AiInsight | null; hasKey: boolean; model: string };

type State =
  | { kind: "loading" }
  | { kind: "noKey" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; insight: AiInsight | null };

/**
 * A short read of the month, written by the model once a day.
 *
 * The server makes at most one a day on its own — the first visit of the
 * day pays the wait, everyone after reads the stored one — and "New
 * insight" is the deliberate way past that. The wait gets a sentence
 * rather than a spinner over the page: the charts around it are ready and
 * worth reading in the meantime.
 */
export function AiInsightsCard() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  function settle(promise: Promise<InsightResponse>) {
    return promise
      .then((result) => setState(result.hasKey ? { kind: "ready", insight: result.insight } : { kind: "noKey" }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) setState({ kind: "noKey" });
        else setState({ kind: "failed", message: err instanceof Error ? err.message : "Couldn't get an insight." });
      });
  }

  useEffect(() => {
    settle(api.get<InsightResponse>("/ai/insights"));
  }, []);

  async function refresh() {
    setRefreshing(true);
    await settle(api.post<InsightResponse>("/ai/insights/refresh"));
    setRefreshing(false);
  }

  const insight = state.kind === "ready" ? state.insight : null;

  return (
    <section className="card ai-card" aria-labelledby="ai-insight-title">
      <div className="ai-head">
        <span className="icon-tile tile-ac" aria-hidden="true">
          <Icon name="ic-sparkles" />
        </span>
        <div className="ai-head-text">
          <h2 id="ai-insight-title">Today’s insight</h2>
          <p className="ai-byline">Uses your Gemini key</p>
        </div>
        {(state.kind === "ready" || state.kind === "failed") && (
          <button className="btn btn-sm" onClick={refresh} disabled={refreshing}>
            <Icon name="ic-refresh" /> {refreshing ? "Writing…" : "New insight"}
          </button>
        )}
      </div>

      {state.kind === "loading" || refreshing ? (
        <div className="ai-wait" aria-live="polite">
          <span className="spinner sm" aria-hidden="true" />
          <p>
            Reading this month's spending. The first look each day takes up to half a minute — the charts
            are ready in the meantime.
          </p>
        </div>
      ) : state.kind === "noKey" ? (
        <div className="ai-empty">
          <p className="ai-sub">
            Insights and the savings plan use your own free Gemini key. Add one and a fresh read of your
            month appears here once a day.
          </p>
          <Link className="btn btn-primary btn-sm" to="/settings?tab=ai">
            Add a key in Settings
          </Link>
        </div>
      ) : state.kind === "failed" ? (
        <p className="ai-sub ai-error">
          <Icon name="ic-alert-triangle" /> {state.message}
        </p>
      ) : insight ? (
        <>
          <Markdown text={insight.text} className="ai-text" />
          <p className="ai-meta">
            Written {formatDateTime(insight.updatedAt)} · {insight.model} · refreshes once a day
          </p>
        </>
      ) : (
        <p className="ai-sub">Nothing to say yet — a few transactions in, there will be.</p>
      )}
    </section>
  );
}
