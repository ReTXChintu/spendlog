# Plan: trips, cash, and refunds that cover several purchases

Four asks. Three are small; one of them quietly changes how the whole
backend decides who may see what, so it gets most of the attention here.

---

## 1. One credit against several debits

### Where this breaks today

A refund points at exactly one purchase — `refundOfId` on the credit,
`refundedMinor` on the purchase. Cancel three orders and get one lump
credit back, and there is nowhere to put it.

Worse, `GET /transactions/:id/refund-candidates` only offers purchases
**at least as large as the credit**, on the reasoning that a refund cannot
exceed what was paid. A credit covering three purchases is larger than any
one of them, so the list would come back empty.

### Allocations

Replace the single pointer with a list on the credit:

```ts
refundOf: [{ transactionId: ObjectId, amountMinor: number }]
```

A purchase's `refundedMinor` becomes the sum of allocations pointing at it,
which is what it already is — only now more than one credit can contribute.

This also gives a better answer for a credit that is *partly* a refund:

```
credit counted = amountMinor − Σ allocations
```

So ₹1,000 in, of which ₹800 settles two cancelled orders, leaves ₹200
counting as ordinary income. Today the whole ₹1,000 would count as nothing.

Migration is mechanical: each existing `refundOfId` becomes one allocation
for the credit's full amount.

The candidate list drops the size filter and gains the ability to pick
several, splitting the credit across them — defaulting each allocation to
the purchase's full amount until the credit runs out.

---

## 2. A cash account

`ACCOUNT_TYPES` gains `CASH`, and every user gets one Cash account made for
them, the way default categories already are.

Nothing detects cash — no message announces it — so it exists purely to be
chosen by hand. It is deliberately a normal account rather than a flag, so
the account filter, the ledger and the trip totals all treat it like any
other without knowing about it.

One rule worth stating: `resolveAccount` must never match it. Cash has no
bank name or last four digits, so it cannot, but a test will say so.

---

## 3. A refund in cash for something paid by card

Once refunds are allocations, this mostly works already: a manual credit on
the Cash account, allocated to a purchase on a card.

The only thing in the way is that same size filter above, plus the
candidate ranking, which scores a same-account match higher. Ranking is
fine — it is a hint, not a restriction — but the list must not *exclude*
purchases on other accounts, which it does not.

So this needs no work of its own beyond §1, which is worth knowing rather
than building twice.

---

## 4. Trip mode

### The simple half

```ts
Trip {
  _id, name, ownerId,
  startedAt, endedAt,          // endedAt null while it is running
  members: [{ userId, joinedAt }],
  joinCode,                    // short, random, rotatable
}
```

`Transaction` gains `tripId`. It is a tag and nothing more: `tripId` never
touches `countedAmountMinor`, because a meal on holiday is still a meal.
What it buys is being able to ask what a trip cost.

**Turning it on** means starting a trip. From then until it is stopped,
anything created or ingested is stamped with it — including a message that
arrives days later, since the decision is made on `occurredAt`, not on when
the message turned up. A transaction can be taken out of a trip, or put
into one, by hand afterwards.

**Stopping** sets `endedAt`. A re-scan action sweeps the window for
anything that was missed — a phone that was offline for the last two days
of the holiday, say.

### The half that changes the backend

> *"i can invite other users to the trip so they can also add their
> payments in the trip so we can calculate actually how much is spent"*

Every query in the backend today ends in `userId: currentUserId(req)`. That
single rule is what makes the app safe. A shared trip is the first thing
that has to reach across it: the trip total is the sum of what **several
people** spent.

So trip-scoped reads are authorised differently — by membership of the
trip, not ownership of the row:

```ts
// The only place a query may be scoped by something other than userId.
async function assertTripMember(tripId, userId): Promise<TripDoc>
```

Everything outside `/trips` keeps the existing rule untouched. The risk
here is not subtle bugs but a blunt one — a leak — so it is worth keeping
the exception to one helper, in one file, used by a handful of endpoints.

