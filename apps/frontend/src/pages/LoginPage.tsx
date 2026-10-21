import { useSearchParams } from "react-router-dom";
import { Icon, IconSprite, LogoMark } from "../components/Icon";

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

const BENEFITS = [
  { icon: "ic-message", text: "Reads bank SMS on your phone — never OTPs or chats" },
  { icon: "ic-mail", text: "Reads card statements from Gmail" },
  { icon: "ic-list", text: "Shows where every figure came from" },
];

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const error = searchParams.get("error");

  return (
    <>
      <IconSprite />
      <section id="screen-signin">
        <div className="signin-brand">
          <div className="signin-lockup">
            <LogoMark />
            <span className="word">SpendLog</span>
          </div>

          <div className="signin-pitch">
            <h1 className="signin-headline">Every rupee, matched to your bank.</h1>
            <p className="signin-tagline">
              SpendLog reads your bank SMS and card statements, keeps a passbook for every account, and tells you
              the moment a balance doesn’t match.
            </p>
          </div>

          <ul className="signin-benefits">
            {BENEFITS.map((benefit) => (
              <li key={benefit.icon}>
                <span className="icon-tile sm tile-ac">
                  <Icon name={benefit.icon} />
                </span>
                {benefit.text}
              </li>
            ))}
          </ul>

          {/* A glimpse of the product: static, decorative. */}
          <div className="signin-glimpse" aria-hidden="true">
            <div className="glimpse-card">
              <div className="t-label">15 Oct – 14 Nov · day 7 of 31</div>
              <div className="glimpse-row">
                <span className="tx2">Free to spend</span>
                <span className="tx2 num">24 days left · about ₹919/day</span>
              </div>
              <div className="glimpse-figure num">₹22,060</div>
              <div className="pace compact">
                <div className="pace-track">
                  <div className="seg-spent" style={{ width: "23.5%" }} />
                  <div className="seg-promised" style={{ width: "58%" }} />
                  <div className="pace-tick" style={{ left: "20%" }}>
                    <span className="pace-tick-label">Today</span>
                  </div>
                </div>
              </div>
              <div className="pace-legend glimpse-legend">
                <span>
                  <i className="swatch swatch-spent" /> Spent <b>₹28,240</b>
                </span>
                <span>
                  <i className="swatch swatch-promised" /> Promised <b>₹69,700</b>
                </span>
                <span>
                  <i className="swatch swatch-free" /> Budget <b>₹1,20,000</b>
                </span>
              </div>
            </div>
            <div className="glimpse-card">
              <div className="glimpse-row">
                <div>
                  <div className="glimpse-title">Passbook · Federal Bank ••3295</div>
                  <div className="t-caption">20 Oct · 4:20 pm · from HDFC ••8342</div>
                </div>
                <span className="money-in num glimpse-amount">+₹10,000</span>
                <div className="glimpse-balances t-caption num">
                  SpendLog ₹41,220.00
                  <br />
                  Bank ₹41,220.00
                </div>
              </div>
              <div className="glimpse-badges">
                <span className="badge badge-good">
                  <Icon name="ic-check" /> Matches
                </span>
                <span className="badge badge-outline">Added for your transfer</span>
                <span className="t-caption">Bank said ₹41,220.00 at 7:02 pm</span>
              </div>
            </div>
          </div>
        </div>

        <div className="signin-panel">
          <div className="signin-col">
            <div className="signin-card">
              <h2 className="t-title-page">Sign in to SpendLog</h2>
              <p className="signin-lede">
                One account for SpendLog, Trippin and InFrame. Your first sign-in creates your ledger — there’s
                no separate sign-up.
              </p>

              {/* A plain link to the backend, which redirects on to the identity
                  server. No JavaScript SDK, so an extension can't block sign-in. */}
              <a className="btn btn-primary btn-xl btn-block btn-sso" href={`${API_URL}/auth/oidc/start`}>
                <span className="sso-mark" aria-hidden="true">
                  <Icon name="ic-lock" />
                </span>
                Sign in with your account
              </a>

              <div className="signin-notice">
                <Icon name="ic-info" />
                <div>
                  <b>Kids:</b> sign in on the SpendLog phone app. The web app is for the account owner.
                </div>
              </div>

              <p className="signin-legal">
                New here? Install the phone app first — it reads your bank SMS and fills your ledger.
              </p>
            </div>

            {error && (
              <div className="alert-card" role="alert">
                <span className="icon-tile">
                  <Icon name="ic-alert-triangle" />
                </span>
                <div>
                  <p className="alert-card-title">{ERRORS[error] ?? "Sign-in failed. Please try again."}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
