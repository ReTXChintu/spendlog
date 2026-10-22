import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/subscription_models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/ds/ds.dart';
import '../widgets/state_block.dart';
import '../widgets/subscription_sheet.dart';
import 'subscription_detail_screen.dart';

/// Everything that renews, in one place: what it all comes to a month and
/// a year, what renews this month, the ones that need a look, and three
/// ways through the list - by next renewal, on a calendar, by the card
/// they go out on. Below, the repeating charges that look like
/// subscriptions nobody is tracking yet.
class SubscriptionsScreen extends StatefulWidget {
  const SubscriptionsScreen({super.key});

  static Future<void> open(BuildContext context) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => const SubscriptionsScreen()));

  @override
  State<SubscriptionsScreen> createState() => _SubscriptionsScreenState();
}

enum _View { list, calendar, byCard }

/// "Renews in 5 days", "Due 3 days ago", "Paused".
String renewalWords(Subscription sub) {
  if (sub.status == 'paused') return 'Paused${sub.pausedOn != null ? ' since ${dayWords(sub.pausedOn!, year: false)}' : ''}';
  if (sub.status == 'cancelled') return 'Cancelled${sub.cancelledOn != null ? ' ${dayWords(sub.cancelledOn!, year: false)}' : ''}';
  final days = sub.daysToRenewal;
  if (days < 0) return 'Due ${-days} ${-days == 1 ? 'day' : 'days'} ago';
  if (days == 0) return 'Renews today';
  if (days == 1) return 'Renews tomorrow';
  if (days <= 7) return 'Renews in $days days';
  return 'Renews ${dayWords(sub.nextRenewalOn, year: false)}';
}

/// An amount in a sentence: whole rupees without the paise, paise when there are any.
String money(int minor) => minor % 100 == 0 ? formatMoneyShort(minor) : formatMoney(minor);

/// What an alert says, in one line.
String alertWords(Subscription sub, SubscriptionAlert alert) => switch (alert.kind) {
      'missed' => '${sub.name}: no payment seen for ${dayWords(alert.dueOn ?? '', year: false)}',
      'overdue' => '${sub.name} was due ${dayWords(alert.dueOn ?? '', year: false)} - nothing yet',
      'price' => '${sub.name} came in at ${money(alert.toMinor)}, not ${money(alert.fromMinor)}',
      'trial_ending' => "${sub.name}'s trial ends ${dayWords(alert.on ?? '', year: false)}",
      _ => sub.name,
    };

DsTone alertTone(SubscriptionAlert alert) => switch (alert.kind) {
      'missed' || 'overdue' => DsTone.warn,
      _ => DsTone.ac,
    };

class _SubscriptionsScreenState extends State<SubscriptionsScreen> {
  SubscriptionsPage? _page;
  bool _failed = false;
  _View _view = _View.list;