**Joining.** The owner shares a code; the invitee enters it, or scans it as
a QR code from the owner's screen. The QR carries the code and nothing
else, and the scanner lives in the phone app only — no deep links, no URL
handling, no second way in to keep correct.

No email is sent and nothing is looked up by address. Inviting by email
would mean either sending mail or answering "does this person have an
account", and neither earns its keep for a holiday with four people on it.
A code can be rotated if it ends up somewhere it should not.

**What members see of each other.** A trip's transactions, and nothing
else: amount, merchant, date, and who paid. That is the point of the
feature, and it is also the whole of it — no other endpoint changes, so a
trip member cannot see anything of yours outside the trip.

**Leaving and removing.** A member can leave; the owner can remove someone.
Either way their transactions keep their own `tripId` — the trip total
should not silently change because someone left — but they stop being able
to see the trip. The owner cannot leave; they end or delete the trip
instead. Deleting a trip clears `tripId` from its transactions rather than
deleting anyone's rows.

### What a trip reports

```
GET /trips/:id/summary
  totalMinor            everyone's spend on the trip
  byMember: [{ userId, name, spentMinor, transactionCount }]
  byCategory
  dayCount, perDayMinor
```

Splits, refunds and settlements all work inside a trip exactly as they do
outside it, because `countedAmountMinor` is what a trip sums. A bill split
with a stranger on the trip counts the user's share; a cancelled hotel
booking counts what did not come back.

### Settling up within the trip

Each expense is shared by everyone on the trip unless it says otherwise:

```ts
Transaction.tripShare = "ALL" | [userId, ...]
```

A souvenir bought for yourself is marked as shared with just you, and
drops out of everyone else's arithmetic without leaving the trip total.

Balances use `countedAmountMinor`, the same figure every other total in the
app uses, so a refunded hotel and a bill split with someone outside the
trip both behave without trips knowing anything about refunds or splits:

```
for each expense: each sharer owes counted / sharerCount to whoever paid
net(member) = paid − owed
```

Transfers are then the usual greedy pairing of the largest creditor with
the largest debtor, which settles N people in at most N−1 payments rather
than everyone paying everyone.

```
GET /trips/:id/settlement
  balances:  [{ userId, name, paidMinor, shareMinor, netMinor }]
  transfers: [{ fromUserId, toUserId, amountMinor }]
```

This overlaps with Splitwise, which is already in the picture. It is worth
building anyway because the ledger already knows what was spent and by
whom — the part Splitwise makes you type in by hand — so the marginal cost
is the arithmetic rather than the data entry.

---

## Order of work

| Phase | What | Why here |
| --- | --- | --- |
| 1 | Refund allocations, plus the migration | Self-contained; also unblocks §3 |
| 2 | Cash account and `CASH` type | A few lines, and trips want it |
| 3 | Trips for one person: model, stamping, re-scan, totals, UI | The whole feature minus sharing |
| 4 | Members: join codes, QR, `assertTripMember`, per-member totals | The part that needs care |
| 5 | Shares and settlement: who owes whom, and the transfers to fix it | Needs members to exist before it means anything |

Doing 3 before 4 means the tagging and totals are already proven when the
authorisation change lands, so a bug at that point is unambiguous.

## Testing

- An allocation cannot exceed the credit, and a credit cannot be allocated
  past its own amount
- Two credits against one purchase, and one credit across three purchases
- Unallocating puts a purchase back to full cost; deleting either side
  tidies up after itself
- A cash refund against a card purchase, end to end
- Stamping follows `occurredAt`, not arrival — a message ingested after the
  trip ended still lands in it
- **A non-member gets nothing from every trip endpoint**, checked one by
  one rather than in aggregate
- A member sees the trip's transactions and none of the owner's others
- Settlement balances to zero, whatever the spending looks like
- A personal expense inside a trip moves nobody else's balance
- Three people, one payer: two transfers, not three
