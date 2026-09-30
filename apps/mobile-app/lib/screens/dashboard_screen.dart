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
import '../widgets/loan_dialog.dart';
import '../widgets/state_block.dart';
import 'people_screen.dart';
import 'perks_screen.dart';

/// The landing screen: what you need to know now.
///
/// Everything here passes one test — could you act on it before putting the
/// phone away? A card near its limit changes which card comes out; a chart
/// of last March changes nothing, and lives on the analytics screen.
///
/// One request draws the whole thing. Seven round trips over mobile data to
/// paint the screen you land on is the worst place to spend them.
class DashboardScreen extends StatefulWidget {
  final VoidCallback? onOpenTransactions;
  final VoidCallback? onOpenSettings;

  const DashboardScreen({super.key, this.onOpenTransactions, this.onOpenSettings});

  @override
  State<DashboardScreen> createState() => DashboardScreenState();
}

class DashboardScreenState extends State<DashboardScreen> {
  DashboardData? _data;
  bool _failed = false;

  /// Who owes what, fetched on its own after the dashboard. It is one line
  /// on this screen, and a slow or failed answer should cost that line and
  /// nothing else.
  ContactBalance? _people;

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
      // The card falls back to the split-bill total from the dashboard.
    }
  }

  Future<void> _openPeople() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PeopleScreen()));
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

          // Three groups, in the order the questions come. Today: what can
          // I spend and which card. Cards: where each one stands. This
          // month: how the month is going. It was one long run of sections
          // and the figures for different timescales sat next to each other
          // as though they were comparable.
          const _Group('Today'),

          if (data.daily.configured) ...[
            _Heading(
              title: 'Daily budget',
              sub: '${formatMoney(data.daily.dailyBudgetMinor)} a day.',
            ),
            const SizedBox(height: 12),
            DailyBucket(daily: data.daily),
            const SizedBox(height: 24),
          ],

          const _Heading(
            title: 'Which card today',
            sub: 'The card that gives you longest before the money actually has to leave.',
          ),
          const SizedBox(height: 12),
          CardPicker(picks: data.picks, onOpenAccounts: widget.onOpenSettings),

          if (data.cards.isNotEmpty) ...[
            const _Group('Cards'),
            _Heading(
              title: 'Where the cards stand',
              sub: _cardsSub(data.cards),
            ),
            const SizedBox(height: 12),
            CardLimits(cards: data.cards, onOpenAccounts: widget.onOpenSettings),
          ],

          const _Group('This month'),

          _Heading(
            title: 'So far',
            sub: 'Day ${data.monthSoFar.dayOfMonth}, against the same point last month — not the whole '
                'of it, which would look like overspending every time.',
          ),
          const SizedBox(height: 10),
          _MonthSoFarBlock(month: data.monthSoFar),

          const SizedBox(height: 24),
          if (data.pace.configured) ...[
            _Heading(
              title: 'Spending pace',
              sub: '${data.pace.daysLeft} ${data.pace.daysLeft == 1 ? 'day' : 'days'} until the next salary.',
            ),
            const SizedBox(height: 12),
            _PaceBlock(pace: data.pace, onTogglePaid: _togglePaid),
          ] else
            const _Heading(
              title: 'Spending pace',
              sub: 'Tell SpendLog what lands each month and when, and it can say how much a day is left. '
                  'Set it under Settings.',
            ),

          if (data.emiCount > 0) ...[
            const SizedBox(height: 24),
            _SummaryCard(
              label: 'EMIs running',
              figure: formatMoney(data.emiMonthlyMinor),
              sub: 'a month across ${data.emiCount == 1 ? 'one plan' : '${data.emiCount} plans'} · '
                  '${formatMoneyShort(data.emiRemainingMinor)} still to pay',
            ),
          ],

          // Always here, since it is the way in to People: the question
          // "who still owes me for that dinner" has nowhere else to go.
          SizedBox(height: data.emiCount > 0 ? 12 : 24),
          _PeopleCard(people: _people, splitBalanceMinor: data.owedBalanceMinor, onTap: _openPeople),

          // Each loan by name, rather than one total. A loan was otherwise
          // only ever seen in Settings, and the question it raises - when
          // is the next one and how much - is a today question.
          if (data.loans.isNotEmpty) ...[
            const _Group('Loans'),
            _Heading(
              title: '${formatMoney(data.loanMonthlyMinor)} a month',
              sub: '${formatMoneyShort(data.loanRemainingMinor)} still to repay across '
                  '${data.loanCount == 1 ? 'one loan' : '${data.loanCount} loans'}. Tap one to change it.',
            ),
            const SizedBox(height: 12),
            for (final loan in data.loans) _LoanRow(loan: loan, onTap: () => _editLoan(loan)),
          ] else if (data.loanCount > 0) ...[
            const SizedBox(height: 12),
            _SummaryCard(
              label: 'Loans',
              figure: formatMoney(data.loanMonthlyMinor),
              sub: 'a month across ${data.loanCount == 1 ? 'one loan' : '${data.loanCount} loans'} · '
                  '${formatMoneyShort(data.loanRemainingMinor)} still to repay',
            ),
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
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.1,
              color: c.muted,
            ),
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
        decoration: BoxDecoration(
          color: c.brand50,
          borderRadius: BorderRadius.circular(T.rMd),
        ),
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
      padding: const EdgeInsets.only(bottom: 20),
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