  String _calendarMonth = DateFormat('yyyy-MM').format(DateTime.now());
  List<CalendarRenewal>? _calendar;
  bool _calendarFailed = false;
  String? _selectedDay;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _failed = false);
    try {
      final json = await ApiClient.instance.get('/subscriptions') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() => _page = SubscriptionsPage.fromJson(json));
      if (_view == _View.calendar) await _loadCalendar();
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _loadCalendar() async {
    setState(() {
      _calendar = null;
      _calendarFailed = false;
    });
    try {
      final json = await ApiClient.instance.get('/subscriptions/calendar?month=$_calendarMonth') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _calendar = (json['renewals'] as List<dynamic>? ?? []).map((r) => CalendarRenewal.fromJson(r as Map<String, dynamic>)).toList();
      });
    } catch (_) {
      if (mounted) setState(() => _calendarFailed = true);
    }
  }

  void _showView(_View view) {
    setState(() => _view = view);
    if (view == _View.calendar && _calendar == null) _loadCalendar();
  }

  void _stepMonth(int by) {
    final parts = _calendarMonth.split('-').map(int.parse).toList();
    final next = DateTime(parts[0], parts[1] + by, 1);
    setState(() {
      _calendarMonth = DateFormat('yyyy-MM').format(next);
      _selectedDay = null;
    });
    _loadCalendar();
  }

  Future<void> _add() async {
    final saved = await showSubscriptionSheet(context);
    if (saved == true) _load();
  }

  Future<void> _track(SubscriptionSuggestion suggestion) async {
    final saved = await showSubscriptionSheet(context, from: suggestion);
    if (saved == true) _load();
  }

  Future<void> _dismiss(SubscriptionSuggestion suggestion) async {
    setState(() => _page = SubscriptionsPage(
          items: _page!.items,
          totals: _page!.totals,
          suggestions: _page!.suggestions.where((s) => s.key != suggestion.key).toList(),
        ));
    try {
      await ApiClient.instance.post('/subscriptions/suggestions/${Uri.encodeComponent(suggestion.key)}/dismiss');
    } catch (_) {
      // It comes back on the next load; nothing lost.
    }
  }

  Future<void> _open(Subscription sub) async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => SubscriptionDetailScreen(initial: sub)));
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Subscriptions'),
        actions: [
          IconButton(tooltip: 'Add a subscription', onPressed: _add, icon: const DsIcon(DsIcons.plus)),
          const SizedBox(width: 4),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_failed) {
      return StateBlock(
        icon: Icons.wifi_off,
        warn: true,
        title: "Couldn't load subscriptions",
        body: 'The connection failed. Check your internet and try again.',
        actionLabel: 'Retry',
        onAction: _load,
      );
    }
    final page = _page;
    if (page == null) return const Center(child: DsSpinner());

    if (page.items.isEmpty && page.suggestions.isEmpty) {
      return StateBlock(
        icon: DsIcons.repeat,
        title: 'Nothing renews yet',
        body: 'Add the things that charge you on their own - streaming, the gym, broadband - and each renewal is '
            'matched to the payment that lands, counted in your month, and flagged when it does not show up.',
        actionLabel: 'Add a subscription',
        onAction: _add,
      );
    }

    final alerts = [
      for (final sub in page.items)
        for (final alert in sub.alerts) (sub, alert),
    ];

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: kPagePad,
        children: [
          _Totals(totals: page.totals),
          if (alerts.isNotEmpty) ...[
            const SizedBox(height: kCardGap),
            for (final (i, (sub, alert)) in alerts.indexed) ...[
              if (i > 0) const SizedBox(height: 8),
              DsCallout(
                tone: alertTone(alert),
                icon: alert.kind == 'price' ? DsIcons.trendingUp : (alert.kind == 'trial_ending' ? DsIcons.bell : DsIcons.alertTriangle),
                title: alertWords(sub, alert),
                action: TextButton(onPressed: () => _open(sub), child: const Text('Open')),
              ),
            ],
          ],
          if (page.items.isNotEmpty) ...[
            const SizedBox(height: kCardGap),
            DsSegmented<_View>(
              segments: const [(_View.list, 'List'), (_View.calendar, 'Calendar'), (_View.byCard, 'By card')],
              selected: _view,
              onChanged: _showView,
              height: 40,
            ),
            const SizedBox(height: kCardGap),
            switch (_view) {
              _View.list => _ListView(items: page.items, onOpen: _open),
              _View.calendar => _CalendarView(
                  month: _calendarMonth,
                  renewals: _calendar,
                  failed: _calendarFailed,
                  selectedDay: _selectedDay,
                  onSelectDay: (day) => setState(() => _selectedDay = day),
                  onStep: _stepMonth,
                  onRetry: _loadCalendar,
                  onOpen: (id) {
                    final sub = page.items.where((s) => s.id == id).firstOrNull;
                    if (sub != null) _open(sub);
                  },
                ),
              _View.byCard => _ByCardView(items: page.items, onOpen: _open),
            },
          ] else ...[
            const SizedBox(height: kCardGap),
            DsEmpty(message: 'Nothing tracked yet. Take one up below, or add your own.', icon: DsIcons.repeat, actionLabel: 'Add a subscription', onAction: _add),
          ],
          if (page.suggestions.isNotEmpty) ...[
            const SizedBox(height: 24),
            const DsSectionHeader('Looks like a subscription', meta: 'Charged again and again'),
            const SizedBox(height: 10),
            for (final (i, suggestion) in page.suggestions.indexed) ...[
              if (i > 0) const SizedBox(height: 8),
              _SuggestionCard(
                suggestion: suggestion,
                onTrack: () => _track(suggestion),
                onDismiss: () => _dismiss(suggestion),
              ),
            ],
          ],
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

/// The two figures that matter: what it all costs, and what this month takes.
class _Totals extends StatelessWidget {
  const _Totals({required this.totals});
  final SubscriptionTotals totals;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final count = totals.dueThisMonthCount;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: DsStatTile(
            label: 'A month',
            icon: DsIcons.repeat,
            value: formatMoney(totals.monthlyMinor),
            foot: '${formatMoneyShort(totals.yearlyMinor)} a year · ${totals.activeCount} ${totals.activeCount == 1 ? 'active' : 'active'}',
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: DsStatTile(
            label: 'This month',
            icon: DsIcons.calendar,
            value: formatMoney(totals.dueThisMonthMinor),
            foot: count == 0
                ? 'No renewals ${totals.monthLabel.isEmpty ? 'this month' : 'in ${totals.monthLabel}'}'
                : '$count ${count == 1 ? 'renewal' : 'renewals'} · ${formatMoneyShort(totals.paidThisMonthMinor)} paid, '
                    '${formatMoneyShort(totals.upcomingThisMonthMinor)} to come',
            footColor: totals.alertCount > 0 ? c.warn : null,
          ),
        ),
      ],
    );
  }
}

