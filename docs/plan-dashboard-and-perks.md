# Plan: a dashboard, an analytics page that is only analytics, and perks

Five pieces of work that share one question: **where does a thing belong?**

---

## The split that decides everything else

> **Dashboard answers "what do I need to know right now?"**
> **Analytics answers "what happened?"**

Present tense against past tense. Everything on the dashboard should be
something you might *act on* before you close the app; everything on
analytics is something you *understand* and then carry away.

That test moves three blocks off the analytics page, which had become a
dumping ground for anything with a number in it.

| Block | Goes to | Why |
|---|---|---|
| Spending pace, salary left | **Dashboard** | It changes what you spend today. |
| Card limits and warnings | **Dashboard** | Same — it changes which card comes out. |
| Which card to pay with | **Dashboard** | A decision, made at the till. |
| EMIs still running | **Dashboard** | Money already committed against the month you are in. |
| Split balances owed | **Dashboard** | Someone owes you now; it is not a historical fact. |
| Needs a category | **Dashboard** | A job, and the only screen that will chase you about it. |
| Coupons about to lapse | **Dashboard** | Settled: shown here, no notification. |
| Spend by category | **Analytics** | Understanding. |
| Spend by merchant | **Analytics** | New. Understanding. |
| This month against last | **Analytics** | New. Understanding. |
| Six-month trend | **Analytics** | Understanding. |

The dashboard becomes `/`, and the ledger moves to `/transactions`.

One number bridges the two: the dashboard shows **this month so far**, with
how it compares to the same point last month, as a single line rather than
a chart. It is the hook into analytics — enough to notice something, not
enough to study it.

### One request, not seven

The dashboard is composed server-side into `GET /dashboard`. Seven round
trips to draw one screen is slow on a phone on mobile data, and it is the
screen that has to be fastest because it is the one you land on.

---

## Which card, by network

Today the card strip names one best card. That is the wrong shape, because
the question at a till is not "which card" but "which card *that this place
takes*" — and in India that is mostly a question about networks. A RuPay
credit card pays over UPI; a Visa or Mastercard does not.

So the answer becomes one per network, plus an overall pick:

```
Best on RuPay        ICICI Amazon Pay    31 days
Best on Visa         HDFC IOCL           12 days
Best on Mastercard   —  (no card)
Overall              ICICI Amazon Pay    31 days
```

A card at its own limit is never the answer, however long its float. The
existing sort already knows that; this groups it rather than replacing it.

Networks have to be recorded somewhere, so the Accounts and Cards tab gains
the field.

---

## Settings, in five tabs

1. **Connections** — Gmail, SMS, statements. Where data comes from.
2. **Accounts and cards** — names, merges, limits, statement days, network,
   statement password.
3. **Presets** — the merchant and category shortcuts.
4. **You** — name, salary and pay day, sign out.
5. **About** — version, update check, what the app does and does not know.

Salary moves here from the spending-pace block. The block keeps showing the
figure; setting it belongs with the other things about you.

---

## Perks

> "I am at Gucci. Do we have a coupon or any card that will give me
> cashback?"

Two things are being asked about at once, and they are different in kind:

- A **card offer** stands. *Tata Neu gives 5% at Croma*, every time, until
  the bank changes it.
- A **coupon** is spent. *GUCCI20, 20% off over ₹5,000, expires 30 Sep* —
  once used, it is gone.

One collection with a discriminator rather than two, because every lookup
wants both and ranking them against each other is the whole point.

```
Perk
  kind          CARD_OFFER | COUPON
  title         "5% NeuCoins" / "20% off"
  accountId     the card — required for an offer, optional on a coupon
  merchants[]   patterns; empty means anywhere
  categoryId    optional — "all dining", which is how most card offers work
  percent | flatMinor
  maxDiscountMinor, minSpendMinor
  startsOn, expiresOn
  usedAt        coupons only
```

A perk with neither a merchant nor a category applies everywhere — which is
what a flat "2% on everything" card is.

### Asking

`GET /perks/lookup?q=...`, tolerant of how a person types: *"I'm at
Gucci"*, *"gucci"*, *"GUCCI INDIA PVT"* all have to find a perk stored as
`gucci`.

Words match through the two things that routinely differ between what was
saved and what is typed:

- **A plural.** A coupon saved as `flights` has to answer `flight`, and the
  s may be on either side, so the prefix test runs both ways.
- **A typo**, including the one autocorrect makes — typing a brand the
  keyboard has never heard of turns `wrogn` into `wrong`. Damerau rather
  than plain edit distance, because a swapped pair is one mistake and two
  substitutions, and only the first number is small enough to allow. From
  five letters up only: at four, one edit is as likely to be a different
  word, and `zara` and `tara` are not the same shop.

A pattern then matches in one of three strengths, ranked in that order:
the whole pattern appearing in the query, the query being the start of the
pattern, or any word of the pattern turning up anywhere in the query.

That last one was refused at first, on the reasoning that a name is typed
from its beginning. The reasoning did not survive a coupon saved as
*MakeMyTrip flights* and someone typing *flight* — the same shape as
`coffee` against *blue tokai coffee*, and obviously wanting to match. It is
allowed and ranked last instead: the answer is a list saying where each
perk works, so a wrong guess costs a glance rather than a trip.

Expired, used and inactive perks never appear. There is no worse outcome
here than being told to hand over a code that does not work.

### What it answers with

Settled: **cashback first, float underneath.**

Money back is certain and immediate; float is timing. So the offer leads,
and what the other card would have bought you in days is said below it —
both numbers in view, the decision yours.

```
At CROMA

  → Tata Neu · 5% back, up to ₹500
    Bills 4 Sep · 18 days to pay

  Longest float: ICICI Amazon Pay, 31 days,
  but no offer here.
```

The verdict sentence is composed on the server so the phone and the web
cannot drift into saying different things about the same cards.

Deliberately not done: valuing float in rupees to declare a single winner.
That comparison needs a price for a day of float, and there is no honest
source for one — it would be a number I invented, dressed up as advice.

---

## Phases

1. ~~**Backend.**~~ Merchant and comparison analytics, cards by network, the
   perk model and lookup, the composed dashboard endpoint.
2. ~~**Web.**~~ Dashboard, analytics rebuilt, settings in tabs, perks.
3. ~~**Phone.**~~ The same.

### Where the perk lookup ended up on the phone

Not a nav tab. The bar has five slots and Trips earns one, so a sixth would
have meant burying something that is opened more often.

Instead the ask bar is the **first thing on the dashboard** — one tap from
launch, which is what "standing in a shop" actually requires, and better
than a tab because the bar can say what it is for rather than fitting a
word under an icon.

Two things the phone gets that the web does not, because of where it is
used: the lookup field holds focus the moment it opens, and a coupon code
is tappable to copy — the next thing after reading a code is typing it
somewhere else.
