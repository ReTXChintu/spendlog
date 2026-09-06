import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";

const navItems = [
  { to: "/", label: "Today", end: true },
  { to: "/transactions", label: "Transactions" },
  { to: "/analytics", label: "Analytics" },
  { to: "/settings", label: "Settings" },
];

export function Layout() {
  const { logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-header">
        {/* The icon tile plus a wordmark, rather than the full lockup —
            its tagline would be illegible at header size. */}
        <span className="app-brand">
          <img className="app-brand-icon" src="/app_icon.png" alt="" />
          <span className="app-title">SpendLog</span>
        </span>
        <nav className="app-nav">
          {navItems.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? "active" : "")}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button className="link-button" onClick={logout}>
          Sign out
        </button>
      </header>
      <main className="app-content">
        <Outlet />
      </main>
    </div>
  );
}
