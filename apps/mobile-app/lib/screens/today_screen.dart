import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';
import '../widgets/transaction_tile.dart';

class TodayScreen extends StatefulWidget {
  final VoidCallback? onReviewUncategorized;
  final VoidCallback? onOpenSettings;

  const TodayScreen({super.key, this.onReviewUncategorized, this.onOpenSettings});

  @override
  State<TodayScreen> createState() => TodayScreenState();
}

class TodayScreenState extends State<TodayScreen> {
  List<DayGroup>? _days;
  List<Category> _categories = [];
  AnalyticsSummary? _summary;
  bool _hasGmail = false;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/transactions/by-day'),
        ApiClient.instance.get('/categories'),
        ApiClient.instance.get('/analytics/summary?month=${currentMonth()}'),
        ApiClient.instance.get('/ingestion/email/status'),
      ]);
      if (!mounted) return;
      setState(() {
        _days = (results[0] as List<dynamic>).map((d) => DayGroup.fromJson(d as Map<String, dynamic>)).toList();
        _categories = (results[1] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
        _summary = AnalyticsSummary.fromJson(results[2] as Map<String, dynamic>);
        _hasGmail = (results[3] as List<dynamic>).isNotEmpty;
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  void _replace(int dayIndex, Transaction updated) {
    setState(() {
      final day = _days![dayIndex];
      _days![dayIndex] = DayGroup(
        date: day.date,
        spendMinor: day.spendMinor,
        incomeMinor: day.incomeMinor,
        transactions: day.transactions.map((t) => t.id == updated.id ? updated : t).toList(),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_error) {
      return StateBlock(
        icon: Icons.wifi_off,
        warn: true,
        title: "Couldn't load your transactions",
        body: "The connection to SpendLog's server failed. Your data is safe — this is just a "
            'connection problem. Check your internet and try again.',
        actionLabel: 'Retry',
        onAction: load,
      );
    }

    if (_days == null) {
      return const Center(child: CircularProgressIndicator());
    }

    if (_days!.isEmpty) {
      return RefreshIndicator(
        onRefresh: load,
        child: ListView(
          children: [
            SizedBox(
              height: MediaQuery.of(context).size.height * 0.7,
              child: _hasGmail
                  ? StateBlock(
                      icon: Icons.mail_outline,
                      title: 'No bank emails found yet',
                      body: "Your Gmail is connected and we've checked it, but no transaction email from your "
                          'bank has turned up. Many Indian banks only send SMS for card and UPI payments — '
                          'turn on SMS access to catch those.',
                      actionLabel: 'Open Settings',
                      onAction: widget.onOpenSettings,
                    )
                  : StateBlock(
                      icon: Icons.receipt_long_outlined,
                      title: 'Nothing here yet',
                      body: 'SpendLog fills in on its own once a bank message arrives — there\'s no "add '
                          'transaction" button because there\'s nothing to type. Turn on SMS access or connect '
                          'Gmail and today\'s spending will show up here.',
                      actionLabel: 'Open Settings',
                      onAction: widget.onOpenSettings,
                    ),
            ),
          ],
        ),
      );
    }

    final uncategorized = _summary?.byCategory.where((c) => c.categoryId == null).toList() ?? [];

    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.only(top: 16, bottom: 24),
        children: [
          if (_summary != null) _MonthRollup(summary: _summary!),
          if (uncategorized.isNotEmpty)
            _NudgeStrip(
              amountMinor: uncategorized.first.amountMinor,
              onReview: widget.onReviewUncategorized,
            ),
          for (var i = 0; i < _days!.length; i++) ...[
            _DayHeader(day: _days![i]),
            for (final transaction in _days![i].transactions)
              TransactionTile(
                transaction: transaction,
                categories: _categories,
                onUpdated: (updated) => _replace(i, updated),
              ),
            const SizedBox(height: 22),
          ],
        ],
      ),
    );
  }
}

class _MonthRollup extends StatelessWidget {
  final AnalyticsSummary summary;
  const _MonthRollup({required this.summary});

  @override
  Widget build(BuildContext context) {
    // "Spent (Sep)" — the rollup names the month it covers.
    final month = formatMonthLabel(summary.month).split(' ').first.substring(0, 3);
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: T.surface,
        border: Border.all(color: T.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          _RollupItem(
            label: 'Spent ($month)',
            value: formatMoneyShort(summary.totalSpendMinor),
            color: T.debit,
          ),
          _RollupItem(
            label: 'Received',
            value: formatMoneyShort(summary.totalIncomeMinor),
            color: T.credit,
          ),
        ],
      ),
    );
  }
}

class _RollupItem extends StatelessWidget {
  final String label;
  final String value;
  final Color color;

  const _RollupItem({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(fontSize: 11, color: T.muted, fontWeight: FontWeight.w600)),
        const SizedBox(height: 2),
        Text(value, style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: color)),
      ],
    );
  }
}

class _NudgeStrip extends StatelessWidget {
  final int amountMinor;
  final VoidCallback? onReview;

  const _NudgeStrip({required this.amountMinor, this.onReview});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: T.brand50,
        border: Border.all(color: T.brand100),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Row(
        children: [
          const Icon(Icons.help_outline, size: 16, color: T.brandDark),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '${formatMoneyShort(amountMinor)} needs a category',
              style: const TextStyle(fontSize: 12, color: T.ink70),
            ),
          ),
          GestureDetector(
            onTap: onReview,
            child: const Text(
              'Review',
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: T.brandDark),
            ),
          ),
        ],
      ),
    );
  }
}

class _DayHeader extends StatelessWidget {
  final DayGroup day;
  const _DayHeader({required this.day});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      padding: const EdgeInsets.only(bottom: 8),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: T.ink, width: 2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            formatDayLabel(day.date),
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5, color: T.ink),
          ),
          Row(
            children: [
              if (day.spendMinor > 0)
                Text(
                  '−${formatMoney(day.spendMinor)}',
                  style: kNum.copyWith(fontSize: 12.8, fontWeight: FontWeight.w700, color: T.debit),
                ),
              if (day.spendMinor > 0 && day.incomeMinor > 0)
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 6),
                  child: Text('·', style: TextStyle(color: T.mutedLight)),
                ),
              if (day.incomeMinor > 0)
                Text(
                  '+${formatMoney(day.incomeMinor)}',
                  style: kNum.copyWith(fontSize: 12.8, fontWeight: FontWeight.w700, color: T.credit),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
