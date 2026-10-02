import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../services/reminder_service.dart';
import '../widgets/card_limits.dart';
import '../widgets/card_picker.dart';
import '../widgets/commitment_amount.dart';
import '../widgets/daily_bucket.dart';
import '../widgets/home/earmarks_tile.dart';
import '../widgets/home/home_grid.dart';
import '../widgets/home/money_carousel.dart';
import '../widgets/home/plan_warnings.dart';
import '../widgets/loan_dialog.dart';
import '../widgets/state_block.dart';
import 'accounts_screen.dart';
import 'people_screen.dart';
import 'perks_screen.dart';

/// The Dashboard tab of Home: what you need to know now.
///
/// Everything here passes one test — could you act on it before putting the
/// phone away? A card near its limit changes which card comes out; a chart
/// of last March changes nothing, and lives on the Analytics tab.
///
/// Laid out as compact tiles two to a row, so a phone screen shows half a
/// dozen answers at once instead of two long cards.
///
/// One request draws the whole thing. Seven round trips over mobile data to
/// paint the screen you land on is the worst place to spend them.
class DashboardScreen extends StatefulWidget {
  final VoidCallback? onOpenTransactions;
  final VoidCallback? onOpenSettings;

  /// Opens the savings plan on the Analytics tab, from a plan warning.
  final VoidCallback? onOpenPlan;

  const DashboardScreen({super.key, this.onOpenTransactions, this.onOpenSettings, this.onOpenPlan});

  @override
  State<DashboardScreen> createState() => DashboardScreenState();
}

class DashboardScreenState extends State<DashboardScreen> with AutomaticKeepAliveClientMixin {
  DashboardData? _data;
  bool _failed = false;

  /// Who owes what, fetched on its own after the dashboard. It is one tile
  /// on this screen, and a slow or failed answer should cost that tile and
  /// nothing else.
  ContactBalance? _people;

  // Kept alive so swiping to Analytics and back does not refetch and lose
  // the scroll position.
  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final result = await ApiClient.instance.get('/dashboard');
      if (!mounted) return;
      final data = DashboardData.fromJson(result as Map<String, dynamic>);
      setState(() {
        _data = data;
        _failed = false;
      });

      // The follow-up reminders are armed and disarmed from here, because
      // this is where the count becomes known - every open and every pull
      // to refresh. Nothing waits on it.
      unawaited(ReminderService.instance.updateFollowUps(data.needsCategoryYesterday));
      unawaited(_loadPeople());
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _loadPeople() async {
    try {
      final json = await ApiClient.instance.get('/contacts') as Map<String, dynamic>;
      if (mounted) setState(() => _people = ContactBalance.fromJson(json));
    } catch (_) {
      // The tile falls back to the split-bill total from the dashboard.
    }
  }

