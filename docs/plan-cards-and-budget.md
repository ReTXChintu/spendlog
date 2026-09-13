# Plan: billing cycles, card limits, and a spending pace

Four asks that share one piece of arithmetic — where a payment falls in a
card's billing cycle — and one honest limitation worth stating up front.

## What this app can and cannot know

SpendLog reads messages about **transactions**. It has never known a single
**balance**. So it can say "you have spent faster this fortnight than your
salary supports" and it cannot say "you cannot afford next week's bill".

That distinction decides the whole design below. Everything here is a
**pace** indicator built from money that moved, not a solvency one built
from money that is sitting somewhere. Presenting it as the latter would be
a more impressive feature and a dishonest one.

---

## 1. Billing cycles

`Account` already carries `statementDay`, `dueDay` and `creditLimitMinor`.
Nothing reads them yet.

```
cycleFor(card, date) -> { start, statementOn, dueOn }
```

With a statement day of 12, a payment on the 13th belongs to the statement
generated on the 12th of the following month. So the cycle containing any
date runs from the day after one statement to the next statement.

Month-end is the usual trap: a statement day of 31 falls on the 28th in
February. `addMonths` already clamps exactly this way for EMI schedules, so
this reuses it rather than inventing a second answer.

`dueOn` is the `dueDay` in the month **after** `statementOn`, unless the due
day is later in the month than the statement day, in which case it is the
same month. That covers both the common shapes: statement on the 12th, due
on the 1st; and statement on the 1st, due on the 20th.

This one function is what the next three features are made of.

---

## 2. A limit per card, with a warning

`Account.spendLimitMinor` — separate from `creditLimitMinor`, which is what
the bank allows. This is what *you* allow.

The window it applies to is a real fork, and the questions below ask about
it. Assuming the billing cycle for now:

```
GET /accounts/:id/cycle
  start, statementOn, dueOn
  spentMinor          this cycle, from countedAmountMinor
  limitMinor
  remainingMinor
  state: "ok" | "close" | "over"
```

"Close" at 80%, which is the point at which knowing changes a decision;
warning any earlier is noise that gets ignored, and then so is the real one.

Shown as a strip on the ledger when a card is close or over, and on the
account itself. The edit form says it too when a payment is put on a card
that is already over.

---

## 3. Which card to pay with

> *"i have 2 rupay cards ... billing dates are 1 and 17 so we can plan
> accordingly from which card to pay so that i have to pay the bill next
> month not this month"*

For a payment made today, each card gives a different number of days before
that money actually has to leave your account:

```
float(card, today) = dueOn(cycleFor(card, today)) − today
```

On the 13th, a card that statements on the 1st has just started a fresh
cycle: the payment lands on next month's statement, due the month after.
A card that statements on the 17th puts it on a bill due in three weeks.
Same purchase, a fortnight of difference.

```
GET /cards/best-today
  [{ accountId, name, floatDays, dueOn, spentMinor, limitMinor, state }]
  sorted by float, with anything over its limit dropped to the bottom
```

A card at its limit is not the answer however long its float, so the limit
outranks the float — but it is shown rather than silently filtered, because
"why is it not suggesting my usual card" should never be a mystery.

Surfaced as a small line on the ledger: **"Paying by card today? Use HDFC —
37 days to pay, against 22 on ICICI."**

---

## 4. Salary, commitments, and a daily pace

### On the user

```
salaryAmountMinor
salaryDay            15
```

### Fixed commitments

```
FixedCommitment {
  userId, name, amountMinor, dayOfMonth,
  kind: "RENT" | "SIP" | "INSURANCE" | "OTHER",
  isActive
}
```

### The period

A salary on the 15th makes the useful month run the 15th to the 14th, not
the 1st to the 31st. The questions below check that.

### The arithmetic

The trap here is double counting, and it is easy to fall into. A card bill
is not new spending — it is last cycle's spending arriving at the bank. Add
both and every rupee on a card counts twice.

So this counts **spending when it happens**, never when it is billed:

```
available   = salary − commitments not yet paid this period
spent       = countedAmountMinor over the period, excluding
              settlements, transfers and card bill payments
remaining   = available − spent
daysLeft    = days until the next salary
perDay      = remaining / daysLeft
```

A commitment moves from "not yet paid" to "paid" when a transaction
matching its amount turns up near its day — the same trick the EMI
instalments already use — with the option to tick it off by hand when no
message ever arrives.

Card bill payments have to be excluded from `spent` or they double count.
They are recognisable: a transfer to a card account. `isTransfer` already
covers the ones between known accounts.

### What it says

```
GET /budget/pace
  periodStart, periodEnd, daysLeft
  salaryMinor, commitmentsRemainingMinor
  spentMinor, remainingMinor
  perDayMinor              what is sustainable from here
  recentPerDayMinor        the last seven days' actual pace
  state: "ok" | "watch" | "over"
```

Two numbers rather than one, because "slow down" is only meaningful
against something: what you have been spending, and what you can. `over`
when `remaining` is negative; `watch` when the recent pace would exhaust it
before the next salary.

Shown as a block on Analytics, and a single line on the ledger when the
state is not `ok`.

---

## Order of work

| Phase | What |
| --- | --- |
| 1 | `cycleFor`, as a pure function with tests. Everything else needs it |
| 2 | Card limits: the field, the cycle endpoint, the warnings |
| 3 | Which card to use today |
| 4 | Salary and commitments: profile, model, CRUD, matching |
| 5 | The pace endpoint and where it shows |

## Testing

- A statement day of 31 through February, and a leap February
- The 13th belonging to next month's statement when the statement day is 12
- Both due-date shapes: statement 12th/due 1st, and statement 1st/due 20th
- Float on the 13th with statements on the 1st and the 17th — the example
  this was asked for
- A card over its limit ranks below one with a shorter float
- **The pace never counts a card payment twice**: spend on a card, pay the
  bill, and the period's spending figure does not move
- A commitment paid by a real transaction stops being counted as pending
- Nobody else's cards or salary are ever reachable
