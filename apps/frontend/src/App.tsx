import { Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { AuthCallbackPage } from "./pages/AuthCallbackPage";
import { DashboardPage } from "./pages/DashboardPage";
import { PerksPage } from "./pages/PerksPage";
import { LoginPage } from "./pages/LoginPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TripsPage } from "./pages/TripsPage";
import { TransactionsPage } from "./pages/TransactionsPage";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        {/* The dashboard is what you land on: what needs knowing now. The
            ledger keeps its own path rather than sharing the root. */}
        <Route path="/" element={<DashboardPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/perks" element={<PerksPage />} />
        <Route path="/trips" element={<TripsPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
