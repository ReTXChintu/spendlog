import { FormEvent, useCallback, useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { PerkModal } from "../components/PerkModal";
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

  const load = useCallback(() => {
    api.get<Perk[]>("/perks").then(setPerks).catch(() => setPerks([]));
  }, []);

  useEffect(load, [load]);
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
          <button className="btn btn-sm btn-primary" onClick={() => setEditing({ perk: null })}>
            <Icon name="ic-plus" /> Add one
          </button>
        </div>
      </div>

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
          <div className="perk-list">
            {perks.map((perk) => (
              <PerkRow
                key={perk.id}
                perk={perk}
                onEdit={() => setEditing({ perk })}
                onUsed={(used) => markUsed(perk, used)}
                onRemove={() => remove(perk)}
              />
            ))}
          </div>
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

  return (
    <div className={`perk-row${perk.isLive === false ? " is-dead" : ""}`}>
      <span className={`perk-kind is-${perk.kind === "COUPON" ? "coupon" : "offer"}`}>
        {perk.kind === "COUPON" ? "Coupon" : "Card offer"}
      </span>

      <div className="perk-main">
        <div className="perk-title">
          {perk.title} {worth && <span className="perk-worth">{worth}</span>}
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
        <button className="btn btn-sm btn-ghost" onClick={onEdit}>
          <Icon name="ic-pencil" />
        </button>
        <button className="btn btn-sm btn-ghost btn-danger-text" onClick={onRemove}>
          <Icon name="ic-x" />
        </button>
      </div>
    </div>
  );
}
