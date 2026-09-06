import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { setToken } from "../lib/api";

/**
 * Lands here after Google sign-in. The backend puts the session token in
 * the URL fragment, which never reaches a server or an access log; it is
 * stored and then wiped from the address bar and history so it isn't left
 * sitting in the URL.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = params.get("token");

    if (!token) {
      navigate("/login?error=no_token", { replace: true });
      return;
    }

    setToken(token);
    window.history.replaceState(null, "", window.location.pathname);
    navigate("/", { replace: true });
  }, [navigate]);

  return <p className="empty-state">Signing you in…</p>;
}