class _ListView extends StatelessWidget {
  const _ListView({required this.items, required this.onOpen});
  final List<Subscription> items;
  final ValueChanged<Subscription> onOpen;

  @override
  Widget build(BuildContext context) {
    final overdue = items.where((s) => s.isLive && s.daysToRenewal < 0).toList();
    final soon = items.where((s) => s.isLive && s.daysToRenewal >= 0 && s.daysToRenewal <= 7).toList();
    final later = items.where((s) => s.isLive && s.daysToRenewal > 7).toList();
    final paused = items.where((s) => s.status == 'paused').toList();
    final cancelled = items.where((s) => s.status == 'cancelled').toList();
    final groups = [
      ('Overdue', overdue),
      ('This week', soon),
      ('Later', later),
      ('Paused', paused),
      ('Cancelled', cancelled),
    ].where((g) => g.$2.isNotEmpty).toList();

    return Column(
      children: [
        for (final (i, (title, subs)) in groups.indexed) ...[
          if (i > 0) const SizedBox(height: kCardGap),
          _Group(title: title, meta: _meta(subs), subs: subs, onOpen: onOpen),
        ],
      ],
    );
  }

  String _meta(List<Subscription> subs) {
    final total = subs.fold<int>(0, (sum, s) => sum + s.monthlyMinor);
    return subs.every((s) => !s.isLive) ? '${subs.length}' : '${formatMoneyShort(total)} a month';
  }
}

class _Group extends StatelessWidget {
  const _Group({required this.title, required this.meta, required this.subs, required this.onOpen});
  final String title;
  final String meta;
  final List<Subscription> subs;
  final ValueChanged<Subscription> onOpen;

  @override
  Widget build(BuildContext context) {
    return DsCard(
      padding: EdgeInsets.zero,
      clip: true,
      child: Column(
        children: [
          DsSectionHeader(title, meta: meta, padding: const EdgeInsets.fromLTRB(16, 14, 16, 4)),
          for (final (i, sub) in subs.indexed) ...[
            if (i > 0) const Divider(indent: 68, height: 1),
            SubscriptionRow(sub: sub, onTap: () => onOpen(sub)),
          ],
          const SizedBox(height: 4),
        ],
      ),
    );
  }
}

/// One subscription in a list: its mark, name, how often and how, when
/// next, and what each time costs.
class SubscriptionRow extends StatelessWidget {
  const SubscriptionRow({super.key, required this.sub, required this.onTap});
  final Subscription sub;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final dim = !sub.isLive;
    final overdue = sub.isLive && sub.daysToRenewal < 0;
    final how = [sub.frequencyLabel, if (sub.paidWithLabel != null) sub.paidWithLabel!].join(' · ');
    return ListTile(
      key: ValueKey('sub-row-${sub.id}'),
      onTap: onTap,
      minVerticalPadding: 12,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16),
      leading: DsMonogram(sub.name, size: 40, tone: dim ? DsTone.neutral : DsTone.ac),
      // A badge drops under the name when the two will not share a line.
      title: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 6,
        runSpacing: 4,
        children: [
          Text(
            sub.name,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: dim ? c.tx3 : c.tx),
          ),
          if (sub.status == 'trial') const DsBadge('Trial', tone: DsTone.ac),
          if (sub.alerts.any((a) => a.kind == 'missed')) const DsBadge('No payment', tone: DsTone.warn),
        ],
      ),
      subtitle: Text(
        '$how\n${renewalWords(sub)}',
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(fontSize: 12, height: 16 / 12, color: overdue ? c.warn : c.tx3),
      ),
      isThreeLine: true,
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(
            formatMoney(sub.amountMinor),
            style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: dim ? c.tx3 : c.tx),
          ),
          if (sub.frequencyPreset != 'monthly')
            Text('${formatMoneyShort(sub.monthlyMinor)}/mo', style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3)),
        ],
      ),
    );
  }
}

