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
 * The wallet comes first, every card and account in full, so nothing needs
 * a trip into Settings to find. Then the month's budget across the whole
 * width - the one figure the rest of the month is measured against - and
 * below it a grid of compact cards, two to a row, so a wide screen is used
 * side to side instead of as one long column.
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

  if (!data) return <div className="home-loading" aria-busy="true" />;

  const { pace, budget, monthSoFar, needsCategory, emis, loans, owed, expiringPerks, statements, bills } = data;
  const change = monthSoFar.changeMinor;
  const earmarks = data.earmarks;
  const pocketMoney = data.pocketMoney ?? [];
  const commitments = pace.configured ? pace.commitments : [];

  return (
    <>
      {/* What there is, card by card and account by account, comes first:
          every other figure on the page is a question about it. */}
      <Wallet money={data.money} cards={data.wallet?.cards ?? []} banks={data.wallet?.banks ?? []} />

      {/* The plan's broken rules, while there is still month left to fix them. */}
      <PlanWarnings warnings={data.planWarnings ?? []} />

      {/* Jobs before figures: the things that want doing are the reason to
          have opened the app at all. */}
      <TodoStrip
        needsCategory={needsCategory}
        stuckStatements={statements.stuckCount}
        expiring={expiringPerks.length}
        bills={bills}
        pocketMoney={pocketMoney}
      />

      <div className="home-grid">
        {budget && (
          <MonthlyBudgetCard
            budget={budget}
            onEdit={(startFromMinor) => setEditingBudget({ startFromMinor: startFromMinor ?? null })}
            onSaved={load}
          />
        )}

        <div className="home-card">
          <h3 className="home-card-title">Which card today</h3>
          <p className="section-sub">
            The card that gives you longest before the money actually has to leave, on each network.
          </p>
          <CardPicker picks={data.picks} />
        </div>

        <div className="home-card">
          <h3 className="home-card-title">This month so far</h3>
          <p className="section-sub">
            Day {monthSoFar.dayOfMonth}
            {monthSoFar.label ? ` of ${monthSoFar.label}` : ""}, against the same point last month — not the
            whole of it, which would look like overspending every time.
          </p>
          <div className="home-figure">{formatMoney(monthSoFar.spentMinor)}</div>
          <div className={`month-delta${change > 0 ? " is-up" : change < 0 ? " is-down" : ""}`}>
            <Icon name="ic-updown" />
            {change === 0
              ? "Level with last month"
              : `${formatMoneyShort(Math.abs(change))} ${change > 0 ? "more" : "less"} than last month`}
          </div>
          <Link className="home-card-link" to="/?tab=analytics">
            See where it went <Icon name="ic-arrow-right" />
          </Link>
        </div>

        {earmarks && earmarks.count > 0 && <EarmarksCard earmarks={earmarks} />}

        {/* Rent, SIPs and the like count against the budget like anything
            else; ticking one off here is how the budget's pace knows it has
            gone out and stops holding money back for it. */}
        {pace.configured && commitments.length > 0 && (
          <div className="home-card">
            <h3 className="home-card-title">Fixed each month</h3>
            <p className="section-sub">
              {pace.commitmentsRemainingMinor > 0
                ? `${formatMoneyShort(pace.commitmentsRemainingMinor)} still to go out — the budget's safe-a-day figure already sets it aside.`
                : "All gone out for this month."}
            </p>

            {/* Sending less than usual is worth a sentence rather than a
                silently unticked box. */}
            {pace.shortfallNote && (
              <p className="budget-verdict">
                <Icon name="ic-info" />
                {pace.shortfallNote}
              </p>
            )}

            <div className="budget-commitments">
              {commitments.map((commitment) => (
                <label className="budget-commitment" key={commitment.id}>
                  <input
                    type="checkbox"
                    checked={commitment.isPaid ?? false}
                    onChange={(e) => togglePaid(commitment, e.target.checked)}
                  />
                  <span className={commitment.isPaid ? "is-paid" : ""}>
                    {commitment.name} · {commitment.dayOfMonth}
                    {ordinal(commitment.dayOfMonth)}
                    {commitment.isPartial && (
                      <em className="commitment-short">{formatMoneyShort(commitment.shortfallMinor ?? 0)} short</em>
                    )}
                  </span>
                  <span className="num">
                    {commitment.isPartial
                      ? `${formatMoney(commitment.paidMinor ?? 0)} of ${formatMoney(
                          commitment.thisPeriodAmountMinor ?? commitment.amountMinor
                        )}`
                      : commitmentAmountLabel(commitment, formatMoney)}
                  </span>
                </label>
              ))}
            </div>
            <Link className="home-card-link" to="/settings?tab=budget">
              Change fixed costs <Icon name="ic-arrow-right" />
            </Link>
          </div>
        )}

        {(emis.count > 0 || owed.balanceMinor !== 0) && (
          <div className="home-card">
            <h3 className="home-card-title">Owed and owing</h3>
            {emis.count > 0 && (
              <div className="home-stat">
                <span className="home-stat-label">EMIs running</span>
                <span className="home-stat-figure num">{formatMoney(emis.monthlyMinor)}</span>
                <span className="home-stat-sub">
                  a month across {emis.count === 1 ? "one plan" : `${emis.count} plans`} ·{" "}
                  {formatMoneyShort(emis.remainingMinor)} still to pay
                </span>
              </div>
            )}
            {owed.balanceMinor !== 0 && (
              <div className="home-stat">
                <span className="home-stat-label">Split bills</span>
                <span className={`home-stat-figure num ${owed.balanceMinor > 0 ? "credit" : "debit"}`}>
                  {formatMoney(Math.abs(owed.balanceMinor))}
                </span>
                <span className="home-stat-sub">
                  {owed.balanceMinor > 0 ? "owed to you" : "you owe"} · <Link to="/people">see who</Link>
                </span>
              </div>
            )}
          </div>
        )}

        {loans.count > 0 && (
          <div className={`home-card${loans.count > 1 ? " is-wide" : ""}`}>
            <h3 className="home-card-title">Loans · {formatMoney(loans.monthlyMinor)} a month</h3>
            <p className="section-sub">
              Across {loans.count === 1 ? "one loan" : `${loans.count} loans`} ·{" "}
              {formatMoney(loans.remainingMinor)} still to repay. Soonest due first.
            </p>
            <div className="loan-list">
              {loans.loans.map((loan) => (
                <button className="loan-row" key={loan.id} onClick={() => setEditingLoan(loan)}>
                  <div className="loan-row-top">
                    <span className="loan-row-name">{loan.label}</span>
                    <span className="loan-row-left num">{formatMoney(loan.remainingMinor)} left</span>
                  </div>
                  <div className="emi-progress">
                    <div
                      className="emi-progress-fill"
                      style={{ width: `${Math.round((loan.paidCount / Math.max(1, loan.months)) * 100)}%` }}
                    />
                  </div>
                  <div className="loan-row-sub">
                    <span>
                      {loan.paidCount} of {loan.months} paid · {formatMoney(loan.monthlyAmountMinor)} a month
                    </span>
                    {loan.nextDue && (
                      <span>
                        Next {formatShortDate(loan.nextDue.dueDate)}
                        {loan.nextDue.amountMinor !== loan.monthlyAmountMinor &&
                          ` · ${formatMoney(loan.nextDue.amountMinor)}`}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
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
    </>
  );
}

/**
 * The jobs, across the top.
 *
 * Nothing here when there is nothing to do — a row that is always on screen
 * stops being read, and then so does the real one.
 */
function TodoStrip({
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
  const jobs: { to: string; icon: string; text: string; urgent?: boolean }[] = [];

  if (needsCategory.yesterday > 0) {
    jobs.push({
      to: "/transactions?category=none",
      icon: "ic-question",
      text: `${needsCategory.yesterday} from yesterday ${
        needsCategory.yesterday === 1 ? "needs" : "need"
      } a category`,
      urgent: true,
    });
  } else if (needsCategory.month > 0) {
    jobs.push({
      to: "/transactions?category=none",
      icon: "ic-question",
      text: `${needsCategory.month} this month still ${
        needsCategory.month === 1 ? "needs" : "need"
      } a category`,
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

    jobs.push({
      to: "/transactions",
      icon: "ic-wallet",
      text: `${bill.cardName} bill ${formatMoney(bill.totalDueMinor)}${due}`,
      urgent: (bill.daysUntilDue ?? 99) <= 3,
    });
  }

  // Renewal day: put back what last month used. Gone once it's been done,
  // or when last month used nothing.
  for (const pocket of pocketMoney) {
    if (!pocket.renewsToday || pocket.toppedUpMinor > 0 || pocket.lastMonthSpentMinor <= 0) continue;
    jobs.push({
      to: `/settings?tab=accounts&account=${pocket.accountId}`,
      icon: "ic-wallet",
      text: `Top up ${possessive(pocket.holder)} pocket money ${formatMoney(pocket.lastMonthSpentMinor)} today`,
      urgent: true,
    });
  }

  if (stuckStatements > 0) {
    jobs.push({
      to: "/settings?tab=accounts",
      icon: "ic-alert",
      text: `${stuckStatements} ${stuckStatements === 1 ? "statement" : "statements"} could not be read`,
      urgent: true,
    });
  }

  if (expiring > 0) {
    jobs.push({
      to: "/perks",
      icon: "ic-percent",
      text: `${expiring} ${expiring === 1 ? "perk" : "perks"} expiring soon`,
    });
  }

  if (jobs.length === 0) return null;

  return (
    <div className="todo-strip">
      {jobs.map((job) => (
        <Link className={`todo-chip${job.urgent ? " is-urgent" : ""}`} key={job.text} to={job.to}>
          <Icon name={job.icon} />
          {job.text}
          <Icon name="ic-arrow-right" />
        </Link>
      ))}
    </div>
  );
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
}
