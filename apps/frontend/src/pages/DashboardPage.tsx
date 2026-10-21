import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BudgetEditor } from "../components/budget/BudgetEditor";
import { MonthlyBudgetCard } from "../components/budget/MonthlyBudgetCard";
import { CardPicker } from "../components/CardPicker";
import { EarmarksCard } from "../components/home/EarmarksCard";
import { PlanWarnings } from "../components/home/PlanWarnings";
import { possessive } from "../components/PocketMoneyPanel";
import { Icon } from "../components/Icon";
import { LoanModal } from "../components/LoanModal";
import { StateBlock } from "../components/States";
import { Wallet } from "../components/wallet/Wallet";
import { api } from "../lib/api";
import { formatMoney, formatMoneyShort, formatShortDate } from "../lib/format";
import {
  DashboardData,
  FixedCommitment,
  Loan,
  PocketMoneyStatus,
  UpcomingBill,
  commitmentAmountLabel,
} from "../types";

/**
 * The Dashboard tab of Home: what you need to know now.
 *
 * Everything here passes one test — could you act on it before closing the
 * app? A card near its limit changes which card comes out of the wallet; a
 * chart of last March changes nothing, and lives on the Analytics tab.
 *
 * Laid out as the design lays it out: the month's "Free to spend" hero
 * beside the "Needs you" queue, then the wallet of cards and accounts
 * across the full width, then this month's figures and the card to use
 * today, then fixed costs, loans and earmarked money.
 *
 * One request draws the whole thing. Seven round trips to paint the screen
 * you land on is the slowest possible place to spend them.
 */
