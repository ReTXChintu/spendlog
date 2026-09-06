import { useSearchParams } from "react-router-dom";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const ERROR_MESSAGES: Record<string, string> = {
  oauth_failed: "Google sign-in failed. Please try again.",
  oauth_expired: "That sign-in link expired. Please try again.",
  no_token: "Sign-in didn't complete. Please try again.",
};

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const error = searchParams.get("error");

  return (
    <div className="login-page">
      <h1>Expense Tracker</h1>
      <p>Sign in to auto-import and track your spending.</p>

      {/* A plain link to the backend, which redirects on to Google. No
          Google JavaScript SDK, so nothing here can be blocked by an
          extension or fail to load. */}
      <a className="google-button" href={`${API_URL}/auth/google/start`}>
        Sign in with Google
      </a>

      <p className="hint">
        Google will ask for read-only access to your email in the same step, so transactions can be
        imported automatically. You can untick it and connect later from Settings.
      </p>

      {error && <p className="error-text">{ERROR_MESSAGES[error] ?? "Sign-in failed. Please try again."}</p>}
    </div>
  );
}
