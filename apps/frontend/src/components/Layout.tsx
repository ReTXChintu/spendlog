import { Link, Outlet, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary";
import { useAuth } from "../lib/auth";
import { Icon, IconSprite, LogoMark } from "./Icon";
import { PerkImportWatcher } from "./PerkImportWatcher";
import { ThemeToggle } from "./ThemeToggle";

type NavEntry = {
  to: string;
  label: string;
  icon: string;
  /** Whether the current location is this entry's. */
  match: (path: string, tab: string | null) => boolean;
};

/**
 * The sidebar, grouped as the design groups it (Activity, Money, Plan,
 * Shared, Extras). Every entry is an existing route: Analytics is Home's
 * second tab, and Accounts, Budget and Family are tabs of Settings, so they
 * link straight to those tabs rather than to pages of their own.
 */
const NAV: { group: string | null; items: NavEntry[] }[] = [
  {
    group: null,
    items: [
      { to: "/", label: "Home", icon: "ic-home", match: (p, t) => p === "/" && t !== "analytics" },
    ],
  },
  {
    group: "Activity",
    items: [
      { to: "/transactions", label: "Transactions", icon: "ic-list", match: (p) => p === "/transactions" },
      { to: "/?tab=analytics", label: "Analytics", icon: "ic-bar-chart", match: (p, t) => p === "/" && t === "analytics" },
    ],
  },
  {
    group: "Money",
    items: [
      {
        to: "/settings?tab=accounts",
        label: "Accounts & cards",
        icon: "ic-bank",
        match: (p, t) => p === "/settings" && t === "accounts",
      },
    ],
  },
  {
    group: "Plan",
    items: [
      { to: "/settings?tab=budget", label: "Budget", icon: "ic-target", match: (p, t) => p === "/settings" && t === "budget" },
    ],
  },
  {
    group: "Shared",
    items: [
      { to: "/people", label: "People", icon: "ic-users", match: (p) => p === "/people" },
      { to: "/trips", label: "Trips", icon: "ic-briefcase", match: (p) => p === "/trips" },
      { to: "/settings?tab=family", label: "Family", icon: "ic-shield", match: (p, t) => p === "/settings" && t === "family" },
    ],
  },
  {
    group: "Extras",
    items: [
      { to: "/perks", label: "Perks", icon: "ic-tag", match: (p) => p === "/perks" },
      { to: "/ask", label: "Ask AI", icon: "ic-sparkles", match: (p) => p === "/ask" },
    ],
  },
];

const SETTINGS_ELSEWHERE = new Set(["accounts", "budget", "family"]);

/** Two initials for the avatar, from a name or, failing that, the email. */
function initials(user: { name?: string | null; email?: string } | null): string {
  const source = user?.name?.trim() || user?.email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const tab = new URLSearchParams(location.search).get("tab");
  const settingsActive = location.pathname === "/settings" && !SETTINGS_ELSEWHERE.has(tab ?? "");

  return (
    <>
      <IconSprite />
      {/* Here, not on the perks page, so "done reading" reaches you anywhere. */}
      <PerkImportWatcher />
      <div id="app-shell">
        <aside className="sidebar">
          <Link to="/" className="brand-mark" aria-label="SpendLog home">
            <LogoMark />
            <span className="brand-word">SpendLog</span>
          </Link>

          <Link to="/ask" className="side-search">
            <Icon name="ic-search" />
            <span>Search or ask…</span>
          </Link>

          <nav className="nav" aria-label="Main">
            {NAV.map((section, index) => (
              <div key={section.group ?? index} style={{ display: "contents" }}>
                {section.group && <div className="nav-group">{section.group}</div>}
                {section.items.map((item) => {
                  const active = item.match(location.pathname, tab);
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`nav-item${active ? " active" : ""}`}
                      aria-current={active ? "page" : undefined}
                    >
                      <Icon name={item.icon} />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="nav-foot">
            <Link
              to="/settings"
              className={`nav-item${settingsActive ? " active" : ""}`}
              aria-current={settingsActive ? "page" : undefined}
            >
              <Icon name="ic-sliders" />
              Settings
            </Link>
            <ThemeToggle />
            <div className="nav-user">
              <div className="nav-avatar" aria-hidden="true">
                {initials(user)}
              </div>
              <div className="nav-user-meta">
                <div className="nav-user-name">{user?.name ?? "Signed in"}</div>
                <div className="nav-user-email">{user?.email ?? ""}</div>
              </div>
            </div>
            <button className="nav-signout" onClick={logout}>
              Sign out
            </button>
          </div>
        </aside>

        <main className="content">
          {/* Keyed on the path, so a screen that threw does not keep its
              error over the next one, which would have rendered fine. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </>
  );
}
