# SpendLog design system (redesign, Oct 2026)

The single source of truth for the new look of **SpendLog**, and the shared base for **Trippin**, **InFrame** and the **Identity** sign-in site.

Extracted from `spendlog.html` (the bundled design export in the repo root). Every value marked **(export)** was read straight out of the unpacked pages. Anything marked **(proposed)** is not in the export and was derived from the system so the apps have a complete spec. Treat proposed values as defaults you may tune, and treat export values as fixed.

Companion files in `docs/design-assets/`:

| Path | What |
|---|---|
| `tokens.json` | Every colour token (light + dark), chart palette, card-face gradients, font stacks, machine-readable |
| `icons/*.svg`, `icons/icons.json` | The full 46-icon set used in the design (24 grid, 1.75 stroke), named |
| `logo/spendlog-mark-*.svg` | The SpendLog mark: light, dark, CSS-var and 1024 px versions |
| `screenshots/NN-<page>-<theme>.png` | Headless-Chrome renders of all 15 pages (light), plus dark for Home, Transactions, Budget, Cards, Trips, Settings, Sign-in |

---

## 0. What the export is

- `spendlog.html` is a "bundler" file. The outer `__bundler/manifest` holds 15 gzip+base64 HTML pages, listed in `__bundler/page_order` and laid out on a board by `__bundler/template` (iframes at 1440 px wide). Each page is itself a nested bundle containing:
  - a 45 KB `x-dc` component runtime (identical in all 15);
  - React 18.3.1 and ReactDOM;
  - a template.
- All styling is **inline styles plus one shared `<helmet>` style block** that defines the tokens as CSS custom properties on `.lt` (light) and `.dk` (dark). The helmet is byte-identical on all 15 pages, so the token set below is complete and consistent.
- **No font files, images or bitmaps are inlined.** Fonts load from Google Fonts. Icons and the logo are inline SVG.
- Every page has one prop, `theme: light | dark`, which swaps the root class `lt`/`dk`.
- **Only desktop web (1440 px) frames exist.** There are no phone frames. The phone layout in §6.3 is derived from the same components and is marked as proposed.

The unpack and analysis scripts live in the session scratchpad (`…/scratchpad/design-unpack/unpack.js`, `analyze.js`, `compact.js`, `shoot.js`, `assets.js`). Re-run them if a newer export lands.

## 1. Screens in the export (`page_order`)

All are 1440 px wide, with light and dark themes. The sidebar and header are shared by all except Sign-in.