export function DashboardTab() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [editingLoan, setEditingLoan] = useState<Loan | null>(null);
  // The budget editor, and the total it starts from when there is none yet.
  const [editingBudget, setEditingBudget] = useState<{ startFromMinor: number | null } | null>(null);

  const load = useCallback(() => {
    api
      .get<DashboardData>("/dashboard")
      .then((next) => {
        setData(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(load, [load]);

  async function togglePaid(commitment: FixedCommitment, paid: boolean) {
    await api.post(`/budget/commitments/${commitment.id}/paid`, { paid }).catch(() => undefined);
    load();
  }

  if (failed) {
    return (
      <StateBlock
        icon="ic-wifioff"
        title="Couldn't reach the server"
        body="Nothing is lost — this screen is built from what the server already knows. Try again in a moment."
        actions={
          <button className="btn btn-primary" onClick={load}>
            Try again
          </button>
        }
      />
    );
  }

  if (!data) return <HomeSkeleton />;

  const { pace, budget, monthSoFar, needsCategory, emis, loans, owed, expiringPerks, statements, bills } = data;
  const change = monthSoFar.changeMinor;
  const changePct = monthSoFar.previousMinor > 0 ? Math.round((change / monthSoFar.previousMinor) * 100) : null;
  const earmarks = data.earmarks;
  const pocketMoney = data.pocketMoney ?? [];
  const commitments = pace.configured ? pace.commitments : [];
  const paidCount = commitments.filter((commitment) => commitment.isPaid).length;
  const paidMinor = commitments.reduce(
    (sum, commitment) =>
      sum +
      (commitment.isPaid
        ? (commitment.thisPeriodAmountMinor ?? commitment.amountMinor)
        : (commitment.paidMinor ?? 0)),
    0
  );
  const fixedRemaining = pace.configured ? pace.commitmentsRemainingMinor : 0;
  const fixedTotal = paidMinor + fixedRemaining;

  return (
    <div className="home-dash">
      <div className="flow">
        {budget && (
          <div className="span-8">
            <MonthlyBudgetCard
              budget={budget}
              onEdit={(startFromMinor) => setEditingBudget({ startFromMinor: startFromMinor ?? null })}
              onSaved={load}
            />
          </div>
        )}

        <div className="span-4 stack">
          {/* Jobs before figures: the things that want doing are the reason
              to have opened the app at all. */}
          <NeedsYou
            needsCategory={needsCategory}
            stuckStatements={statements.stuckCount}
            expiring={expiringPerks.length}
            bills={bills}
            pocketMoney={pocketMoney}
          />

          {/* The plan's broken rules, while there is still month left to fix them. */}
          <PlanWarnings warnings={data.planWarnings ?? []} />
        </div>
      </div>

      {/* What there is, card by card and account by account: every other
          figure on the page is a question about it. */}
      <Wallet money={data.money} cards={data.wallet?.cards ?? []} banks={data.wallet?.banks ?? []} />

      <div className="flow">
        <section className="card span-8" aria-labelledby="this-month-title">
          <div className="card-head">
            <h2 id="this-month-title">This month</h2>
            <span className="meta">
              Day {monthSoFar.dayOfMonth}
              {monthSoFar.label ? ` of ${monthSoFar.label}` : ""}, against the same point last month — not the whole
              of it
            </span>
          </div>

          <div className="tile-grid home-tiles">
            <Link className="stat-tile" to="/?tab=analytics">
              <span className="label">
                <Icon name="ic-list" /> Spent so far
              </span>
              <span className="value num">{formatMoneyShort(monthSoFar.spentMinor)}</span>
              <span className={`home-delta num${change > 0 ? " is-up" : change < 0 ? " is-down" : ""}`}>
                {change === 0
                  ? "Level with last month"
                  : `${change > 0 ? "+" : "−"}${formatMoneyShort(Math.abs(change))}${
                      changePct !== null ? ` (${change > 0 ? "+" : "−"}${Math.abs(changePct)}%)` : ""
                    } ${change > 0 ? "more" : "less"} than last month`}
              </span>
              <span className="foot home-tile-link">
                See where it went <Icon name="ic-chevron-right" />
              </span>
            </Link>

            {pace.configured && commitments.length > 0 && (
              <div className="stat-tile">
                <span className="label">
                  <Icon name="ic-list-checks" /> Fixed costs
                </span>
                <span className="value num">
                  {paidCount} of {commitments.length} paid
                </span>
                <span className="foot">
                  {fixedRemaining > 0 ? `${formatMoneyShort(fixedRemaining)} still to go out` : "All gone out for this month"}
                </span>
              </div>
            )}

            {emis.count > 0 && (
              <div className="stat-tile">
                <span className="label">
                  <Icon name="ic-repeat" /> EMIs running
                </span>
                <span className="value num">
                  {formatMoneyShort(emis.monthlyMinor)}
                  <small className="home-unit">/month</small>
                </span>
                <span className="foot">
                  Across {emis.count === 1 ? "one plan" : `${emis.count} plans`} · {formatMoneyShort(emis.remainingMinor)}{" "}
                  still to pay
                </span>
              </div>
            )}

            {loans.count > 0 && (
              <div className="stat-tile">
                <span className="label">
                  <Icon name="ic-banknote" /> Loans
                </span>
                <span className="value num">
                  {formatMoneyShort(loans.monthlyMinor)}
                  <small className="home-unit">/month</small>
                </span>
                <span className="foot">
                  {loans.count === 1 ? "One loan" : `${loans.count} loans`} · {formatMoneyShort(loans.remainingMinor)} still to
                  repay
                </span>
              </div>
            )}

            {owed.balanceMinor !== 0 && (
              <Link className="stat-tile" to="/people">
                <span className="label">
                  <Icon name="ic-users" /> Split bills
                </span>
                <span className={`value num${owed.balanceMinor > 0 ? " is-good" : ""}`}>
                  {formatMoneyShort(Math.abs(owed.balanceMinor))}
                </span>
                <span className="foot">{owed.balanceMinor > 0 ? "owed to you" : "you owe"} · see who</span>
              </Link>
            )}
          </div>
        </section>

        <section className="card span-4" aria-labelledby="pick-title">
          <div className="card-head">
            <h2 id="pick-title">Which card today</h2>
          </div>
          <p className="home-meta">
            The card that gives you longest before the money actually has to leave, on each network.
          </p>
          <CardPicker picks={data.picks} />
        </section>
      </div>

      <div className="flow">
        {/* Rent, SIPs and the like count against the budget like anything
            else; ticking one off here is how the budget's pace knows it has
            gone out and stops holding money back for it. */}
        {pace.configured && commitments.length > 0 && (
          <section className="card span-5" aria-labelledby="fixed-title">
            <div className="card-head">
              <h2 id="fixed-title">Fixed each month</h2>
              <span className="badge badge-neutral">
                {paidCount} of {commitments.length} settled
              </span>
              <span className="spacer" />
              <Link className="btn-link" to="/settings?tab=budget">
                Change fixed costs <Icon name="ic-chevron-right" />
              </Link>
            </div>

            {fixedTotal > 0 && (
              <div
                className="pace-track compact home-fixed-bar"
                role="img"
                aria-label={`${formatMoneyShort(paidMinor)} settled, ${formatMoneyShort(fixedRemaining)} still to come`}
              >
                <span className="seg-spent" style={{ width: `${(paidMinor / fixedTotal) * 100}%` }} />
                <span className="seg-promised" style={{ width: `${(fixedRemaining / fixedTotal) * 100}%` }} />
              </div>
            )}
            <p className="home-meta num">
              {fixedRemaining > 0
                ? `${formatMoneyShort(paidMinor)} settled · ${formatMoneyShort(fixedRemaining)} still to come — the budget's safe-a-day figure already sets it aside.`
                : "All gone out for this month."}
            </p>

            {/* Sending less than usual is worth a sentence rather than a
                silently unticked box. */}
            {pace.shortfallNote && (
              <div className="callout callout-warn home-callout-sm">
                <Icon name="ic-info" />
                <div className="callout-body">{pace.shortfallNote}</div>
              </div>
            )}

            <ul className="home-fixed">
              {commitments.map((commitment) => (
                <li key={commitment.id}>
                  <label className={`home-fixed-row${commitment.isPaid ? " is-paid" : ""}`}>
                    <input
                      type="checkbox"
                      checked={commitment.isPaid ?? false}
                      onChange={(e) => togglePaid(commitment, e.target.checked)}
                    />
                    <span className="home-fixed-main">
                      <span className="home-fixed-name">{commitment.name}</span>
                      <span className="home-fixed-sub">
                        Due on the {commitment.dayOfMonth}
                        {ordinal(commitment.dayOfMonth)}
                        {commitment.isPartial && (
                          <em className="home-fixed-short">
                            {" · "}
                            {formatMoneyShort(commitment.shortfallMinor ?? 0)} short
                          </em>
                        )}
                      </span>
                    </span>
                    <span className="home-fixed-amount num">
                      {commitment.isPartial
                        ? `${formatMoneyShort(commitment.paidMinor ?? 0)} of ${formatMoneyShort(
                            commitment.thisPeriodAmountMinor ?? commitment.amountMinor
                          )}`
                        : commitmentAmountLabel(commitment, formatMoneyShort)}
                      {commitment.isPaid && <span className="badge badge-good">Paid</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        )}

        {loans.count > 0 && (
          <section className="card span-4" aria-labelledby="loans-title">
            <div className="card-head">
              <h2 id="loans-title">Loans</h2>
              <span className="meta num">
                {formatMoneyShort(loans.monthlyMinor)} a month · {formatMoneyShort(loans.remainingMinor)} still to repay. Soonest due
                first.
              </span>
            </div>
            <div className="home-loans">
              {loans.loans.map((loan) => {
                const share = Math.round((loan.paidCount / Math.max(1, loan.months)) * 100);
                return (
                  <button className="home-loan" key={loan.id} onClick={() => setEditingLoan(loan)}>
                    <span className="home-loan-top">
                      <span className="home-loan-name">{loan.label}</span>
                      <span className="home-loan-left num">{formatMoneyShort(loan.remainingMinor)} left</span>
                    </span>
                    <span className="home-loan-figure num">
                      {formatMoneyShort(loan.monthlyAmountMinor)}
                      <small> /month</small>
                    </span>
                    <span className="meter home-loan-meter" aria-hidden="true">
                      <span className="meter-fill is-ink" style={{ width: `${share}%` }} />
                    </span>
                    <span className="home-loan-sub num">
                      <span>
                        {loan.paidCount} of {loan.months} paid
                      </span>
                      {loan.nextDue && (
                        <span>
                          Next {formatShortDate(loan.nextDue.dueDate)}
                          {loan.nextDue.amountMinor !== loan.monthlyAmountMinor &&
                            ` · ${formatMoneyShort(loan.nextDue.amountMinor)}`}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {earmarks && earmarks.count > 0 && (
          <div className="span-3">
            <EarmarksCard earmarks={earmarks} />
          </div>
        )}
      </div>

      {editingBudget && (
        <BudgetEditor
          status={budget ?? null}
          initialAmountMinor={editingBudget.startFromMinor}
          onSaved={() => {
            setEditingBudget(null);
            load();
          }}
          onClose={() => setEditingBudget(null)}
        />
      )}

      {editingLoan && (
        <LoanModal
          loan={editingLoan}
          onSaved={() => {
            setEditingLoan(null);
            load();
          }}
          onClose={() => setEditingLoan(null)}
        />
      )}
    </div>
  );
}

/** The page's shape while it loads: the hero beside the queue, then the wallet. */
function HomeSkeleton() {
  return (
    <div className="home-dash" aria-busy="true">
      <p className="skel-caption">Loading your month…</p>
      <div className="flow">
        <div className="card card-hero span-8 home-skel">
          <span className="skel skel-line" style={{ width: "24%" }} />
          <span className="skel" style={{ width: "40%", height: 44 }} />
          <span className="skel skel-line sm" style={{ width: "32%" }} />
          <span className="skel" style={{ width: "100%", height: 14, borderRadius: 7 }} />
        </div>
        <div className="card span-4 home-skel">
          {[0, 1, 2].map((row) => (
            <div className="skel-row" key={row}>
              <span className="skel skel-circle" />
              <span>
                <span className="skel skel-line" style={{ width: "70%", marginBottom: 6 }} />
                <span className="skel skel-line sm" style={{ width: "50%" }} />
              </span>
              <span />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type Job = { to: string; icon: string; tone: "ac" | "warn" | "crit" | "neutral"; text: string; verb: string; urgent?: boolean };

/**
 * "Needs you": the jobs, as a calm queue of rows, each with one verb-led
 * action. An empty queue is one quiet line.
 */
function NeedsYou({
  needsCategory,
  stuckStatements,
  expiring,
  bills,
  pocketMoney,
}: {
  needsCategory: { yesterday: number; month: number };
  stuckStatements: number;
  expiring: number;
  bills: UpcomingBill[];
  pocketMoney: (PocketMoneyStatus & { accountId: string; name: string })[];
}) {
  const jobs: Job[] = [];

  if (needsCategory.yesterday > 0) {
    jobs.push({
      to: "/transactions?category=none",
      icon: "ic-tag",
      tone: "warn",
      text: `${needsCategory.yesterday} from yesterday ${needsCategory.yesterday === 1 ? "needs" : "need"} a category`,
      verb: "Pick categories",
      urgent: true,
    });
  } else if (needsCategory.month > 0) {
    jobs.push({
      to: "/transactions?category=none",
      icon: "ic-tag",
      tone: "ac",
      text: `${needsCategory.month} this month still ${needsCategory.month === 1 ? "needs" : "need"} a category`,
      verb: "Pick categories",
    });
  }

  // A statement is the first moment the app can know what a bill actually
  // is, rather than estimating it from the transactions it happened to see.
  for (const bill of bills) {
    const due =
      bill.daysUntilDue === null
        ? ""
        : bill.daysUntilDue < 0
          ? ` — ${Math.abs(bill.daysUntilDue)} days overdue`
          : bill.daysUntilDue === 0
            ? " — due today"
            : ` — due in ${bill.daysUntilDue} days`;
    const urgent = (bill.daysUntilDue ?? 99) <= 3;

    jobs.push({
      to: "/transactions",
      icon: "ic-credit-card",
      tone: (bill.daysUntilDue ?? 0) < 0 ? "crit" : "warn",
      text: `${bill.cardName} bill ${formatMoneyShort(bill.totalDueMinor)}${due}`,
      verb: "See payments",
      urgent,
    });
  }

  // Renewal day: put back what last month used. Gone once it's been done,
  // or when last month used nothing.
  for (const pocket of pocketMoney) {
    if (!pocket.renewsToday || pocket.toppedUpMinor > 0 || pocket.lastMonthSpentMinor <= 0) continue;
    jobs.push({
      to: `/settings?tab=accounts&account=${pocket.accountId}`,
      icon: "ic-wallet",
      tone: "warn",
      text: `Top up ${possessive(pocket.holder)} pocket money ${formatMoneyShort(pocket.lastMonthSpentMinor)} today`,
      verb: "Open the account",
      urgent: true,
    });
  }

  if (stuckStatements > 0) {
    jobs.push({
      to: "/settings?tab=accounts",
      icon: "ic-mail",
      tone: "crit",
      text: `${stuckStatements} ${stuckStatements === 1 ? "statement" : "statements"} could not be read`,
      verb: "See statements",
      urgent: true,
    });
  }

  if (expiring > 0) {
    jobs.push({
      to: "/perks",
      icon: "ic-tag",
      tone: "neutral",
      text: `${expiring} ${expiring === 1 ? "perk" : "perks"} expiring soon`,
      verb: "See perks",
    });
  }

  return (
    <section className="card needs" aria-labelledby="needs-title">
      <div className="card-head">
        <h2 id="needs-title">Needs you</h2>
        {jobs.length > 0 && <span className="badge badge-crit num">{jobs.length}</span>}
      </div>

      {jobs.length === 0 ? (
        <p className="needs-empty">Nothing needs you right now.</p>
      ) : (
        <ul className="needs-list">
          {jobs.map((job) => (
            <li className="list-row" key={job.text}>
              <span className={`icon-tile tile-${job.tone}`} aria-hidden="true">
                <Icon name={job.icon} />
              </span>
              <div className="list-row-main">
                <div className={`list-row-title${job.urgent ? " is-urgent" : ""}`}>{job.text}</div>
                <div className="list-row-actions">
                  <Link className="btn-link" to={job.to}>
                    {job.verb} <Icon name="ic-chevron-right" />
                  </Link>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
}
