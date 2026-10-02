import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CardLimits } from "../components/CardLimits";
import { DailyBucket } from "../components/DailyBucket";
import { CardPicker } from "../components/CardPicker";
import { EarmarksCard } from "../components/home/EarmarksCard";
import { MoneyCarousel } from "../components/home/MoneyCarousel";
import { PlanWarnings } from "../components/home/PlanWarnings";
import { Icon } from "../components/Icon";
import { LoanModal } from "../components/LoanModal";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { formatMoney, formatMoneyShort, formatShortDate } from "../lib/format";
import { DashboardData, FixedCommitment, Loan, UpcomingBill, commitmentAmountLabel } from "../types";

/**
 * The Dashboard tab of Home: what you need to know now.
 *
 * Everything here passes one test — could you act on it before closing the
 * app? A card near its limit changes which card comes out of the wallet; a
 * chart of last March changes nothing, and lives on the Analytics tab.
 *
 * Laid out as a grid of compact cards, two to a row, so a wide screen is
 * used side to side instead of as one long column. A card takes the whole
 * row only when what it holds is genuinely wide (a list of loans).
 *
 * One request draws the whole thing. Seven round trips to paint the screen
 * you land on is the slowest possible place to spend them.
 */
export function DashboardTab() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [editingLoan, setEditingLoan] = useState<Loan | null>(null);

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

  const { pace, daily, monthSoFar, needsCategory, emis, loans, owed, expiringPerks, statements, bills } = data;
  const change = monthSoFar.changeMinor;
  const earmarks = data.earmarks;

  return (
    <>
      {/* What there is to spend comes first: every other figure on the
          page is a question about it. */}
      <MoneyCarousel money={data.money} cards={data.cards} />

      {/* The plan's broken rules, while there is still month left to fix them. */}
      <PlanWarnings warnings={data.planWarnings ?? []} />

      {/* Jobs before figures: the things that want doing are the reason to
          have opened the app at all. */}
      <TodoStrip
        needsCategory={needsCategory}
        stuckStatements={statements.stuckCount}
        expiring={expiringPerks.length}
        bills={bills}
      />

      <div className="home-grid">
        {daily?.configured && (
          <div className="home-card">
            <DailyBucket daily={daily} />
          </div>
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

        {pace.configured ? (
          <div className="home-card">
            <h3 className="home-card-title">Spending pace</h3>
            <p className="section-sub">
              {pace.daysLeft} {pace.daysLeft === 1 ? "day" : "days"} until the next salary.
            </p>

            <div className={`budget-headline home-pace is-${pace.state}`}>
              <div>
                <span className="emi-preview-label">Left to spend</span>
                <span className="budget-figure num">{formatMoney(pace.remainingMinor)}</span>
              </div>
              <div>
                <span className="emi-preview-label">A day from here</span>
                <span className="budget-figure num">{formatMoney(pace.perDayMinor)}</span>
              </div>
              <div>
                <span className="emi-preview-label">Lately</span>
                <span className="budget-figure num">{formatMoney(pace.recentPerDayMinor)} a day</span>
              </div>
            </div>

            <div className={`pace-source${pace.salaryIsActual ? "" : " is-guess"}`}>
              <Icon name={pace.salaryIsActual ? "ic-check" : "ic-info"} />
              {pace.salaryIsActual
                ? `Built on the ${formatMoney(pace.salaryMinor)} that actually landed.`
                : "Built on the salary in Settings. Tick the credit on your ledger as salary and this uses what really arrived."}
            </div>

            {pace.state !== "ok" && (
              <p className="budget-verdict">
                <Icon name="ic-alert" />
                {pace.state === "over"
                  ? "Past the salary for this period. Anything more comes out of something else."
                  : "Carrying on at the last week's pace would run this period dry before payday."}
              </p>
            )}

            {/* Sending less than usual is worth a sentence rather than a
                silently unticked box. */}
            {pace.shortfallNote && (
              <p className="budget-verdict">
                <Icon name="ic-info" />
                {pace.shortfallNote}
              </p>
            )}

            {pace.commitments.length > 0 && (
              <div className="budget-commitments">
                <div className="trip-settle-title">
                  Fixed each month
                  {pace.commitmentsRemainingMinor > 0 &&
                    ` · ${formatMoneyShort(pace.commitmentsRemainingMinor)} still to go out`}
                </div>
                {pace.commitments.map((commitment) => (
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
                        <em className="commitment-short">
                          {formatMoneyShort(commitment.shortfallMinor ?? 0)} short
                        </em>
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
            )}
          </div>
        ) : (
          <div className="home-card">
            <h3 className="home-card-title">Spending pace</h3>
            <p className="section-sub">
              Tell SpendLog what lands each month and when, and it can say how much a day is left before the
              next one. <Link to="/settings?tab=budget">Set your salary</Link>.
            </p>
          </div>
        )}

        {data.cards.length > 0 && (
          <div className="home-card">
            <CardLimits cards={data.cards} />
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
}: {
  needsCategory: { yesterday: number; month: number };
  stuckStatements: number;
  expiring: number;
  bills: UpcomingBill[];
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
