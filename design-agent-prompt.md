# Design brief: SpendLog, a full redesign of the web and mobile apps

You are the design lead for **SpendLog**, a personal finance app for India. Redesign both apps from scratch: the **Android app** (Flutter, the main app, used daily) and the **web app** (React). Give it a fresh visual identity and much better UX. Every feature listed below already works and must keep working. Your job is how it looks, how it's organised, and how it feels to use. One new feature, **Subscriptions** (section 15), isn't built yet; design it as part of the same system.

The app has grown feature by feature, so things have piled up: dashboard cards stacked on cards, important tools buried three screens deep, and the same idea shown differently in different places. The person using it should open the app and know in five seconds whether they're fine this month, and reach any task in two taps.

---

## Who uses it

- **The owner.** A salaried person in India who tracks everything: several bank accounts, several credit cards, cash, loans, SIPs, trips with friends, and a kid's pocket money. They check it on their phone many times a day and do bigger tidying on the web. They care that the numbers match the bank exactly.
- **Kids** (a limited mode). A child signs in on their own phone with an email and password the parent set up, and sees only their pocket-money accounts. Phone only.
- **Trip companions.** Other SpendLog users who join a trip with a code and split costs.

## What everything rests on

- **Money is in rupees**, with Indian digit grouping (₹1,00,000) and paise where it matters. Dates and times are in IST.
- **A "month" runs from pay day to pay day.** With pay day on the 15th, the month is 15 Oct – 14 Nov. Every screen uses this month, not the calendar month. When no pay day is set, it's the calendar month.
- **Transactions arrive by themselves.** The phone reads bank SMS in the background; Gmail alerts and bank or card statements are read on the server. Most transactions are never typed in by hand. The user's main jobs are reviewing, correcting, explaining and planning.
- **Trust is the product.** Every figure should be explainable in one tap: where it came from, which message, what's counted and what isn't.

---

## Feature inventory

Each item says what exists today. Keep every one.

### 1. Sign-in, roles and setup
- Google sign-in for the owner.
- A kid's sign-in with email and password, on the phone app only (the web app refuses it).
- SMS permission onboarding: why it's needed, and a one-time scan of the existing inbox.
- Gmail connection. It can drop out ("Google refused, reconnect"); that state has to be obvious and fixable in one tap.
- A first-run "ledger start" month (how far back to track), which can be moved later.
- Light and dark theme, plus a system setting.

### 2. Home / Dashboard
Today this is the busiest screen and the one most in need of a rethink. What's on it now:
- **Monthly budget card.**
  - Spent vs budget for the pay-day month, a marker for where spending "should" be by today, and amount left or over.
  - A pace message, e.g. *"Pace is high — slow down. Keep to ₹300/day or you'll run out by 3 Oct"*, or "On track · ₹X/day is safe for the next N days".
  - Category limits as bars, with an "Everything else" pool.
  - The savings bucket balance ("+₹X if the month ended now").
  - When no budget is set, a set-up prompt pre-filled with a suggested amount.
- **Wallet.**
  - Credit cards drawn as **real card faces**: bank or network gradient, chip, `•••• •••• •••• 1234`, and the network wordmark (VISA, Mastercard, RuPay, Amex).
  - On each card face: a bar of credit used vs limit (green, amber from 70%, red from 90%), "₹X of ₹Y used · ₹Z available", and either "Bill ₹A due 12 Oct · in 3 days" or "Bill paid", plus this cycle's spend.
  - An eye icon asks for the vault PIN, then the card **flips** to show the full number, expiry and name. It flips back after 60 seconds.
  - Tapping a card opens its transactions for the current statement cycle.
  - Bank-account tiles: balance, last 4 digits, linked debit cards, and pocket-money progress. Each shows a red "₹3,000 off" chip when its balance doesn't match the bank.
  - **The savings account balance stays hidden** until tapped.
- **To-dos.** Things waiting on the user:
  - balance alerts;
  - "₹5,000 came in, what was it?" (missing credits);
  - unexplained differences;
  - payments with no account;
  - uncategorised transactions;
  - statements to read or upload;
  - bills due.
