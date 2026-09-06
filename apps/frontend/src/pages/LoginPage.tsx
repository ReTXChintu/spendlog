import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";
const GSI_SRC = "https://accounts.google.com/gsi/client";

type LoadState = "loading" | "ready" | "blocked" | "origin-rejected";

/**
 * Resolves once Google Identity Services has attached itself to `window`.
 * The script tag in index.html is `async defer`, so it is frequently still
 * in flight when React mounts — polling covers that, and also the case
 * where the tag already finished loading before we could listen for it.
 * Rejects if it never arrives (commonly an ad blocker or privacy
 * extension blocking accounts.google.com).
 */
function whenGoogleReady(timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }

    if (!document.querySelector(`script[src="${GSI_SRC}"]`)) {
      const script = document.createElement("script");
      script.src = GSI_SRC;
      script.async = true;
      document.head.appendChild(script);
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (window.google?.accounts?.id) {
        window.clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        window.clearInterval(timer);
        reject(new Error("Google Identity Services did not load"));
      }
    }, 100);
  });
}

export function LoginPage() {
  const { loginWithGoogleIdToken } = useAuth();
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  // The auth helpers are recreated on every render, so this effect
  // deliberately takes no dependencies and guards with a ref — otherwise
  // it would re-run and stack up duplicate Google buttons.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || initializedRef.current) return;
    initializedRef.current = true;

    let cancelled = false;

    whenGoogleReady()
      .then(() => {
        if (cancelled || !buttonRef.current) return;

        window.google!.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: async (response) => {
            try {
              await loginWithGoogleIdToken(response.credential);
              navigate("/", { replace: true });
            } catch (err) {
              setError(err instanceof Error ? err.message : "Sign-in failed");
            }
          },
        });
        window.google!.accounts.id.renderButton(buttonRef.current, { theme: "outline", size: "large" });
        setLoadState("ready");

        // Google refuses to render the button — silently, logging only to
        // the console — when the page's origin isn't listed under
        // "Authorized JavaScript origins" for this client ID. Detect the
        // empty container and say so, rather than showing nothing.
        window.setTimeout(() => {
          if (!cancelled && buttonRef.current?.childElementCount === 0) {
            setLoadState("origin-rejected");
          }
        }, 2000);
      })
      .catch(() => {
        if (!cancelled) setLoadState("blocked");
      });

    return () => {
      cancelled = true;
    };
  }, [loginWithGoogleIdToken, navigate]);

  return (
    <div className="login-page">
      <h1>Expense Tracker</h1>
      <p>Sign in to auto-import and track your spending.</p>

      {!GOOGLE_CLIENT_ID && (
        <p className="error-text">Set VITE_GOOGLE_CLIENT_ID in the .env at the repo root to enable sign-in.</p>
      )}

      <div ref={buttonRef} />

      {loadState === "loading" && GOOGLE_CLIENT_ID && <p>Loading Google Sign-In…</p>}

      {loadState === "blocked" && (
        <p className="error-text">
          Couldn't load Google Sign-In. An ad blocker or privacy extension is likely blocking
          accounts.google.com — disable it for this site and reload.
        </p>
      )}

      {loadState === "origin-rejected" && (
        <p className="error-text">
          Google rejected this origin. Add <code>{window.location.origin}</code> to "Authorized JavaScript
          origins" on your OAuth client in Google Cloud Console, then reload. (Check the browser console for
          the exact error.)
        </p>
      )}

      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
