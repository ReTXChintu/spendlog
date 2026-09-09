import { useSearchParams } from "react-router-dom";
import { Icon, IconSprite } from "../components/Icon";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const ERRORS: Record<string, string> = {
  oauth_failed: "Sign-in didn't go through — the link may have expired.",
  oauth_expired: "That sign-in link expired. Please try again.",
  no_token: "Sign-in didn't complete. Please try again.",
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
              One Google account. Your first sign-in creates your ledger — there's no separate sign-up.
            </p>

            {/* A plain link to the backend, which redirects on to Google. No
                Google JavaScript SDK, so an extension can't block sign-in. */}
            <a className="btn btn-google" href={`${API_URL}/auth/google/start`}>
              <Icon name="ic-google" /> Sign in with Google
            </a>

            <div className="permission-note">
              <Icon name="ic-mail" />
              <div>
                Google will also ask for read-only access to your Gmail in this same step — that's how
                email-based transaction alerts get picked up.
              </div>
            </div>

            {error && (
              <div className="signin-error">
                <Icon name="ic-alert" />
                <div>{ERRORS[error] ?? "Sign-in failed. Please try again."}</div>
              </div>
            )}

            <div className="signin-notice">
              <Icon name="ic-alert" />
              <div>
                Google may show an "unverified app" screen before you continue — that's expected while SpendLog
                completes verification. It's safe to proceed.
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