class _MonthSoFarBlock extends StatelessWidget {
  final MonthSoFar month;

  const _MonthSoFarBlock({required this.month});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final change = month.changeMinor;
    final colour = change > 0 ? c.debit : (change < 0 ? c.credit : c.muted);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          formatMoney(month.spentMinor),
          style: kNum.copyWith(fontSize: 29, fontWeight: FontWeight.w800, color: c.ink),
        ),
        const SizedBox(height: 5),
        Row(
          children: [
            Icon(
              change > 0 ? Icons.arrow_upward : (change < 0 ? Icons.arrow_downward : Icons.remove),
              size: 14,
              color: colour,
            ),
            const SizedBox(width: 5),
            Flexible(
              child: Text(
                change == 0
                    ? 'Level with last month'
                    : '${formatMoneyShort(change.abs())} ${change > 0 ? 'more' : 'less'} than last month',
                style: TextStyle(fontSize: 12.8, fontWeight: FontWeight.w600, color: colour),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _PaceBlock extends StatelessWidget {
  final BudgetPace pace;
  final Future<void> Function(FixedCommitment, bool) onTogglePaid;

  const _PaceBlock({required this.pace, required this.onTogglePaid});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (background, foreground) = switch (pace.state) {
      'over' => (c.debit50, c.debit),
      'watch' => (c.warnBg, c.warn),
      _ => (c.brand50, c.brandDark),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(T.rMd)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _Figure(label: 'Left', value: formatMoneyShort(pace.remainingMinor)),
                  _Figure(label: 'A day from here', value: formatMoneyShort(pace.perDayMinor)),
                  _Figure(label: 'Lately', value: formatMoneyShort(pace.recentPerDayMinor)),
                ],
              ),
              const SizedBox(height: 10),
              // Where the figure came from, said plainly rather than left
              // to be guessed from a number that moves when a month has
              // leave taken in it.
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    pace.salaryIsActual ? Icons.check_circle_outline : Icons.info_outline,
                    size: 13,
                    color: pace.salaryIsActual ? c.muted : c.warn,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      pace.salaryIsActual
                          ? 'Built on the ${formatMoney(pace.salaryMinor)} that actually landed.'
                          : 'Built on the salary in Settings. Tick the credit on your ledger as '
                              'salary and this uses what really arrived.',
                      style: TextStyle(
                        fontSize: 11.5,
                        height: 1.4,
                        color: pace.salaryIsActual ? c.muted : c.warn,
                      ),
                    ),
                  ),
                ],
              ),
              // Sending less than usual is worth a sentence rather than a
              // silently unticked box.
              if (pace.shortfallNote != null) ...[
                const SizedBox(height: 10),
                Text(
                  pace.shortfallNote!,
                  style: TextStyle(fontSize: 12, height: 1.45, color: foreground),
                ),
              ],
              if (pace.state != 'ok') ...[
                const SizedBox(height: 10),
                Text(
                  pace.state == 'over'
                      ? 'Past the salary for this period. Anything more comes out of something else.'
                      : "Carrying on at the last week's pace would run this period dry before payday.",
                  style: TextStyle(fontSize: 12, height: 1.45, color: foreground),
                ),
              ],
            ],
          ),
        ),
        if (pace.commitments.isNotEmpty) ...[
          const SizedBox(height: 14),
          Text(
            pace.commitmentsRemainingMinor > 0
                ? 'FIXED EACH MONTH · ${formatMoneyShort(pace.commitmentsRemainingMinor)} STILL TO GO OUT'
                : 'FIXED EACH MONTH',
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
              color: c.muted,
            ),
          ),
          for (final commitment in pace.commitments)
            CheckboxListTile(
              value: commitment.isPaid,
              onChanged: (value) => onTogglePaid(commitment, value ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              title: Text(
                commitment.isPartial
                    ? '${commitment.name}  ·  ${formatMoneyShort(commitment.shortfallMinor)} short'
                    : commitment.name,
                style: TextStyle(
                  fontSize: 12.8,
                  color: commitment.isPaid
                      ? c.mutedLight
                      : (commitment.isPartial ? c.warn : c.ink70),
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
      ],
    );
  }
}

