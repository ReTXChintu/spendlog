import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { AskPage } from "./pages/AskPage";
import { AuthCallbackPage } from "./pages/AuthCallbackPage";
import { HomePage } from "./pages/HomePage";
import { PeoplePage } from "./pages/PeoplePage";
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
        {/* Home is what you land on: the dashboard, with analytics as its
            second tab. The ledger keeps its own path rather than sharing
            the root. */}
        <Route path="/" element={<HomePage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="/perks" element={<PerksPage />} />
        <Route path="/trips" element={<TripsPage />} />
        {/* Old links and bookmarks still land on the analytics. */}
        <Route path="/analytics" element={<Navigate to="/?tab=analytics" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/ask" element={<AskPage />} />
        <Route path="/people" element={<PeoplePage />} />
      </Route>
    </Routes>
  );
}