- **Investments tile**: portfolio value, today's change, and funds that need a look.
- **Earmarked money**: money given for a future purchase.
- **"Which card today"**: suggests the best card to use right now, based on cycles and limits.
- **Fixed each month**: a tick list of rent, EMIs, SIPs and similar.
- **People** who owe the user or are owed; **Loans** with an ahead/behind position.
- **AI**: daily insights, a savings plan with warnings, and an "Ask AI" bar.
- A **Dashboard / Analytics** tab switch at the top.

### 3. Transactions
- A list grouped by day, loading 7 days at a time as you scroll back. A **pay-day-month bar** at the top ("14 Sep – 14 Oct · this month") with back and forward arrows and the budget used for that month.
- Search, and filters: account, debit or credit, needs a category, no account, unexplained.
- A refresh that reads SMS and email ("Checked 23 messages — 3 new").
- **Row chips** for what each row is or where it came from:
  - kinds: Not counted, Transfer, Card bill, Refund, Split, Lent, Pocket money · <kid>, by <kid>;
  - where it came from: Added for your transfer / bill payment, Edited, Unexplained, No account;
  - On trip <name>.
- **Transaction editor**, one sheet, the most important interaction in the app:
  - Amount, debit or credit, merchant, category, account, date and time, note.
  - **Kind** (exactly one):
    - for money out: Normal, Split, Lent, To my own account, Card bill, Loan repayment, Settling up;
    - for money in: Income, Salary, Refund, For a future purchase, From my own account, Paid back, Split.
  - **Split**: with contacts, including yourself; equal or custom shares.
  - **Lent / Paid back**: picking a person as the merchant sets this automatically.
  - **Transfer**: pick the other account. SpendLog then pairs it with the matching row there or writes that row in, and a snackbar says which.
  - **Card bill**: pick the card. Its card-side credit is paired or written in the same way.
  - **Loan repayment across several loans**: tick the loans, each pre-filled with its due amount and editable, with a live line "₹14,500 of ₹15,000 assigned · ₹500 not assigned".
  - **Refund**: link it to the purchases it pays back.
  - **Fixed cost**: link it to a fixed monthly commitment.
  - **Trip**: "On <trip>" switch to remove it; "Add to a trip" picker to add it; "Just mine on <trip>".
  - **Convert to EMI**.
  - **See the original message** (raw SMS or email text).
  - Merge duplicates, and undo a merge.
- **Refund candidates**: purchases within 30 days either side of a refund.

### 4. Analytics
- Pay-day months with month-on-month comparison and same-day comparison ("day 8 of this month vs day 8 of last").
- Charts: daily spend columns, a category donut, category trends, merchants, and per-account breakdowns.
- Filters by account, category and month.

### 5. Budget and savings
- A **monthly budget** in which everything counts, including rent, EMIs, SIPs and one-off purchases. Category limits can't add up to more than the budget.
- An editor with a live "₹X of ₹Y assigned · ₹Z unassigned" meter.
- The **pace** described in section 2.
- The **savings bucket**: each month's leftover goes in, and overspending comes out. History month by month.
- **AI savings plan**: a target with warnings when the user drifts from it.

### 6. Accounts, balances and reconciliation
New and central to the user's trust, so give it real weight in the design.
- **Account types**:
  - Bank (savings or current, with a savings account hidden by default);
  - Cash;
  - Credit card, with its own statement day, due day and credit limit, and cards that share one credit limit;
  - Debit card, linked to a bank account;
  - Pocket money: a holder (a kid), a monthly limit and a renewal day.
- **Passbook** per bank or cash account:
  - The ledger newest first. Each row shows the amount, SpendLog's running balance, and the bank's own stated balance (taken from SMS when the bank sends one), with the drift chip when they differ.
  - Special rows: Starting balance, Bank app said ₹X (a checkpoint), Unexplained difference, Missing credit (amber), Added for your transfer.
  - A pinned strip, "The figures part on 12 Oct (₹3,000)", with **Jump to it** and **Find the cause**.
  - Header: "SpendLog expects ₹X · Bank said ₹Y on 14 Oct" with "Matches" or "₹3,000 off". When the bank never states a balance: "Add a checkpoint from your bank app."