class _ByCardView extends StatelessWidget {
  const _ByCardView({required this.items, required this.onOpen});
  final List<Subscription> items;
  final ValueChanged<Subscription> onOpen;

  @override
  Widget build(BuildContext context) {
    final live = items.where((s) => s.isLive).toList();
    final groups = <String, List<Subscription>>{};
    for (final sub in live) {
      (groups[sub.paidWithLabel ?? 'Not said how'] ??= []).add(sub);
    }
    final ordered = groups.entries.toList()
      ..sort((a, b) {
        final totalA = a.value.fold<int>(0, (sum, s) => sum + s.monthlyMinor);
        final totalB = b.value.fold<int>(0, (sum, s) => sum + s.monthlyMinor);
        return totalB - totalA;
      });
    if (ordered.isEmpty) return const DsEmpty(message: 'Nothing running at the moment.', icon: DsIcons.creditCard);
    return Column(
      children: [
        for (final (i, entry) in ordered.indexed) ...[
          if (i > 0) const SizedBox(height: kCardGap),
          _Group(
            title: entry.key,
            meta: '${formatMoneyShort(entry.value.fold<int>(0, (sum, s) => sum + s.monthlyMinor))} a month',
            subs: entry.value,
            onOpen: onOpen,
          ),
        ],
      ],
    );
  }
}

/// A month of renewals: seven columns, today ringed in accent, the picked
/// day in ink, and what lands on each day under its number.
class _CalendarView extends StatelessWidget {
  const _CalendarView({
    required this.month,
    required this.renewals,
    required this.failed,
    required this.selectedDay,
    required this.onSelectDay,
    required this.onStep,
    required this.onRetry,
    required this.onOpen,
  });

  final String month;
  final List<CalendarRenewal>? renewals;
  final bool failed;
  final String? selectedDay;
  final ValueChanged<String> onSelectDay;
  final ValueChanged<int> onStep;
  final VoidCallback onRetry;
  final ValueChanged<String> onOpen;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final parts = month.split('-').map(int.parse).toList();
    final first = DateTime(parts[0], parts[1], 1);
    final daysInMonth = DateTime(parts[0], parts[1] + 1, 0).day;
    final leading = (first.weekday + 6) % 7; // Monday first
    final today = dayKey(DateTime.now());
    final byDay = <String, List<CalendarRenewal>>{};
    for (final renewal in renewals ?? const <CalendarRenewal>[]) {
      (byDay[renewal.on] ??= []).add(renewal);
    }
    final picked = selectedDay != null ? byDay[selectedDay!] ?? const <CalendarRenewal>[] : null;
    final cells = <Widget>[];
    for (var i = 0; i < leading; i++) {
      cells.add(const SizedBox.shrink());
    }
    for (var day = 1; day <= daysInMonth; day++) {
      final key = '$month-${day.toString().padLeft(2, '0')}';
      cells.add(_DayCell(
        day: day,
        dayKey: key,
        isToday: key == today,
        isSelected: key == selectedDay,
        renewals: byDay[key] ?? const [],
        onTap: () => onSelectDay(key),
      ));
    }
    while (cells.length % 7 != 0) {
      cells.add(const SizedBox.shrink());
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        DsCard(
          child: Column(
            children: [
              Row(
                children: [
                  IconButton(tooltip: 'Earlier month', onPressed: () => onStep(-1), icon: const DsIcon(DsIcons.chevronLeft)),
                  Expanded(
                    child: Text(
                      DateFormat('MMMM yyyy').format(first),
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                  ),
                  IconButton(tooltip: 'Later month', onPressed: () => onStep(1), icon: const DsIcon(DsIcons.chevronRight)),
                ],
              ),
              const SizedBox(height: 4),
              Row(
                children: [
                  for (final name in const ['M', 'T', 'W', 'T', 'F', 'S', 'S'])
                    Expanded(
                      child: Text(name, textAlign: TextAlign.center, style: TextStyle(fontSize: 11, height: 16 / 11, fontWeight: FontWeight.w600, color: c.tx3)),
                    ),
                ],
              ),
              const SizedBox(height: 4),
              if (renewals == null && !failed)
                const Padding(padding: EdgeInsets.all(24), child: DsSpinner())
              else ...[
                for (var row = 0; row < cells.length ~/ 7; row++)
                  Row(
                    children: [
                      for (var col = 0; col < 7; col++) Expanded(child: cells[row * 7 + col]),
                    ],
                  ),
              ],
              if (failed) ...[
                const SizedBox(height: 8),
                DsCallout(tone: DsTone.warn, title: "Couldn't load this month.", action: TextButton(onPressed: onRetry, child: const Text('Retry'))),
              ],
            ],
          ),
        ),
        const SizedBox(height: kCardGap),
        if (picked != null)
          DsCard(
            padding: EdgeInsets.zero,
            clip: true,
            child: Column(
              children: [
                DsSectionHeader(dayWords(selectedDay!), meta: picked.isEmpty ? null : formatMoney(picked.fold<int>(0, (sum, r) => sum + r.amountMinor)), padding: const EdgeInsets.fromLTRB(16, 14, 16, 4)),
                if (picked.isEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                    child: Align(alignment: Alignment.centerLeft, child: Text('Nothing renews that day.', style: TextStyle(fontSize: 13, color: c.tx3))),
                  ),
                for (final (i, renewal) in picked.indexed) ...[
                  if (i > 0) const Divider(indent: 16, height: 1),
                  ListTile(
                    onTap: () => onOpen(renewal.subscriptionId),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                    title: Text(renewal.name, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: c.tx)),
                    subtitle: Text(_statusWords(renewal.status), style: TextStyle(fontSize: 12, color: c.tx3)),
                    trailing: Text(formatMoney(renewal.amountMinor), style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx)),
                  ),
                ],
                const SizedBox(height: 4),
              ],
            ),
          )
        else
          Text('Tap a day to see what renews.', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: c.tx3)),
      ],
    );
  }

  static String _statusWords(String status) => switch (status) {
        'paid' => 'Paid',
        'missed' => 'No payment seen',
        'skipped' => 'Skipped',
        _ => 'To come',
      };
}

