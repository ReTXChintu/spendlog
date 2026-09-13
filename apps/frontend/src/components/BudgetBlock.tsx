import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatMoney, formatMoneyShort } from "../lib/format";
import { BudgetPace, BudgetProfile } from "../types";
import { Icon } from "./Icon";

/**
 * What is left to spend before the next salary, and how fast it is going.
 *
 * Two figures rather than one: "slow down" only means something against
 * what you have actually been spending. This measures a pace, not whether
 * a bill can be paid — SpendLog has never known an account balance.
 */
export function BudgetBlock() {
  const [pace, setPace] = useState<BudgetPace | null>(null);
  const [editing, setEditing] = useState(false);
  const [salary, setSalary] = useState("");
  const [salaryDay, setSalaryDay] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [day, setDay] = useState("");

  const load = useCallback(() => {
    api
      .get<BudgetPace>("/budget/pace")
      .then(setPace)
      .catch(() => setPace(null));
  }, []);

  useEffect(load, [load]);

  async function saveProfile() {
    const rupees = Number.parseFloat(salary);
    await api.patch<BudgetProfile>("/budget/profile", {
      salaryAmountMinor: Number.isFinite(rupees) ? Math.round(rupees * 100) : null,
      salaryDay: Number.parseInt(salaryDay, 10) || null,
    });
    setEditing(false);
    load();
  }

  async function addCommitment() {
    const rupees = Number.parseFloat(amount);
    if (!name.trim() || !Number.isFinite(rupees)) return;
    await api.post("/budget/commitments", {
      name: name.trim(),
      amountMinor: Math.round(rupees * 100),
      dayOfMonth: Number.parseInt(day, 10) || 1,
    });
    setName("");
    setAmount("");
    setDay("");
    setAdding(false);
    load();
  }

  async function togglePaid(id: string, paid: boolean) {
    await api.post(`/budget/commitments/${id}/paid`, { paid });
    load();
  }

  async function removeCommitment(id: string) {
    await api.delete(`/budget/commitments/${id}`);
    load();
  }

  if (!pace) return null;

  if (!pace.configured || editing) {
    return (
      <div className="section-block">
        <h3>Spending pace</h3>
        <p className="section-sub">
          Tell it what lands each month and when, and it can say how much a day is left before the
          next one.
        </p>
        <div className="budget-setup">
          <label className="field">
            <span>Salary</span>
            <div className="amount-input">
              <span className="prefix">₹</span>
              <input
                className="filter-input"
                inputMode="decimal"
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                placeholder="100000"
              />
            </div>
          </label>
          <label className="field">
            <span>Paid on</span>
            <input
              className="filter-input"
              inputMode="numeric"
              value={salaryDay}
              onChange={(e) => setSalaryDay(e.target.value)}
              placeholder="15"
            />
          </label>
          <button className="btn btn-primary" onClick={saveProfile}>
            Save
          </button>
          {editing && (
            <button className="btn btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  const pct = pace.salaryMinor > 0 ? Math.min(100, (pace.spentMinor / pace.salaryMinor) * 100) : 0;

  return (
    <div className="section-block">
      <h3>Spending pace</h3>
      <p className="section-sub">
        {pace.daysLeft} {pace.daysLeft === 1 ? "day" : "days"} until the next salary.{" "}
        <button className="preset-save" onClick={() => setEditing(true)}>
          Change salary
        </button>
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

      {pace.state !== "ok" && (
        <p className="budget-verdict">
          <Icon name="ic-alert" />
          {pace.state === "over"
            ? "Past the salary for this period. Anything more comes out of something else."
            : "Carrying on at the last week's pace would run this period dry before payday."}
        </p>
      )}

      <div className="budget-bar">
        <div className="budget-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="budget-legend">
        <span>{formatMoneyShort(pace.spentMinor)} spent</span>
        <span>{formatMoneyShort(pace.salaryMinor)} salary</span>
      </div>

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
              onChange={(e) => togglePaid(commitment.id, e.target.checked)}
            />
            <span className={commitment.isPaid ? "is-paid" : ""}>
              {commitment.name} · {commitment.dayOfMonth}
              {ordinal(commitment.dayOfMonth)}
            </span>
            <span className="num">{formatMoney(commitment.amountMinor)}</span>
            <button
              className="preset-remove"
              title={`Remove ${commitment.name}`}
              onClick={(e) => {
                e.preventDefault();
                removeCommitment(commitment.id);
              }}
            >
              ×
            </button>
          </label>
        ))}

        {adding ? (
          <div className="budget-setup">
            <input
              className="filter-input"
              placeholder="Rent"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="filter-input"
              placeholder="₹ amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <input
              className="filter-input"
              placeholder="Day"
              inputMode="numeric"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
            <button className="btn btn-sm btn-primary" onClick={addCommitment}>
              Add
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="preset-save" onClick={() => setAdding(true)}>
            Add rent, a SIP, insurance…
          </button>
        )}

        <p className="field-hint" style={{ marginTop: 8 }}>
          Tick one when it has gone out. Until then it is held back from what is left to spend — so
          an unticked one that has already been paid is counted twice.
        </p>
      </div>
    </div>
  );
}

function ordinal(day: number): string {
  if (day > 3 && day < 21) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
}