- **Find the cause** (reconcile sheet):
  - Likely causes, likeliest first, each with an explanation and an **Apply** one-tap fix: payment with no account, duplicate from two SMS, transfer recorded on one side only, card bill filed under the card, gap between two stated balances, a single row equal to the gap.
  - "Fixed it" when the gap reaches zero.
  - Last of all, quietly: "None of these? Record the difference", which creates an Unexplained difference that counts as spending and stays a to-do until explained.
- **Missing credits**: money the bank's own balance shows came in, but SpendLog never got a message for. The "What came in?" sheet shows the amount and the date window, suggestions first (e.g. "From HDFC ••8342, you sent ₹5,000 on 11 Oct"), then from my other account, salary, refund, someone paid me back, other income, or "Not sure — dismiss".
- **Checkpoints**: "my bank app shows ₹X on <date>".
- **Start fresh from today**, for one account or all at once: type what each bank shows now. Transactions are untouched; only balance tracking restarts. Can be undone.
- **"This bank doesn't text me about money coming in"**: a per-account switch. It changes how alerts are worded and adds a monthly statement to-do.
- A nightly check sends a **push notification** when a balance is more than ₹5 off.

### 7. Credit cards
- Each card follows **its own statement cycle**. Shown: used, available, last bill, due date, paid or unpaid, this cycle's spend, "Set billing date" when unknown.
- **Card vault**: one PIN unlocks card numbers, expiry, name and bank details (IFSC). No CVV, ever.
- **Statements**, read from Gmail (including password-protected PDFs, with a per-account password and an eye toggle):
  - statement detail, and reconciling a statement against the app's transactions;
  - **Compare with app**: on the statement but not in SpendLog, in SpendLog but not on the statement, closing balance vs expected.
- **EMIs**: convert a purchase into a plan, with instalments.

### 8. People, splits and lending
- **Contacts** picked from the phone, each with a starting balance and a running balance (owes you / you owe).
- Splits and settling up.
- **Clear**: settle part or all of what someone owes with no money moving. The user types an amount, an optional note ("Bought me a watch") and a date; it shows "₹1,000 owed → ₹1 left after this". Undo is available.
- A person's history mixes transactions and clearances.

### 9. Loans
- Loans with schedules: amount, rate, tenure, start, and how many instalments were already paid before tracking began. Edit, close early, delete.
- Instalments marked **Paid / Part paid ("₹1,500 of ₹6,000 · ₹4,500 short") / Due / To come**.
- A per-loan tab: "₹500 ahead — covers part of the Nov instalment" / "₹300 behind on the Oct instalment"; an overall line, "₹1,200 ahead overall".
- Combined payments split across loans (see the transaction editor in section 3), plus each loan's share of every payment.

### 10. Fixed monthly costs (commitments)
- Rent, SIPs, subscriptions, support for a parent, and so on. A tick list per month, or settled by linking the actual payment. Partial payments are shown with their shortfall.
- A changed amount applies from the next payment, not retroactively.
- Card-bill commitments are recognised and never double counted.

### 11. Trips
- Trip mode: start or end a trip; payments inside its dates join automatically.
- Members join with a **code or QR**. There's a members screen, the code can be rotated, and members can be removed.
- Summary (total, days, per day), and **settlement** (who owes whom).
- **The trip's payments list.** Your own payments open the editor; other members' show "Paid by X".
- **Add earlier payments** (tickets, hotel advances): a picker with "Looks like travel" first, search, "go back further" (60 → 180 → 365 days), and a sticky "Add 3 payments (₹X)" button.
- Re-scan the trip; take a payment off it; "just mine".

