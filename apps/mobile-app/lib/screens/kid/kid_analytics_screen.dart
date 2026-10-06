import 'package:flutter/material.dart';
import '../../models/kid_models.dart';
import '../../models/models.dart';
import '../../services/api_client.dart';
import '../../services/kid_service.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import '../../widgets/charts/chart_utils.dart';
import '../../widgets/charts/daily_spend_chart.dart';
import '../../widgets/charts/donut_chart.dart';
import '../../widgets/home/home_grid.dart';
import '../../widgets/state_block.dart';
import 'kid_money_screen.dart';

/// One month of the kid's own money: totals, where it went, the places it
/// went most, and day by day.
class KidAnalyticsScreen extends StatefulWidget {
  const KidAnalyticsScreen({super.key});

  @override
  State<KidAnalyticsScreen> createState() => KidAnalyticsScreenState();
}

class KidAnalyticsScreenState extends State<KidAnalyticsScreen> {
  final _service = KidService.instance;

  List<UserMonth> _months = [];
  int _monthIndex = 0;
  List<KidAccount> _accounts = [];
  String? _accountId;
  List<Category> _categories = [];
  KidAnalytics? _data;
  bool _loading = true;
  String? _error;

  // Drops an answer for a month or account that is no longer chosen.
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    final generation = ++_generation;
    setState(() {
      _loading = _data == null;
      _error = null;
    });
    try {
      // Months, accounts and categories rarely change; fetched once.
      if (_months.isEmpty) {
        final results = await Future.wait([_service.months(), _service.me(), _service.categories()]);
        _months = (results[0] as UserMonths).months;
        _accounts = (results[1] as KidProfile).accounts;
        _categories = results[2] as List<Category>;
      }
      final month = _months.isEmpty ? null : _months[_monthIndex].month;
      final data = await _service.analytics(accountId: _accountId, month: month);
      if (!mounted || generation != _generation) return;
      setState(() => _data = data);
    } catch (e) {
      if (mounted && generation == _generation) {
        setState(() => _error = e is ApiException ? e.message : 'Check your internet and try again.');
      }
    } finally {
      if (mounted && generation == _generation) setState(() => _loading = false);
    }
  }

  /// Same as on Money: wake the parent's phone, then reload.
  Future<void> _pullToRefresh() async {
    try {
      final hint = (await _service.refresh()).hint;
      if (hint != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(hint)));
      }
    } catch (_) {
      // The reload still shows whatever the server already has.
    }
    await load();
  }

  Color _colorFor(String? categoryId) {
    if (categoryId == null) return context.c.mutedLight;
    final match = _categories.where((c) => c.id == categoryId);
    return match.isEmpty ? context.c.muted : parseHexColor(match.first.color);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final data = _data;

    if (_loading && data == null) return const Center(child: CircularProgressIndicator());
    if (data == null) {
      return StateBlock(
        icon: Icons.cloud_off_outlined,
        title: "Couldn't load your analytics",
        body: _error ?? 'Something went wrong.',
        actionLabel: 'Try again',
        onAction: load,
        warn: true,
      );
    }

    return RefreshIndicator(
      onRefresh: _pullToRefresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
        children: [
          KidAccountChips(
            accounts: _accounts,
            selected: _accountId,
            onChanged: (id) {
              setState(() => _accountId = id);
              load();
            },
          ),
          if (_accounts.length > 1) const SizedBox(height: 10),
          KidMonthBar(
            months: _months,
            index: _monthIndex,
            onChanged: (i) {
              setState(() => _monthIndex = i);
              load();
            },
          ),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
          ],
          const SizedBox(height: 12),
          _totals(data),
          const SizedBox(height: 12),
          _donut(data),
          const SizedBox(height: 12),
          _merchants(data),
          const SizedBox(height: 12),
          HomeTile(
            label: 'Day by day',
            icon: Icons.show_chart,
            child: data.daily.isEmpty || data.totalSpendMinor == 0
                ? Text('Nothing spent this month.', style: TextStyle(fontSize: 12.5, color: c.muted))
                : DailySpendChart(days: data.daily),
          ),
        ],
      ),
    );
  }

  Widget _totals(KidAnalytics data) {
    final c = context.c;

    Widget figure(String label, String value, Color color) => Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.muted)),
              const SizedBox(height: 4),
              FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.centerLeft,
                child: Text(value, style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w800, color: color)),
              ),
            ],
          ),
        );

    return HomeTile(
      label: 'This month',
      icon: Icons.account_balance_wallet_outlined,
      child: Row(
        children: [
          figure('Spent', formatMoney(data.totalSpendMinor), c.ink),
          figure('Money in', formatMoney(data.totalInMinor), c.credit),
          figure('Transactions', '${data.transactionCount}', c.ink),
        ],
      ),
    );
  }

  /// The biggest five categories named, the rest gathered as "Other" so
  /// the ring stays readable.
  Widget _donut(KidAnalytics data) {
    final c = context.c;
    if (data.byCategory.isEmpty) {
      return HomeTile(
        label: 'Where it went',
        icon: Icons.donut_large_outlined,
        child: Text('Nothing spent this month.', style: TextStyle(fontSize: 12.5, color: c.muted)),
      );
    }

    final shown = data.byCategory.take(5).toList();
    final rest = data.byCategory.skip(5).fold<int>(0, (sum, e) => sum + e.amountMinor);
    final total = data.totalSpendMinor == 0 ? 1 : data.totalSpendMinor;
    final segments = [
      for (final e in shown) DonutSegment(value: e.amountMinor, color: _colorFor(e.categoryId), label: e.name),
      if (rest > 0) DonutSegment(value: rest, color: c.lineStrong, label: 'Other'),
    ];

    return HomeTile(
      label: 'Where it went',
      icon: Icons.donut_large_outlined,
      child: Row(
        children: [
          DonutChart(segments: segments, centerTop: compactMoney(data.totalSpendMinor), centerBottom: 'spent', size: 124),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final s in segments)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      children: [
                        Expanded(child: LegendDot(color: s.color, label: s.label, textColor: c.ink70)),
                        const SizedBox(width: 6),
                        Text(
                          formatMoneyShort(s.value),
                          style: kNum.copyWith(fontSize: 11.5, fontWeight: FontWeight.w700, color: c.ink),
                        ),
                        SizedBox(
                          width: 38,
                          child: Text(
                            '${(s.value / total * 100).round()}%',
                            textAlign: TextAlign.right,
                            style: kNum.copyWith(fontSize: 11, color: c.muted),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _merchants(KidAnalytics data) {
    final c = context.c;
    final rows = data.byMerchant;
    final peak = rows.isEmpty || rows.first.amountMinor == 0 ? 1 : rows.first.amountMinor;

    return HomeTile(
      label: 'Top places',
      icon: Icons.storefront_outlined,
      child: rows.isEmpty
          ? Text('Nothing this month has a name on it yet.', style: TextStyle(fontSize: 12.5, color: c.muted))
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final m in rows)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                m.merchant,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.ink70),
                              ),
                            ),
                            Text('×${m.count}  ', style: TextStyle(fontSize: 11, color: c.muted)),
                            Text(formatMoney(m.amountMinor), style: kNum.copyWith(fontSize: 12, color: c.ink)),
                          ],
                        ),
                        const SizedBox(height: 4),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(100),
                          child: LinearProgressIndicator(
                            value: (m.amountMinor / peak).clamp(0.0, 1.0),
                            minHeight: 6,
                            backgroundColor: c.track,
                            valueColor: AlwaysStoppedAnimation(c.brand),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }
}
