import { Component, ErrorInfo, ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * What to show when a screen throws while rendering.
 *
 * React unmounts the whole tree when a render throws and nothing catches
 * it, which is why one bad field turned into a blank white page with no
 * clue in it. A blank page is the worst possible answer: it cannot be
 * reported, it cannot be worked around, and it looks the same whether the
 * server is down or a number was null.
 *
 * So: say what broke, in the words the error used, and offer the two
 * things that actually help — going back to a screen that works, and
 * reloading in case the page is simply older than the server.
 *
 * Keyed on the route, so moving to another screen clears it rather than
 * leaving the error sitting there over a page that would have rendered.
 */

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // Kept in the console as well as on screen: the stack is the useful
    // half and it is too long to put in front of somebody.
    console.error("SpendLog hit a rendering error", error, info.componentStack);
  }

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    // The first frame naming one of ours, which is nearly always the one
    // worth knowing. React writes them as "\n    at CardVaultPanel (...)".
    const inComponent = componentStack?.trim().split("\n")[0]?.trim().replace(/^at\s+/, "");

    return (
      <section className="screen">
        <div className="crash">
          <div className="crash-icon">
            <Icon name="ic-alert" />
          </div>
          <h2>This screen stopped working</h2>
          <p className="desc">
            Something on it threw an error while drawing. Nothing has been changed or lost — it is
            the page that broke, not your data.
          </p>

          <pre className="crash-detail">
            {error.message}
            {inComponent && `\n\nin ${inComponent}`}
          </pre>

          <div className="set-card-actions">
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              <Icon name="ic-sync" /> Reload
            </button>
            <a className="btn btn-ghost" href="/">
              Go to the dashboard
            </a>
          </div>

          <p className="field-hint">
            If this started after an update, the page may be older than the server. A reload
            usually settles it.
          </p>
        </div>
      </section>
    );
  }
}
