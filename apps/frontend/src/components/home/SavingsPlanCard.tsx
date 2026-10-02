import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { formatDateTime, formatMoney, formatShortDate } from "../../lib/format";
import { SavingsPlan } from "../../types";
import { Icon } from "../Icon";
import { RuleLine } from "./PlanWarnings";

type State =
  | { kind: "loading" }
  | { kind: "noKey" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; plan: SavingsPlan | null };

/** What the wait is spent on, said in turn so 20 seconds doesn't feel stuck. */
const STEPS = [
  "Looking over the last few months…",
  "Finding where the money tends to go…",
  "Working out what could be saved…",
  "Writing the rules down…",
];

/**
 * A savings plan written from your own spending, with each rule scored
 * against this month as it goes.
 *
 * Writing one takes the model a while, so it happens only when asked —
 * "Make my savings plan" the first time, "Rewrite plan" after. Keeping
 * score is the server's job and costs nothing, so the pills and bars are
 * always current. The rules being broken also show on the Dashboard.
 */
export function SavingsPlanCard() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [writing, setWriting] = useState(false);
  const [step, setStep] = useState(0);
  const [writeError, setWriteError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ plan: SavingsPlan | null }>("/ai/plan")
      .then((result) => setState({ kind: "ready", plan: result.plan }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 409) setState({ kind: "noKey" });
        else setState({ kind: "failed", message: err instanceof Error ? err.message : "Couldn't load the plan." });
      });
  }, []);

  useEffect(() => {
    if (!writing) return;
    setStep(0);
    const id = window.setInterval(() => setStep((current) => Math.min(STEPS.length - 1, current + 1)), 6000);
    return () => window.clearInterval(id);
  }, [writing]);

  async function write() {
    setWriting(true);
    setWriteError(null);
    try {
      const result = await api.post<{ plan: SavingsPlan | null }>("/ai/plan");
      setState({ kind: "ready", plan: result.plan });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setState({ kind: "noKey" });
      else setWriteError(err instanceof Error ? err.message : "Couldn't write the plan just now.");
    } finally {
      setWriting(false);
    }
  }

  const plan = state.kind === "ready" ? state.plan : null;

  return (
    <div className="home-card ai-card">
      <div className="home-card-head">
        <h3 className="home-card-title">
          <Icon name="ic-percent" /> Savings plan
        </h3>
        {plan && !writing && (
          <button className="btn btn-sm" onClick={write}>
            <Icon name="ic-pencil" /> Rewrite plan
          </button>
        )}
      </div>

      {writing ? (
        <div className="ai-wait" aria-live="polite">
          <span className="ask-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <p>{STEPS[step]} This takes up to half a minute.</p>
        </div>
      ) : state.kind === "loading" ? (
        <p className="section-sub">Loading the plan…</p>
      ) : state.kind === "noKey" ? (
        <div className="ai-empty">
          <p className="section-sub">The plan is written by Gemini using your own key.</p>
          <Link className="btn btn-primary btn-sm" to="/settings?tab=ai">
            Add a key in Settings
          </Link>
        </div>
      ) : state.kind === "failed" ? (
        <p className="section-sub set-warn">
          <Icon name="ic-alert" /> {state.message}
        </p>
      ) : !plan ? (
        <div className="ai-empty">
          <p className="section-sub">
            A few plain rules for saving more, worked out from where your money actually goes — then checked
            against every month, with a warning on the Dashboard whenever one slips.
          </p>
          <button className="btn btn-primary btn-sm" onClick={write}>
            <Icon name="ic-spark" /> Make my savings plan
          </button>
        </div>
      ) : (
        <>
          <p className="plan-summary">{plan.summary}</p>
          {plan.monthlyTargetMinor != null && (
            <div className="plan-target">
              <span className="home-figure-sub">Aim to save each month</span>
              <span className="plan-target-figure">{formatMoney(plan.monthlyTargetMinor)}</span>
            </div>
          )}
          <ul className="plan-rules">
            {plan.rules.map((rule, index) => (
              <li key={`${rule.text}-${index}`}>
                <RuleLine rule={rule} />
              </li>
            ))}
          </ul>
          <p className="ai-meta">
            Scored for {formatShortDate(plan.month.from)} – {formatShortDate(plan.month.to)} · written{" "}
            {formatDateTime(plan.updatedAt)}
          </p>
        </>
      )}

      {writeError && (
        <p className="section-sub set-warn">
          <Icon name="ic-alert" /> {writeError}
        </p>
      )}
    </div>
  );
}