class _DayCell extends StatelessWidget {
  const _DayCell({
    required this.day,
    required this.dayKey,
    required this.isToday,
    required this.isSelected,
    required this.renewals,
    required this.onTap,
  });

  final int day;
  final String dayKey;
  final bool isToday;
  final bool isSelected;
  final List<CalendarRenewal> renewals;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final total = renewals.fold<int>(0, (sum, r) => sum + r.amountMinor);
    final missed = renewals.any((r) => r.status == 'missed');
    final paid = renewals.isNotEmpty && renewals.every((r) => r.status == 'paid' || r.status == 'skipped');
    final amountColor = isSelected ? c.bg : (missed ? c.crit : (paid ? c.good : c.tx2));
    return Semantics(
      button: true,
      label: '$day${renewals.isEmpty ? '' : ', ${renewals.length} renewals'}',
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Ds.rMd),
        child: Container(
          height: 50,
          margin: const EdgeInsets.all(1),
          decoration: BoxDecoration(
            color: isSelected ? c.tx : Colors.transparent,
            borderRadius: BorderRadius.circular(Ds.rMd),
            border: isToday && !isSelected ? Border.all(color: c.ac, width: 1.5) : null,
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Text(
                '$day',
                style: kNum.copyWith(
                  fontSize: 13,
                  height: 16 / 13,
                  fontWeight: renewals.isEmpty ? FontWeight.w400 : FontWeight.w600,
                  color: isSelected ? c.bg : (isToday ? c.ac : c.tx),
                ),
              ),
              if (renewals.isNotEmpty)
                Text(
                  formatMoneyShort(total),
                  maxLines: 1,
                  overflow: TextOverflow.clip,
                  style: kNum.copyWith(fontSize: 9, height: 12 / 9, fontWeight: FontWeight.w600, color: amountColor),
                )
              else
                const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Netflix ₹649 every month - track it?"
class _SuggestionCard extends StatelessWidget {
  const _SuggestionCard({required this.suggestion, required this.onTrack, required this.onDismiss});
  final SubscriptionSuggestion suggestion;
  final VoidCallback onTrack;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              DsMonogram(suggestion.suggestedName, size: 40, tone: DsTone.warn),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${suggestion.suggestedName} · ${money(suggestion.amountMinor)} ${suggestion.label.toLowerCase()}',
                      maxLines: 2,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${suggestion.count} charges as "${suggestion.merchant}", last ${dayWords(suggestion.lastOn, year: false)} · '
                      'next about ${dayWords(suggestion.nextOn, year: false)}',
                      style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton.tonal(key: ValueKey('track-${suggestion.key}'), onPressed: onTrack, child: const Text('Track it')),
              TextButton(key: ValueKey('dismiss-${suggestion.key}'), onPressed: onDismiss, child: const Text('Not a subscription')),
            ],
          ),
        ],
      ),
    );
  }
}