  Future<void> _openPeople() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PeopleScreen()));
    await load();
  }

  Future<void> _openAccounts() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AccountsScreen()));
    await load();
  }

  Future<void> _togglePaid(FixedCommitment commitment, bool paid) async {
    await ApiClient.instance
        .post('/budget/commitments/${commitment.id}/paid', {'paid': paid})
        .catchError((_) => null);
    await load();
  }

  Future<void> _openPerks() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PerksScreen()));
    await load();
  }

  Future<void> _editLoan(Loan loan) async {
    if (await LoanDialog.show(context, loan: loan)) await load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);

    if (_failed) {
      return StateBlock(
        icon: Icons.wifi_off,
        title: "Couldn't reach the server",
        body: 'Nothing is lost — this screen is built from what the server already knows.',
        actionLabel: 'Try again',
        onAction: load,
      );
    }

    final data = _data;
    if (data == null) return const Center(child: CircularProgressIndicator());

    final pace = data.pace;

    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
        children: [
          // First on the screen because it is the thing you open the app
          // standing up to use. Everything else can wait for a scroll.
          _AskBar(onTap: _openPerks),
          const SizedBox(height: 16),

          _Todos(
            data: data,
            onOpenTransactions: widget.onOpenTransactions,
            onOpenSettings: widget.onOpenSettings,
            onOpenPerks: _openPerks,
          ),

          // Above the money, because a broken rule is the one thing here
          // meant to change what you do next.
          PlanWarnings(warnings: data.planWarnings, onOpenPlan: widget.onOpenPlan ?? () {}),

          MoneyCarousel(money: data.money, cards: data.cards, onOpenAccounts: _openAccounts),

          // Three groups, in the order the questions come. Today: what can
          // I spend and which card. Cards: where each one stands. This
          // month: how the month is going.
          const _Group('Today'),
          HomeGrid(items: [
            if (data.daily.configured)
              GridItem(HomeTile(
                label: 'Daily budget',
                icon: Icons.today_outlined,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    DailyBucket(daily: data.daily, framed: false),
                    const SizedBox(height: 6),
                    Text(
                      '${formatMoneyShort(data.daily.dailyBudgetMinor)} a day',
                      style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: context.c.muted),
                    ),
                  ],
                ),
              )),
            if (data.earmarks.count > 0) GridItem(EarmarksTile(earmarks: data.earmarks)),
            GridItem(
              HomeTile(
                label: 'Which card today',
                icon: Icons.credit_score_outlined,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'The card that gives you longest before the money actually has to leave.',
                      style: TextStyle(fontSize: 11.5, height: 1.4, color: context.c.muted),
                    ),
                    const SizedBox(height: 10),
                    CardPicker(picks: data.picks, onOpenAccounts: widget.onOpenSettings),
                  ],
                ),
              ),
              span: 2,
            ),
          ]),

          if (data.cards.isNotEmpty) ...[
            const _Group('Cards'),
            _Heading(title: 'Where the cards stand', sub: _cardsSub(data.cards)),
            const SizedBox(height: 12),
            CardLimits(cards: data.cards, onOpenAccounts: widget.onOpenSettings),
          ],

          const _Group('This month'),
          HomeGrid(items: [
            GridItem(_SoFarTile(month: data.monthSoFar)),
            GridItem(_PaceTile(pace: pace, onOpenSettings: widget.onOpenSettings)),
            if (pace.configured && pace.commitments.isNotEmpty)
              GridItem(_FixedCostsTile(pace: pace, onTogglePaid: _togglePaid), span: 2),
            if (data.emiCount > 0)
              GridItem(HomeTile(
                label: 'EMIs running',
                icon: Icons.event_repeat_outlined,
                child: _TileBody(
                  figure: formatMoney(data.emiMonthlyMinor),
                  sub: 'a month across ${data.emiCount == 1 ? 'one plan' : '${data.emiCount} plans'} · '
                      '${formatMoneyShort(data.emiRemainingMinor)} still to pay',
                ),
              )),
            // Always here, since it is the way in to People: the question
            // "who still owes me for that dinner" has nowhere else to go.
            GridItem(_PeopleTile(people: _people, splitBalanceMinor: data.owedBalanceMinor, onTap: _openPeople)),
            if (data.loans.isEmpty && data.loanCount > 0)
              GridItem(HomeTile(
                label: 'Loans',
                icon: Icons.account_balance_outlined,
                child: _TileBody(
                  figure: formatMoney(data.loanMonthlyMinor),
                  sub: 'a month across ${data.loanCount == 1 ? 'one loan' : '${data.loanCount} loans'} · '
                      '${formatMoneyShort(data.loanRemainingMinor)} still to repay',
                ),
              )),
          ]),

          // Each loan by name, rather than one total: when is the next one
          // and how much is a today question.
          if (data.loans.isNotEmpty) ...[
            const _Group('Loans'),
            _Heading(
              title: '${formatMoney(data.loanMonthlyMinor)} a month',
              sub: '${formatMoneyShort(data.loanRemainingMinor)} still to repay across '
                  '${data.loanCount == 1 ? 'one loan' : '${data.loanCount} loans'}. Tap one to change it.',
            ),
            const SizedBox(height: 12),
            HomeGrid(items: [
              for (final loan in data.loans) GridItem(_LoanTile(loan: loan, onTap: () => _editLoan(loan))),
            ]),
          ],
        ],
      ),
    );
  }
}

