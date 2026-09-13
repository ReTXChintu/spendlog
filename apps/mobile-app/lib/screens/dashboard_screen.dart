import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/card_picker.dart';
import '../widgets/state_block.dart';
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

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final result = await ApiClient.instance.get('/dashboard');
      if (!mounted) return;
      setState(() {
        _data = DashboardData.fromJson(result as Map<String, dynamic>);
        _failed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
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

  @override
  Widget build(BuildContext context) {
    final c = context.c;

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

          _Heading(
            title: 'This month so far',
            sub: 'Day ${data.monthSoFar.dayOfMonth}, against the same point last month — not the whole '
                'of it, which would look like overspending every time.',
          ),
          const SizedBox(height: 10),
          _MonthSoFarBlock(month: data.monthSoFar),

          const SizedBox(height: 24),
          const _Heading(
            title: 'Which card today',
            sub: 'The card that gives you longest before the money actually has to leave.',
          ),
          const SizedBox(height: 12),
          CardPicker(picks: data.picks, onOpenAccounts: widget.onOpenSettings),

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

          if (data.owedBalanceMinor != 0) ...[
            const SizedBox(height: 12),
            _SummaryCard(
              label: 'Split bills',
              figure: formatMoney(data.owedBalanceMinor.abs()),
              sub: data.owedBalanceMinor > 0 ? 'owed to you' : 'you owe',
              colour: data.owedBalanceMinor > 0 ? c.credit : c.debit,
            ),
          ],
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
                commitment.name,
                style: TextStyle(
                  fontSize: 12.8,
                  color: commitment.isPaid ? c.mutedLight : c.ink70,
                  decoration: commitment.isPaid ? TextDecoration.lineThrough : null,
                ),
              ),
              secondary: Text(
                formatMoney(commitment.amountMinor),
                style: kNum.copyWith(fontSize: 12.8, color: c.ink70),
              ),
            ),
        ],
      ],
    );
  }
}

class _SummaryCard extends StatelessWidget {
  final String label;
  final String figure;
  final String sub;
  final Color? colour;

  const _SummaryCard({required this.label, required this.figure, required this.sub, this.colour});

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
            style: kNum.copyWith(fontSize: 20, fontWeight: FontWeight.w800, color: colour ?? c.ink),
          ),
          const SizedBox(height: 2),
          Text(sub, style: TextStyle(fontSize: 12, height: 1.45, color: c.muted)),
        ],
      ),
    );
  }
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
