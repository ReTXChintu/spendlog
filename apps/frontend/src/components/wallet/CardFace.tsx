import { CSSProperties, MouseEvent, MutableRefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../lib/api";
import { formatMoneyShort, formatShortDate } from "../../lib/format";
import { useVaultSession } from "../../lib/vaultSession";
import { CardFace as CardFaceData, CardNetwork } from "../../types";
import { CopyButton, VaultPinForm, spaced } from "../CardVaultPanel";
import { Icon } from "../Icon";
import { lookFor } from "./look";

/**
 * A credit card, drawn as the card in your wallet.
 *
 * The front is what anyone looking over your shoulder could see anyway:
 * the bank, the last four digits, the network. Along the bottom, how much
 * of the limit is in use, coloured by your own spending limit rather than
 * the bank's - a card can sit comfortably inside what the bank allows and
 * well past what you meant to spend.
 *
 * Tapping the card opens its transactions for the statement cycle running
 * now. The eye asks for the PIN and turns the card over to the full
 * number, expiry and name. What comes back is held in this component's
 * state and nowhere else, and forgotten when the card turns back - after a
 * minute, or on a tap. There is no CVV on the back, because the vault
 * never keeps one.
 */

/** How long the back stays up before the card turns itself over. */
const SHOWN_FOR_MS = 60_000;
/** Matches the flip in wallet.css, so the details go only once out of sight. */
const FLIP_MS = 650;

interface Revealed {
  number: string;
  expiry: string | null;
  nameOnCard: string | null;
  note: string | null;
}

export function CardFace({ card }: { card: CardFaceData }) {
  const look = lookFor(card);
  const session = useVaultSession();

  const [details, setDetails] = useState<Revealed | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [asking, setAsking] = useState(false);
  const [hidesAt, setHidesAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const cardRef = useRef<HTMLElement | null>(null);
  const eyeRef = useRef<HTMLButtonElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);

  function show(revealed: Revealed) {
    setDetails(revealed);
    setFlipped(true);
    setHidesAt(Date.now() + SHOWN_FOR_MS);
    setNow(Date.now());
  }

  function hide() {
    setFlipped(false);
    // Focus follows the card back over, but only if it was on the card -
    // the clock running out shouldn't pull it from somewhere else.
    if (cardRef.current?.contains(document.activeElement)) eyeRef.current?.focus();
  }

  // Turned back by the clock as well as by hand. The details are dropped
  // once the back is out of sight, so they don't vanish mid-turn.
  useEffect(() => {
    if (!flipped) {
      const id = window.setTimeout(() => setDetails(null), FLIP_MS);
      return () => window.clearTimeout(id);
    }
    backRef.current?.focus();
    const tick = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= hidesAt) hide();
    }, 1000);
    return () => window.clearInterval(tick);
  }, [flipped, hidesAt]);

  function openEye() {
    // Already unlocked on the accounts screen: no second prompt for it.
    const open = session?.details.get(card.accountId);
    if (open) show(open);
    else setAsking(true);
  }

  const secondsLeft = Math.max(0, Math.ceil((hidesAt - now) / 1000));
  const style = { "--wcard-bg": look.background } as CSSProperties;

  return (
    <article
      ref={cardRef}
      className={`wcard is-${card.state}${look.light ? " is-light" : ""}${flipped ? " is-flipped" : ""}`}
      style={style}
      aria-label={`${card.name} card ending ${card.last4 ?? "unknown"}`}
    >
      <div className="wcard-inner">
        <div className="wcard-face wcard-front" aria-hidden={flipped}>
          <Front card={card} flipped={flipped} eyeRef={eyeRef} onEye={openEye} />
        </div>

        <div className="wcard-face wcard-back" aria-hidden={!flipped}>
          {details && (
            <Back
              details={details}
              secondsLeft={secondsLeft}
              network={card.network}
              backRef={backRef}
              onHide={hide}
            />
          )}
        </div>
      </div>

      {/* Over the page rather than inside the card: the card's 3D context
          would otherwise become the box a fixed overlay is placed in. */}
      {asking &&
        createPortal(
          <PinPrompt
            card={card}
            onRevealed={(revealed) => {
              setAsking(false);
              show(revealed);
            }}
            onClose={() => {
              setAsking(false);
              eyeRef.current?.focus();
            }}
          />,
          document.body
        )}
    </article>
  );
}