/// A label between runs of sections: Today, Cards, This month. So figures
/// on different timescales stop reading as one list.
class _Group extends StatelessWidget {
  const _Group(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.only(top: 26, bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 1.1, color: c.muted),
          ),
          const SizedBox(height: 6),
          Divider(height: 1, color: c.line),
        ],
      ),
    );
  }
}

/// The way into the perk lookup, made to look like what it is: a question.
class _AskBar extends StatelessWidget {
  final VoidCallback onTap;

  const _AskBar({required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(T.rMd),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        decoration: BoxDecoration(color: c.brand50, borderRadius: BorderRadius.circular(T.rMd)),
        child: Row(
          children: [
            Icon(Icons.local_offer_outlined, size: 19, color: c.brandDark),
            const SizedBox(width: 11),
            Expanded(
              child: Text(
                'Where are you? Check for a coupon or cashback',
                style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: c.brandDark),
              ),
            ),
            Icon(Icons.chevron_right, size: 19, color: c.brandDark),
          ],
        ),
      ),
    );
  }
}

/// The jobs, across the top.
///
/// Renders nothing when there is nothing to do — a row that is always on
/// screen stops being read, and then so does the real one.
class _Todos extends StatelessWidget {
  final DashboardData data;
  final VoidCallback? onOpenTransactions;
  final VoidCallback? onOpenSettings;
  final VoidCallback onOpenPerks;

  const _Todos({
    required this.data,
    this.onOpenTransactions,
    this.onOpenSettings,
    required this.onOpenPerks,
  });

  @override
  Widget build(BuildContext context) {
    final jobs = <({IconData icon, String text, bool urgent, VoidCallback? onTap})>[];

    if (data.needsCategoryYesterday > 0) {
      final count = data.needsCategoryYesterday;
      jobs.add((
        icon: Icons.help_outline,
        text: '$count from yesterday ${count == 1 ? 'needs' : 'need'} a category',
        urgent: true,
        onTap: onOpenTransactions,
      ));
    } else if (data.needsCategoryMonth > 0) {
      final count = data.needsCategoryMonth;
      jobs.add((
        icon: Icons.help_outline,
        text: '$count this month still ${count == 1 ? 'needs' : 'need'} a category',
        urgent: false,
        onTap: onOpenTransactions,
      ));
    }

    for (final bill in data.bills) {
      jobs.add((
        icon: Icons.account_balance_wallet_outlined,
        text: '${bill.cardName} bill ${formatMoney(bill.totalDueMinor)}${bill.whenDue}',
        urgent: (bill.daysUntilDue ?? 99) <= 3,
        onTap: onOpenTransactions,
      ));
    }

    if (data.stuckStatements.isNotEmpty) {
      final count = data.stuckStatements.length;
      jobs.add((
        icon: Icons.error_outline,
        text: '$count ${count == 1 ? 'statement' : 'statements'} could not be read',
        urgent: true,
        onTap: onOpenSettings,
      ));
    }

    if (data.expiringPerks.isNotEmpty) {
      final count = data.expiringPerks.length;
      jobs.add((
        icon: Icons.local_offer_outlined,
        text: '$count ${count == 1 ? 'perk' : 'perks'} expiring soon',
        urgent: false,
        onTap: onOpenPerks,
      ));
    }

    if (jobs.isEmpty) return const SizedBox.shrink();

    final c = context.c;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        children: [
          for (final job in jobs)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: InkWell(
                onTap: job.onTap,
                borderRadius: BorderRadius.circular(T.rSm),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
                  decoration: BoxDecoration(
                    color: job.urgent ? c.warnBg : c.chipNeutral,
                    borderRadius: BorderRadius.circular(T.rSm),
                  ),
                  child: Row(
                    children: [
                      Icon(job.icon, size: 16, color: job.urgent ? c.warn : c.muted),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          job.text,
                          style: TextStyle(
                            fontSize: 12.8,
                            fontWeight: FontWeight.w600,
                            color: job.urgent ? c.warn : c.ink70,
                          ),
                        ),
                      ),
                      Icon(Icons.chevron_right, size: 16, color: job.urgent ? c.warn : c.mutedLight),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A figure and a line under it: the body of most tiles.
class _TileBody extends StatelessWidget {
  const _TileBody({required this.figure, required this.sub, this.colour});

  final String figure;
  final String sub;
  final Color? colour;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TileFigure(figure, color: colour),
        const SizedBox(height: 4),
        Text(sub, style: TextStyle(fontSize: 11.5, height: 1.4, color: context.c.muted)),
      ],
    );
  }
}

/// Spent so far against the same point last month - not the whole of last
/// month, which would look like overspending every time.
class _SoFarTile extends StatelessWidget {
  final MonthSoFar month;

