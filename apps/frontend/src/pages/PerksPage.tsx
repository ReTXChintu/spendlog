import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { PerkModal } from "../components/PerkModal";
import { PerkImportBar, PerkImportStatus } from "../components/PerkImportBar";
import { onImportFinished, subscribeImports, getImportState } from "../lib/perkImports";
import "../styles/perks.css";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { formatMoney, formatMoneyShort } from "../lib/format";
import { Account, Category, Perk, PerkLookup, PerkMatch } from "../types";

/**
 * "I am at Gucci. Do I have anything?"
 *
 * The search is the point of the page, so it is the first thing on it and
 * it holds focus. Everything below is the filing cabinet behind the answer.
 */
export function PerksPage() {
  const [query, setQuery] = useState("");
  const [amount, setAmount] = useState("");
  const [answer, setAnswer] = useState<PerkLookup | null>(null);
  const [asking, setAsking] = useState(false);

  const [perks, setPerks] = useState<Perk[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<{ perk: Perk | null } | null>(null);
  /// "All", a source name, or NO_SOURCE.
  const [sourceFilter, setSourceFilter] = useState<string>(ALL);

  /// Whether this server has a model to read a picture with. Asked before
  /// the button is drawn: a deployment without one hides it rather than
  /// offering something that fails.
  const [reader, setReader] = useState<{ available: boolean } | null>(null);
  /// What the upload just said: accepted (and what happens next), or why not.
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  useEffect(() => {
    api
      .get<{ available: boolean }>("/perks/reader")
      .then(setReader)
      .catch(() => setReader({ available: false }));
  }, []);

  /// The ones a model wrote that nobody has confirmed. They count for
  /// everything meanwhile - this is a prompt to glance, not a gate.
  const unreviewed = perks.filter((perk) => perk.needsReview);

  async function confirmAll() {
    await api.post("/perks/reviewed", {});
    load();
  }

  const load = useCallback(() => {
    api.get<Perk[]>("/perks").then(setPerks).catch(() => setPerks([]));
  }, []);

  useEffect(load, [load]);

  // New perks land one screenshot at a time, so refresh the list as the
  // count of read pictures moves, and once more when a batch finishes.
  const readSoFar = useRef(-1);
  useEffect(() => {
    const stopFinished = onImportFinished(() => load());
    const stopProgress = subscribeImports(() => {
      const read = getImportState().running.reduce((sum, job) => sum + job.counts.done, 0);
      if (read !== readSoFar.current) {
        if (readSoFar.current >= 0 && read > readSoFar.current) load();
        readSoFar.current = read;
      }
    });
    return () => {
      stopFinished();
      stopProgress();
    };
  }, [load]);

  /// The apps and banks these came from, most-used first, for the chips.
  const sources = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    for (const perk of perks) {
      const label = perk.source?.trim();
      if (!label) continue;
      const key = label.toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { label, count: 1 });
    }
    return [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[1].label.localeCompare(b[1].label))
      .map(([key, { label, count }]) => ({ key, label, count }));
  }, [perks]);
  const unsourced = perks.filter((perk) => !perk.source?.trim()).length;

  // A filter whose source no longer exists (last one deleted) falls back to all.
  const activeFilter =
    sourceFilter === ALL ||
    (sourceFilter === NO_SOURCE ? unsourced > 0 : sources.some((s) => s.key === sourceFilter))
      ? sourceFilter
      : ALL;
  const shown = perks.filter((perk) => {
    if (activeFilter === ALL) return true;
    const key = perk.source?.trim().toLowerCase() ?? "";
    return activeFilter === NO_SOURCE ? key === "" : key === activeFilter;
  });
  useEffect(() => {
    api.get<Account[]>("/accounts").then(setAccounts).catch(() => setAccounts([]));
    api.get<Category[]>("/categories").then(setCategories).catch(() => setCategories([]));
  }, []);

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;

    setAsking(true);
    try {
      const rupees = Number.parseFloat(amount);
      const params = new URLSearchParams({ q: query.trim() });
      if (Number.isFinite(rupees) && rupees > 0) params.set("amountMinor", String(Math.round(rupees * 100)));

      setAnswer(await api.get<PerkLookup>(`/perks/lookup?${params}`));
    } finally {
      setAsking(false);
    }
  }

  async function markUsed(perk: Perk, used: boolean) {
    await api.post(`/perks/${perk.id}/used`, { used }).catch(() => undefined);
    load();
    // The answer on screen is now out of date about this one.
    if (answer) setAnswer({ ...answer, matches: answer.matches.filter((m) => m.id !== perk.id) });
  }

  async function remove(perk: Perk) {
    await api.delete(`/perks/${perk.id}`).catch(() => undefined);
    load();
  }

  const coupons = perks.filter((perk) => perk.kind === "COUPON" && perk.isLive !== false).length;
  const endingSoon = perks.filter(
    (perk) => perk.isLive !== false && !perk.usedAt && typeof perk.daysLeft === "number" && perk.daysLeft >= 0 && perk.daysLeft <= 10
  ).length;

  return (
    <section className="screen perks-screen">
      <div className="screen-header">
        <h1 className="screen-title">Perks</h1>
        {perks.length > 0 && (
          <span className="badge badge-neutral">
            {coupons} {coupons === 1 ? "coupon" : "coupons"}
          </span>
        )}
        {endingSoon > 0 && <span className="badge badge-warn">{endingSoon} ending in 10 days</span>}
        <div className="screen-actions">
          <button className="btn btn-primary" onClick={() => setEditing({ perk: null })}>
            <Icon name="ic-plus" /> Add one
          </button>
        </div>
      </div>

      <div className="perks-top">
        <form className="card ask-bar" onSubmit={ask}>
          <div className="ask-bar-head">
            <span className="icon-tile">
              <Icon name="ic-search" />
            </span>
            <div>
              <h2 className="t-title-card">Do I have anything here?</h2>
              <p className="ask-bar-sub">Say where you are, and roughly how much, before you pay.</p>
            </div>
          </div>
          <div className="ask-bar-row">
            <div className="filter-input-icon ask-field">
              <Icon name="ic-search" />
              <input
                autoFocus
                className="filter-input"
                placeholder="Where are you? “I'm at Gucci”"
                aria-label="Where are you?"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="amount-input ask-amount">
              <span className="prefix">₹</span>
              <input
                className="filter-input"
                placeholder="About to spend"
                aria-label="About to spend"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <button className="btn btn-primary ask-submit" type="submit" disabled={asking || !query.trim()}>
              {asking ? "Looking…" : "Ask"}
            </button>
          </div>
        </form>

        {/* Only where the server has a model to read with. A deployment
            without one hides this rather than offering a button that
            fails - reading a picture is an extra way to add a coupon
            and never the only one. */}
        {reader?.available && (
          <div className="perk-dropzone">
            <span className="icon-tile">
              <Icon name="ic-upload" />
            </span>
            <div className="perk-dropzone-text">
              <h2 className="t-title-card">Read coupon screenshots</h2>
              <p>Reading takes about 30 seconds a picture — we’ll notify you when they’re ready. Up to 40 at a time.</p>
            </div>
            <PerkImportBar
              onStarted={(job) =>
                setNotice({
                  tone: "ok",
                  text: `Reading ${job.total} ${
                    job.total === 1 ? "screenshot" : "screenshots"
                  } in the background — about 30 seconds each. ${
                    job.total === 1 ? "It'll" : "They'll"
                  } appear here for review, and you'll get a notification when ${
                    job.total === 1 ? "it's" : "they're"
                  } done. You can leave this page.`,
                })
              }
              onError={(text) => setNotice({ tone: "warn", text })}
            />
          </div>
        )}
      </div>

      {notice && (
        <div
          className={`callout perk-notice ${notice.tone === "warn" ? "callout-warn" : "callout-good"}`}
          role={notice.tone === "warn" ? "alert" : "status"}
        >
          <Icon name={notice.tone === "warn" ? "ic-alert-triangle" : "ic-check"} />
          <p className="callout-body">{notice.text}</p>
          <button className="icon-btn" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="ic-x" />
          </button>
        </div>
      )}
      <PerkImportStatus />

      {answer && <Answer answer={answer} onUsed={(perk) => markUsed(perk, true)} />}

      {unreviewed.length > 0 && (
        <div className="callout callout-info review-bar">
          <Icon name="ic-info" />
          <div className="callout-body">
            <div className="callout-title">
              {unreviewed.length} {unreviewed.length === 1 ? "perk was" : "perks were"} read off a picture.
            </div>
            <div className="callout-detail">
              Nobody has checked the figures yet — open any that look off, then say you are happy.
            </div>
          </div>
          <button className="btn btn-sm" onClick={confirmAll}>
            All look right
          </button>
        </div>
      )}

      <div className="perks-holding">
        <div className="perks-holding-head">
          <h2 className="t-title-section">Everything you're holding</h2>
          <p className="t-caption">A card offer stands until the bank changes it. A coupon is spent once and then gone.</p>
        </div>

        {perks.length === 0 ? (
          <StateBlock
            icon="ic-tag"
            title="Nothing saved yet"
            body="Add the cashback your cards give at particular shops, and any coupon codes you're sitting on. Then you can ask this page before you pay for anything."
            actions={
              <button className="btn btn-primary" onClick={() => setEditing({ perk: null })}>
                Add the first one
              </button>
            }
          />
        ) : (
          <>
            {/* Only worth showing once there is more than one place to pick. */}
            {sources.length + (unsourced > 0 ? 1 : 0) > 1 && (
              <div className="chip-row perk-chips" role="group" aria-label="Filter by where you got it">
                <SourceChip
                  label="All"
                  count={perks.length}
                  on={activeFilter === ALL}
                  onClick={() => setSourceFilter(ALL)}
                />
                {sources.map((source) => (
                  <SourceChip
                    key={source.key}
                    label={source.label}
                    count={source.count}
                    on={activeFilter === source.key}
                    onClick={() => setSourceFilter(source.key)}
                  />
                ))}
                {unsourced > 0 && (
                  <SourceChip
                    label="Not set"
                    count={unsourced}
                    on={activeFilter === NO_SOURCE}
                    onClick={() => setSourceFilter(NO_SOURCE)}
                  />
                )}
              </div>
            )}
            <div className="perk-list">
              {shown.map((perk) => (
                <PerkRow
                  key={perk.id}
                  perk={perk}
                  onEdit={() => setEditing({ perk })}
                  onUsed={(used) => markUsed(perk, used)}
                  onRemove={() => remove(perk)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {editing && (
        <PerkModal
          perk={editing.perk}
          accounts={accounts}
          categories={categories}
          onSaved={() => {
            setEditing(null);
            load();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/**
 * The answer, with the cashback first and the float underneath.
 *
 * Settled deliberately: money back is certain and immediate, float is
 * timing. Both numbers stay in view and the decision is yours.
 */
function Answer({ answer, onUsed }: { answer: PerkLookup; onUsed: (perk: PerkMatch) => void }) {
  return (
    <div className="card card-flush answer">
      <div className="answer-verdict">
        <Icon name="ic-sparkles" />
        {answer.verdict}
      </div>

      {answer.matches.map((match) => (
        <div className={`answer-row${match.kind === "COUPON" ? " is-coupon" : ""}`} key={match.id}>
          <span className={`icon-tile ${match.kind === "COUPON" ? "tile-good" : "tile-ac"}`}>
            <Icon name={match.kind === "COUPON" ? "ic-tag" : "ic-credit-card"} />
          </span>
          <div className="answer-main">
            <div className="answer-title">
              {match.title}
              {match.card && <span className="answer-card">on {match.card.name}</span>}
              {match.reach === "ANYWHERE" && <span className="badge badge-neutral">Everywhere</span>}
              {match.reach === "CATEGORY" && <span className="badge badge-neutral">This category</span>}
            </div>
            <div className="answer-sub num">
              {match.valueMinor !== null && match.valueMinor > 0 && (
                <b className="money-in">{formatMoney(match.valueMinor)} back. </b>
              )}
              {match.minSpendMinor ? `Over ${formatMoneyShort(match.minSpendMinor)}. ` : ""}
              {match.maxDiscountMinor ? `Up to ${formatMoneyShort(match.maxDiscountMinor)}. ` : ""}
              {match.card?.statementOn
                ? `Bills ${new Date(match.card.statementOn).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                  })} · ${match.card.floatDays} days to pay.`
                : ""}
              {typeof match.daysLeft === "number" && match.daysLeft <= 10
                ? ` Expires in ${match.daysLeft} ${match.daysLeft === 1 ? "day" : "days"}.`
                : ""}
            </div>
          </div>

          {match.code && <code className="perk-code-text answer-code">{match.code}</code>}

          {match.kind === "COUPON" && (
            <button className="btn btn-sm" onClick={() => onUsed(match)}>
              Used it
            </button>
          )}
        </div>
      ))}

      {answer.floatAlternative && (
        <div className="answer-float">
          <Icon name="ic-credit-card" />
          <span>
            Longest to pay: <b>{answer.floatAlternative.name}</b>, {answer.floatAlternative.floatDays} days
            {answer.matches.length > 0 ? " — but no offer here." : "."}
          </span>
        </div>
      )}
    </div>
  );
}

const ALL = "__all";
const NO_SOURCE = "__none";

function SourceChip({
  label,
  count,
  on,
  onClick,
}: {
  label: string;
  count: number;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`chip${on ? " on" : ""}`} aria-pressed={on} onClick={onClick}>
      {on && <Icon name="ic-check" />}
      {label} <span className="num">{count}</span>
    </button>
  );
}

/** Two letters for the card's monogram: the first shop, or the title. */
function monogramOf(perk: Perk): string {
  const source = (perk.merchants[0] ?? perk.source ?? perk.title).replace(/[^A-Za-z0-9 ]/g, " ").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "%";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function PerkRow({
  perk,
  onEdit,
  onUsed,
  onRemove,
}: {
  perk: Perk;
  onEdit: () => void;
  onUsed: (used: boolean) => void;
  onRemove: () => void;
}) {
  const card = typeof perk.accountId === "object" && perk.accountId ? perk.accountId : null;
  const worth = perk.percent ? `${perk.percent}%` : perk.flatMinor ? formatMoneyShort(perk.flatMinor) : "";
  const terms = perk.terms?.trim();
  const extracted = perk.extractedText?.trim();
  const daysLeft = perk.daysLeft ?? null;
  const expired = typeof daysLeft === "number" && daysLeft < 0;
  const headline = `${worth} ${perk.kind === "COUPON" ? "off" : "back"}${
    perk.minSpendMinor ? ` on ${formatMoneyShort(perk.minSpendMinor)}+` : ""
  }${perk.maxDiscountMinor ? ` · up to ${formatMoneyShort(perk.maxDiscountMinor)}` : ""}`;

  return (
    <div
      className={`perk-row${perk.isLive === false ? " is-dead" : ""}${perk.needsReview ? " needs-review" : ""}`}
    >
      <div className="perk-row-top">
        <span className="monogram">{monogramOf(perk)}</span>
        <div className="perk-main">
          <div className="perk-title">{perk.title}</div>
          <div className="perk-sub">
            {perk.source?.trim() ? `From ${perk.source.trim()}` : perk.kind === "COUPON" ? "Coupon" : "Card offer"}
            {card ? ` · ${card.nickname?.trim() || card.bankName}` : ""}
          </div>
        </div>
        <div className="perk-actions">
          <button className="icon-btn" onClick={onEdit} aria-label={`Edit ${perk.title}`}>
            <Icon name="ic-pencil" />
          </button>
          <button className="icon-btn perk-delete" onClick={onRemove} aria-label={`Delete ${perk.title}`}>
            <Icon name="ic-trash" />
          </button>
        </div>
      </div>

      {worth && <div className="perk-headline num">{headline}</div>}

      <div className="perk-badges">
        <span className={`badge ${perk.kind === "COUPON" ? "badge-good" : "badge-ac"}`}>
          {perk.kind === "COUPON" ? "Coupon" : "Card offer"}
        </span>
        {perk.usedAt ? (
          <span className="badge badge-neutral">Used</span>
        ) : perk.expiresOn && typeof daysLeft === "number" ? (
          <span className={`badge ${expired ? "badge-crit" : daysLeft <= 10 ? "badge-warn" : "badge-neutral"}`}>
            {expired ? "Expired" : `${daysLeft} ${daysLeft === 1 ? "day" : "days"} left`}
          </span>
        ) : null}
        {/* Which of them a machine wrote, so the count in the banner
            above is findable rather than just a number. */}
        {perk.needsReview && <span className="badge badge-outline">Read from a picture</span>}
      </div>

      <p className="perk-where">{perk.merchants.length > 0 ? perk.merchants.join(", ") : "Anywhere"}</p>

      {perk.code && (
        <div className="perk-code">
          <span className="perk-code-text">{perk.code}</span>
          <CopyButton text={perk.code} label="Copy" />
        </div>
      )}

      {perk.kind === "COUPON" && (
        <button className="btn btn-sm perk-used" onClick={() => onUsed(!perk.usedAt)}>
          {perk.usedAt ? "Unuse" : "Used it"}
        </button>
      )}

      {/* Native <details>: keyboard and screen-reader friendly for free,
          and closed by default so the list stays scannable. */}
      {(terms || extracted) && (
        <div className="perk-more">
          {terms && (
            <details className="perk-details">
              <summary>T&amp;C</summary>
              <p className="perk-terms">{terms}</p>
            </details>
          )}
          {extracted && (
            <details className="perk-details">
              <summary>Text read from the screenshot</summary>
              <pre className="perk-extracted">{extracted}</pre>
              <CopyButton text={extracted} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label = "Copy text" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked (http, old browser): the text is selectable anyway.
    }
  }

  return (
    <button className="btn btn-sm perk-copy" onClick={copy}>
      {copied ? "Copied" : label}
    </button>
  );
}
