import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Icon, IconSprite } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { to: "/", label: "Today", icon: "ic-calendar", end: true },
  { to: "/transactions", label: "Transactions", icon: "ic-search" },
  { to: "/analytics", label: "Analytics", icon: "ic-trend" },
  { to: "/settings", label: "Settings", icon: "ic-filter" },
];

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

  return (
    <>
      <IconSprite />
      <div id="app-shell">
        <aside className="sidebar">
          <div className="brand-mark">
            <div className="brand-tile">
              <Icon name="ic-receipt" />
            </div>
            <div className="brand-word">SpendLog</div>
          </div>

          <nav className="nav">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
              >
                <Icon
                  name={item.icon}
                  // The mockup rotates the filter glyph to serve as the settings icon.
                  className={item.label === "Settings" ? "rotate-90" : ""}
                />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="nav-foot">
            <ThemeToggle />
            <div className="nav-user">
              <div className="nav-avatar">{initials(user)}</div>
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
          <Outlet />
        </main>
      </div>
    </>
  );
}