| # | Board title | Size | What it shows |
|---|---|---|---|
| 0 | Web · Home | 1440×1400 | **Free to spend** hero: ₹22,060 at 44 px, the pace bar (spent / promised / free plus the "today" tick), and a pace warning callout. **Category limits**: 9 limit bars with a today tick. **Needs you** queue: mismatch, unexplained money in, bill due, payment with no account, payments needing a category (with quick-pick chips), statement to read. **Wallet**: 4 credit-card faces plus a dashed "set billing date" card, and 6 account tiles (masked balance, Matches / ₹ off badges). **Which card today**, **This month** stat tiles (Fixed costs, Renewals, Loans, People), **Investments** (value, sparkline, allocation bar, stale-price notice), **Earmarked**, and **Today's insight** (AI) with an ask box. |
| 1 | Web · Transactions (with editor panel) | 1440×1200 | Month summary bar, search, "Check messages" and filter chips. A transaction **table grouped by day** (day header rows with net totals) that includes these row states: new, transfer, refund, split, needs a category, selected. Skeleton loading rows. On the right sits the **edit panel**: amount, Out/In segmented control, Kind radio chips, From/To account selects, an info callout, Date and UPI-ref fields, a Note, "More" link rows, and a footer with Delete / Cancel / Save. An **inverse toast** with Undo sits above it. |
| 2 | Web · Analytics | 1440×1300 | Filter bar (dropdown chips plus period chips), 4 compare stat tiles (one with a sparkline), the **Spending by day** bar chart (past bars in ink, today in accent, future as hollow placeholders, last month as a dashed line, a safe-per-day line, off-chart triangles), the **By category** donut with a legend table and deltas, category trends, top merchants, and per-account breakdown. |
| 3 | Web · Budget, savings bucket and AI plan | 1440×1200 | Monthly budget editor (a live meter and a table of category limits with inline amount inputs), an **error example** (limits over budget: the alert banner and an invalid input), a pace card, the savings bucket, and the AI savings plan. |
| 4 | Web · Accounts, passbook and Find the cause | 1440×1300 | Three panes. The accounts list. The account passbook (running balance compared with the bank's checkpoints, a "Start fresh" / "Add a checkpoint" mini-cards row, and unexplained money in). **Find the cause**: a ranked list of likely reasons for a ₹3,000 mismatch, with a skeleton "loading example". |
| 5 | Web · Cards, vault and statement compare | 1440×1400 | **Card faces**, covering every state: normal, revealed or "flipped" with a countdown, high utilisation, selected (focus ring) and not set up. The card detail. The **statement compare** (on the statement but not in SpendLog, and the reverse, plus the closing balance). A statements table, a password-protected PDF unlock form, and a **vault PIN dialog** over a scrim. |
| 6 | Web · People and Clear | 1440×1100 | People list with balances, a person's detail, an inline **Clear** (settle-up) panel, and the history. |
| 7 | Web · Loans | 1440×1100 | Overall strip, 4 loan cards, an EMI schedule table, and a "one payment, three loans" split panel with checkboxes. |
| 8 | Web · Fixed costs and Subscriptions | 1440×1400 | Explainer band, the fixed-each-month list with tick-to-mark-paid, subscriptions with alerts, a by-card view, a **renewals calendar** (7-column grid, today ringed in accent, selected day in ink) and detected subscriptions. |
| 9 | Web · Trips | 1440×1300 | Trip list (upcoming card with an **empty state**, past trips with a selected state), trip detail with a payments table, settle-up, members and join code, and an "Add earlier payments" panel with checkboxes. |
| 10 | Web · Investments, goals and advice | 1440×1500 | Portfolio row, allocation, funds table, AI advice cards, fund detail (1-year return compared with its category, and SIP history), goals with progress, and an "Add a fund" panel. |
| 11 | Web · IPOs | 1440×1100 | "Open now" IPO cards with status badges. |
| 12 | Web · Family and Perks | 1440×1200 | Child account card, a **reset-password panel** (password field with an eye button), the child's spends, a Perks **dropzone**, **processing** (spinner, progress bar, per-file results including an error row), filters and a coupon grid. |
| 13 | Web · Settings | 1440×1200 | Secondary settings nav (profile header, two-line items, Sign out), Connections (an SMS card in the "Working" state, a Gmail card in the **dropped / critical** state), the **statement passwords table** (masked and revealed password fields with eye toggles), an AI card (an **API key field with an eye button**, a "key works" badge, and a **switch**), and Appearance (a Light/Dark/System segmented control, two mini theme previews, a switch). |
| 14 | Web · Sign-in | 1440×900 | Two panels. On the left, the **brand panel** (logo, a 40 px headline, 3 benefit rows, and a product glimpse showing a mini pace card and a passbook row). On the right, the **sign-in card** ("Continue with Google", a kids notice, legal text), an **error alert** (family login refused) and the **onboarding step card** (Step 2 of 3, Connect Gmail). |

## 2. The signature: what makes it look like SpendLog

1. **Warm paper neutrals, one cobalt accent.** The page is warm off-white paper (`#F4F2EC`), cards are pure white, lines are warm greige, and ink is a near-black, faintly blue `#18191D`. Colour is rare: a single cobalt (`#2C4FCB`) for anything interactive or "now", and green, amber and red only when something is good, needs attention, or is wrong.
2. **Ink is the data colour.** Money spent, bars and selected chips are drawn in **ink** (`--tx`), not in brand colour and not in red. **Spending is never red.** Red is reserved for problems: over a limit, a balance mismatch, a connection that stopped.
3. **The pace bar.** This is the defining motif and is reused everywhere (hero, Transactions, Budget, the sign-in glimpse, theme previews). It has four parts:
   - a solid ink segment for money **spent**;
   - a **diagonal-hatched** segment for money **promised** (rent, EMIs, SIPs that will go out);
   - an empty sunk track for money that is **free**;
   - a thin 2 px **cobalt "today" tick** standing proud of the bar, with an 11 px label ("Today · ₹24,100").

   The hatch (`repeating-linear-gradient(135deg, var(--hatch) 0 2px, transparent 2px 6px)`) means "committed, not yet spent" across the whole product.
4. **Tabular, honest numbers.** Every figure uses tabular lining numerals. Big money is 34–44 px semi-bold with negative tracking. Figures explain themselves in plain words underneath ("24 days left · about ₹919/day").
5. **Icon tiles.** A 40×40 (or 36×36) rounded-10 square in a *soft* semantic tint with the icon in the *strong* tint is the universal leading element for list rows, cards and callouts.
6. **Flat, bordered surfaces.** Cards have a 1 px warm border and **no shadow**. Shadows appear only on things that float: segmented thumbs, toasts, dialogs and card faces.
7. **Realistic card faces.** Credit cards are drawn as actual cards: a 135° issuer gradient, a gold EMV chip, the number in IBM Plex Mono with wide tracking, and an in-card utilisation meter.
8. **"Needs you" over notifications.** Work for the user is a calm queue of rows, each with one verb-led action.

## 3. Colour

### 3.1 Token table (export)

These are the canonical names. Keep them, short as they are, in every app so the design and the code read the same.

| Token | Role | Light | Dark |
|---|---|---|---|
| `--canvas` | Outermost backdrop behind the app (board or desktop letterbox) | `#E4E1D8` | `#08090A` |
| `--bg` | Page / scaffold background, header background | `#F4F2EC` | `#111214` |
| `--sf` | Surface: cards, sidebar, inputs, dialogs | `#FFFFFF` | `#1A1B1E` |
| `--sf2` | Raised-subtle surface: inner tiles, table day-header rows, footers, read-only inputs, the sign-in brand panel | `#FAF9F5` | `#202125` |
| `--sunk` | Recessed: bar tracks, segmented-control track, skeletons, neutral icon tiles and badges | `#ECE9E1` | `#0C0D0F` |
| `--ln` | Hairline: card borders, row dividers | `#E2DED4` | `#2B2D32` |
| `--ln2` | Strong line: input and secondary-button borders, chip borders, dashed placeholders, disabled icon colour | `#C7C2B5` | `#3D3F46` |
| `--tx` | Primary ink: headings, figures, **money out**, spent segments, selected chips | `#18191D` | `#EDEBE6` |
| `--tx2` | Secondary text: labels, body copy, table cells | `#4C4D53` | `#BEBCB6` |
| `--tx3` | Tertiary text: meta lines, hints, timestamps, placeholders, "not counted" amounts | `#67686E` | `#9A9893` |
| `--ac` | Accent (cobalt): primary buttons, links, active nav, focus, the "today" marker, the logo | `#2C4FCB` | `#93A8FF` |
| `--ac-tx` | Text and icons on accent | `#FFFFFF` | `#0D1430` |
| `--ac-soft` | Accent tint: active nav background, info callouts, selected rows, accent icon tiles, "New" badge | `#E6EBFB` | `#1D2544` |
| `--ac-line` | Accent hairline: the inset ring on a selected list item | `#B9C6F2` | `#34407A` |
| `--good` | Positive text and fills: money in, under-limit bar fill, "Matches" | `#15724A` | `#56C892` |
| `--good-soft` | Positive tint background | `#E1F0E6` | `#12291D` |
| `--warn` | Attention **text** (amber-brown, readable) | `#8F5200` | `#F2B661` |
| `--warn-fill` | Attention **fill** (dots, bars) | `#E39A2E` | `#E9A240` |
| `--warn-soft` | Attention tint background | `#FBEED6` | `#2E2312` |
| `--crit` | Critical **text** | `#B3302A` | `#FF8C80` |
| `--crit-fill` | Critical **fill**: count badges, over-limit bar, dots | `#D9473E` | `#E45B50` |
| `--crit-soft` | Critical tint background; also the destructive-button border | `#FBE5E2` | `#341A19` |
| `--hatch` | Stripe colour for "promised / committed" hatching | `#C7C2B5` | `#4A4C53` |
| `--shadow` | Small lift (segmented thumb, glimpse cards, card faces) | `0 1px 2px rgba(24,25,29,.06), 0 2px 8px rgba(24,25,29,.05)` | `0 0 0 1px rgba(255,255,255,.02)` |
| `--shadow2` | Floating (toast, dialog) | `0 16px 40px rgba(24,25,29,.18)` | `0 16px 40px rgba(0,0,0,.6)` |
| `--scrim` | Modal backdrop | `rgba(24,25,29,.42)` | `rgba(0,0,0,.6)` |

Pure white `#FFFFFF` (written `#fff`) is used literally for text on card faces and on the `--crit-fill` count badge, in both themes.

### 3.2 Grouped by role

- **Background, surfaces and elevation** (bottom to top): `canvas` → `bg` → `sunk` (recessed into `bg`/`sf`) → `sf` → `sf2`. Light is paper → white cards. Dark is `#111214` page → `#1A1B1E` cards → `#202125` raised tiles, with `sunk` darker than the page.
- **Ink, three levels:** `tx` (15.7:1 on bg), `tx2` (7.5:1), `tx3` (5.0:1 on bg, 4.6:1 on sunk). All pass AA for body text in both themes.
- **Lines:** `ln` for structure and `ln2` for interactive edges.
- **Accent:** `ac`, `ac-tx`, `ac-soft`, `ac-line`. Accent on surface is 6.8:1 light and 7.6:1 dark.
- **Semantic:** each of `good`, `warn` and `crit` comes as **text** + **soft**. `warn` and `crit` also have a separate **fill**, because their text shade is too dark to read as a bright dot or bar. Every text-on-soft pair is ≥5:1.
- **Money (from the Transactions and Home usage):**

| Meaning | Colour | Sign | Example |
|---|---|---|---|
| Money out (counted spend) | `--tx` | `−` (U+2212 minus, not a hyphen) | `−₹486` |
| Money in (income, refund, paid back) | `--good` | `+` | `+₹3,420` |
| Not counted (own-account transfer, card bill, earmarked) | `--tx3` | none | `₹10,000` |
| More spend than last period (bad delta) | `--crit` | `+` | `+₹6,280 (+29%)` |
| Gain on investments | `--good` | `+` | `+₹1,22,210 (+21.7%)` |
| Promised / committed | hatch pattern | n/a | Rent, EMIs, SIPs |

  Suggested aliases (proposed) to make intent explicit in code: `--money-out: var(--tx); --money-in: var(--good); --money-neutral: var(--tx3);`.

### 3.3 Chart palette (export)

The chart palette uses fixed hex values, the same in both themes in the export. The order is the series order used by the donut, the allocation bar and the legends.

| Slot | Hex | Used for |
|---|---|---|
| `c1` | `#2C4FCB` cobalt (= light accent) | The biggest category (SIPs) or the Equity series |
| `c2` | `#C7792B` ochre | Shopping / Debt |
| `c3` | `#2F8A7A` teal | Food & dining / Hybrid |
| `c4` | `#B04A6F` rose | Groceries |
| `c5` | `#6A7A2F` olive | Transport |
| `other` | `#8A8780` warm grey | "Everything else" / Other: always last |

Other chart conventions (export):
- the series of "spent" bars is **ink** (`--tx`);
- the current period is **accent**;
- future or empty periods are `--sunk` fill with a 1 px `--ln2` stroke;
- the comparison series is a `--tx3` dashed line (1.75 px, `5 4`);
- a target line is accent, 1.5 px, `2 3` dashes.

(Proposed) In dark mode `c1 #2C4FCB` is only 2.5:1 on `#1A1B1E`. Swap c1 to `#93A8FF` (the dark accent) in dark. c2–c5 and other are all ≥3.3:1 on the dark surface and can stay.

### 3.4 Card-face colours (export)

| Issuer | Gradient (135°) |
|---|---|
| HDFC | `#0B2554 → #1C4F9C` |
| HDFC, revealed or flipped | `#071733 → #123870` |
| ICICI | `#7A1717 → #C2522A` |
| Axis | `#5E0F31 → #A41E55` |
| SBI Card | `#0D4A8F → #2B8AD3` |

| Element | Value |
|---|---|
| EMV chip | `linear-gradient(135deg, #E8D7A6, #B8995A)`, with two 1 px `rgba(0,0,0,.25)` contact lines |
| Utilisation meter, low (≤~50%) | `#7EE2AE` |
| Utilisation meter, high (~70%) | `#FFCB70` |
| Utilisation meter, critical (≥90%) | `#FF9A90` |
| Meter track | `rgba(255,255,255,.22)` |
| Translucent eye button | `rgba(255,255,255,.14)` |
| Revealed-card magnetic stripe | `rgba(0,0,0,.55)` |

(Proposed) For an issuer without a defined gradient, use `#2A2B30 → #4C4D53` (neutral graphite).

## 4. Typography

### 4.1 Families (export)

| Role | Family | Weights used | Source |
|---|---|---|---|
| UI, everything | **IBM Plex Sans** | 400, 500, 600, 700 (700 only for the wordmark, avatar initials, the toast action and card-network wordmarks; 800 italic is requested for "VISA" / "RuPay" but falls back to 700 because only 400–700 are loaded) | Google Fonts |
| Machine strings | **IBM Plex Mono** | 400, 500 | Google Fonts |

Stacks:
- Sans: `'IBM Plex Sans', system-ui, sans-serif`.
- Mono: `'IBM Plex Mono', ui-monospace, monospace`.

Mono is used **only** for:
- card numbers;
- UPI references;
- raw bank merchant strings (`PAYTM*MERCHANT`);
- email addresses in error text;
- revealed passwords and API keys;
- file names.

There is no serif and no display face.

### 4.2 Type scale (export, ranked by real usage)

Sizes are in px, which equals Flutter logical px / sp. Tracking is in em. Weights 600 = SemiBold, 500 = Medium.

| Token | Size / line | Weight | Tracking | Used for |
|---|---|---|---|---|
| `display-xl` | 44 / 52 | 600 | −0.02em | Hero money ("Free to spend ₹22,060") |
| `display-l` | 40 / 48 | 600 | −0.02em | Marketing headline (sign-in brand panel) |
| `display-m` | 34 / 40 | 600 | −0.02em | Big figure in a card (portfolio value, editor amount, glimpse) |
| `display-s` | 28 / 34 · 26 / 32 | 600 | −0.02em | Detail-page totals |
| `title-page` | 22 / 28 | 600 | 0 | Page `h1`, sign-in title, **stat-tile values** |
| `title-l` | 20 / 26 | 600 | −0.01em (optional) | Large card headline |
| `title-m` | 19 / 26 (dialog: 19 / 24) | 600 | 0 | Recommendation headline ("Use HDFC Regalia ••4417"), dialog title |
| `title-section` | 17 / 24 | 600 | 0 | Section `h2` in cards ("Needs you", "Wallet") |
| `title-card` | 15 / 20 | 600 | 0 | Card `h3`, list-row title, alert title |
| `body-l` | 15 / 22 | 400 (500 in callouts) | 0 | Descriptions, insight text, dialog body, callout text |
| `body` | 14 / 20 | 400 / 500 | 0 | Default UI text, nav items (500), table cells, link rows |
| `body-s` | 13 / 18 | 400 | 0 | Secondary row lines (`tx3`), chips (500), small buttons (600) |
| `label` | 12 / 16 | 600 | **+0.02em** | Eyebrows and field labels ("Kind", "From account", "Value"), `tx2` |
| `caption` | 12 / 16 (footnotes 12 / 17) | 400 | 0 | Meta lines, legal text, footnotes, `tx3` |
| `badge` | 12 | 600 | 0 | Badges, table headers, day headers |
| `micro` | 11 / 14 | 600 | 0 | Nav group headings ("Activity"), "Today" marker label, chart axis (400), nav counts |
| `wordmark` | 18 | 700 | −0.01em | "SpendLog" next to the mark |

Inline stat (label over value):
- label: `12/600 tx2`;
- value: `17/600` (`15/600` in tighter rows), `margin-top: 2px`;
- a unit suffix like `/day` at `13/500 tx3`.

Button text:
- 15/600 for 48–52 px buttons;
- 14/600 for 40–44 px;
- 13/600 for 32–36 px.

No text is ever uppercase. Everything is sentence case. The only exception is the cardholder name on a revealed card face (`13/600 +.08em`).

### 4.3 Numbers and currency

- **Every number gets tabular lining figures:** `.num { font-variant-numeric: tabular-nums lining-nums }`. This covers amounts, dates in steppers, counts, percentages and chart labels. Mono already has tabular figures.
- **Currency:**
  - `₹` is prefixed with **no space**, using Indian digit grouping: `₹1,20,000`, `₹6,84,210`, `₹1,46,719`.
  - No decimals for spending and budgets.
  - **2 decimals** for bank or reconciliation balances (`₹41,220.00`, "Bank said ₹12,480.00").
  - Compact axis labels: `₹12k`, `₹34.2k`.
  - Rates: `₹919/day`, `₹27,000/month`, `13.8% a year`.
- **Signs:** `−` (U+2212) for out, `+` for in. Not-counted amounts carry no sign. Percentages sit in brackets after the amount: `+₹6,280 (+29%)`.
- **Masking:**
  - Accounts: `••4417` (two U+2022 bullets, then the last 4).
  - Card numbers: `•••• •••• •••• 4417` in mono with `.12em` tracking.
  - Hidden balance: `₹ ••••••`, with an eye button.
- **Dates and times:**
  - Ranges: `15 Oct – 14 Nov` (spaced en dash between months), `15–21 Oct` (unspaced within a month).
  - Days: `Tue 20 Oct`, `Today · Wed 21 Oct`.
  - Times: `8:52 pm` (lower-case am/pm).
  - The separator is a spaced middle dot ` · `.

## 5. Spacing, radii, borders, elevation, motion, breakpoints

### 5.1 Spacing (export)

Base unit 2 px, with a working 4 px grid. Values in use, by frequency:
- gaps: 12 › 8 › 6 › 10 › 4 › 16 › 20 › 14 › 2 › 24 › 32;
- padding also uses 18, 40 and 48.

| Token | px | Typical use |
|---|---|---|
| `space-0.5` | 2 | Segmented-control internal gap, the stepper's inner padding |
| `space-1` | 4 | Tight stacks (label → value), badge icon gap |
| `space-1.5` | 6 | Label → input, chip groups, legend items |
| `space-2` | 8 | Button icon gap, chip rows, small stacks |
| `space-2.5` | 10 | Logo gap, table cell vertical padding |
| `space-3` | 12 | **Default gap**: row items, icon tile → text, card internals |
| `space-3.5` | 14 | Inner tile padding, callout horizontal padding |
| `space-4` | 16 | Stat-tile padding, grid gaps, card-face padding |
| `space-5` | 20 | **Section-card padding**, gap between cards and rows |
| `space-6` | 24 | Hero card padding, main top padding, large gaps |
| `space-8` | 32 | Desktop side padding, auth-card padding, wide column gaps |
| `space-10` | 40 | Sign-in panel vertical padding |
| `space-12` | 48 | Main bottom padding, sign-in panel horizontal padding |

### 5.2 Radii (export)

| Token | px | Applies to |
|---|---|---|
| `r-hair` | 1–2 | Today tick (1), legend swatches (2), step segments (2) |
| `r-xs` | 3 | 6 px meters, 12 px legend swatches |
| `r-sm` | 5 / 6 | 10 px bars (5), **badges (6)**, EMV chip (6), checkbox (6) |
| `r-pace` | 7 | 14 px pace bar |
| `r-md-` | 8 | Logo square (rx 8), small on-card button |
| `r-seg` | 9 | Segmented-control thumb |
| `r-md` | **10** | **Inputs, nav items, icon tiles, small buttons (32–36), calendar cells, merchant monograms** |
| `r-lg` | **12** | **Buttons (40–52), segmented-control track, callouts, inner panels, toast** |
| `r-xl` | **14** | **Cards, sections, stat tiles, account tiles, alert cards** |
| `r-2xl` | 16 | Credit-card face, card-sized placeholders |
| `r-3xl` | 20 | **Dialog** (and proposed bottom-sheet top corners) |
| `r-full` | 999 / h÷2 | Filter chips, avatars (18 on 36, 20 on 40), icon buttons, switch (16 on 32) |

The rule: bars and tracks always use radius = height ÷ 2.

### 5.3 Borders and strokes (export)

| Use | Spec |
|---|---|
| Card / section outline | `1px solid var(--ln)` |
| Row divider | `border-bottom: 1px solid var(--ln)` (535 uses) |
| Input, secondary button, chip | `1px solid var(--ln2)` |
| Focused or active input / select | `2px solid var(--ac)` (padding reduced by 1 px to avoid a shift) |
| Invalid input | `2px solid var(--crit)` |
| Destructive button | `1px solid var(--crit-soft)` |
| Selected chip | `1px solid var(--tx)` (with `--tx` fill) |
| Placeholder / not set up / empty / add | `1px dashed var(--ln2)` |
| Dropzone | `1.5px dashed var(--ln2)` |
| Outline badge, legend swatch edge | `box-shadow: inset 0 0 0 1px var(--ln2)` |
| Selected list item | `background: var(--ac-soft); box-shadow: inset 0 0 0 1px var(--ac-line)` |
| Selected table row | `background: var(--ac-soft); box-shadow: inset 0 0 0 2px var(--ac)` |
| Avatar stack ring | `2px solid var(--bg)`, overlap `margin-left: -8px` |
| **Focus ring** | `outline: 3px solid var(--ac); outline-offset: 3px` (shown on a selected card face; apply it to every `:focus-visible`) |
| Icon stroke | 1.75 (2 at 12–14 px, 3 for the "more" dots), round caps and joins |

### 5.4 Elevation (export)

The design is flat. **Cards never have a shadow; they have a border.**

| Level | Token | Where |
|---|---|---|
| 0 | none + `1px --ln` | All cards, panels, sidebar |
| 1 | `--shadow` | Segmented-control selected thumb, sign-in glimpse cards, card faces on the Cards page |
| 2 | `--shadow2` | Toast, dialog (and proposed: menus, popovers, bottom sheets) |

In dark mode `--shadow` is effectively a 2 % white hairline. Elevation in dark comes from the surface steps (`bg` → `sf` → `sf2`), not from shadows.

### 5.5 Motion (proposed: the export has no transitions or animations)

| Token | Value | Use |
|---|---|---|
| `--dur-fast` | 120 ms | Hover, press, colour changes |
| `--dur` | 200 ms | Switch thumb, segmented thumb, chip select, accordion |
| `--dur-slow` | 280 ms | Dialog, bottom sheet, side panel, toast in |
| `--ease` | `cubic-bezier(.2, 0, 0, 1)` | Standard (enter / move) |
| `--ease-exit` | `cubic-bezier(.3, 0, 1, 1)` | Exits |

Bar fills (pace, limits, meters) may grow from 0 once on first paint (400 ms, `--ease`). Nothing loops except the spinner (900 ms linear). Honour `prefers-reduced-motion` / `MediaQuery.disableAnimations` by cutting everything to opacity-only or 0 ms.

### 5.6 Breakpoints

**Export:** none. The layout is intrinsic, built from `flex-wrap` with flex-basis minimums (sidebar `1 1 248px`, content `999 1 560px`, cards `8 1 560px` / `4 1 320px`) and `repeat(auto-fit, minmax(…, 1fr))` grids, so panes wrap rather than switch.

**Proposed for the apps:**

| Name | Width | Side padding | Navigation |
|---|---|---|---|
| phone | < 600 | **16** | Bottom tab bar |
| tablet | 600–1023 | 24 | Navigation rail (72–80 wide) or collapsible sidebar |
| desktop | ≥ 1024 | 32 | 248 px sidebar (export) |
| wide | ≥ 1440 | 32 | Same; extra width goes to more grid columns, never to empty gutters |

## 6. Layout

### 6.1 Desktop shell (export)

```
┌──────────── sidebar 248 ────────────┬──────────────────── content (fills) ───────────────────────┐
│ [mark 28] SpendLog        pad 20/12 │ header: pad 16 32 · border-bottom ln · bg                   │
│ [search 40h]                        │  H1 22/28 · [‹ 15 Oct – 14 Nov ›] · "Day 7 of 31…" ·         │
│ ▣ Home                    (6)       │  ───── flex ───── · [status pill] · [+ Add] · (RI)          │
│ Activity   (11/14 600 tx3)          │                                                              │
│   Transactions · Analytics          │ main: pad 24 32 48 · column gap 20                          │
│ Money: Accounts · Cards · Investm.  │  rows = flex-wrap of cards (8:4, 4:8, 6:2:4 ratios)         │
│ Plan: Budget · Fixed · Subs · Loans │  or 2–3 panes (list 8 : detail 4, max 520)                  │
│ Shared: People · Trips · Family     │                                                              │
│ Extras: IPOs · Perks · Ask AI       │                                                              │
│ ── spacer ──                        │                                                              │
│ Settings                            │                                                              │
│ ● SMS read 9:38 pm · Gmail connected│                                                              │
└─────────────────────────────────────┴──────────────────────────────────────────────────────────────┘
```

**Sidebar** (export):
- `--sf` background, `1px --ln` right border, padding `20px 12px`, gap 4.
- Logo row: padding `0 8px 12px`.
- Search: 40 h, `--sf2` fill.
- Nav item: 40 h, radius 10, padding `0 12px`, gap 12, icon 20, `14/500 --tx2`.
  - Active: `--ac-soft` background, `--ac` text and icon, weight 600, `aria-current="page"`.
  - Trailing extras: a count badge, an 8 px dot, or a `11/600 --crit` note such as "1 off".
- Group headings: `11/14 600 --tx3`, margin `14px 12px 4px`.
- Footer: a sync-status line, `12/16 --tx3`, with an 8 px status dot (`--good` / `--warn-fill` / `--crit-fill`).

**Header** (export):
- Padding `16px 32px`, `1px --ln` bottom border, `--bg` background.
- Contents: page title; a **period stepper** (40 h, radius 12, `1px --ln2`, `--sf`, two 36×36 icon buttons with radius 10, a `14/600` tabular label; the disabled chevron is `--ln2`); helper text `13 --tx3`; a flexible spacer; a status pill; the primary **Add** button (40 h); and the avatar (36 circle, `--tx` background with `--bg` initials, `13/600`).

**Main** (export):
- Padding `24px 32px 48px`, gap 20.
- Card rows are `display:flex; flex-wrap:wrap; gap:20px`, with children sized by flex ratios and a minimum basis. Examples: hero `8 1 560px` + Needs you `4 1 320px`; Investments `6 1 420px` + Earmarked `2 1 200px` + Insight `4 1 300px`.
- Tile grids:
  - stat tiles: `repeat(auto-fit, minmax(170–220px, 1fr))`, gap 12–16;
  - limit bars: `minmax(260px, 1fr)`, gap `16px 32px`;
  - settings cards: `minmax(min(100%, 340px), 1fr)`, gap 20.
- Multi-pane pages: list `8 1 600px` + aside `4 1 380px` (max 520) on Transactions; three panes on Accounts; secondary nav `1 1 240px` + detail `999 1 560px` on Settings.

**Full width** (matches the user's rule): content always spans the viewport minus the side padding. The only width caps in the export are:
- sign-in card 440;
- dialog 360;
- brand-panel copy 560;
- editor aside 520;
- the budget input 160.

No page or shell is centred in a max-width column.

### 6.2 Sign-in / Identity layout (export)

- Two panels in a wrapping flex row:
  - the **brand panel** is `flex 1 1 520px`, `--sf2`, right border `--ln`, padding `40px 48px`, gap 32;
  - the **form panel** is `flex 1 1 480px`, padding `40px 48px`, content vertically centred with a column max width of 440 and gap 24.
- Below roughly 1000 px the panels stack. The brand panel comes first; on phones, shorten it to logo + headline + benefits and drop the product glimpse.
- The auth card: `--sf`, `1px --ln`, radius 14, **padding 32**, gap 20. Contents in order:
  - title 22/28;
  - lede 15/22 `--tx2`;
  - a full-width **52 px** primary button;
  - a neutral `--sunk` notice;
  - legal text 12/17 `--tx3` with links in `--ac`.

### 6.3 Phone layout (proposed, derived; no phone frames in the export)

- **Side padding 16**, vertical rhythm 12–16 between cards. Cards keep radius 14 and border `--ln`; padding drops to 16.
- **Top app bar:** `--bg`, title 22/28 600 left-aligned, avatar right. The period stepper sits on its own row under the title (full width, 40 h).
- **Bottom navigation bar:** `--sf` with a top hairline `--ln`, height 64 + safe area, five destinations, each a 24 px icon over a `12/600` label.
  - Proposed destinations: **Home** (home), **Activity** (list → Transactions/Analytics), **Money** (bank → Accounts, Cards, Investments), **Plan** (target → Budget, Fixed costs, Subscriptions, Loans, Goals), **More** (sliders → People, Trips, Family, IPOs, Perks, Ask AI, Settings).
  - Selected: icon and label in `--ac`, with a 32×56 radius-16 `--ac-soft` indicator pill behind the icon. Unselected: `--tx2`.
  - These are the sidebar's own groups.
- **Primary "Add":** a 56×56 radius-16 `--ac` FAB at bottom-right above the nav, or the header button on the Transactions screen.
- **Tables become list rows:** see §7.6, phone row.
- **The side-panel editor becomes a full-screen route** (or a full-height bottom sheet), with the footer actions pinned to the bottom.
- **Hero:** 34/40 money (`display-m`) instead of 44/52. The pace bar stays 14 px.
- **Horizontal scrollers:** wallet card faces at 85 % viewport width with snap; chip rows scroll horizontally rather than wrap.
- **Touch targets:** the export already uses ≥ 48 px rows and 44–52 px inputs. Keep 48 as the minimum for anything tappable, using padding to reach it (as the 24 px checkbox in its 48 px button does).

## 7. Components

All specs are (export) unless marked. Colours are tokens from §3.

### 7.1 Buttons

| Variant | Fill / text / border | Heights | Radius | Text | Padding |
|---|---|---|---|---|---|
| **Primary** | `--ac` / `--ac-tx` / none | 52 (auth, full width), **48** (forms, dialogs, cards), 40 (header) | 12 | 15/600 (14/600 at 40) | `0 20–24` (`0 16` at 40) |
| **Secondary** | `--sf` / `--tx` / `1px --ln2` | 48, 44, 40, 36, 32 | 12 (10 at ≤36) | 15/600 · 14/600 · 13/600 | `0 14–20` |
| **Ghost / text** | transparent / `--ac` / none | 48 (dialog Cancel), 36 (row actions) | 12 | 15/600 or 14/600 | `0 16` (row actions: `0`) |
| **Destructive** | transparent / `--crit` / `1px --crit-soft` | 48 | 12 | 15/600 + 18 px trash icon | `0 16` |
| **Icon** | transparent / `--tx2` | 36 or 40 | 10 or full | 18–20 icon | n/a |
| **On-card icon** | `rgba(255,255,255,.14)` / `#fff` | 40 | full | 20 icon | n/a |
| **Google** | Primary, plus a leading 20 px circle (`--ac-tx` background, `--ac` "G", 12/600) | 52 / 48 | 12 | 15/600 | gap 10 |

Further details:
- Icon + label gap is 8, icon 18. A trailing chevron on text buttons is 16 with gap 4 ("Find the cause ›").
- **Disabled** (export shows only an icon button): icon colour `--ln2`, `disabled` attribute set. (Proposed) For filled buttons, use `--sunk` fill, `--tx3` text, no border, no pointer.
- **Hover / pressed** (proposed; the export only has `a:hover { color: var(--tx) }`):
  - primary: `color-mix(in srgb, var(--ac) 90%, var(--tx))` / 82 %;
  - secondary and ghost: `--sf2` / `--sunk` background;
  - transition `--dur-fast`.
- **Destructive confirm** (proposed, for a final "Delete" inside a dialog): `--crit-fill` fill, `#fff` text.

### 7.2 Inputs

- **Text field:**
  - Height **52** (forms and dialogs), 44 (in-page search, table cells), 40 (header and sidebar search).
  - Radius 10, `1px --ln2` border, `--sf` fill.
  - Text 15 (14 at 40/44), padding `0 14px`.
- **Label** above the field: `12/16 600 --tx2 +.02em`, gap 6 to the field.
- **Help text** below: `12/16 --tx3`.
- **States:**
  - **Focus or active:** `2px --ac` border, padding `0 13px` to hold position.
  - **Invalid:** `2px --crit` border, `aria-invalid="true"`, help text turns `--crit` and says what to do.
  - **Read-only:** `--sf2` fill, `--tx2` text (Plex Mono for references).
  - **Placeholder:** `--tx3`.
- **Search:** a leading 20 px icon at `left:12–14px`, `--tx3`; padding-left 40–44.
- **Select (button styled as a field):** same box, value left (500 when chosen), trailing chevron-down 20 `--tx2`. The active select shows the `2px --ac` border.
- **Amount input** (budget): 44 h, 160 wide, right-aligned, 14/600 tabular.
- **Password / secret with eye button** (required on every password, PIN and API key field):

  ```html
  <div style="position:relative">
    <input type="password" … style="height:52px;padding:0 52px 0 14px;…">
    <button type="button" aria-label="Show password" aria-pressed="false"
            style="position:absolute;right:2px;top:2px;width:48px;height:48px;border:0;background:transparent;color:var(--tx2);border-radius:10px">
      <!-- icons/eye.svg (20px) ; when shown: icons/eye-off.svg + aria-label="Hide password" aria-pressed="true" -->
    </button>
  </div>
  ```

  - In a 44 px field the button is 44×44 at `top:0`, with input padding-right 48.
  - When revealed, the value switches to **Plex Mono** so ambiguous characters are clear.
  - Labels change with the object: "Show password", "Show key", "Show PIN" and their "Hide …" forms.
  - **PIN:** `inputmode="numeric"`, 22 px with `letter-spacing: .4em`.
- **Switch:** 52×32, radius 16. On: `--ac` track, 24 px `--ac-tx` thumb at `left:24px; top:4px`. (Proposed) Off: `--ln2` track, `--sf` thumb at `left:4px`. Use `role="switch"` and `aria-checked`. The row is 48 min-height with a 14/20 label plus a 12 `--tx3` sub-line and the switch trailing.
- **Checkbox:**
  - Native: 20×20, `accent-color: var(--ac)`.
  - Custom: 22×22 (or 24×24 inside a 48×48 hit area), radius 6–7, `1.5px --ln2`, `--sf` fill. (Proposed) Checked: `--ac` fill, white check icon at stroke 2.4.
- **Radio-as-chips:** see the chips section (`role="radiogroup"`).

### 7.3 Segmented control / tabs

- Track: `--sunk`, radius 12, padding 4, gap 4, laid out as an equal-column grid (`repeat(n, minmax(0,1fr))`). Fixed widths in use: 148 (2 options), 200, 240, or full width.
- Segment: height 32 (header, card headers), 36 (in-form), 40 (settings), radius 9.
  - Selected: `--sf` fill, `--shadow`, `14/600 --tx` (13/600 in card headers).
  - Unselected: transparent, `14/500 --tx2`.
- Use `role="tablist"` / `role="tab"` / `aria-selected`.
- There are no underline tabs in the export; segmented is the only tab style.

### 7.4 Chips and badges

**Filter / choice chip:**
- Height 36 (32 for inline quick-picks), radius 999, `1px --ln2`, `--sf` fill, `13/500 --tx`, padding `0 14px` (`0 12px`).
- Selected (`aria-pressed` / `aria-checked`): **ink-filled**, i.e. `--tx` fill, `--tx` border, `--bg` text, with an optional 14 px leading check icon.
- A count inside the chip is `600 --warn`.
- A dropdown chip has a trailing chevron-down 16, padding `0 10px 0 14px`, gap 4.
- A group label before chips: `12/600 --tx2 +.02em`.

**Badge / status tag:**
- Height 24, radius 6, padding `0 8px`, `12/600`, optional 14 px icon with gap 4.
- Variants are soft fill + strong text:

| Variant | Fill | Text | Example |
|---|---|---|---|
| good | `--good-soft` | `--good` | Matches, Paid back, Refund, Working |
| warn | `--warn-soft` | `--warn` | ₹5,000 to explain, Oct statement waiting |
| crit | `--crit-soft` | `--crit` | ₹3,000 off, 1 fund needs a look |
| accent | `--ac-soft` | `--ac` | New, Split, Step 2 of 3 |
| neutral | `--sunk` | `--tx2` | Transfer, Not counted, Not started |
| outline | transparent + inset `1px --ln2` | `--tx2` | Edited, Added for your transfer |
| on tinted row | `--sf` | strong colour of the row | Needs a category (on a `--warn-soft` row) |

**Other markers:**
- **Status pill** (header, larger badge): 28 h, radius 6, padding `0 10px`, gap 6, with a 14 px icon or a 6 px dot. Example: "SMS 9:38 pm · Gmail connected".
- **Count badge:** 20 h, min-width 22, radius 10, `--crit-fill` with `#fff` `11/600` text.
- **Dot:** 8×8 radius 4, colour `--crit-fill` for needs-attention. Status dots use `--good` / `--warn-fill` / `--crit-fill`.

### 7.5 Cards and tiles

| Type | Spec |
|---|---|
| **Section card** | `--sf`, `1px --ln`, radius **14**, padding **20** (hero 24, auth 32), column gap 12–20. Header row: `h2 17/24 600` + flex spacer + meta `12 --tx3` + links `14/600 --ac` (gap 12). |
| **Inner tile** (account) | `--sf2`, `1px --ln`, radius 14, padding 14, min-height 132, gap 4. Name 13/600, meta 12 `--tx3`, value 17/600 (line-height 32), badges row, foot 11/500 `--tx3`. A dashed `--ln2` border marks "no data yet". |
| **Stat tile** | `--sf`, `1px --ln`, radius 14, padding 16, gap 6. Label `12/16 600 +.02em --tx2` (optional 16 px icon, gap 8), value `22/28 600` tabular (coloured `--good`/`--crit` when the value is the judgement), footnote `12/16 --tx3`, optional badge (align-self start) or 80×24 sparkline. Clickable tiles are whole `<a>` elements. |
| **Callout / banner** | Radius 12, padding `12px 16px` (14 for the info variant), gap 12, 20 px icon. Warn: `--warn-soft` + `--warn`, text 15/22 500, trailing link `14/600` in the same colour ("Ask AI how"). Info: `--ac-soft` + `--tx`, 14/20 500 title plus 12/16 `--tx2` detail. Neutral: `--sunk` + `--tx2` 13/18, with a trailing secondary button (Retry). |
| **Alert card** (blocking error) | `--crit-soft` (no visible border), radius 14, padding 16, gap 12. A 36 px icon tile (`--sf` fill, `--crit` icon); title 15/20 600 `--crit`; body 13/18 `--tx2`; secondary button 40 h. `role="alert"`. |
| **Critical state card** (e.g. Gmail stopped) | A normal card with `--crit-soft` fill and border; an inner list on `--sf` radius 12; actions pinned to the bottom (`margin-top:auto`). |
| **Icon tile** | 40×40 (rows, cards) or 36×36 (inline, benefits), radius 10, soft fill + strong icon colour, 20 px icon. Variants: `ac`, `good`, `warn`, `crit`, neutral (`--sunk` + `--tx2`), "on tinted" (`--sf` + strong). |
| **Merchant monogram** | 36×36 radius 10, two-letter initials 13/600 in a soft tint (it picks the category's tone: warn for food, good for groceries, ac for transport/SIP, neutral otherwise). |
| **Person avatar** | Circle 36 (radius 18) or 40, initials 13–14/600–700 in a soft tint. Header avatar: `--tx` fill + `--bg` text. Stack: overlap −8 with a 2 px `--bg` ring. |
| **Placeholder / add tile** | `1px dashed --ln2`, radius 14–16, `--tx2` text with a `13/600 --ac` action ("Set billing date"). |

### 7.6 List rows

**"Needs you" row:**
- Layout: flex, gap 12, padding `12px 0`, `1px --ln` bottom (none on the last row).
- Contents: a 40 px icon tile; title 15/20 600; meta 13/18 `--tx3` (or `--warn 500` when time-critical, e.g. "Due 24 Oct · in 3 days").
- Actions: text buttons `14/600 --ac`, min-height 36, gap 16, optional trailing chevron 16. Quick-pick chips (32 h) may replace the actions.
- Footer: `12/16 --tx3`, "Done today · 3 · Show".

**Transaction table row (desktop):**
- Columns: Time (84), Merchant, Category, Account, Amount (right).
- Cells: padding `10px 8px`; the first cell has 20 left and the last has 20 right; `1px --ln` bottom.
- Time: 13 `--tx3`, tabular.
- Merchant: a 36 monogram (or a 36 icon tile for transfers and bills) + name 14/500 + inline badges (gap 6), or a second line of badges or a 12 `--tx3` note.
- Category and Account: 14 `--tx2`.
- Amount: 14/600, tabular, `nowrap`, coloured per §3.2.
- **Day header row:** `--sf2`, `12/600 --tx2`, padding `10px 20px`, with the day's net on the right ("−₹2,392 · +₹3,420" with the plus part in `--good`).
- **Column header:** `12/600 --tx2`, padding 12.
- **States:**
  - selected: `--ac-soft` + inset `2px --ac`;
  - needs attention: `--warn-soft` row with the monogram on `--sf`;
  - an inline "Pick category ▾" secondary button (36 h, radius 10, 13/600).
- The table sits in a card (radius 14) with `overflow-x:auto` and a min-width of 720.

**Phone transaction row** (proposed):
- Min-height 64, padding `12px 16px`, gap 12.
- Leading: a 40 monogram.
- Two-line middle: merchant 15/20 500 + badges, then `13/18 --tx3` "Category · Account · 8:52 pm".
- Trailing: amount 15/600 tabular, coloured per §3.2.
- Day headers: sticky `--sf2` strips, 12/600 `--tx2`, with the net on the right.

**Link row** ("More" list in the editor):
- Min-height 48, gap 12, `1px --ln` bottom.
- Icon 20 `--tx2`; label 14 `--tx` (flex); value 13 `--tx3`; chevron-right 18.

**Settings row:**
- Min-height 48.
- Label 14/20 with a `12 --tx3` sub-line.
- Trailing: a value (`13/600` in a semantic colour, e.g. "Allowed" in `--good`), a link (`14/600 --ac`), or a switch.

**Secondary nav item** (settings list):
- Min-height 48, padding `6px 10px`, radius 10.
- Title 14/500 + sub-line 12/16 `--tx3`.
- Active: `--ac-soft` / `--ac` 600. An error sub-line is in `--crit 500` with a trailing 8 px `--crit-fill` dot.

**Legend / category row:**
- `grid-template-columns: 12px minmax(0,1fr) auto 44px 80px`, gap 10, min-height 40, divider `--ln`.
- A 10×10 radius 3 swatch, the name, the amount 600, the share 12 `--tx3`, and a delta 12/600 coloured, with a 12 px arrow at stroke 2.

### 7.7 Dialogs, bottom sheets and side panels

**Dialog:**
- Scrim `--scrim`. Panel: `--sf`, radius **20**, padding **24**, max-width **360**, `--shadow2`, gap 16. Use `role="dialog" aria-modal="true" aria-labelledby`.
- Header: a 40 icon tile + title `19/24 600`.
- Body: `15/22 --tx2`.
- Fields as in §7.2, with a `12/16 --tx3` reassurance line ("No CVV is ever stored.").
- Actions right-aligned, gap 8: ghost Cancel (`--ac`) and primary (48 h).

**Bottom sheet** (proposed, phone):
- The same panel full-width, with top corners radius 20, padding `8px 16px 16px` + safe area, and a 36×4 radius-2 `--ln2` drag handle centred 8 px from the top.
- The title row matches the dialog. Long forms go full-height with the footer pinned.

**Side panel / editor** (web, preferred over a modal for editing):
- A card (radius 14) in the right pane, flex `4 1 380px`, max 520.
- Header: padding `12px 12px 12px 20px`, bottom `--ln`; `h2 17/24`; a "Saved 7:46 pm" note `12 --tx3`; 40 px round icon buttons (more, close).
- Body: padding 20, gap 18.
- Footer: `--sf2`, top `--ln`, padding `16px 20px`, bottom radius 14. Destructive on the left, then a spacer, then secondary Cancel and primary Save (48 h).
- Footnote under it: 12/17 `--tx3`.

### 7.8 Progress, pace and meters

| Component | Spec |
|---|---|
| **Pace bar** (signature) | Track 14 h radius 7 `--sunk` (10 h radius 5 compact). Segments in a flex row: spent `--tx` (left radius only), promised hatch `repeating-linear-gradient(135deg, var(--hatch) 0 2px, transparent 2px 6px)`, the rest is free track. **Today tick:** absolutely positioned, `width:2px; height: bar+10 (24 or 20); top:-5px; background: var(--ac); radius 1`. Label above (`padding-top:18px` on the wrapper), `11/14 600 --ac`, centred with `translateX(-50%)`. Legend row below: 12×12 radius 3 swatches (hatch swatch at `2px 4px` spacing + inset `--ln2` ring; free swatch `--sunk` + ring; the tick legend is a 2×14 `--ac` line), `13/18 --tx2` labels, `600 --tx` figures, gap `8px 24px`. Provide an `aria-label` that spells out every figure. |
| **Limit bar** | 10 h radius 5 `--sunk`; fill `--good` when on pace, `--crit-fill` when over pace or near the limit, plus the same today tick (`2×20`, top −5). Status line `12`: `--tx3` normally ("54% used · ₹4,180 left"), `600 --crit` when over ("91% used · ₹520 left for 24 days"). Fully promised: the whole bar is `repeating-linear-gradient(135deg, var(--hatch) 0 2px, var(--sunk) 2px 6px)`. Partly paid: `--good` then hatch. |
| **Thin meter** | 6 h radius 3; track `--sunk`, fill `--tx` (neutral), `--ac` (progress) or semantic. On card faces: track `rgba(255,255,255,.22)`, fill mint/amber/coral (§3.4). |
| **Step indicator** | A "Step 2 of 3" accent badge plus an equal grid of 4 h radius-2 segments, gap 4; done `--ac`, to-do `--sunk`. |
| **Allocation / stacked bar** | 12 h radius 6, `overflow:hidden`, gap 2 between segments, chart palette, legend with 10×10 radius 3 swatches. |
| **Spinner** | 28 px: ring `--sunk` 3 px plus a quarter arc `--ac` 3 px with a round cap (proposed: rotate 900 ms linear). |
| **Countdown ring** | 20 px, track `rgba(255,255,255,.25)` 2.5 px, white arc 2.5 px with a round cap, "Hides in 42 s". |
| **Timeline / schedule dot** | 10 px dot `--ac` = done; 10 px `1.5px dashed --ac` ring = upcoming; connectors 1 px `--ln2`. |

### 7.9 Credit-card face

- **Size:** 328×206 (ISO ratio 1.59), `max-width:100%`, radius **16**, padding 16, `#fff` text, `linear-gradient(135deg, issuer-dark 0%, issuer-light 100%)` (§3.4). Arranged as a column with `space-between`. On the Cards page it carries `--shadow`.
- **Top row:** "Bank · Product" 13/600 left; the network wordmark right: `VISA` 18/800 italic `+.04em`, `Mastercard` 14/700, `RuPay` 15/800 italic. These are text, not logos.
- **Middle row** (gap 12):
  - the **EMV chip**, 38×28, radius 6, gold gradient, with 1 px `rgba(0,0,0,.25)` lines at y = 9 and 18;
  - the number in **Plex Mono 17, letter-spacing .12em**, `•••• •••• •••• 4417`;
  - a 40 round eye button (`rgba(255,255,255,.14)`), labelled "Show card details".
- **Bottom block** (gap 6): the utilisation meter (6 h); a usage line `12/16` tabular ("₹46,820 of ₹3,00,000 used · ₹2,53,180 available", at opacity .92 on the Cards page); then the bill line left (600 when due soon) and "This cycle ₹9,860" right at opacity .85. A paid bill shows a 14 px check icon.
- **States:**
  - **Revealed (vault unlocked):** darker gradient; a 36 h `rgba(0,0,0,.55)` magnetic stripe 18 px from the top; "Hides in 42 s" with a countdown ring; full number Mono 19 `.1em`; "Valid thru" 11 at opacity .75 over Mono 14; name 13/600 `+.08em` upper-case.
  - **Selected:** `outline: 3px solid var(--ac); outline-offset: 3px`.
  - **Not set up:** an inline dashed `rgba(255,255,255,.6)` box, radius 10, padding `8px 10px`, with an icon, a 12/16 sentence, and a white button (`#fff` fill, issuer-colour text, 32 h, radius 8, 12/700).
  - **Placeholder:** a 160×206 dashed `--ln2` tile with the name, a `12 --tx3` reason, and a `13/600 --ac` action.
- **Caption under the card** (`figure`): `12/16`, `--tx3`, or `--crit 600` when utilisation is critical.

### 7.10 Stat displays

- **Hero figure:** eyebrow `12/16 600 +.02em --tx2` ("15 Oct – 14 Nov · day 7 of 31"), then the title `15/20 600 --tx2` ("Free to spend"), then the figure `44/52 600 −.02em`, then the explanation `15/22 --tx2` with the key number inline at `600 --tx`.
- **Inline KPI group:** flex, gap 24; label `12/600 --tx2`, value `17/600` tabular.
- **Big value with change:** `34/40 600 −.02em`, then the change `14/600 --good` ("Today +₹2,140 (+0.31%)"), next to a 200×56 sparkline (`--ac`, 1.75 px, round).

### 7.11 Empty, error and loading states

- **Empty (inline in a card):**
  - Layout: centred column, gap 8, padding `14px 12px`, `1px dashed --ln2`, radius 12.
  - Contents: a 40 icon tile (`--sunk` / `--tx3`); one sentence `13/18 --tx2` ("No payments on this trip yet."); one ghost action `13/600 --ac`.
  - An empty queue is just a line: "Nothing new to review. We check every night." (`14/20 --tx2` under a `12/600 --tx3` label).
  - (Proposed) For a full-page empty state, use the same structure at 48 icon / 15/22 text / 48 h primary button, centred in the content area. This is one of the few centred elements.
- **Errors**, in order of severity:
  - field error: a 2 px `--crit` border plus a help line saying what to do;
  - inline alert banner: `--crit-soft`, radius 12, padding `10px 14px`, 20 px icon, `15/20 600 --crit`;
  - an alert card (§7.5);
  - a whole-card critical state (§7.5).
- **Stale data:** a neutral `--sunk` callout with a Retry button ("Prices from 7h ago · couldn't refresh").
- **Loading:**
  - Skeletons are `--sunk` blocks: a 36 radius-10 square plus lines 12 h radius 6 (widths 40 % / 32 %) and 10 h (24 % / 20 %), a 72×12 amount stub, rows gap 12.
  - They are preceded by a `12/600 --tx2` caption ("Loading 7 more days…", "Checking your Sep statement…") and wrapped in `aria-busy="true"` (optionally in a dashed `--ln2` radius-14 box).
  - (Proposed) A gentle 1.2 s opacity pulse between 1 and .6, with no shimmer gradient.
- **Processing:** a card with the spinner, a title "Reading 4 screenshots…" 15/20 600, a sub-line, an "2 of 4" counter, a 6 h progress bar, and per-item rows (mono file name plus a result badge; failed items sit on a `--crit-soft` radius-10 row).

### 7.12 Toast / snackbar

- **Inverse:** `--tx` fill, `--bg` text, radius 12, min-height 52, padding `10px 8px 10px 16px`, gap 12, `14/20`, a 20 px leading icon, `--shadow2`, `role="status"`.
- **Action:** a text button in `--bg`, `14/700` **underlined** ("Undo"), min-height 36, padding `0 12px`.
- **Placement** (proposed): on web, top of the right pane or bottom-left, 16 from the edges. On phone, bottom, above the nav bar, 16 side margins. Auto-dismiss after 6 s, or 10 s if it has an action.

### 7.13 Charts

- **Bar chart:**
  - Bars 14 wide, rx 2. Past bars in `--tx`; today in `--ac`; future as `--sunk` fill + `--ln2` stroke (13×14 stubs).
  - Gridlines: `--ln` 1 px. Baseline: `--ln2`.
  - Y labels: 11 `--tx3` tabular, right-aligned at x = 40. X labels: 11 `--tx3`, with "Today" in `--ac 600`.
  - Comparison: polyline `--tx3` 1.75 dashed `5 4`. Target: `--ac` 1.5 dashed `2 3`.
  - Off-scale values: hollow triangles (`--sf` fill, `--tx3` stroke) with 11 px labels.
  - The legend row sits above the chart, with a `role="img"` + `aria-label` summary on the SVG.
- **Donut:** 168 box, r 52, stroke 16, start at 12 o'clock, ~2 px gaps between segments. Centre: 11 `--tx3` label over a 17/600 tabular figure.
- **Sparkline:** `--ac`, 1.75 px, round joins; 200×56 (card) or 80×24 (tile).

### 7.14 Calendar

- A 7-column grid with gap 4. Weekday heads: `12/600 --tx3`.
- Day cell: min-height 64, radius 10, padding 6, 13 tabular. States:
  - **out of period:** `--ln2` text only;
  - **in period:** `--sf2` + `1px --ln`;
  - **today:** `--sf` + `2px --ac`, "Today" `11/600 --ac`;
  - **has an event / selected:** a `--tx` fill with `--bg` text, a 6 px dot and the amount 11/600.
- Annotations ("Pay day") are 11 `--tx3`.

### 7.15 Icons

- **A custom set in the Lucide style:**
  - 24×24 grid, `fill:none`, `stroke: currentColor`, **stroke-width 1.75**, round caps and joins;
  - 2.0 at 12–14 px, 3 for the "more" dots;
  - sizes 20 (default, nav, tiles), 18 (buttons, small rows), 16 (inline links, tile labels), 14 (badges, chips), 12 (delta arrows), 24 (dropzone).
- All 46 are extracted to `docs/design-assets/icons/` (named SVGs plus `icons.json`): home, list, bar-chart, bank, credit-card, trending-up, target, list-checks, repeat, banknote, piggy-bank, users, briefcase, shield, calendar, tag, sparkles (AI), sliders (Settings), search, check, plus, chevron-left, chevron-right, chevron-up, chevron-down, x, eye, eye-off, alert-triangle, info, lock, refresh, trash, pencil, mail, more-vertical, arrow-up-right, arrow-down-left, link, bell, message (SMS), transfer, upload, trophy, undo, filter.
- **In apps:** use these SVGs directly (React: inline components; Flutter: `flutter_svg`, or convert to an icon font). The closest off-the-shelf fallback is **Lucide** (`lucide-react`, `lucide_icons` for Flutter) at `strokeWidth={1.75}`, but its glyph shapes differ slightly.
- Icons are always `aria-hidden` next to text. Icon-only buttons carry `aria-label`.

### 7.16 Logo

- **Mark:**
  - a 28×28 square, rx 8, filled with `--ac`;
  - a glyph of two "ledger lines" (`M7 10.5h14`, `M7 17.5h8`) plus a vertical cursor stroke (`M18.5 14v7`), drawn in `--ac-tx` at stroke 2.2 with round caps.
- **Wordmark:** "SpendLog" in Plex Sans 18/700 `−.01em` `--tx`, gap 10.
- **Files:** `docs/design-assets/logo/` holds:
  - `spendlog-mark-light.svg` (`#2C4FCB` / white);
  - `spendlog-mark-dark.svg` (`#93A8FF` / `#0D1430`);
  - `spendlog-mark-cssvars.svg`;
  - `spendlog-mark-1024.svg` for launcher-icon generation.

## 8. Copy and voice (export)

- **Plain, second person, sentence case.** No title case, no all-caps, no exclamation marks. Short labels ("Free to spend", "Needs you", "Promised", "Not counted", "Earmarked").
- **Numbers explain themselves.** Every figure is followed by what it means: "24 days left · about ₹919/day", "Limits add to ₹1,20,000 · ₹0 unassigned", "Bank said ₹12,480 on 20 Oct; SpendLog expects ₹15,480".
- **Actions are verbs that say what happens:** Find the cause, Pick account, Mark paid, Read it from Gmail, Upload PDF, Set billing date, Ask the phone to check now, Use a different account, Reconnect Gmail, Upload PDFs instead.
- **Ask, don't accuse:** "₹5,000 came in to Federal ••3295 — what was it?"
- **Errors say what happened and the way out:** "Limits can't add up to more than the budget — you're ₹2,000 over. Lower another limit or raise the budget to ₹1,22,000." "That's a family login — kids can only sign in on the phone app."
- **Privacy is stated plainly and specifically:** "Reads bank SMS on your phone — never OTPs or chats", "Stored encrypted on your phone", "No CVV is ever stored."
- **Typography in copy:**
  - curly apostrophes `’`;
  - em dash `—` with spaces;
  - ellipsis `…` (one character) for in-progress ("Reading 4 screenshots…", "Search or ask…");
  - middle dot ` · ` as the separator.
- **Status chips use past or present facts:** "Matches", "Working", "Stopped", "Key works · last used today 9:12 pm".
- **AI is labelled honestly:** "Uses your Gemini key", with "Ask AI how" as a link, never auto-applied.

## 9. Porting guide

### 9.1 CSS custom properties (ready to paste)

Use for: the SpendLog React web app (plain CSS), the Identity site, and as the variable source for Tailwind and Chakra.

```css
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap');

:root {
  color-scheme: light;
  /* surfaces */
  --canvas:#E4E1D8; --bg:#F4F2EC; --sf:#FFFFFF; --sf2:#FAF9F5; --sunk:#ECE9E1;
  /* lines */
  --ln:#E2DED4; --ln2:#C7C2B5;
  /* ink */
  --tx:#18191D; --tx2:#4C4D53; --tx3:#67686E;
  /* accent (per-app: see §10) */
  --ac:#2C4FCB; --ac-tx:#FFFFFF; --ac-soft:#E6EBFB; --ac-line:#B9C6F2;
  /* semantic */
  --good:#15724A; --good-soft:#E1F0E6;
  --warn:#8F5200; --warn-fill:#E39A2E; --warn-soft:#FBEED6;
  --crit:#B3302A; --crit-fill:#D9473E; --crit-soft:#FBE5E2;
  --hatch:#C7C2B5;
  /* money (aliases) */
  --money-out:var(--tx); --money-in:var(--good); --money-neutral:var(--tx3);
  /* charts */
  --c1:#2C4FCB; --c2:#C7792B; --c3:#2F8A7A; --c4:#B04A6F; --c5:#6A7A2F; --c-other:#8A8780;
  /* elevation */
  --shadow:0 1px 2px rgba(24,25,29,.06),0 2px 8px rgba(24,25,29,.05);
  --shadow2:0 16px 40px rgba(24,25,29,.18);
  --scrim:rgba(24,25,29,.42);
  /* type */
  --font-sans:'IBM Plex Sans',system-ui,sans-serif;
  --font-mono:'IBM Plex Mono',ui-monospace,monospace;
  /* radii */
  --r-xs:3px; --r-sm:6px; --r-md:10px; --r-lg:12px; --r-xl:14px; --r-2xl:16px; --r-3xl:20px; --r-full:999px;
  /* motion (proposed) */
  --dur-fast:120ms; --dur:200ms; --dur-slow:280ms;
  --ease:cubic-bezier(.2,0,0,1); --ease-exit:cubic-bezier(.3,0,1,1);
  /* hatch pattern */
  --hatch-pattern:repeating-linear-gradient(135deg,var(--hatch) 0 2px,transparent 2px 6px);
}

[data-theme="dark"] {
  color-scheme: dark;
  --canvas:#08090A; --bg:#111214; --sf:#1A1B1E; --sf2:#202125; --sunk:#0C0D0F;
  --ln:#2B2D32; --ln2:#3D3F46;
  --tx:#EDEBE6; --tx2:#BEBCB6; --tx3:#9A9893;
  --ac:#93A8FF; --ac-tx:#0D1430; --ac-soft:#1D2544; --ac-line:#34407A;
  --good:#56C892; --good-soft:#12291D;
  --warn:#F2B661; --warn-fill:#E9A240; --warn-soft:#2E2312;
  --crit:#FF8C80; --crit-fill:#E45B50; --crit-soft:#341A19;
  --hatch:#4A4C53;
  --c1:#93A8FF; /* proposed dark swap, see §3.3 */
  --shadow:0 0 0 1px rgba(255,255,255,.02);
  --shadow2:0 16px 40px rgba(0,0,0,.6);
  --scrim:rgba(0,0,0,.6);
}

/* "System" theme: follow the OS unless the user picked one */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --canvas:#08090A; --bg:#111214; --sf:#1A1B1E; --sf2:#202125; --sunk:#0C0D0F;
    --ln:#2B2D32; --ln2:#3D3F46;
    --tx:#EDEBE6; --tx2:#BEBCB6; --tx3:#9A9893;
    --ac:#93A8FF; --ac-tx:#0D1430; --ac-soft:#1D2544; --ac-line:#34407A;
    --good:#56C892; --good-soft:#12291D;
    --warn:#F2B661; --warn-fill:#E9A240; --warn-soft:#2E2312;
    --crit:#FF8C80; --crit-fill:#E45B50; --crit-soft:#341A19;
    --hatch:#4A4C53; --c1:#93A8FF;
    --shadow:0 0 0 1px rgba(255,255,255,.02);
    --shadow2:0 16px 40px rgba(0,0,0,.6);
    --scrim:rgba(0,0,0,.6);
  }
}

html { background:var(--bg); color:var(--tx); font:14px/20px var(--font-sans); }
body { margin:0; background:var(--bg); }
*,*::before,*::after { box-sizing:border-box; }
.num  { font-variant-numeric:tabular-nums lining-nums; }
.mono { font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
a { color:var(--ac); } a:hover { color:var(--tx); }
:focus-visible { outline:3px solid var(--ac); outline-offset:3px; }
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { transition-duration:0ms !important; animation-duration:0ms !important; } }
```

**Migration from the current SpendLog web tokens** (`apps/frontend/src/index.css`):

| Old token | New token |
|---|---|
| `--ink` | `--tx` |
| `--ink-70` | `--tx2` |
| `--muted` | `--tx3` |
| `--muted-light` | `--ln2` |
| `--brand` | `--ac` |
| `--brand-dark` | hover mix (§7.1) |
| `--brand-50` / `--brand-100` | `--ac-soft` / `--ac-line` |
| `--credit` | `--good` |
| `--credit-50` | `--good-soft` |
| `--debit` | **`--tx`** for normal spend (spending is no longer red); `--crit` only for problems |
| `--debit-50` | `--crit-soft` |
| `--paper` | `--bg` |
| `--surface` | `--sf` |
| `--line` | `--ln` |
| `--line-strong` | `--ln2` |
| `--transfer` | `--tx3` |
| `--warn` | `--warn` |
| `--warn-bg` | `--warn-soft` |
| `--radius-md` 12 | `--r-lg` 12 |

Cards move to `--r-xl` 14.

### 9.2 Tailwind v4 (`@theme`), for InFrame

Keep §9.1's variables as the source of truth (so dark mode is just a variable swap) and map them into Tailwind with `@theme inline`:

```css
@import "tailwindcss";
/* paste the :root / [data-theme=dark] / prefers-color-scheme blocks from §9.1 here */

@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

@theme inline {
  --color-canvas: var(--canvas);
  --color-bg: var(--bg);
  --color-sf: var(--sf);
  --color-sf2: var(--sf2);
  --color-sunk: var(--sunk);
  --color-ln: var(--ln);
  --color-ln2: var(--ln2);
  --color-tx: var(--tx);
  --color-tx2: var(--tx2);
  --color-tx3: var(--tx3);
  --color-ac: var(--ac);
  --color-ac-tx: var(--ac-tx);
  --color-ac-soft: var(--ac-soft);
  --color-ac-line: var(--ac-line);
  --color-good: var(--good);
  --color-good-soft: var(--good-soft);
  --color-warn: var(--warn);
  --color-warn-fill: var(--warn-fill);
  --color-warn-soft: var(--warn-soft);
  --color-crit: var(--crit);
  --color-crit-fill: var(--crit-fill);
  --color-crit-soft: var(--crit-soft);
  --color-hatch: var(--hatch);
  --color-c1: var(--c1); --color-c2: var(--c2); --color-c3: var(--c3);
  --color-c4: var(--c4); --color-c5: var(--c5); --color-c-other: var(--c-other);

  --font-sans: 'IBM Plex Sans', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;

  /* type scale: size / line-height / tracking / weight */
  --text-display-xl: 44px;  --text-display-xl--line-height: 52px; --text-display-xl--letter-spacing: -0.02em; --text-display-xl--font-weight: 600;
  --text-display-l: 40px;   --text-display-l--line-height: 48px;  --text-display-l--letter-spacing: -0.02em;  --text-display-l--font-weight: 600;
  --text-display-m: 34px;   --text-display-m--line-height: 40px;  --text-display-m--letter-spacing: -0.02em;  --text-display-m--font-weight: 600;
  --text-display-s: 28px;   --text-display-s--line-height: 34px;  --text-display-s--letter-spacing: -0.02em;  --text-display-s--font-weight: 600;
  --text-title-page: 22px;  --text-title-page--line-height: 28px; --text-title-page--font-weight: 600;
  --text-title-l: 20px;     --text-title-l--line-height: 26px;    --text-title-l--font-weight: 600;
  --text-title-m: 19px;     --text-title-m--line-height: 26px;    --text-title-m--font-weight: 600;
  --text-title-section: 17px; --text-title-section--line-height: 24px; --text-title-section--font-weight: 600;
  --text-title-card: 15px;  --text-title-card--line-height: 20px; --text-title-card--font-weight: 600;
  --text-body-l: 15px;      --text-body-l--line-height: 22px;
  --text-body: 14px;        --text-body--line-height: 20px;
  --text-body-s: 13px;      --text-body-s--line-height: 18px;
  --text-label: 12px;       --text-label--line-height: 16px;      --text-label--letter-spacing: 0.02em; --text-label--font-weight: 600;
  --text-caption: 12px;     --text-caption--line-height: 16px;
  --text-micro: 11px;       --text-micro--line-height: 14px;      --text-micro--font-weight: 600;

  --radius-xs: 3px; --radius-sm: 6px; --radius-md: 10px; --radius-lg: 12px;
  --radius-xl: 14px; --radius-2xl: 16px; --radius-3xl: 20px;

  --shadow-1: var(--shadow);
  --shadow-2: var(--shadow2);

  --ease-ds: cubic-bezier(.2,0,0,1);
  --breakpoint-tablet: 600px;
  --breakpoint-desktop: 1024px;
  --breakpoint-wide: 1440px;
}

@utility num { font-variant-numeric: tabular-nums lining-nums; }
@utility hatch { background: repeating-linear-gradient(135deg, var(--hatch) 0 2px, transparent 2px 6px); }
```

Usage examples (Tailwind's default 4 px spacing scale covers the system: `gap-3` = 12, `p-5` = 20, `gap-1.5` = 6, `p-3.5` = 14):
- **Card:** `bg-sf border border-ln rounded-xl p-5`
- **Primary button:** `h-12 px-5 rounded-lg bg-ac text-ac-tx text-[15px] font-semibold`
- **Badge:** `h-6 px-2 rounded-sm text-xs font-semibold bg-good-soft text-good`
- **Chip (selected):** `h-9 px-3.5 rounded-full border border-tx bg-tx text-bg text-[13px] font-medium`
- **Page shell:** `px-4 tablet:px-6 desktop:px-8`, with no `container` and no `mx-auto max-w-*`.

On Tailwind v3, put the same names under `theme.extend.colors` as `'var(--sf)'` (opacity modifiers won't work on hex variables), plus `fontFamily`, `borderRadius` and `boxShadow`.

### 9.3 Chakra UI v2 theme, for Trippin

```ts
// theme.ts
import { extendTheme, type ThemeConfig } from '@chakra-ui/react';

const config: ThemeConfig = { initialColorMode: 'system', useSystemColorMode: true };

const c = (light: string, dark: string) => ({ default: light, _dark: dark });

export const theme = extendTheme({
  config,
  fonts: {
    heading: `'IBM Plex Sans', system-ui, sans-serif`,
    body: `'IBM Plex Sans', system-ui, sans-serif`,
    mono: `'IBM Plex Mono', ui-monospace, monospace`,
  },
  fontSizes: { '2xs': '11px', xs: '12px', sm: '13px', md: '14px', lg: '15px', xl: '17px', '2xl': '19px', '3xl': '22px', '4xl': '28px', '5xl': '34px', '6xl': '40px', '7xl': '44px' },
  lineHeights: { micro: '14px', caption: '16px', bodyS: '18px', body: '20px', bodyL: '22px', section: '24px', title: '26px', page: '28px', d34: '40px', d40: '48px', d44: '52px' },
  letterSpacings: { tight: '-0.02em', snug: '-0.01em', label: '0.02em' },
  radii: { xs: '3px', sm: '6px', md: '10px', lg: '12px', xl: '14px', '2xl': '16px', '3xl': '20px', full: '9999px' },
  shadows: {
    ds1: '0 1px 2px rgba(24,25,29,.06), 0 2px 8px rgba(24,25,29,.05)',
    ds2: '0 16px 40px rgba(24,25,29,.18)',
    outline: '0 0 0 3px var(--chakra-colors-ac)',
  },
  semanticTokens: {
    colors: {
      canvas: c('#E4E1D8', '#08090A'),
      bg: c('#F4F2EC', '#111214'),
      sf: c('#FFFFFF', '#1A1B1E'),
      sf2: c('#FAF9F5', '#202125'),
      sunk: c('#ECE9E1', '#0C0D0F'),
      ln: c('#E2DED4', '#2B2D32'),
      ln2: c('#C7C2B5', '#3D3F46'),
      tx: c('#18191D', '#EDEBE6'),
      tx2: c('#4C4D53', '#BEBCB6'),
      tx3: c('#67686E', '#9A9893'),
      // Trippin accent (§10); SpendLog would use #2C4FCB/#93A8FF etc.
      ac: c('#0A6E86', '#6CCBE3'),
      acTx: c('#FFFFFF', '#062029'),
      acSoft: c('#E0F1F5', '#10282F'),
      acLine: c('#A9D6E1', '#1F4E5A'),
      good: c('#15724A', '#56C892'), goodSoft: c('#E1F0E6', '#12291D'),
      warn: c('#8F5200', '#F2B661'), warnFill: c('#E39A2E', '#E9A240'), warnSoft: c('#FBEED6', '#2E2312'),
      crit: c('#B3302A', '#FF8C80'), critFill: c('#D9473E', '#E45B50'), critSoft: c('#FBE5E2', '#341A19'),
      hatch: c('#C7C2B5', '#4A4C53'),
      scrim: c('rgba(24,25,29,.42)', 'rgba(0,0,0,.6)'),
      'chakra-body-bg': c('#F4F2EC', '#111214'),
      'chakra-body-text': c('#18191D', '#EDEBE6'),
      'chakra-border-color': c('#E2DED4', '#2B2D32'),
      'chakra-placeholder-color': c('#67686E', '#9A9893'),
    },
    shadows: {
      ds1: { default: '0 1px 2px rgba(24,25,29,.06), 0 2px 8px rgba(24,25,29,.05)', _dark: '0 0 0 1px rgba(255,255,255,.02)' },
      ds2: { default: '0 16px 40px rgba(24,25,29,.18)', _dark: '0 16px 40px rgba(0,0,0,.6)' },
    },
  },
  styles: { global: { body: { bg: 'bg', color: 'tx', fontSize: 'md', lineHeight: 'body' }, '.num': { fontVariantNumeric: 'tabular-nums lining-nums' } } },
  components: {
    Button: {
      baseStyle: { borderRadius: 'lg', fontWeight: 600 },
      sizes: {
        lg: { h: '52px', px: 5, fontSize: 'lg' },
        md: { h: '48px', px: 5, fontSize: 'lg' },
        sm: { h: '40px', px: 4, fontSize: 'md' },
        xs: { h: '36px', px: 3, fontSize: 'sm', borderRadius: 'md' },
      },
      variants: {
        primary: { bg: 'ac', color: 'acTx', _hover: { filter: 'brightness(.94)' } },
        secondary: { bg: 'sf', color: 'tx', border: '1px solid', borderColor: 'ln2', _hover: { bg: 'sf2' } },
        ghost: { bg: 'transparent', color: 'ac', _hover: { bg: 'sf2' } },
        danger: { bg: 'transparent', color: 'crit', border: '1px solid', borderColor: 'critSoft', _hover: { bg: 'critSoft' } },
      },
      defaultProps: { variant: 'primary', size: 'md' },
    },
    Input: {
      variants: {
        ds: {
          field: {
            h: '52px', px: '14px', fontSize: 'lg', borderRadius: 'md', bg: 'sf', border: '1px solid', borderColor: 'ln2',
            _focusVisible: { borderWidth: '2px', borderColor: 'ac', px: '13px', boxShadow: 'none' },
            _invalid: { borderWidth: '2px', borderColor: 'crit', px: '13px', boxShadow: 'none' },
            _readOnly: { bg: 'sf2', color: 'tx2' },
            _placeholder: { color: 'tx3' },
          },
        },
      },
      defaultProps: { variant: 'ds' },
    },
    FormLabel: { baseStyle: { fontSize: 'xs', lineHeight: 'caption', fontWeight: 600, letterSpacing: 'label', color: 'tx2', mb: '6px' } },
    Badge: { baseStyle: { h: '24px', px: 2, borderRadius: 'sm', fontSize: 'xs', fontWeight: 600, textTransform: 'none', display: 'inline-flex', alignItems: 'center' } },
    Tag: { baseStyle: { container: { h: '36px', px: '14px', borderRadius: 'full', fontSize: 'sm', fontWeight: 500 } } },
    Card: { baseStyle: { container: { bg: 'sf', border: '1px solid', borderColor: 'ln', borderRadius: 'xl', boxShadow: 'none' } } },
    Modal: { baseStyle: { overlay: { bg: 'scrim' }, dialog: { bg: 'sf', borderRadius: '3xl', boxShadow: 'ds2', p: 6, maxW: '360px' } } },
    Drawer: { baseStyle: { overlay: { bg: 'scrim' }, dialog: { bg: 'sf' } } },
    Switch: { baseStyle: { track: { bg: 'ln2', _checked: { bg: 'ac' } }, thumb: { bg: 'sf', _checked: { bg: 'acTx' } } } },
    Divider: { baseStyle: { borderColor: 'ln', opacity: 1 } },
  },
});
```

Chakra notes:
- Use `<InputRightElement>` with a 48×48 ghost `IconButton` (eye / eye-off, `aria-label` "Show password" / "Hide password", `aria-pressed`) for every password field.
- Toasts: render a custom component (inverse `tx`/`bg`, radius 12, `ds2`) through `toast({ render })`.
- Layout: `<Box px={{ base: 4, md: 6, lg: 8 }}>`. Never use `<Container>`.

### 9.4 Flutter (SpendLog Android, Trippin, InFrame)

Replace SpendLog's current `SpendColors` extension in `apps/mobile-app/lib/theme.dart` with this shared token set. The field names mirror the CSS so design and code read the same.

The sketch targets Flutter ≥ 3.27 (`CardThemeData` / `DialogThemeData`, `WidgetStateProperty`, the `surfaceContainer*` roles). On older SDKs use `CardTheme` / `DialogTheme` / `MaterialStateProperty` and drop the `surfaceContainer*` lines.

```dart
import 'dart:ui' show FontFeature;
import 'package:flutter/material.dart';

/// Shared design tokens. One instance per brightness; apps override only the accent quad.
@immutable
class DsColors extends ThemeExtension<DsColors> {
  const DsColors({
    required this.canvas, required this.bg, required this.sf, required this.sf2, required this.sunk,
    required this.ln, required this.ln2,
    required this.tx, required this.tx2, required this.tx3,
    required this.ac, required this.acTx, required this.acSoft, required this.acLine,
    required this.good, required this.goodSoft,
    required this.warn, required this.warnFill, required this.warnSoft,
    required this.crit, required this.critFill, required this.critSoft,
    required this.hatch, required this.scrim, required this.chart,
  });

  final Color canvas, bg, sf, sf2, sunk, ln, ln2, tx, tx2, tx3;
  final Color ac, acTx, acSoft, acLine;
  final Color good, goodSoft, warn, warnFill, warnSoft, crit, critFill, critSoft, hatch, scrim;
  final List<Color> chart; // c1..c5, other

  Color get moneyOut => tx;
  Color get moneyIn => good;
  Color get moneyNeutral => tx3;

  static const light = DsColors(
    canvas: Color(0xFFE4E1D8), bg: Color(0xFFF4F2EC), sf: Color(0xFFFFFFFF), sf2: Color(0xFFFAF9F5), sunk: Color(0xFFECE9E1),
    ln: Color(0xFFE2DED4), ln2: Color(0xFFC7C2B5),
    tx: Color(0xFF18191D), tx2: Color(0xFF4C4D53), tx3: Color(0xFF67686E),
    ac: Color(0xFF2C4FCB), acTx: Color(0xFFFFFFFF), acSoft: Color(0xFFE6EBFB), acLine: Color(0xFFB9C6F2),
    good: Color(0xFF15724A), goodSoft: Color(0xFFE1F0E6),
    warn: Color(0xFF8F5200), warnFill: Color(0xFFE39A2E), warnSoft: Color(0xFFFBEED6),
    crit: Color(0xFFB3302A), critFill: Color(0xFFD9473E), critSoft: Color(0xFFFBE5E2),
    hatch: Color(0xFFC7C2B5), scrim: Color(0x6B18191D), // rgba(24,25,29,.42)
    chart: [Color(0xFF2C4FCB), Color(0xFFC7792B), Color(0xFF2F8A7A), Color(0xFFB04A6F), Color(0xFF6A7A2F), Color(0xFF8A8780)],
  );

  static const dark = DsColors(
    canvas: Color(0xFF08090A), bg: Color(0xFF111214), sf: Color(0xFF1A1B1E), sf2: Color(0xFF202125), sunk: Color(0xFF0C0D0F),
    ln: Color(0xFF2B2D32), ln2: Color(0xFF3D3F46),
    tx: Color(0xFFEDEBE6), tx2: Color(0xFFBEBCB6), tx3: Color(0xFF9A9893),
    ac: Color(0xFF93A8FF), acTx: Color(0xFF0D1430), acSoft: Color(0xFF1D2544), acLine: Color(0xFF34407A),
    good: Color(0xFF56C892), goodSoft: Color(0xFF12291D),
    warn: Color(0xFFF2B661), warnFill: Color(0xFFE9A240), warnSoft: Color(0xFF2E2312),
    crit: Color(0xFFFF8C80), critFill: Color(0xFFE45B50), critSoft: Color(0xFF341A19),
    hatch: Color(0xFF4A4C53), scrim: Color(0x99000000), // rgba(0,0,0,.6)
    chart: [Color(0xFF93A8FF), Color(0xFFC7792B), Color(0xFF2F8A7A), Color(0xFFB04A6F), Color(0xFF6A7A2F), Color(0xFF8A8780)],
  );

  /// Per-app accent override (see §10).
  DsColors withAccent({required Color ac, required Color acTx, required Color acSoft, required Color acLine}) =>
      copyWith(ac: ac, acTx: acTx, acSoft: acSoft, acLine: acLine, chart: [ac, ...chart.skip(1)]);

  @override
  DsColors copyWith({Color? ac, Color? acTx, Color? acSoft, Color? acLine, List<Color>? chart}) => DsColors(
    canvas: canvas, bg: bg, sf: sf, sf2: sf2, sunk: sunk, ln: ln, ln2: ln2, tx: tx, tx2: tx2, tx3: tx3,
    ac: ac ?? this.ac, acTx: acTx ?? this.acTx, acSoft: acSoft ?? this.acSoft, acLine: acLine ?? this.acLine,
    good: good, goodSoft: goodSoft, warn: warn, warnFill: warnFill, warnSoft: warnSoft,
    crit: crit, critFill: critFill, critSoft: critSoft, hatch: hatch, scrim: scrim, chart: chart ?? this.chart,
  );

  @override
  DsColors lerp(ThemeExtension<DsColors>? other, double t) {
    if (other is! DsColors) return this;
    Color l(Color a, Color b) => Color.lerp(a, b, t)!;
    return DsColors(
      canvas: l(canvas, other.canvas), bg: l(bg, other.bg), sf: l(sf, other.sf), sf2: l(sf2, other.sf2), sunk: l(sunk, other.sunk),
      ln: l(ln, other.ln), ln2: l(ln2, other.ln2), tx: l(tx, other.tx), tx2: l(tx2, other.tx2), tx3: l(tx3, other.tx3),
      ac: l(ac, other.ac), acTx: l(acTx, other.acTx), acSoft: l(acSoft, other.acSoft), acLine: l(acLine, other.acLine),
      good: l(good, other.good), goodSoft: l(goodSoft, other.goodSoft),
      warn: l(warn, other.warn), warnFill: l(warnFill, other.warnFill), warnSoft: l(warnSoft, other.warnSoft),
      crit: l(crit, other.crit), critFill: l(critFill, other.critFill), critSoft: l(critSoft, other.critSoft),
      hatch: l(hatch, other.hatch), scrim: l(scrim, other.scrim),
      chart: [for (var i = 0; i < chart.length; i++) l(chart[i], other.chart[i])],
    );
  }
}

/// Spacing, radii, durations.
abstract final class Ds {
  static const s2 = 2.0, s4 = 4.0, s6 = 6.0, s8 = 8.0, s10 = 10.0, s12 = 12.0, s14 = 14.0, s16 = 16.0, s20 = 20.0, s24 = 24.0, s32 = 32.0;
  static const rXs = 3.0, rSm = 6.0, rMd = 10.0, rLg = 12.0, rXl = 14.0, r2xl = 16.0, r3xl = 20.0;
  static const pagePadPhone = 16.0, pagePadTablet = 24.0, pagePadDesktop = 32.0;
  static const durFast = Duration(milliseconds: 120), dur = Duration(milliseconds: 200), durSlow = Duration(milliseconds: 280);
  static const ease = Cubic(.2, 0, 0, 1);
  static const tabular = [FontFeature.tabularFigures(), FontFeature.liningFigures()];
}

TextTheme dsTextTheme(Color tx, Color tx2) {
  const f = 'IBM Plex Sans';
  TextStyle s(double size, double lh, FontWeight w, {double em = 0, Color? c}) =>
      TextStyle(fontFamily: f, fontSize: size, height: lh / size, fontWeight: w, letterSpacing: em * size, color: c ?? tx);
  return TextTheme(
    displayLarge:  s(44, 52, FontWeight.w600, em: -0.02),   // hero money
    displayMedium: s(40, 48, FontWeight.w600, em: -0.02),
    displaySmall:  s(34, 40, FontWeight.w600, em: -0.02),   // big figure; phone hero
    headlineLarge: s(28, 34, FontWeight.w600, em: -0.02),
    headlineMedium:s(26, 32, FontWeight.w600, em: -0.02),
    headlineSmall: s(22, 28, FontWeight.w600),              // page title, stat value
    titleLarge:    s(19, 26, FontWeight.w600),              // dialog / recommendation
    titleMedium:   s(17, 24, FontWeight.w600),              // section header
    titleSmall:    s(15, 20, FontWeight.w600),              // card / row title
    bodyLarge:     s(15, 22, FontWeight.w400),
    bodyMedium:    s(14, 20, FontWeight.w400),
    bodySmall:     s(13, 18, FontWeight.w400, c: tx2),
    labelLarge:    s(15, 20, FontWeight.w600),              // buttons
    labelMedium:   s(12, 16, FontWeight.w600, em: 0.02, c: tx2), // field labels, eyebrows
    labelSmall:    s(11, 14, FontWeight.w600, c: tx2),
  );
}

ThemeData dsTheme(DsColors c, Brightness b) {
  final scheme = ColorScheme(
    brightness: b,
    primary: c.ac, onPrimary: c.acTx, primaryContainer: c.acSoft, onPrimaryContainer: c.ac,
    secondary: c.tx, onSecondary: c.bg, secondaryContainer: c.sunk, onSecondaryContainer: c.tx,
    tertiary: c.good, onTertiary: c.sf, tertiaryContainer: c.goodSoft, onTertiaryContainer: c.good,
    error: c.crit, onError: c.sf, errorContainer: c.critSoft, onErrorContainer: c.crit,
    surface: c.sf, onSurface: c.tx, onSurfaceVariant: c.tx2,
    surfaceContainerLowest: c.sf, surfaceContainerLow: c.sf2, surfaceContainer: c.sf2,
    surfaceContainerHigh: c.sf2, surfaceContainerHighest: c.sunk,
    outline: c.ln2, outlineVariant: c.ln,
    inverseSurface: c.tx, onInverseSurface: c.bg, inversePrimary: b == Brightness.light ? const Color(0xFF93A8FF) : const Color(0xFF2C4FCB),
    shadow: const Color(0xFF18191D), scrim: c.scrim, surfaceTint: Colors.transparent,
  );
  final text = dsTextTheme(c.tx, c.tx2);
  final r10 = BorderRadius.circular(Ds.rMd), r12 = BorderRadius.circular(Ds.rLg), r14 = BorderRadius.circular(Ds.rXl);
  OutlineInputBorder ob(Color col, double w) => OutlineInputBorder(borderRadius: r10, borderSide: BorderSide(color: col, width: w));

  return ThemeData(
    useMaterial3: true,
    brightness: b,
    colorScheme: scheme,
    scaffoldBackgroundColor: c.bg,
    canvasColor: c.bg,
    fontFamily: 'IBM Plex Sans',
    textTheme: text,
    extensions: [c],
    dividerTheme: DividerThemeData(color: c.ln, thickness: 1, space: 1),
    appBarTheme: AppBarTheme(backgroundColor: c.bg, foregroundColor: c.tx, elevation: 0, scrolledUnderElevation: 0,
        centerTitle: false, titleTextStyle: text.headlineSmall, shape: Border(bottom: BorderSide(color: c.ln))),
    cardTheme: CardThemeData(color: c.sf, elevation: 0, margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(borderRadius: r14, side: BorderSide(color: c.ln))),
    filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(
        backgroundColor: c.ac, foregroundColor: c.acTx, minimumSize: const Size(64, 48), padding: const EdgeInsets.symmetric(horizontal: 20),
        shape: RoundedRectangleBorder(borderRadius: r12), textStyle: text.labelLarge, elevation: 0)),
    outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(
        backgroundColor: c.sf, foregroundColor: c.tx, side: BorderSide(color: c.ln2), minimumSize: const Size(64, 48),
        padding: const EdgeInsets.symmetric(horizontal: 20), shape: RoundedRectangleBorder(borderRadius: r12), textStyle: text.labelLarge)),
    textButtonTheme: TextButtonThemeData(style: TextButton.styleFrom(
        foregroundColor: c.ac, minimumSize: const Size(48, 48), padding: const EdgeInsets.symmetric(horizontal: 16),
        shape: RoundedRectangleBorder(borderRadius: r12), textStyle: text.labelLarge)),
    iconButtonTheme: IconButtonThemeData(style: IconButton.styleFrom(foregroundColor: c.tx2, minimumSize: const Size(48, 48))),
    inputDecorationTheme: InputDecorationTheme(
      filled: true, fillColor: c.sf, isDense: false,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16), // 52 px with 15/22 text
      hintStyle: text.bodyLarge!.copyWith(color: c.tx3),
      labelStyle: text.labelMedium, floatingLabelBehavior: FloatingLabelBehavior.never,
      helperStyle: text.bodySmall!.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
      errorStyle: text.bodySmall!.copyWith(fontSize: 12, height: 16 / 12, color: c.crit),
      border: ob(c.ln2, 1), enabledBorder: ob(c.ln2, 1), focusedBorder: ob(c.ac, 2),
      errorBorder: ob(c.crit, 2), focusedErrorBorder: ob(c.crit, 2), disabledBorder: ob(c.ln, 1),
      suffixIconColor: c.tx2, prefixIconColor: c.tx3,
    ),
    chipTheme: ChipThemeData(
      backgroundColor: c.sf, selectedColor: c.tx, disabledColor: c.sunk,
      labelStyle: text.bodySmall!.copyWith(fontWeight: FontWeight.w500, color: c.tx),
      secondaryLabelStyle: text.bodySmall!.copyWith(fontWeight: FontWeight.w500, color: c.bg),
      side: BorderSide(color: c.ln2), shape: const StadiumBorder(), showCheckmark: true, checkmarkColor: c.bg,
      padding: const EdgeInsets.symmetric(horizontal: 6), labelPadding: const EdgeInsets.symmetric(horizontal: 8),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(style: SegmentedButton.styleFrom(
        backgroundColor: c.sunk, selectedBackgroundColor: c.sf, foregroundColor: c.tx2, selectedForegroundColor: c.tx,
        side: BorderSide.none, shape: RoundedRectangleBorder(borderRadius: r12))), // or the custom DsSegmented widget below
    switchTheme: SwitchThemeData(
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.ac : c.ln2),
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.acTx : c.sf),
      trackOutlineColor: const WidgetStatePropertyAll(Colors.transparent),
    ),
    checkboxTheme: CheckboxThemeData(
      fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? c.ac : c.sf),
      checkColor: WidgetStatePropertyAll(c.acTx), side: BorderSide(color: c.ln2, width: 1.5),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(6)),
    ),
    dialogTheme: DialogThemeData(backgroundColor: c.sf, elevation: 0, shadowColor: Colors.transparent, barrierColor: c.scrim,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.r3xl)), titleTextStyle: text.titleLarge,
        contentTextStyle: text.bodyLarge!.copyWith(color: c.tx2)),
    bottomSheetTheme: BottomSheetThemeData(backgroundColor: c.sf, modalBackgroundColor: c.sf, modalBarrierColor: c.scrim,
        showDragHandle: true, dragHandleColor: c.ln2, dragHandleSize: const Size(36, 4),
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)))),
    snackBarTheme: SnackBarThemeData(backgroundColor: c.tx, contentTextStyle: text.bodyMedium!.copyWith(color: c.bg),
        actionTextColor: c.bg, behavior: SnackBarBehavior.floating, shape: RoundedRectangleBorder(borderRadius: r12)),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.sf, indicatorColor: c.acSoft, height: 64, elevation: 0, surfaceTintColor: Colors.transparent,
      labelTextStyle: WidgetStateProperty.resolveWith((s) => text.labelMedium!.copyWith(letterSpacing: 0,
          color: s.contains(WidgetState.selected) ? c.ac : c.tx2)),
      iconTheme: WidgetStateProperty.resolveWith((s) => IconThemeData(size: 24, color: s.contains(WidgetState.selected) ? c.ac : c.tx2)),
    ),
    listTileTheme: ListTileThemeData(minVerticalPadding: 12, minTileHeight: 64, iconColor: c.tx2,
        titleTextStyle: text.titleSmall!.copyWith(fontWeight: FontWeight.w500), subtitleTextStyle: text.bodySmall!.copyWith(color: c.tx3)),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: c.ac, linearTrackColor: c.sunk, circularTrackColor: c.sunk,
        linearMinHeight: 6, borderRadius: BorderRadius.circular(3)),
    tooltipTheme: TooltipThemeData(decoration: BoxDecoration(color: c.tx, borderRadius: BorderRadius.circular(Ds.rMd)),
        textStyle: text.bodySmall!.copyWith(color: c.bg)),
    floatingActionButtonTheme: FloatingActionButtonThemeData(backgroundColor: c.ac, foregroundColor: c.acTx, elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.r2xl))),
  );
}

// Usage:
// theme: dsTheme(DsColors.light, Brightness.light), darkTheme: dsTheme(DsColors.dark, Brightness.dark), themeMode: ThemeMode.system
// Access: final c = Theme.of(context).extension<DsColors>()!;
// Money text: Text('−₹486', style: tt.bodyMedium!.copyWith(fontWeight: FontWeight.w600, color: c.moneyOut, fontFeatures: Ds.tabular))
```

Flutter widgets to write once and share (not stock Material):
- **`DsPaceBar`**: draw it with a `CustomPainter`. Track `sunk` with a radius of h/2; spent `tx`; promised hatch made of 2 px lines at 135°, every 6 px, in `hatch`; the today tick 2×(h+10) in `ac`; a label above.
- **`DsBadge(variant)`**: 24 h, radius 6.
- **`DsIconTile(tone, icon, size: 40)`**.
- **`DsSegmented`**: `sunk` track, radius 12, padding 4, with an `sf` thumb + small shadow that animates with `AnimatedAlign` (`Ds.dur`, `Ds.ease`).
- **`DsCardFace`**: §7.9.
- **`DsPasswordField`**: a `TextField` with `obscureText` and a `suffixIcon` `IconButton` (eye / eye-off, `tooltip` + `Semantics(label: 'Show password' / 'Hide password', toggled:)`). When revealed, it switches the style to `IBM Plex Mono`.
- **`DsMoney(amount, kind)`**: formats with Indian grouping (`NumberFormat.currency(locale: 'en_IN', symbol: '₹', decimalDigits: 0)`), adds the U+2212 or `+` sign, picks the colour per §3.2, and applies `Ds.tabular`.

### 9.5 Plain server-rendered HTML (Identity site)

No framework is needed: one stylesheet (§9.1 tokens + the classes below), Google Fonts `<link>`s, and about 15 lines of JavaScript for the theme and the password eye. Layout follows §6.2.

```html
<!doctype html>
<html lang="en-IN" data-theme="">  <!-- "", "light" or "dark"; empty = follow OS -->
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/static/ds.css">
  <title>Sign in · iBoon</title>
</head>
<body>
  <div class="auth">
    <section class="auth__brand" aria-label="About"> … logo, 40/48 headline, benefit rows with .icon-tile … </section>
    <main class="auth__form">
      <div class="auth__col">
        <form class="card card--auth" method="post">
          <h1 class="t-title-page">Sign in</h1>
          <p class="t-body-l tx2">Use your iBoon account.</p>
          <div class="field">
            <label class="label" for="email">Email</label>
            <input class="input" id="email" name="email" type="email" autocomplete="username" required>
          </div>
          <div class="field">
            <label class="label" for="pw">Password</label>
            <div class="pw">
              <input class="input" id="pw" name="password" type="password" autocomplete="current-password" required>
              <button class="pw__toggle" type="button" aria-label="Show password" aria-pressed="false" aria-controls="pw">
                <svg class="i-eye" …eye.svg…></svg><svg class="i-eye-off" hidden …eye-off.svg…></svg>
              </button>
            </div>
          </div>
          <button class="btn btn--primary btn--block btn--lg" type="submit">Sign in</button>
          <p class="t-caption tx3">By continuing you agree to the <a href="/terms">terms</a>.</p>
        </form>
        <!-- error: <div class="alert" role="alert">…</div> -->
      </div>
    </main>
  </div>
  <script>
    document.querySelectorAll('.pw__toggle').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = document.getElementById(b.getAttribute('aria-controls'));
        var show = i.type === 'password';
        i.type = show ? 'text' : 'password';
        i.classList.toggle('mono', show);
        b.setAttribute('aria-pressed', String(show));
        b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        b.querySelector('.i-eye').hidden = show; b.querySelector('.i-eye-off').hidden = !show;
      });
    });
  </script>
</body>
</html>
```

```css
/* ds.css: after the §9.1 token block */
.auth{display:flex;flex-wrap:wrap;min-height:100vh;background:var(--bg)}
.auth__brand{flex:1 1 520px;min-width:0;background:var(--sf2);border-right:1px solid var(--ln);padding:40px 48px;display:flex;flex-direction:column;gap:32px}
.auth__form{flex:1 1 480px;min-width:0;padding:40px 48px;display:flex;justify-content:center;align-items:center}
.auth__col{width:100%;max-width:440px;display:flex;flex-direction:column;gap:24px}
@media (max-width:599px){.auth__brand,.auth__form{padding:24px 16px}.auth__brand{border-right:0;border-bottom:1px solid var(--ln)}}
.card{background:var(--sf);border:1px solid var(--ln);border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:16px}
.card--auth{padding:32px;gap:20px}
@media (max-width:599px){.card--auth{padding:20px}}
.t-title-page{margin:0;font-size:22px;line-height:28px;font-weight:600}
.t-body-l{margin:0;font-size:15px;line-height:22px}
.t-caption{margin:0;font-size:12px;line-height:17px}
.tx2{color:var(--tx2)}.tx3{color:var(--tx3)}
.field{display:flex;flex-direction:column;gap:6px}
.label{font-size:12px;line-height:16px;font-weight:600;letter-spacing:.02em;color:var(--tx2)}
.input{width:100%;height:52px;border-radius:10px;border:1px solid var(--ln2);background:var(--sf);color:var(--tx);padding:0 14px;font:inherit;font-size:15px}
.input::placeholder{color:var(--tx3)}
.input:focus{outline:none;border:2px solid var(--ac);padding:0 13px}
.input[aria-invalid="true"]{border:2px solid var(--crit);padding:0 13px}
.help{margin:0;font-size:12px;line-height:16px;color:var(--tx3)}.help--error{color:var(--crit)}
.pw{position:relative}.pw .input{padding-right:52px}.pw .input:focus{padding-right:51px}
.pw__toggle{position:absolute;right:2px;top:2px;width:48px;height:48px;border:0;background:transparent;color:var(--tx2);border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 20px;border-radius:12px;border:0;font:inherit;font-size:15px;font-weight:600;cursor:pointer;transition:background var(--dur-fast) var(--ease)}
.btn--lg{min-height:52px}.btn--block{width:100%}
.btn--primary{background:var(--ac);color:var(--ac-tx)}.btn--primary:hover{background:color-mix(in srgb,var(--ac) 90%,var(--tx))}
.btn--secondary{background:var(--sf);color:var(--tx);border:1px solid var(--ln2)}.btn--secondary:hover{background:var(--sf2)}
.btn--ghost{background:transparent;color:var(--ac)}
.btn--danger{background:transparent;color:var(--crit);border:1px solid var(--crit-soft)}
.btn:disabled{background:var(--sunk);color:var(--tx3);border-color:transparent;cursor:not-allowed}
.alert{background:var(--crit-soft);border-radius:14px;padding:16px;display:flex;gap:12px;align-items:flex-start}
.alert__title{margin:0;font-size:15px;line-height:20px;font-weight:600;color:var(--crit)}
.notice{background:var(--sunk);border-radius:12px;padding:12px 14px;display:flex;gap:10px;font-size:13px;line-height:18px;color:var(--tx2)}
.icon-tile{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;background:var(--ac-soft);color:var(--ac)}
.badge{height:24px;border-radius:6px;padding:0 8px;display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600}
.badge--good{background:var(--good-soft);color:var(--good)}.badge--warn{background:var(--warn-soft);color:var(--warn)}
.badge--crit{background:var(--crit-soft);color:var(--crit)}.badge--ac{background:var(--ac-soft);color:var(--ac)}
.badge--neutral{background:var(--sunk);color:var(--tx2)}
```

## 10. Applying it to the other apps

**Shared across SpendLog, Trippin, InFrame and Identity (do not vary):**
- the neutrals (`canvas`, `bg`, `sf`, `sf2`, `sunk`, `ln`, `ln2`, `tx`, `tx2`, `tx3`, `hatch`) and the semantics (`good`, `warn`, `crit` with their fill and soft shades);
- the IBM Plex Sans and Mono type scale, tabular numbers, currency and date formats;
- spacing, radii, borders, elevation, motion, the focus ring;
- the icon set and stroke;
- every component's construction (heights, paddings, states), the flat-card rule, and ink-as-data;
- copy voice, the full-width layout, the sidebar / bottom-nav pattern, and light/dark/system behaviour;
- the logo construction: 28 px square, rx 8, accent fill, a 2.2-stroke round-cap glyph in `ac-tx`, and an 18/700 wordmark.

**What each app varies: only the accent quad** (`ac`, `ac-tx`, `ac-soft`, `ac-line`), its logo glyph, and chart slot `c1` (always equal to the app's accent).

All pairs below were checked: accent on `sf` ≥ 5.8:1, `ac-tx` on `ac` ≥ 5.8:1, accent on `ac-soft` ≥ 5.0:1.

| App | Character | Light `ac` / `ac-tx` / `ac-soft` / `ac-line` | Dark `ac` / `ac-tx` / `ac-soft` / `ac-line` | Notes |
|---|---|---|---|---|
| **SpendLog** | Cobalt: trust, ledgers (export) | `#2C4FCB` / `#FFFFFF` / `#E6EBFB` / `#B9C6F2` | `#93A8FF` / `#0D1430` / `#1D2544` / `#34407A` | As designed |
| **Trippin** | Ocean teal-blue: travel, sea (proposed) | `#0A6E86` / `#FFFFFF` / `#E0F1F5` / `#A9D6E1` | `#6CCBE3` / `#062029` / `#10282F` / `#1F4E5A` | 5.85:1 on white, 9.3:1 on dark `sf`. Because it sits near chart `c3` teal, **Trippin's charts swap `c3` to `#2C4FCB` cobalt**. Kept blue-leaning so it never reads as `good` green. |
| **InFrame** | Violet: creative, photo (proposed) | `#6A3FC4` / `#FFFFFF` / `#EEE8FB` / `#CFC0F1` | `#BBA4FF` / `#1C0F3D` / `#251D3D` / `#463878` | 6.7:1 on white, 8.1:1 on dark `sf`. The chart palette stays as is (rose `c4` is distinct enough). |
| **Identity** | Neutral ink: belongs to every app (proposed) | `#18191D` / `#FFFFFF` / `#ECE9E1` / `#C7C2B5` | `#EDEBE6` / `#111214` / `#202125` / `#3D3F46` | The sign-in is shared, so its default accent is the ink itself (a black primary button, ink links). When the sign-in is started *for* a specific app (e.g. `?client=trippin`), swap in that app's accent quad and logo so the hand-off feels continuous. |

Rules for any future app:
1. Pick a hue at least 30° away from cobalt, from green `good` (~150°), from the amber `warn` (~35°) and from the red `crit` (~5°).
2. The light accent needs ≥ 4.5:1 on `#FFFFFF` with white text.
3. The dark accent is a pastel ≥ 7:1 on `#1A1B1E` with a near-black same-hue `ac-tx`.
4. `ac-soft` is the accent at about 10–12 % over white (light) or a very dark same-hue tint (dark). `ac-line` is about 30 % over white, or a mid-dark tint.

Logo glyph concepts (proposed; keep the 28/rx 8/2.2 stroke construction):
- SpendLog: ledger lines + cursor;
- Trippin: a route line ending in a pin;
- InFrame: four frame corners;
- Identity: a keyhole.

## 11. Fonts

| Family | Weights | Google Fonts |
|---|---|---|
| IBM Plex Sans | 400, 500, 600, 700 | `https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap` |
| IBM Plex Mono | 400, 500 | `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap` |
| Both (as in the export) | | `https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap` |

- The export **inlines no font files**; it links Google Fonts with `preconnect` to `fonts.googleapis.com` and `fonts.gstatic.com`. So there are no extracted font files in `docs/design-assets/`.
- **Licence:** IBM Plex is released under the SIL Open Font License 1.1. It is free to bundle in apps and sites; keep the OFL text alongside bundled files.
- **Web / Identity:** the Google Fonts `<link>` above, or self-host via `@fontsource/ibm-plex-sans` + `@fontsource/ibm-plex-mono` (weights 400/500/600/700 and 400/500) for no third-party requests on the sign-in page. Self-hosting is recommended for Identity.
- **Flutter:** either the `google_fonts` package (`GoogleFonts.ibmPlexSans()`), or, recommended for offline Android, bundle the static TTFs (`IBMPlexSans-Regular/Medium/SemiBold/Bold.ttf`, `IBMPlexMono-Regular/Medium.ttf`, downloadable from Google Fonts or the IBM/plex GitHub releases) under `assets/fonts/` and declare them in `pubspec.yaml` as families `IBM Plex Sans` (weights 400/500/600/700) and `IBM Plex Mono` (400/500).
- **Fallbacks:** `system-ui, sans-serif` and `ui-monospace, monospace`. On Android without the bundled font, Roboto takes its place, so check tabular figures there.

## 12. Gaps: not in the export (decide in-app, using the proposals above)

- **No phone or tablet frames.** The phone layout, bottom navigation, bottom sheet, phone transaction row and FAB are all proposed (§6.3, §7.6, §7.7).
- **No motion**, and no hover or pressed states beyond `a:hover`. These are proposed in §5.5 and §7.1.
- **Switch off-state, checked custom checkbox, filled destructive button, toast placement** are proposed.
- **The dark chart palette is not re-tuned** in the export. Only the `c1` swap is proposed.
- **Card-network marks are text wordmarks**, not official logos. Bank and issuer logos are absent (gradients stand in).
- **No favicon or app-icon artwork** beyond the 28 px mark (a 1024 SVG of the mark is provided for generating launcher icons).
- **Only SpendLog's accent is defined.** Trippin, InFrame and Identity accents are proposals (§10).