  const _SoFarTile({required this.month});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final change = month.changeMinor;
    final colour = change > 0 ? c.debit : (change < 0 ? c.credit : c.muted);

    return HomeTile(
      label: 'So far',
      icon: Icons.calendar_month_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TileFigure(formatMoney(month.spentMinor)),
          const SizedBox(height: 5),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: Icon(
                  change > 0 ? Icons.arrow_upward : (change < 0 ? Icons.arrow_downward : Icons.remove),
                  size: 13,
                  color: colour,
                ),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  change == 0
                      ? 'Level with this point last month'
                      : '${formatMoneyShort(change.abs())} ${change > 0 ? 'more' : 'less'} than this point '
                          'last month',
                  style: TextStyle(fontSize: 11.5, height: 1.35, fontWeight: FontWeight.w600, color: colour),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          // "Your month", not the calendar's: with a salary day set it runs
          // pay day to pay day, and day 1 is the pay day.
          Text(
            month.label.isEmpty
                ? 'Day ${month.dayOfMonth} of your month'
                : 'Day ${month.dayOfMonth} · ${month.label}',
            style: TextStyle(fontSize: 11, color: c.mutedLight),
          ),
        ],
      ),
    );
  }
}

/// How much is left until the salary and what that allows a day.
class _PaceTile extends StatelessWidget {
  final BudgetPace pace;
  final VoidCallback? onOpenSettings;

  const _PaceTile({required this.pace, this.onOpenSettings});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    if (!pace.configured) {
      return HomeTile(
        label: 'Spending pace',
        icon: Icons.speed_outlined,
        onTap: onOpenSettings,
        child: Text(
          'Tell SpendLog what lands each month and when, and it can say how much a day is left. '
          'Set it under Settings.',
          style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
        ),
      );
    }

    final (background, foreground) = switch (pace.state) {
      'over' => (c.debit50, c.debit),
      'watch' => (c.warnBg, c.warn),
      _ => (null, c.brandDark),
    };