/// Who owes what, by person, as one tappable line.
class _PeopleCard extends StatelessWidget {
  final ContactBalance? people;

  /// The dashboard's own split-bill balance, for before anyone has been
  /// named on a bill - or when the people list could not be fetched.
  final int splitBalanceMinor;
  final VoidCallback onTap;

  const _PeopleCard({required this.people, required this.splitBalanceMinor, required this.onTap});

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
      figure = 'Who owes what';
      sub = 'Money lent and bills split, kept by person.';
    }

    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(T.rMd),
      child: Ink(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: c.surface,
          border: Border.all(color: c.line),
          borderRadius: BorderRadius.circular(T.rMd),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'PEOPLE',
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.5,
                      color: c.muted,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    figure,
                    style: colour == null
                        ? TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink)
                        : kNum.copyWith(fontSize: 20, fontWeight: FontWeight.w800, color: colour),
                  ),
                  const SizedBox(height: 2),
                  Text(sub, style: TextStyle(fontSize: 12, height: 1.45, color: c.muted)),
                ],
              ),
            ),
            Icon(Icons.chevron_right, color: c.mutedLight),
          ],
        ),
      ),
    );
  }
}

class _SummaryCard extends StatelessWidget {
  final String label;
  final String figure;
  final String sub;

  const _SummaryCard({required this.label, required this.figure, required this.sub});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label.toUpperCase(),
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
              color: c.muted,
            ),
          ),
          const SizedBox(height: 5),
          Text(
            figure,
            style: kNum.copyWith(fontSize: 20, fontWeight: FontWeight.w800, color: c.ink),
          ),
          const SizedBox(height: 2),
          Text(sub, style: TextStyle(fontSize: 12, height: 1.45, color: c.muted)),
        ],
      ),
    );
  }
}

/// One loan: how far through it is, and what comes out next and when.
class _LoanRow extends StatelessWidget {
  final Loan loan;
  final VoidCallback onTap;

  const _LoanRow({required this.loan, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final progress = loan.months > 0 ? (loan.paidCount / loan.months).clamp(0.0, 1.0) : 0.0;
    final next = loan.nextDue;

    // Past its date and still not marked: either it was missed, or it was
    // paid and never matched. Worth a different colour either way.
    final overdue = next != null &&
        istWallClock(next.dueDate).toIso8601String().substring(0, 10).compareTo(istToday()) < 0;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(T.rMd),
        child: Ink(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
          decoration: BoxDecoration(
            color: c.surface,
            border: Border.all(color: c.line),
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      loan.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Text(formatMoney(loan.monthlyAmountMinor), style: kNum.copyWith(fontSize: 13.5)),
                  const SizedBox(width: 4),
                  Text('a month', style: TextStyle(fontSize: 11.5, color: c.muted)),
                ],
              ),
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
              Wrap(
                spacing: 10,
                runSpacing: 2,
                children: [
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
            ],
          ),
        ),
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

class _Figure extends StatelessWidget {
  final String label;
  final String value;

  const _Figure({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: c.muted)),
        const SizedBox(height: 2),
        Text(value, style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink)),
      ],
    );
  }
}
