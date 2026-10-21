import { useSearchParams } from "react-router-dom";
import { Icon, IconSprite } from "../components/Icon";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const ERRORS: Record<string, string> = {
  oauth_failed: "Sign-in didn't go through — the link may have expired.",
  oauth_expired: "That sign-in link expired. Please try again.",
  no_token: "Sign-in didn't complete. Please try again.",
  sso_unavailable: "The sign-in service isn't answering just now. Please try again in a minute.",
  kid_email: "That email is a kid's login. Kids sign in on the SpendLog phone app with their own password.",
  email_unverified:
    "A SpendLog account already uses this email. Verify the address with your account, then sign in again.",
  account_conflict: "This email's SpendLog account is already linked to a different sign-in.",
};

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const error = searchParams.get("error");

  return (
    <>
      <IconSprite />
      <section id="screen-signin">
        <div className="signin-brand">
          <svg className="icon receipt-bg" viewBox="0 0 24 24" style={{ stroke: "#fff" }} aria-hidden="true">
            <use href="#ic-receipt" />
          </svg>
          <div className="signin-lockup">
            <div className="brand-tile">
              <Icon name="ic-receipt" />
            </div>
            <div className="word">SpendLog</div>
          </div>
          <p className="signin-tagline">
            Track every rupee, every day. Connect your bank messages once — every transaction after that files
            itself.
          </p>
        </div>

        <div className="signin-panel">
          <div className="signin-card">
            <h2>Sign in to SpendLog</h2>
            <p className="sub">
              One account for SpendLog, Trippin and InFrame. Your first sign-in creates your ledger — there's no
              separate sign-up.
            </p>

            {/* A plain link to the backend, which redirects on to the identity
                server. No JavaScript SDK, so an extension can't block sign-in. */}
            <a className="btn btn-sso" href={`${API_URL}/auth/oidc/start`}>
              <Icon name="ic-lock" /> Sign in with your account
            </a>

            {error && (
              <div className="signin-error">
                <Icon name="ic-alert" />
                <div>{ERRORS[error] ?? "Sign-in failed. Please try again."}</div>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
