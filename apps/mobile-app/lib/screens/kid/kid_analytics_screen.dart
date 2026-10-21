import 'package:flutter/material.dart';
import '../../models/kid_models.dart';
import '../../models/models.dart';
import '../../services/api_client.dart';
import '../../services/kid_service.dart';
import '../../widgets/ds/ds.dart';
import '../../utils/format.dart';
import '../../widgets/charts/chart_utils.dart';
import '../../widgets/charts/daily_spend_chart.dart';
import '../../widgets/charts/donut_chart.dart';
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
    if (categoryId == null) return context.c.ln2;
    final match = _categories.where((c) => c.id == categoryId);
    return match.isEmpty ? context.c.tx3 : parseHexColor(match.first.color);
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;

    if (_loading && data == null) return const Center(child: DsSpinner());
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
        padding: kPagePad,
        children: [
          KidAccountChips(
            accounts: _accounts,
            selected: _accountId,
            onChanged: (id) {
              setState(() => _accountId = id);
              load();
            },
          ),
          if (_accounts.length > 1) const SizedBox(height: 12),
          KidMonthBar(
            months: _months,
            index: _monthIndex,
            onChanged: (i) {
              setState(() => _monthIndex = i);
              load();
            },
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            DsCallout(title: _error!, tone: DsTone.crit),
          ],
          const SizedBox(height: kCardGap),
          _totals(data),
          const SizedBox(height: kCardGap),
          _donut(data),
          const SizedBox(height: kCardGap),
          _merchants(data),
          const SizedBox(height: kCardGap),
          _Card(
            title: 'Day by day',
            child: data.daily.isEmpty || data.totalSpendMinor == 0
                ? const _Nothing('Nothing spent this month.')
                : DailySpendChart(days: data.daily),
          ),
        ],
      ),
    );
  }

  Widget _totals(KidAnalytics data) {
    final c = context.c;
    return _Card(
      title: 'This month',
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: _Figure(label: 'Spent', value: formatMoney(data.totalSpendMinor), color: c.tx)),
          const SizedBox(width: 12),
          Expanded(child: _Figure(label: 'Money in', value: formatMoney(data.totalInMinor), color: c.good)),
          const SizedBox(width: 12),
          Expanded(child: _Figure(label: 'Transactions', value: '${data.transactionCount}', color: c.tx)),
        ],
      ),
    );
  }

  /// The biggest five categories named, the rest gathered as "Other" so
  /// the ring stays readable.
  Widget _donut(KidAnalytics data) {
    final c = context.c;
    if (data.byCategory.isEmpty) {
      return const _Card(title: 'Where it went', child: _Nothing('Nothing spent this month.'));
    }

    final shown = data.byCategory.take(5).toList();
    final rest = data.byCategory.skip(5).fold<int>(0, (sum, e) => sum + e.amountMinor);
    final total = data.totalSpendMinor == 0 ? 1 : data.totalSpendMinor;
    final segments = [
      for (final e in shown) DonutSegment(value: e.amountMinor, color: _colorFor(e.categoryId), label: e.name),
      if (rest > 0) DonutSegment(value: rest, color: c.chart.last, label: 'Other'),
    ];

    return _Card(
      title: 'Where it went',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: DonutChart(
              segments: segments,
              centerTop: compactMoney(data.totalSpendMinor),
              centerBottom: 'spent',
            ),
          ),
          const SizedBox(height: 12),
          for (var i = 0; i < segments.length; i++)
            Container(
              constraints: const BoxConstraints(minHeight: 40),
              padding: const EdgeInsets.symmetric(vertical: 8),
              decoration: BoxDecoration(
                border: i == segments.length - 1 ? null : Border(bottom: BorderSide(color: c.ln)),
              ),
              child: Row(
                children: [
                  Expanded(child: LegendDot(color: segments[i].color, label: segments[i].label, textColor: c.tx)),
                  const SizedBox(width: 8),
                  Text(
                    formatMoneyShort(segments[i].value),
                    style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  SizedBox(
                    width: 44,
                    child: Text(
                      '${(segments[i].value / total * 100).round()}%',
                      textAlign: TextAlign.right,
                      style: kNum.copyWith(fontSize: 12, color: c.tx3),
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

    return _Card(
      title: 'Top places',
      child: rows.isEmpty
          ? const _Nothing('Nothing this month has a name on it yet.')
          : Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final m in rows)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Row(
                      children: [
                        DsMonogram(m.merchant, size: 36),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      m.merchant,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 14,
                                        height: 20 / 14,
                                        fontWeight: FontWeight.w500,
                                        color: c.tx,
                                      ),
                                    ),
                                  ),
                                  Text('×${m.count}  ', style: kNum.copyWith(fontSize: 12, color: c.tx3)),
                                  Text(
                                    formatMoney(m.amountMinor),
                                    style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 6),
                              DsMeter(value: m.amountMinor / peak, color: c.tx),
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
}

/// A section card: a 17/24 title over its content.
class _Card extends StatelessWidget {
  const _Card({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => DsCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DsSectionHeader(title),
            const SizedBox(height: 12),
            child,
          ],
        ),
      );
}

/// Label over value: 12/600 `tx2`, then a 17/600 tabular figure.
class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value, required this.color});

  final String label;
  final String value;
  final Color color;

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsLabel(label),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: color),
            ),
          ),
        ],
      );
}

class _Nothing extends StatelessWidget {
  const _Nothing(this.text);

  final String text;

  @override
  Widget build(BuildContext context) =>
      Text(text, style: TextStyle(fontSize: 13, height: 18 / 13, color: context.c.tx3));
}
