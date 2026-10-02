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

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Perks</h1>
        <div className="screen-actions">
          {/* Only where the server has a model to read with. A deployment
              without one hides this rather than offering a button that
              fails - reading a picture is an extra way to add a coupon
              and never the only one. */}
          {reader?.available && (
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
          )}
          <button className="btn btn-sm btn-primary" onClick={() => setEditing({ perk: null })}>
            <Icon name="ic-plus" /> Add one
          </button>
        </div>
      </div>

      {notice && (
        <div
          className={`perk-notice${notice.tone === "warn" ? " is-warn" : ""}`}
          role={notice.tone === "warn" ? "alert" : "status"}
        >
          <Icon name={notice.tone === "warn" ? "ic-alert" : "ic-check"} />
          <p>{notice.text}</p>
          <button className="btn btn-sm btn-ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="ic-x" />
          </button>
        </div>
      )}
      <PerkImportStatus />

      <form className="ask-bar" onSubmit={ask}>
        <div className="ask-field">
          <Icon name="ic-search" />
          <input
            autoFocus
            className="ask-input"
            placeholder="Where are you? “I'm at Gucci”"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <input
          className="filter-input ask-amount"
          placeholder="₹ about to spend"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={asking || !query.trim()}>
          {asking ? "Looking…" : "Ask"}
        </button>
      </form>

      {answer && <Answer answer={answer} onUsed={(perk) => markUsed(perk, true)} />}

      {unreviewed.length > 0 && (
        <div className="review-bar">
          <Icon name="ic-info" />
          <div>
            <b>
              {unreviewed.length} {unreviewed.length === 1 ? "perk was" : "perks were"} read off a
              picture.
            </b>{" "}
            Nobody has checked the figures yet — open any that look off, then say you are happy.
          </div>
          <button className="btn btn-sm" onClick={confirmAll}>
            All look right
          </button>
        </div>
      )}

      <div className="section-block" style={{ marginTop: 28 }}>
        <h3>Everything you're holding</h3>
        <p className="section-sub">
          A card offer stands until the bank changes it. A coupon is spent once and then gone.
        </p>

        {perks.length === 0 ? (
          <StateBlock
            icon="ic-percent"
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
              <div className="perk-chips" role="group" aria-label="Filter by where you got it">
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
    <div className="answer">
      <div className="answer-verdict">{answer.verdict}</div>

      {answer.matches.map((match) => (
        <div className={`answer-row${match.kind === "COUPON" ? " is-coupon" : ""}`} key={match.id}>
          <div className="answer-main">
            <div className="answer-title">
              {match.title}
              {match.card && <span className="answer-card">on {match.card.name}</span>}
              {match.reach === "ANYWHERE" && <span className="answer-reach">everywhere</span>}
              {match.reach === "CATEGORY" && <span className="answer-reach">this category</span>}
            </div>
            <div className="answer-sub">
              {match.valueMinor !== null && match.valueMinor > 0 && (
                <b>{formatMoney(match.valueMinor)} back. </b>
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

          {match.code && <code className="answer-code">{match.code}</code>}

          {match.kind === "COUPON" && (
            <button className="btn btn-sm" onClick={() => onUsed(match)}>
              Used it
            </button>
          )}
        </div>
      ))}

      {answer.floatAlternative && (
        <div className="answer-float">
          <Icon name="ic-wallet" />
          Longest to pay: <b>{answer.floatAlternative.name}</b>, {answer.floatAlternative.floatDays} days
          {answer.matches.length > 0 ? " — but no offer here." : "."}
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
    <button className={`perk-chip${on ? " is-on" : ""}`} aria-pressed={on} onClick={onClick}>
      {label} <span className="perk-chip-count">{count}</span>
    </button>
  );
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
  const worth = perk.percent ? `${perk.percent}%` : perk.flatMinor ? formatMoney(perk.flatMinor) : "";
  const terms = perk.terms?.trim();
  const extracted = perk.extractedText?.trim();

  return (
    <div
      className={`perk-row perk-row-full${perk.isLive === false ? " is-dead" : ""}${
        perk.needsReview ? " needs-review" : ""
      }`}
    >
      <div className="perk-row-top">
        <span className={`perk-kind is-${perk.kind === "COUPON" ? "coupon" : "offer"}`}>
          {perk.kind === "COUPON" ? "Coupon" : "Card offer"}
        </span>

        <div className="perk-main">
          <div className="perk-title">
            {perk.title} {worth && <span className="perk-worth">{worth}</span>}
            {perk.source?.trim() && <span className="perk-source">from {perk.source.trim()}</span>}
            {/* Which of them a machine wrote, so the count in the banner
                above is findable rather than just a number. */}
            {perk.needsReview && <span className="perk-unread">read from a picture</span>}
          </div>
          <div className="perk-sub">
            {perk.merchants.length > 0 ? perk.merchants.join(", ") : "anywhere"}
            {card ? ` · ${card.nickname?.trim() || card.bankName}` : ""}
            {perk.code ? ` · ${perk.code}` : ""}
            {perk.usedAt
              ? " · used"
              : perk.expiresOn
                ? ` · ${
                    (perk.daysLeft ?? 0) < 0
                      ? "expired"
                      : `${perk.daysLeft} ${perk.daysLeft === 1 ? "day" : "days"} left`
                  }`
                : ""}
          </div>
        </div>

        <div className="perk-actions">
          {perk.kind === "COUPON" && (
            <button className="btn btn-sm btn-ghost" onClick={() => onUsed(!perk.usedAt)}>
              {perk.usedAt ? "Unuse" : "Used it"}
            </button>
          )}
          <button className="btn btn-sm btn-ghost" onClick={onEdit} aria-label={`Edit ${perk.title}`}>
            <Icon name="ic-pencil" />
          </button>
          <button
            className="btn btn-sm btn-ghost btn-danger-text"
            onClick={onRemove}
            aria-label={`Delete ${perk.title}`}
          >
            <Icon name="ic-x" />
          </button>
        </div>
      </div>

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

function CopyButton({ text }: { text: string }) {
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
    <button className="btn btn-sm btn-ghost perk-copy" onClick={copy}>
      {copied ? "Copied" : "Copy text"}
    </button>
  );
}