### 12. Investments (mutual funds) and goals
- **Portfolio**: value, invested, gain, annual return (XIRR), today's change, monthly SIP total, NAV date, an allocation bar (equity / debt / hybrid / other), and stale-price notes.
- **Funds**:
  - Each fund shows its rank in its category ("#4 of 37"), 1-year and 3-year returns vs the category median, and flags explained in plain words: lagging its category, low return, Regular plan.
  - Add a fund: search, then "I already hold units" and/or "I run a SIP" **with its full history** (amount changes from given months, skipped months, pauses).
  - Fund detail: price chart, stats, category comparison, a **SIP history timeline** (month by month: invested / skipped / paused / upcoming, with units and NAV, and "₹2,000 paid vs ₹1,000 planned"), and the ledger.
  - Link SIP payments from suggestions.
- **Goals**:
  - e.g. "Laptop, ₹2,00,000 by June 2027": progress, "Invest ₹19,500/month", on track / behind / done, a suggested fund type with the assumption shown, and example funds.
- **AI advice**: underperforming SIPs with reasons, what to do with amounts and example funds, a line per goal. Always carries a "not investment advice" note.

### 13. IPOs
- Open now / Upcoming / Waiting to list, filterable by Mainboard or SME (SME tagged).
- Per IPO: dates, "1 lot · 50 shares · ₹14,850", and **"At today's GMP +₹1,350 (+9.1%) per lot"** (green, red or neutral; "No GMP yet" when there isn't one).
- An always-visible note: GMP is unofficial and not a forecast; data from IPO Guru (credit required).
- Hidden entirely when the server has no IPO key.

### 14. AI assistant
- The user's own Gemini key, entered in Settings (with an eye toggle).
- Ask AI (chat), daily insights, the savings plan, and a coach that talks in terms of the monthly budget, pace and category limits.

### 15. Subscriptions (NEW: design it, it isn't built yet)
A place to manage Netflix, Prime Video, Spotify, YouTube Premium, iCloud, gym, mobile and broadband plans, and anything else that renews.
- **Per subscription**:
  - name and logo or monogram;
  - amount;
  - **frequency**: weekly, monthly, quarterly, half-yearly, yearly, or custom every N days or months;
  - next renewal date;
  - how it's paid: card, UPI autopay, bank or wallet (pick the account or card);
  - category;
  - start date;
  - optional free-trial end;
  - shared with (family or friends, with each person's share);
  - notes.
- **States**: active, on trial, paused, cancelled (kept for history), and price changed (with a history of past prices).
- **Views**:
  - a list sorted by next renewal;
  - a calendar of renewals;
  - totals as **monthly equivalent and yearly** ("₹2,140/month · ₹25,680/year");
  - grouping by payment card.
- **Smart parts**:
  - detect likely subscriptions from repeating transactions ("Netflix ₹649 every month — track it?");
  - link each renewal to the actual payment;
  - flag a renewal that didn't show up, or came in at a different amount;
  - remind N days before renewal (and before a trial ends);
  - a "renewals this month" line on the dashboard.
- **How it relates to the budget and fixed costs**: subscriptions count against the monthly budget. A yearly plan should show its monthly equivalent in planning while the actual charge lands in the month it renews. Decide whether subscriptions live inside "Fixed each month" or beside it, and make the relationship obvious.
- **Where it lives**: its own place, reachable from Settings and from the dashboard.

### 16. Family (kids)
- **The owner's side**: add a kid (name, email, password with an eye toggle), choose which accounts they see, reset the password, remove them.
- **The kid's app**:
  - their money: limit, spent and left per pocket-money account;
  - their transactions: they can add, and edit merchant, category, note, amount and date, but not delete;
  - their own analytics and their own shortcuts, using the owner's categories;
  - Settings: change password and theme only.
- A kid's pull-to-refresh wakes the parent's phone to read new SMS.
- The owner sees "by <kid>" on those transactions.

### 17. Perks and coupons
- Coupons read from screenshots by a vision model (slow, runs in the background, with a "coupons ready" notification), with source, terms and the extracted text.
- Coupons are matched to merchants.

### 18. Settings
**What's there**:
- Profile; pay day and salary.
- The budget editor.
- Accounts: add, edit or archive accounts; opening balance; statement password; card details in the vault; the no-credit-texts switch.
- Categories (managed by the owner) and shortcuts / presets.
- SMS status and "Sync now".
- Gmail connect or reconnect.
- AI key; family; reminders (the midnight nudge about yesterday's payments); theme; sign out.

**The problem**: Settings has grown into a long scroll. Restructure it.

---

## Hard rules
1. **Full-width layouts.** No centered max-width page columns or fixed-width wrappers. Content spans the viewport with side padding (16px on phones, 24–32px on desktop). Use the extra width on web with multi-column grids and side-by-side panels. Only modals, toasts and short empty-state messages may be centered.
2. **Every password or secret field has an eye button** to show or hide it, with an accessible label ("Show password" / "Hide password"). This covers sign-in, statement passwords, the vault PIN entry, the AI key and kids' passwords.
3. **Phone first.** Design for 360px wide Android first, then scale up. The web app has the same features, laid out for a large screen. Both apps share one design language.
4. **Light and dark themes**, both first-class. Semantic colours (good, warning, critical, and money in / money out) are separate from the brand accent and must read in both themes.
5. **Numbers**: tabular figures in every column of money; ₹ with Indian grouping; negative amounts styled consistently; an amount is never truncated (wrap or shrink instead).
6. **Privacy**: savings balances and card numbers are hidden until the user asks; card details need the PIN.
7. **Every list and card has designed states**: loading, empty (with the next action), error (with retry), stale ("Showing data from 7h ago · couldn't refresh"), and "not set up yet".
8. **Copy**: plain, specific, active, written from the user's side. Say what happened and what to do ("Also recorded ₹3,000 into Federal Bank ••3295"). No jargon like "reconcile entity" or "webhook". Indian English.
9. **Accessibility**: 48dp touch targets, contrast AA in both themes, screen-reader labels on icon buttons, reduced-motion alternatives (e.g. the card flip becomes a crossfade).

## What I want from you
1. **Navigation for both apps.** Today the phone app has bottom tabs (Home, Transactions, Trips, Settings), with everything else pushed from tiles. Propose a better structure and say where each feature in the inventory lives. Show the phone tab bar or drawer and the web side navigation.
2. **A design system**: colour tokens for light and dark, a type scale with chosen typefaces, spacing, radii, elevation, and an icon style. Components, each with all their states: card face, bank tile, amount and money text, chips and badges, progress and pace bars, list rows (transaction, passbook, instalment, SIP month), bottom sheets, dialogs, segmented controls, filter chips, empty and error states, the to-do item, the stat tile, and charts (column, donut, sparkline, allocation bar).
3. **Every screen and sheet**, for the phone and for the web, with real Indian sample data (realistic merchants, banks and amounts; no lorem ipsum):
   - Home;
   - Transactions with the editor sheet in each kind;
   - Analytics;
   - Budget editor;
   - Accounts and Passbook with Find the cause and What came in;
   - Start fresh;
   - Card detail, vault flip and statements compare;
   - People and person detail with Clear;
   - Loans;
   - Fixed costs;
   - Trips with add earlier payments and settlement;
   - Investments (portfolio, fund detail with SIP history, add fund, goals, advice);
   - IPOs;
   - **Subscriptions** (list, calendar, add/edit, detect-from-transactions);
   - Family and the whole kid app;
   - Perks;
   - Settings;
   - sign-in and onboarding.
4. **Key flows, step by step**:
   - A transfer whose receiving bank sent no SMS.
   - A balance alert → passbook → find the cause → fixed.
   - Answering a missing credit.
   - Paying three loans with one payment.
   - Adding a subscription that was detected.
   - Adding a fund with a SIP that changed amount and skipped a month.
   - A kid adding a transaction.
   - Taking a payment off a trip, and adding a ticket booked two weeks before.
5. **A short rationale**: what you changed about the information architecture and why, and what each screen's single job is.

Commit to a distinctive look that suits a money app people trust and open twenty times a day: calm, precise, quick to scan. Avoid generic fintech clichés: purple gradients, a single neon accent on near-black, glassmorphism everywhere, or emoji used as icons.
