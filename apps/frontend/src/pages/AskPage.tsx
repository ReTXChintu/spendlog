import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { AiMessage, AiSettings } from "../types";

const SUGGESTIONS = [
  "How much did I spend on eating out this month?",
  "Give me insights on this month's spending",
  "What are my top 5 merchants this month?",
  "How am I doing against my budget?",
  "How much is left on my loans?",
];

/** What each lookup the model made is, in the user's words. */
const LOOKUP_LABELS: Record<string, string> = {
  list_categories: "your categories",
  spending_summary: "your totals",
  find_transactions: "your transactions",
  budget_status: "your budget",
  loans_and_emis: "your loans and EMIs",
};

interface Turn extends AiMessage {
  /** A question that got no answer, or the error that came back instead. */
  failed?: boolean;
  lookups?: string[];
}

/**
 * Ask about your own money, and get an answer from your own transactions.
 *
 * The conversation lives only on this screen: it is sent whole with each
 * question, so a follow-up like "and last month?" knows what "and" means,
 * and nothing about what was asked is kept anywhere once you leave.
 */
export function AskPage() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .get<AiSettings>("/ai/settings")
      .then(setSettings)
      .catch(() => setLoadFailed(true));
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, asking]);

  async function ask(question: string) {
    const text = question.trim();
    if (!text || asking) return;

    // Failed exchanges stay on screen but out of what is sent, so a retry
    // is not a question asked twice in a row.
    const answered = turns.filter((turn) => !turn.failed);
    let history: AiMessage[] = [...answered, { role: "user" as const, text }]
      .map(({ role, text: body }) => ({ role, text: body }))
      .slice(-20);
    while (history.length && history[0].role !== "user") history = history.slice(1);

    setTurns((previous) => [...previous, { role: "user", text }]);
    setDraft("");
    setAsking(true);

    try {
      const result = await api.post<{ answer: string; lookups: string[] }>("/ai/ask", { messages: history });
      setTurns((previous) => [...previous, { role: "model", text: result.answer, lookups: result.lookups }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't get an answer just now.";
      setTurns((previous) => [
        ...previous.map((turn, index) => (index === previous.length - 1 ? { ...turn, failed: true } : turn)),
        { role: "model", text: message, failed: true },
      ]);
    } finally {
      setAsking(false);
    }
  }

  if (loadFailed) {
    return (
      <section className="screen">
        <StateBlock
          icon="ic-wifioff"
          title="Couldn't reach the server"
          body="Try again in a moment."
          actions={
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Try again
            </button>
          }
        />
      </section>
    );
  }

  if (!settings) return <section className="screen" />;

  if (!settings.hasKey) {
    return (
      <section className="screen">
        <div className="screen-header">
          <h1 className="screen-title">Ask</h1>
        </div>
        <StateBlock
          icon="ic-spark"
          title="Add a Gemini API key to start"
          body="Ask things like “how much did I spend on eating out this month?” and get answers from your own transactions. It uses your own free Gemini key, which you can get from Google AI Studio in a minute."
          actions={
            <Link className="btn btn-primary" to="/settings?tab=ai">
              Add a key in Settings
            </Link>
          }
        />
      </section>
    );
  }

  return (
    <section className="screen ask-screen">
      <div className="screen-header">
        <h1 className="screen-title">Ask</h1>
        <div className="screen-actions">
          {turns.length > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => setTurns([])} disabled={asking}>
              Start over
            </button>
          )}
        </div>
      </div>

      <div className="ask-thread" aria-live="polite">
        {turns.length === 0 && (
          <div className="ask-intro">
            <p>
              Ask anything about your spending, income, budget or loans. Answers come from your own
              transactions, looked up as you ask.
            </p>
            <div className="ask-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} className="ask-chip" onClick={() => ask(suggestion)}>
                  <Icon name="ic-spark" />
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, index) => (
          <div
            key={index}
            className={`ask-msg is-${turn.role}${turn.failed && turn.role === "model" ? " is-failed" : ""}`}
          >
            {turn.role === "user" ? (
              <p>{turn.text}</p>
            ) : turn.failed ? (
              <p>
                <Icon name="ic-alert" /> {turn.text}
              </p>
            ) : (
              <>
                <Markdown text={turn.text} />
                {turn.lookups && turn.lookups.length > 0 && (
                  <div className="ask-lookups">
                    Checked {[...new Set(turn.lookups.map((name) => LOOKUP_LABELS[name] ?? name))].join(", ")}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

        {asking && (
          <div className="ask-msg is-model is-thinking">
            <span className="ask-dots" aria-label="Thinking">
              <i />
              <i />
              <i />
            </span>
            Looking through your transactions…
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="ask-composer"
        onSubmit={(event) => {
          event.preventDefault();
          ask(draft);
        }}
      >
        <textarea
          className="filter-input"
          rows={1}
          value={draft}
          maxLength={2000}
          placeholder="Ask about your money…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask(draft);
            }
          }}
        />
        <button className="btn btn-primary" type="submit" disabled={asking || !draft.trim()}>
          Ask
        </button>
      </form>
    </section>
  );
}
