import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

export function LoginPage() {
  const { loginWithGoogleIdToken } = useAuth();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.google || !buttonRef.current) return;

    window.google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: async (response) => {
        await loginWithGoogleIdToken(response.credential);
        navigate("/", { replace: true });
      },
    });
    window.google.accounts.id.renderButton(buttonRef.current, { theme: "outline", size: "large" });
  }, [loginWithGoogleIdToken, navigate]);

  return (
    <div className="login-page">
      <h1>Expense Tracker</h1>
      <p>Sign in to auto-import and track your spending.</p>
      {GOOGLE_CLIENT_ID ? (
        <div ref={buttonRef} />
      ) : (
        <p className="error-text">Set VITE_GOOGLE_CLIENT_ID in apps/frontend/.env to enable sign-in.</p>
      )}
    </div>
  );
}