function Front({
  card,
  flipped,
  eyeRef,
  onEye,
}: {
  card: CardFaceData;
  flipped: boolean;
  eyeRef: MutableRefObject<HTMLButtonElement | null>;
  onEye: () => void;
}) {
  const limit = card.creditLimitMinor;
  const spendLimit = card.spendLimitMinor;
  // The bank's limit when there is one; otherwise your own, against this
  // cycle. Neither, and there is nothing to measure against.
  const fraction = limit
    ? card.usedMinor / limit
    : spendLimit
      ? card.cycleSpentMinor / spendLimit
      : null;
  const width = fraction === null ? 0 : Math.min(100, Math.max(0, Math.round(fraction * 100)));

  const owing = card.lastStatement !== null && card.lastStatement.isPaid === false;
  const dueText = dueLabel(card.daysToDue);
  const bank = card.issuer?.trim() || card.bankName;
  const showName = card.name.trim().toLowerCase() !== bank.toLowerCase();
  const tabIndex = flipped ? -1 : undefined;

  return (
    <>
      {/* The whole card is the link; the eye sits above it. */}
      <Link
        className="wcard-hit"
        to={`/transactions?account=${card.accountId}`}
        tabIndex={tabIndex}
        aria-label={`${card.name} ••${card.last4 ?? ""}: this cycle's transactions`}
      />

      <div className="wcard-top">
        <div className="wcard-bank">
          <span className="wcard-bank-name">{bank}</span>
          {showName && <span className="wcard-card-name">{card.name}</span>}
        </div>
        {card.hasCardDetails ? (
          <button
            ref={eyeRef}
            type="button"
            className="wcard-eye"
            onClick={onEye}
            tabIndex={tabIndex}
            aria-label="Show card details"
            title="Show card details"
          >
            <EyeIcon />
          </button>
        ) : (
          <Link
            className="wcard-add"
            to={`/settings?tab=accounts&account=${card.accountId}`}
            tabIndex={tabIndex}
          >
            <Icon name="ic-plus" /> Add card details
          </Link>
        )}
      </div>

      <div className="wcard-chip-row">
        <span className="wcard-chip" aria-hidden="true" />
        <ContactlessIcon />
        {card.sharesLimitWith.length > 0 && (
          <span className="wcard-shared" title={`Shares a limit with ${card.sharesLimitWith.join(", ")}`}>
            Shared limit
          </span>
        )}
      </div>

      <div className="wcard-number">
        <span aria-hidden="true">•••• •••• ••••</span> {card.last4 ?? "••••"}
      </div>

      <div className="wcard-foot">
        <div className="wcard-stat">
          <span className="wcard-stat-label">{card.periodIsCycle ? "This cycle" : "This month"}</span>
          <span className="wcard-stat-value">
            {formatMoneyShort(card.cycleSpentMinor)}
            {spendLimit ? <small> / {formatMoneyShort(spendLimit)}</small> : null}
          </span>
        </div>
        <div className={`wcard-stat${owing && (card.daysToDue ?? 99) <= 3 ? " is-urgent" : ""}`}>
          <span className="wcard-stat-label">{owing ? "Bill due" : "Next due"}</span>
          <span className="wcard-stat-value">
            {card.nextDueOn ? formatShortDate(card.nextDueOn) : "—"}
            {owing && dueText && <small> · {dueText}</small>}
          </span>
        </div>
        <Wordmark network={card.network} />
      </div>

      <div className="wcard-limit">
        <div className="wcard-limit-text">
          {limit ? (
            <>
              <span>{formatMoneyShort(card.usedMinor)} used</span>
              <span>
                {card.availableMinor !== null ? `${formatMoneyShort(card.availableMinor)} free of ` : "of "}
                {formatMoneyShort(limit)}
              </span>
            </>
          ) : spendLimit ? (
            <>
              <span>{formatMoneyShort(card.cycleSpentMinor)} spent</span>
              <span>your limit {formatMoneyShort(spendLimit)}</span>
            </>
          ) : (
            <span>No limit set</span>
          )}
        </div>
        <div
          className="wcard-bar"
          role="img"
          aria-label={
            fraction === null
              ? "No limit to measure against"
              : `${width}% of the ${limit ? "credit limit" : "spending limit"} in use`
          }
        >
          <div className="wcard-bar-fill" style={{ width: `${width}%` }} />
        </div>
      </div>
    </>
  );
}

