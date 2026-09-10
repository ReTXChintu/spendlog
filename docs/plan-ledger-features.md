# Plan: merging, accounts, splits and EMIs

Four requested features. They look independent but three of them break the
same assumption, so that gets fixed first.

## The assumption that breaks

Today `amountMinor` means two things at once: **what the bank moved** and
**what I spent**. Every total in the app sums it directly —
[`analytics.routes.ts:52`](../apps/backend/src/modules/analytics/analytics.routes.ts#L52),
the category breakdown below it, the trend, and the day totals in
[`transactions.routes.ts:135`](../apps/backend/src/modules/transactions/transactions.routes.ts#L135)
— each with its own `isTransfer: false` filter.

Three of the four features drive those two meanings apart:

| Case | Bank moved | I actually spent |
| --- | --- | --- |
| Split dinner, I paid | ₹1,200 | ₹400 |
| ₹36,000 fridge on EMI | ₹36,000 today | ₹3,200 × 12 months |
| Splitwise settles up | ₹850 in | ₹0 (it's a repayment) |
| Transfer between my accounts | ₹5,000 | ₹0 (already handled) |

Adding each feature by bolting another condition onto four aggregation
pipelines gets wrong quickly — and quietly, because a wrong total still
looks like a number.

### The fix: one counted amount

Add to `Transaction`:

```ts
/// What this row contributes to spend and income totals. Differs from
/// amountMinor whenever only part of the money was really mine.
countedAmountMinor: number;

/// Why it differs, so the UI can explain a number that doesn't match
/// the figure on the row.
countedReason: "FULL" | "TRANSFER" | "SETTLEMENT" | "SPLIT" | "EMI_PARENT" | "EXCLUDED";
```

Resolved by one function, in priority order:

1. `isTransfer` → `0`, `TRANSFER`
2. is an EMI parent purchase → `0`, `EMI_PARENT`
3. `isSettlement` → `0`, `SETTLEMENT`
4. `split.myShareMinor` set → that value, `SPLIT`
5. `excludeFromTotals` set by hand → `0`, `EXCLUDED`
6. otherwise → `amountMinor`, `FULL`

Stored rather than computed per query, recalculated in a `pre('save')` hook
and on every update path, so aggregations stay simple. Every total then
sums `countedAmountMinor` and drops its bespoke `isTransfer` filter.

One catch: breakdowns must filter `countedAmountMinor: { $gt: 0 }`, or
transfers and EMI parents turn up as ₹0 rows in the category list.

A backfill script sets it on existing rows (`= amountMinor`, or `0` where
`isTransfer`). Nothing else changes behaviour, so this ships invisibly and
everything after it becomes a small change instead of a risky one.

---

## 1. Merging SMS and email

### What happens now

[`ingest.ts:34`](../apps/backend/src/parsing/ingest.ts#L34) finds a duplicate
and **throws the second message away** — `status: "duplicate"`, nothing
stored. So there is no record that two sources saw it, and the email's
often-better merchant name is lost. Nothing to "show as merged", because
only one message survives.

### Keep both

```ts
sources: [{
  source: "SMS" | "EMAIL",
  sourceRef: string | null,
  rawText: string,
  receivedAt: Date,
}]
```

Top-level `source` / `rawText` / `sourceRef` stay as the first-seen values,
so nothing that reads them breaks. On a duplicate, append to `sources`
instead of discarding — and **enrich**: fill in a merchant or account the
first message lacked, but never overwrite a field where `editedAt` is set.
A hand-corrected row stays corrected.

### Manual merge

Auto-dedup misses when the amounts differ (email includes a fee), the gap
exceeds the 20-minute window, or one side has no account. It also
occasionally *over*-merges: two genuine ₹500 payments ten minutes apart on
unknown accounts look identical to it.

- `POST /transactions/:id/merge` `{ sourceIds: [...] }` — absorbs their
  `sources`, fills blank fields, stores a full snapshot of each absorbed
  row in `mergedFrom[]`, deletes them
- `POST /transactions/:id/unmerge` — recreates from those snapshots

Snapshots are what make unmerge exact rather than a guess, and they cost a
few hundred bytes on the rows that have been merged.

### UI

- A merged row shows both source icons; "original message" becomes a list
- Long-press in the ledger for selection mode → pick two → **Merge**
- The edit sheet gets **Unmerge** when `mergedFrom` is non-empty
- Later: a "possible duplicates" prompt for near-matches auto-dedup skipped

---

## 2. Accounts and cards

Half of this exists. `Account` already has `bankName`, `last4`,
`accountType`, `nickname`; [`resolveAccount`](../apps/backend/src/parsing/accounts.ts)
upserts one per real account; the edit form already lets you reassign a
transaction. What's missing is everything to do with *managing* them —
only `GET /accounts` exists.

### Add

- `POST` / `PATCH` / `DELETE /accounts`
- New fields: `issuer`, `cardNetwork`, `creditLimitMinor`, `statementDay`,
  `dueDay`, `isActive`, `color` — the last four matter for EMIs and card
  bills later
- Delete refuses while transactions reference the account, offering merge
  or unassign instead

### The alias problem

Auto-created accounts will duplicate: "HDFC" from one SMS format, "HDFC
Bank" from another. Merging them is not enough — `resolveAccount` upserts
on `{bankName, last4, accountType}` and would recreate the duplicate on the
next message.

So `Account` needs:

```ts
aliases: [{ bankName: string, last4: string | null, accountType: AccountType }]
```

`resolveAccount` matches the primary tuple *or* any alias; merging moves
the loser's tuple into the winner's `aliases`. Without this, merged
accounts silently reappear.

Note that `nickname` is display-only and deliberately not part of the match
key — renaming an account must never affect matching.

### UI

Settings → **Accounts**: list with balance-relevant detail, add/edit sheet,
merge action. Ledger rows show `nickname ?? bankName`. Add an account
filter to the ledger (`buildFilter` already takes `accountId`).

---

## 3. Splits and Splitwise

Two separate mechanics, worth not conflating.

### (a) Per-transaction split

I paid ₹1,200, my share is ₹400.

```ts
split: {
  myShareMinor: number,
  direction: "I_PAID",          // see below
  groupLabel?: string,          // "Goa trip"
  participants?: [{ name: string, shareMinor: number }],
}
```

`countedAmountMinor` becomes `myShareMinor`; the remaining ₹800 becomes
**owed to me**. `participants` is optional — for most rows "my share was
₹400" is the whole story, and demanding a full participant list would make
the common case tedious.

The mirror case (a friend paid, I owe my share) creates no bank
transaction at all, so it isn't a transaction row. **Deferred** — it only
ever surfaces as part of a settlement, below.

### (b) Settling up

At month end Splitwise nets everything into one payment. That money must
not count as income (or spend, if paying out) — it is settling receivables
already recorded.

```ts
isSettlement: boolean;
```

`countedAmountMinor` → `0`, and the amount moves the **owed-to-me balance**
instead:

```
owed to me = Σ (amountMinor − myShareMinor) over splits
           − Σ settlements received
           + Σ settlements paid
```

Deliberately a **pool, not a ledger of linked debts**. Splitwise nets
across many transactions, months and people; insisting each settlement be
matched to specific splits would be laborious and still wrong. A running
balance you can eyeball against the Splitwise app is honest about its own
precision, and drift is itself informative.

Surfaced on Analytics as "Owed to you: ₹X", with a list of unsettled
splits behind it.

### Splitwise API — deferred, not designed out

An integration (OAuth, pull expenses, match to transactions) is a project
in itself, and matching their expense records to bank rows is the same
fuzzy problem as SMS/email dedup. Manual first. Nothing above blocks it
later: `split.groupLabel` and `participants` are the fields it would fill.

---

## 4. EMIs

A ₹36,000 purchase becomes 12 × ₹3,200.

```ts
EmiPlan {
  userId, sourceTransactionId, accountId,
  principalMinor, months, monthlyAmountMinor, totalPayableMinor,
  interestRatePctAnnual?, processingFeeMinor?,
  startDate, status: "ACTIVE" | "CLOSED" | "CANCELLED",
}

EmiInstalment {
  planId, seq, dueDate, amountMinor,
  status: "DUE" | "PAID" | "SKIPPED",
  transactionId?,   // the real debit, once it arrives
}
```

### When does an EMI count as spend?

Two defensible answers: at purchase (accrual), or per instalment
(cash-flow). This app answers "what did I spend today", so **cash-flow**:
the parent purchase counts `0` (`EMI_PARENT`) and each instalment counts
when it is actually debited. Counting both would double the ₹36,000.

### Instalments are not transactions until they happen

Generating 12 future `Transaction` rows would put money in the ledger that
hasn't moved. `EmiInstalment` rows are the schedule; they drive an
**Upcoming** view and the monthly forecast. When the real EMI debit
arrives, ingest matches it to a `DUE` instalment (same account, amount
within tolerance, near the due date), links it, and it counts as spend
like any other row.

### Interest

Let the user enter **either** the monthly amount (it's on the statement —
always right, no arithmetic to disagree with) **or** a rate, computing:

```
monthly = P × r × (1+r)^n / ((1+r)^n − 1)      r = annual / 12 / 100
```

Indian card EMIs are usually flat-rate with GST on the interest, so a
computed figure often misses by a few rupees. The entered amount wins when
both are present.

Edge cases to handle explicitly: no-cost EMI (discount offsets interest),
one-off processing fee (a real transaction, counts in full), foreclosure
(close the plan, mark remaining instalments `SKIPPED`).

### UI

- Edit sheet → **Convert to EMI**: months, monthly amount or rate, start date
- Ledger row shows an "EMI 3/12" badge
- New Analytics block: committed EMI outflow for the month, and total
  outstanding

---

## Order of work

Only phase 0 is a hard prerequisite, and only for 3 and 4.

| Phase | What | Depends on | Why here |
| --- | --- | --- | --- |
| 0 | `countedAmountMinor` + centralised totals + backfill | — | Invisible, but 3 and 4 are unsafe without it |
| 1 | Accounts CRUD, aliases, merge, UI | — | Self-contained; EMIs need real card records |
| 2 | Keep both sources, manual merge/unmerge | — | Touches ingest, so worth doing on its own |
| 3 | Splits and settlements | 0 | |
| 4 | EMI plans, schedule, matching | 0, 1 | Largest, and benefits from the rest settling |

1 and 2 can swap freely; 2 is the one you named first, and the only cost of
doing it first is that it changes ingest, where the tests already are.

## Testing

- `countedAmountMinor` resolution: one case per reason, plus precedence
  (a split that's also a transfer)
- Merge/unmerge round-trip: unmerge restores byte-identical rows
- `resolveAccount` honours aliases and does not recreate merged accounts
- EMI schedule maths against a real statement; instalment matching within
  tolerance
- Existing 25 tests must stay green — phase 0 changes their totals path

## Deliberately not doing yet

- Splitwise API integration
- "A friend paid, I owe" as a first-class row
- Credit-card statement/bill-cycle reconciliation
- Multi-currency (the `currency` field exists; nothing reads it)