    return HomeTile(
      label: 'Spending pace',
      icon: Icons.speed_outlined,
      background: background,
      accent: background == null ? null : foreground,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TileFigure(formatMoneyShort(pace.remainingMinor)),
          Text(
            'left · ${pace.daysLeft} ${pace.daysLeft == 1 ? 'day' : 'days'} to salary',
            style: TextStyle(fontSize: 11.5, color: c.muted),
          ),
          const SizedBox(height: 8),
          Text.rich(
            TextSpan(children: [
              TextSpan(
                text: formatMoneyShort(pace.perDayMinor),
                style: kNum.copyWith(fontWeight: FontWeight.w800, color: c.ink),
              ),
              const TextSpan(text: ' a day from here'),
            ]),
            style: TextStyle(fontSize: 12, color: c.ink70),
          ),
          Text.rich(
            TextSpan(children: [
              const TextSpan(text: 'Lately '),
              TextSpan(
                text: formatMoneyShort(pace.recentPerDayMinor),
                style: kNum.copyWith(fontWeight: FontWeight.w700, color: c.ink70),
              ),
              const TextSpan(text: ' a day'),
            ]),
            style: TextStyle(fontSize: 12, color: c.muted),
          ),
          if (pace.state != 'ok') ...[
            const SizedBox(height: 6),
            Text(
              pace.state == 'over'
                  ? "Past this period's salary. Anything more comes out of something else."
                  : "At last week's pace this runs dry before payday.",
              style: TextStyle(fontSize: 11.5, height: 1.4, color: foreground),
            ),
          ],
          // Sending less than usual is worth a sentence rather than a
          // silently unticked box.
          if (pace.shortfallNote != null) ...[
            const SizedBox(height: 6),
            Text(pace.shortfallNote!, style: TextStyle(fontSize: 11.5, height: 1.4, color: foreground)),
          ],
          const SizedBox(height: 6),
          // Where the figure came from, said plainly rather than left to be
          // guessed from a number that moves when a month has leave in it.
          Text(
            pace.salaryIsActual
                ? 'From the ${formatMoneyShort(pace.salaryMinor)} that landed.'
                : 'From the salary in Settings - tick the credit as salary to use what arrived.',
            style: TextStyle(fontSize: 10.5, height: 1.35, color: pace.salaryIsActual ? c.mutedLight : c.warn),
          ),
        ],
      ),
    );
  }
}

/// The fixed costs as a checklist, ticked off as they go out.
class _FixedCostsTile extends StatelessWidget {
  final BudgetPace pace;
  final Future<void> Function(FixedCommitment, bool) onTogglePaid;

  const _FixedCostsTile({required this.pace, required this.onTogglePaid});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return HomeTile(
      label: pace.commitmentsRemainingMinor > 0
          ? 'Fixed each month · ${formatMoneyShort(pace.commitmentsRemainingMinor)} still to go out'
          : 'Fixed each month',
      icon: Icons.checklist_outlined,
      child: Column(
        children: [
          for (final commitment in pace.commitments)
            CheckboxListTile(
              value: commitment.isPaid,
              onChanged: (value) => onTogglePaid(commitment, value ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              visualDensity: VisualDensity.compact,
              title: Text(
                commitment.isPartial
                    ? '${commitment.name}  ·  ${formatMoneyShort(commitment.shortfallMinor)} short'
                    : commitment.name,
                style: TextStyle(
                  fontSize: 12.8,
                  color: commitment.isPaid ? c.mutedLight : (commitment.isPartial ? c.warn : c.ink70),
                  decoration: commitment.isPaid ? TextDecoration.lineThrough : null,
                ),
              ),
              // Partly paid is measured against this period's figure: a
              // raise agreed after the rent went out does not make that
              // rent short.
              secondary: commitment.isPartial
                  ? Text(
                      '${formatMoneyShort(commitment.paidMinor)}/'
                      '${formatMoneyShort(commitment.thisPeriodAmountMinor)}',
                      style: kNum.copyWith(fontSize: 12.8, color: c.ink70),
                    )
                  : CommitmentAmount(commitment: commitment),
            ),
        ],
      ),
    );
  }
}

/// Who owes what, by person, as one tappable tile.
class _PeopleTile extends StatelessWidget {
  final ContactBalance? people;

  /// The dashboard's own split-bill balance, for before anyone has been
  /// named on a bill - or when the people list could not be fetched.
  final int splitBalanceMinor;
  final VoidCallback onTap;