function Back({
  details,
  secondsLeft,
  network,
  backRef,
  onHide,
}: {
  details: Revealed;
  secondsLeft: number;
  network: CardNetwork | null;
  backRef: MutableRefObject<HTMLButtonElement | null>;
  onHide: () => void;
}) {
  // A tap anywhere on the back turns it over, except on Copy.
  function onClick(event: MouseEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest(".vault-copy")) return;
    onHide();
  }

  return (
    <div className="wcard-back-body" onClick={onClick}>
      <div className="wcard-stripe" aria-hidden="true" />
      <div className="wcard-back-number">
        <span className="wcard-stat-label">Card number</span>
        <span className="wcard-back-digits">
          {spaced(details.number)} <CopyButton text={details.number} />
        </span>
      </div>
      <div className="wcard-back-row">
        <div className="wcard-stat">
          <span className="wcard-stat-label">Valid thru</span>
          <span className="wcard-stat-value">{details.expiry || "—"}</span>
        </div>
        <div className="wcard-stat is-name">
          <span className="wcard-stat-label">Name on card</span>
          <span className="wcard-stat-value">{details.nameOnCard || "—"}</span>
        </div>
        <Wordmark network={network} />
      </div>
      {details.note && <p className="wcard-back-note">{details.note}</p>}
      <div className="wcard-back-foot">
        <span>No CVV stored · hides in {secondsLeft}s</span>
        <button ref={backRef} type="button" className="wcard-hide" onClick={onHide}>
          <Icon name="ic-lock" /> Hide
        </button>
      </div>
    </div>
  );
}

/**
 * The PIN, asked for over the page. The same box as the accounts screen
 * uses; only this card's details come back, and only to this card.
 */
function PinPrompt({
  card,
  onRevealed,
  onClose,
}: {
  card: CardFaceData;
  onRevealed: (details: Revealed) => void;
  onClose: () => void;
}) {
  const [problem, setProblem] = useState<"no-pin" | "nothing" | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function reveal(pin: string) {
    setProblem(null);
    try {
      onRevealed(await api.post<Revealed>(`/vault/cards/${card.accountId}/reveal`, { pin }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) setProblem("no-pin");
      if (err instanceof ApiError && err.status === 404) setProblem("nothing");
      throw err;
    }
  }

  const settings = `/settings?tab=accounts&account=${card.accountId}`;

  return (
    <div
      className="overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal wcard-prompt" role="dialog" aria-modal="true" aria-labelledby={`pin-${card.accountId}`}>
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <Icon name="ic-x" />
        </button>
        <h3 id={`pin-${card.accountId}`}>Show card details</h3>
        <div className="modal-sub">
          {card.name} ••{card.last4 ?? "••••"} · the same PIN as on the accounts screen
        </div>

        <VaultPinForm submitLabel="Show" autoFocus onSubmit={reveal} />

        {problem === "no-pin" && (
          <p className="field-hint">
            Card details need a PIN first. <Link to={settings}>Set one up</Link>.
          </p>
        )}
        {problem === "nothing" && (
          <p className="field-hint">
            <Link to={settings}>Add this card's details</Link> to see them here.
          </p>
        )}
        <div className="modal-footnote">
          <Icon name="ic-lock" /> Shown for a minute, then forgotten. No CVV is ever stored.
        </div>
      </div>
    </div>
  );
}

/** The network's name, set the way it appears on the card. */
export function Wordmark({ network }: { network: CardNetwork | null }) {
  if (!network) return <span className="wcard-mark" />;
  switch (network) {
    case "VISA":
      return <span className="wcard-mark is-visa">VISA</span>;
    case "MASTERCARD":
      return (
        <span className="wcard-mark is-mastercard" aria-label="Mastercard">
          <span className="wcard-mc" aria-hidden="true">
            <i />
            <i />
          </span>
          mastercard
        </span>
      );
    case "RUPAY":
      return (
        <span className="wcard-mark is-rupay">
          RuPay<i aria-hidden="true" />
        </span>
      );
    case "AMEX":
      return <span className="wcard-mark is-amex">AMEX</span>;
    case "DINERS":
      return <span className="wcard-mark is-diners">Diners Club</span>;
  }
}

/** "in 3 days", "today", "2 days late". */
function dueLabel(days: number | null): string | null {
  if (days === null) return null;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return `${-days} ${days === -1 ? "day" : "days"} late`;
  return `in ${days} days`;
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ContactlessIcon() {
  return (
    <svg className="wcard-contactless" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.5 8.5a5 5 0 0 1 0 7" />
      <path d="M12 6a8.5 8.5 0 0 1 0 12" />
      <path d="M15.5 3.5a12 12 0 0 1 0 17" />
    </svg>
  );
}
