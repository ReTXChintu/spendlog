# Plan: reading credit card statements

Every alert-based ledger has the same hole in it. SpendLog only knows what
a bank chose to send a message about, and banks do not send messages about
everything. Annual fees, finance charges, GST on those charges, a payment
made on a machine that never triggered an SMS, anything that arrived while
the phone was off — none of it is in the ledger, and nothing in the app
today can discover that it is missing.

The statement is the bank's own list. It is complete, it is late, and it
is the only thing that can tell you what you never saw.

So this feature is **reconciliation**, not another importer.

---

## What a statement is allowed to do

One rule decides most of the design: **a statement may never silently
duplicate a transaction that is already in the ledger.** A month of card
spending is already in SpendLog via SMS and email alerts. Re-importing the
statement naively would double every figure in the app.

So every line is matched against what is already there first, and only the
leftovers are new.

The other half of the rule: **a statement line is not always money spent.**
A statement contains the payment you made against last month's bill, the
opening balance, reward-point totals, and page furniture. Three of those
four would corrupt the ledger if treated as transactions. Classification is
therefore not a tidying step — it is the safety mechanism, and it gets its
own tested module.

---

## 1. Getting the file

Statements arrive as PDF attachments, password-protected, from a small set
of known senders.

Gmail is already connected with read access, so discovery is another query
against the same mailbox — separate from the transaction query, which
cannot match statements anyway (`NOISE_RE` in the parser explicitly drops
anything saying "statement", and it should keep doing so).

```
has:attachment filename:pdf newer_than:Nd
  (subject:statement OR subject:"credit card statement" OR subject:"e-statement")
```

Each attachment is fetched, opened, and identified by finding a card's last
four digits in the extracted text. That maps it to an `Account`, which is
what makes the rest possible.

### The password

Settled: **stored per card, encrypted at rest.**

`Account.statementPassword` holds AES-256-GCM ciphertext, with the key from
a new `STATEMENT_ENCRYPTION_KEY` in the root `.env`. Without that variable
set the app refuses to store a password rather than quietly keeping it in
plain text. The value is never returned by the API — only whether one is
set.

Worth being plain about what this is: these passwords are usually built
from a date of birth and a name, so what is stored unlocks more than one
PDF. The encryption means a leak of the Atlas data alone is not enough; a
leak of the server is.

pdfjs distinguishes "needs a password" from "the password is wrong", so a
statement that fails can say which — a card whose password was never set
and a card whose password is stale are different problems with different
fixes.

---

## 2. Turning a PDF into lines

Text extraction gives positioned fragments, not rows. Fragments are grouped
by their y coordinate into lines, then sorted by x — which reconstructs the
table as text, from which a row is recognised by shape:

```
<date>   <description>            <amount> [Cr]
```

A generic reader handles that shape, which covers most issuers. Where a
layout defeats it, a per-issuer reader is registered by name and takes
over. That keeps adding a bank to a contained change rather than a rewrite,
and keeps the day-one parser honest about being incomplete.

### Classifying a line

| Class | Example | What happens |
|---|---|---|
| `SPEND` | `AMZNIN MUMBAI IN 1,240.00` | Reconciled. Added if unmatched. |
| `FEE` | `FINANCE CHARGES 318.75`, `IGST-VPS@18%` | Reconciled. Added if unmatched — these are the ones no message ever announced. |
| `PAYMENT` | `PAYMENT RECEIVED - THANK YOU 25,000.00 Cr` | Never added. It is last month's bill being paid, already in the ledger from the bank account's side. |
| `REVERSAL` | `REVERSAL AMZNIN MUMBAI IN 1,240.00 Cr` | Added as a credit. Linking it to the purchase it reverses is left to the refund tool that already exists. |
| `NOISE` | `Opening Balance`, `Reward Points`, headers | Dropped. |

`PAYMENT` is the one that would do real damage. A ₹25,000 credit invented
on the card, against a ₹25,000 debit that already exists on the savings
account, is a self-transfer that `detectSelfTransfer` would not catch — its
window is ten minutes and a statement line carries only a date. The result
would be ₹25,000 of spending cancelled out of the totals for no reason.

---

## 3. Matching

For each `SPEND` or `FEE` line, look for a transaction that is already
there: same amount, same direction, on this card (or on no card at all),
within **four days** of the line's date.

Four days because a statement records the date a transaction *posted* and
the alert fired when it *happened*, and a weekend sits between the two more
often than not.

- **One candidate** — matched. The line is accounted for.
- **Several** — take the nearest by date, and record that it was a guess,
  because two ₹500 payments in the same week are genuinely indistinguishable
  from the statement's side.
- **None** — new. This is the point of the whole feature.

Each transaction can be claimed by at most one line, so a statement listing
the same amount twice cannot match both halves to a single existing row.

Running the same statement twice changes nothing: the statement is stored
against its Gmail message id, and its lines keep their resolution.

---

## 4. What happens to the leftovers

Settled: **added straight away, uncategorised, dated to the day the
statement says.**

This is the choice that makes the figures honest immediately. A cycle total
that is missing ₹4,000 of fees is wrong now, and stays wrong for as long as
a review queue goes unread. Adding at once fixes the total and puts the
question — *what was this?* — into the "Needs a category" filter and the
midnight reminders that already exist, rather than into a second queue that
has to be remembered separately.

Each one is marked as having come from a statement, so the ledger can say
where a row nobody remembers appeared from.

### And the other direction

Transactions SpendLog holds for that card in that period which the
statement does **not** list. Usually an alert attributed to the wrong card,
or an authorisation that was never captured. Shown, never acted on
automatically — there is no safe automatic answer.

### The headline

Sum of the statement's spend lines against what SpendLog held for that
period before reconciling:

> Statement says ₹47,850. SpendLog had ₹42,300 of it. 12 lines added.

Note the comparison is spend-to-spend. The "total due" printed on a
statement includes the balance carried forward and subtracts payments, so
comparing against that number would be comparing two different things.

Nothing creates a transaction for the statement total. That is the same
trap as an EMI parent against its instalments, and it is avoided the same
way — the total is a fact about the statement, not an event in the ledger.

---

## Model

```
CardStatement
  userId, accountId
  sourceRef            gmail message id + attachment id — unique per user
  periodStart, periodEnd, statementDate, dueDate
  totalDueMinor, minimumDueMinor
  status               PARSED | LOCKED | UNREADABLE | UNIDENTIFIED
  lines[]
    date, description, amountMinor, type
    kind               SPEND | FEE | PAYMENT | REVERSAL | NOISE
    resolution         MATCHED | ADDED | SKIPPED | UNCERTAIN
    transactionId
  statementSpendMinor  sum of SPEND + FEE
  knownSpendMinor      what the ledger held before this ran
```

`Account` gains `statementPassword` (ciphertext) and `statementSender`
(optional, to narrow discovery).

`Transaction` gains `statementId` and `statementLineId` — which is both the
provenance shown in the UI and the guarantee that a second run cannot add
the same line again.

---

## Phases

1. **The engine.** Model, encryption, PDF extraction, the generic line
   reader, classification, matching, reconciliation, the API. Tested
   against fixtures.
2. **The issuers.** Per-bank readers fitted to real statements.
3. **The screens.** A reconciliation view on web, and the statement list on
   the phone where the reminders already are.

Phase 1 is independent of any particular bank's layout, which is why it
comes first.
