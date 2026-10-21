import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { setToken } from "../lib/api";

/**
 * Lands here after signing in through the identity server. The backend
 * puts the SpendLog session token in the URL fragment, which never reaches
 * a server or an access log; it is stored and then wiped from the address
 * bar and history so it isn't left sitting in the URL.
 *
 * `returnTo`, when present, is the page sign-in started from. The backend
 * only passes on a path on this site, and it is checked again here.
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
    const returnTo = params.get("returnTo");
    navigate(returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/", {
      replace: true,
    });
  }, [navigate]);

  return <p className="empty-state">Signing you in…</p>;
}
