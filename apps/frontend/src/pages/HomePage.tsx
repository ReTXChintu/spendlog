import { KeyboardEvent, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { AnalyticsTab } from "./AnalyticsPage";
import { DashboardTab } from "./DashboardPage";
import "../styles/home.css";

const TABS = [
  { id: "dashboard", label: "Dashboard", icon: "ic-home" },
  { id: "analytics", label: "Analytics", icon: "ic-trend" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/**
 * Home: the Dashboard (what to know now) and Analytics (what happened),
 * as two tabs of one page.
 *
 * The tab lives in the query string, like Settings, so a link can point
 * straight at one — the plan warnings send you to /?tab=analytics#ai.
 */
export function HomePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: TabId = searchParams.get("tab") === "analytics" ? "analytics" : "dashboard";
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function select(next: TabId) {
    // Replace rather than push, as Settings does: flipping between two tabs
    // shouldn't fill the back button.
    setSearchParams(next === "dashboard" ? {} : { tab: next }, { replace: true });
  }

  // Arrow keys move between tabs, as the tabs pattern expects.
  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = (index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    select(TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <section className="screen home">
      <div className="screen-header home-header">
        <h1 className="screen-title">Home</h1>
        <div className="screen-actions">
          <button className="btn btn-sm" onClick={() => navigate("/ask")}>
            <Icon name="ic-question" /> Ask about my money
          </button>
          <button className="btn btn-sm" onClick={() => navigate("/perks")}>
            <Icon name="ic-percent" /> What do I have here?
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Home">
        {TABS.map((candidate, index) => (
          <button
            key={candidate.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            id={`home-tab-${candidate.id}`}
            role="tab"
            aria-selected={tab === candidate.id}
            aria-controls="home-panel"
            tabIndex={tab === candidate.id ? 0 : -1}
            className={`tab${tab === candidate.id ? " on" : ""}`}
            onClick={() => select(candidate.id)}
            onKeyDown={(event) => onKey(event, index)}
          >
            <Icon name={candidate.icon} />
            {candidate.label}
          </button>
        ))}
      </div>

      <div id="home-panel" role="tabpanel" aria-labelledby={`home-tab-${tab}`}>
        {tab === "dashboard" ? <DashboardTab /> : <AnalyticsTab />}
      </div>
    </section>
  );
}
