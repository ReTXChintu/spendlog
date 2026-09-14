import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CardPicker } from "../components/CardPicker";
import { Icon } from "../components/Icon";
import { StateBlock } from "../components/States";
import { api } from "../lib/api";
import { formatMoney, formatMoneyShort } from "../lib/format";
import { DashboardData, FixedCommitment } from "../types";

/**
 * The landing screen: what you need to know now.
 *
 * Everything here passes one test — could you act on it before closing the
 * app? A card near its limit changes which card comes out of the wallet; a
 * chart of last March changes nothing, and lives on the analytics page.
 *
 * One request draws the whole thing. Seven round trips to paint the screen
 * you land on is the slowest possible place to spend them.
 */
export function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [failed, setFailed] = useState(false);

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
      <section className="screen">
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
      </section>
    );
  }

  if (!data) return <section className="screen" />;

  const { pace, monthSoFar, needsCategory, emis, owed, expiringPerks, statements } = data;
  const change = monthSoFar.changeMinor;

  return (
    <section className="screen">
      <div className="screen-header">
        <h1 className="screen-title">Dashboard</h1>
        <div className="screen-actions">
          <button className="btn btn-sm" onClick={() => navigate("/perks")}>
            <Icon name="ic-percent" /> What do I have here?
          </button>
        </div>
      </div>

      {/* Jobs before figures: the things that want doing are the reason to
          have opened the app at all. */}
      <TodoStrip
        needsCategory={needsCategory}
        stuckStatements={statements.stuckCount}
        expiring={expiringPerks.length}
      />

      <div className="layout-2">
        <div>
          <div className="section-block">
            <h3>This month so far</h3>
            <p className="section-sub">
              Day {monthSoFar.dayOfMonth}, against the same point last month — not the whole of it, which
              would look like overspending every time.
            </p>
            <div className="month-headline">
              <div className="month-figure num">{formatMoney(monthSoFar.spentMinor)}</div>
              <div className={`month-delta${change > 0 ? " is-up" : change < 0 ? " is-down" : ""}`}>
                <Icon name="ic-updown" />
                {change === 0
                  ? "Level with last month"
                  : `${formatMoneyShort(Math.abs(change))} ${change > 0 ? "more" : "less"} than last month`}
              </div>
              <Link className="month-link" to="/analytics">
                See where it went
              </Link>
            </div>
          </div>

          <div className="section-block">
            <h3>Which card today</h3>
            <p className="section-sub">
              The card that gives you longest before the money actually has to leave, on each network.
            </p>
            <CardPicker picks={data.picks} />
          </div>

          {pace.configured ? (
            <div className="section-block">
              <h3>Spending pace</h3>
              <p className="section-sub">
                {pace.daysLeft} {pace.daysLeft === 1 ? "day" : "days"} until the next salary.
              </p>

              <div className={`budget-headline is-${pace.state}`}>
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
                      </span>
                      <span className="num">{formatMoney(commitment.amountMinor)}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="section-block">
              <h3>Spending pace</h3>
              <p className="section-sub">
                Tell SpendLog what lands each month and when, and it can say how much a day is left before
                the next one. <Link to="/settings?tab=you">Set your salary</Link>.
              </p>
            </div>
          )}
        </div>

        <div className="rail">
          {expiringPerks.length > 0 && (
            <div className="card rail-card">
              <div className="rail-title">Expiring soon</div>
              {expiringPerks.map((perk) => (
                <Link className="rail-row" key={perk.id} to="/perks">
                  <span>{perk.title}</span>
                  <span className={`rail-badge${(perk.daysLeft ?? 0) <= 3 ? " is-urgent" : ""}`}>
                    {perk.daysLeft === 0
                      ? "today"
                      : `${perk.daysLeft}${perk.daysLeft === 1 ? " day" : " days"}`}
                  </span>
                </Link>
              ))}
            </div>
          )}

          {emis.count > 0 && (
            <div className="card rail-card">
              <div className="rail-title">EMIs running</div>
              <div className="rail-figure num">{formatMoney(emis.monthlyMinor)}</div>
              <div className="rail-sub">
                a month across {emis.count === 1 ? "one plan" : `${emis.count} plans`} ·{" "}
                {formatMoneyShort(emis.remainingMinor)} still to pay
              </div>
            </div>
          )}

          {owed.balanceMinor !== 0 && (
            <div className="card rail-card">
              <div className="rail-title">Split bills</div>
              <div className={`rail-figure num ${owed.balanceMinor > 0 ? "credit" : "debit"}`}>
                {formatMoney(Math.abs(owed.balanceMinor))}
              </div>
              <div className="rail-sub">{owed.balanceMinor > 0 ? "owed to you" : "you owe"}</div>
            </div>
          )}

          <div className="stat-tiles">
            <div className="stat-tile">
              <div className="label">Cards</div>
              <div className="value num">{data.cards.length}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
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
}: {
  needsCategory: { yesterday: number; month: number };
  stuckStatements: number;
  expiring: number;
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

  if (stuckStatements > 0) {
    jobs.push({
      to: "/settings?tab=connections",
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