  const _PeopleTile({required this.people, required this.splitBalanceMinor, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final owed = people?.owedToYouMinor ?? 0;
    final owe = people?.youOweMinor ?? 0;

    final String figure;
    final String sub;
    Color? colour;
    if (owed > 0) {
      figure = formatMoney(owed);
      colour = c.credit;
      sub = owe > 0 ? 'owed to you · you owe ${formatMoney(owe)}' : 'owed to you';
    } else if (owe > 0) {
      figure = formatMoney(owe);
      colour = c.debit;
      sub = 'you owe';
    } else if (splitBalanceMinor != 0) {
      figure = formatMoney(splitBalanceMinor.abs());
      colour = splitBalanceMinor > 0 ? c.credit : c.debit;
      sub = '${splitBalanceMinor > 0 ? 'owed to you' : 'you owe'} on split bills - say who, on each one';
    } else {
      figure = '';
      sub = 'Money lent and bills split, kept by person.';
    }

    return HomeTile(
      label: 'People',
      icon: Icons.people_outline,
      onTap: onTap,
      child: figure.isEmpty
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Who owes what', style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink)),
                const SizedBox(height: 4),
                Text(sub, style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted)),
              ],
            )
          : _TileBody(figure: figure, sub: sub, colour: colour),
    );
  }
}

/// One loan: how far through it is, and what comes out next and when.
class _LoanTile extends StatelessWidget {
  final Loan loan;
  final VoidCallback onTap;

  const _LoanTile({required this.loan, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final progress = loan.months > 0 ? (loan.paidCount / loan.months).clamp(0.0, 1.0) : 0.0;
    final next = loan.nextDue;

    // Past its date and still not marked: either it was missed, or it was
    // paid and never matched. Worth a different colour either way.
    final overdue = next != null &&
        istWallClock(next.dueDate).toIso8601String().substring(0, 10).compareTo(istToday()) < 0;

    return HomeTile(
      label: loan.label,
      icon: Icons.account_balance_outlined,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TileFigure(formatMoney(loan.monthlyAmountMinor), size: 19),
          Text('a month', style: TextStyle(fontSize: 11.5, color: c.muted)),
          const SizedBox(height: 8),
          ClipRRect(
            borderRadius: BorderRadius.circular(100),
            child: LinearProgressIndicator(
              value: progress,
              minHeight: 5,
              backgroundColor: c.track,
              valueColor: AlwaysStoppedAnimation(c.brand),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            '${loan.paidCount} of ${loan.months} paid · ${formatMoneyShort(loan.remainingMinor)} left',
            style: TextStyle(fontSize: 11.5, color: c.muted),
          ),
          if (next != null)
            Text(
              overdue
                  ? '${formatMoneyShort(next.amountMinor)} was due ${formatShortDate(next.dueDate)}'
                  : 'Next ${formatMoneyShort(next.amountMinor)} on ${formatShortDate(next.dueDate)}',
              style: TextStyle(
                fontSize: 11.5,
                fontWeight: overdue ? FontWeight.w700 : FontWeight.w600,
                color: overdue ? c.warn : c.ink70,
              ),
            ),
        ],
      ),
    );
  }
}

/// What the card bars are saying at a glance, before any of them is read.
String _cardsSub(List<CardStatus> cards) {
  final over = cards.where((card) => card.limitMinor != null && card.spentMinor > card.limitMinor!);

  if (over.isEmpty) {
    return 'Spending this cycle against what the bank allows, with your own limit marked.';
  }
  return over.length == 1
      ? '${over.first.name} is past what you meant to spend this month.'
      : '${over.length} cards are past what you meant to spend this month.';
}

class _Heading extends StatelessWidget {
  final String title;
  final String sub;

  const _Heading({required this.title, required this.sub});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: c.ink)),
        const SizedBox(height: 3),
        Text(sub, style: TextStyle(fontSize: 12, height: 1.45, color: c.muted)),
      ],
    );
  }
}
