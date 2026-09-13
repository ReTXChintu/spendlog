import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';

class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key});

  @override
  State<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

class _AnalyticsScreenState extends State<AnalyticsScreen> {
  static const _trendHeight = 110.0;

  late String _month;
  AnalyticsSummary? _summary;
  List<Map<String, dynamic>> _trend = [];
  List<Category> _categories = [];
  List<MerchantSpend> _merchants = [];
  MonthComparison? _comparison;

  /// categories | merchants | compare
  String _view = 'categories';

  @override
  void initState() {
    super.initState();
    _month = currentMonth();
    _loadSummary();
    _loadRest();
  }

  /// The three things a month can be asked about, fetched together so
  /// switching between them is instant rather than a spinner each time.
  Future<void> _loadSummary() async {
    final results = await Future.wait([
      ApiClient.instance.get('/analytics/summary?month=$_month'),
      ApiClient.instance.get('/analytics/merchants?month=$_month'),
      ApiClient.instance.get('/analytics/compare?month=$_month'),
    ]);
    if (!mounted) return;
    setState(() {
      _summary = AnalyticsSummary.fromJson(results[0] as Map<String, dynamic>);
      _merchants = (results[1] as List<dynamic>)
          .map((m) => MerchantSpend.fromJson(m as Map<String, dynamic>))
          .toList();
      _comparison = MonthComparison.fromJson(results[2] as Map<String, dynamic>);
    });
  }

  Future<void> _loadRest() async {
    final results = await Future.wait([
      ApiClient.instance.get('/analytics/trend?months=6'),
      ApiClient.instance.get('/categories'),
    ]);
    if (!mounted) return;
    setState(() {
      _trend = (results[0] as List<dynamic>).cast<Map<String, dynamic>>();
      _categories =
          (results[1] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
    });
  }

  Color _colorFor(String? categoryId) {
    if (categoryId == null) return context.c.mutedLight;
    final match = _categories.where((c) => c.id == categoryId);
    return match.isEmpty ? context.c.muted : parseHexColor(match.first.color);
  }

  @override
  Widget build(BuildContext context) {
    final summary = _summary;

    return Column(
      children: [
        _MonthPicker(
          month: _month,
          onChange: (delta) {
            final next = shiftMonth(_month, delta);
            if (delta > 0 && next.compareTo(currentMonth()) > 0) return;
            setState(() {
              _month = next;
              _summary = null;
            });
            _loadSummary();
          },
        ),
        Expanded(
          child: summary == null
              ? const Center(child: CircularProgressIndicator())
              : summary.transactionCount == 0
                  ? const StateBlock(
                      icon: Icons.trending_up,
                      title: 'Nothing to analyze yet',
                      body: 'Charts need transactions first. Once a few payments come in from SMS or Gmail, '
                          'this fills in on its own.',
                    )
                  : ListView(
                      padding: const EdgeInsets.fromLTRB(16, 4, 16, 28),
                      children: [
                        Row(
                          children: [
                            _Tile(label: 'Spent', value: formatMoney(summary.totalSpendMinor), color: context.c.debit),
                            const SizedBox(width: 12),
                            _Tile(label: 'Received', value: formatMoney(summary.totalIncomeMinor), color: context.c.credit),
                          ],
                        ),
                        const SizedBox(height: 22),
                        SegmentedButton<String>(
                          segments: const [
                            ButtonSegment(value: 'categories', label: Text('Category')),
                            ButtonSegment(value: 'merchants', label: Text('Merchant')),
                            ButtonSegment(value: 'compare', label: Text('vs last')),
                          ],
                          selected: {_view},
                          showSelectedIcon: false,
                          onSelectionChanged: (selection) => setState(() => _view = selection.first),
                        ),
                        const SizedBox(height: 22),

                        if (_view == 'categories') ...[
                          const _SectionTitle(
                            title: 'Spend by category',
                            sub: "Transfers, settlements and the part of a split bill that wasn't yours "
                                'are excluded.',
                          ),
                          const SizedBox(height: 14),
                          ...summary.byCategory.map((entry) {
                            final pct = summary.totalSpendMinor == 0
                                ? 0.0
                                : entry.amountMinor / summary.totalSpendMinor;
                            return _CategoryBar(
                              name: entry.name,
                              amountMinor: entry.amountMinor,
                              fraction: pct,
                              color: _colorFor(entry.categoryId),
                              dashed: entry.categoryId == null,
                            );
                          }),
                        ],

                        if (_view == 'merchants') ...[
                          const _SectionTitle(
                            title: 'Spend by merchant',
                            sub: 'Where the money actually went. "Food" is not a thing to cut back on; '
                                'ordering from one app eleven times is.',
                          ),
                          const SizedBox(height: 14),
                          if (_merchants.isEmpty)
                            Text(
                              'Nothing this month has a merchant name on it yet.',
                              style: TextStyle(fontSize: 12.8, color: context.c.muted),
                            )
                          else
                            ..._merchants.map((entry) => _CategoryBar(
                                  name: entry.merchant,
                                  amountMinor: entry.amountMinor,
                                  fraction: _merchants.first.amountMinor == 0
                                      ? 0.0
                                      : entry.amountMinor / _merchants.first.amountMinor,
                                  color: context.c.brand,
                                  trailing: '×${entry.count}',
                                )),
                        ],

                        if (_view == 'compare' && _comparison != null)
                          _Comparison(comparison: _comparison!),

                        const SizedBox(height: 30),
                        const _SectionTitle(title: 'Last 6 months', sub: 'Spending and income side by side.'),
                        const SizedBox(height: 16),
                        _Trend(points: _trend, maxHeight: _trendHeight),
                      ],
                    ),
        ),
      ],
    );
  }
}

class _MonthPicker extends StatelessWidget {
  final String month;
  final ValueChanged<int> onChange;

  const _MonthPicker({required this.month, required this.onChange});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        decoration: BoxDecoration(
          color: context.c.surface,
          border: Border.all(color: context.c.lineStrong),
          borderRadius: BorderRadius.circular(100),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            IconButton(
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              icon: Icon(Icons.chevron_left, color: context.c.muted),
              onPressed: () => onChange(-1),
            ),
            Text(
              formatMonthLabel(month),
              style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5, color: context.c.ink),
            ),
            IconButton(
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              icon: Icon(Icons.chevron_right, color: context.c.muted),
              onPressed: () => onChange(1),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String title;
  final String sub;
  const _SectionTitle({required this.title, required this.sub});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: context.c.ink)),
        const SizedBox(height: 3),
        Text(sub, style: TextStyle(fontSize: 12.5, color: context.c.muted)),
      ],
    );
  }
}

class _Tile extends StatelessWidget {
  final String label;
  final String value;
  final Color color;

  const _Tile({required this.label, required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        decoration: BoxDecoration(
          color: context.c.surface,
          border: Border.all(color: context.c.line),
          borderRadius: BorderRadius.circular(T.rMd),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(fontSize: 12, color: context.c.muted, fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            Text(value, style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w800, color: color)),
          ],
        ),
      ),
    );
  }
}

class _CategoryBar extends StatelessWidget {
  final String name;
  final int amountMinor;
  final double fraction;
  final Color color;
  final bool dashed;

  /// What follows the amount. A share of the month for a category; how many
  /// times it was paid, for a merchant.
  final String? trailing;

  const _CategoryBar({
    required this.name,
    required this.amountMinor,
    required this.fraction,
    required this.color,
    this.dashed = false,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 13),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (trailing == null) ...[
                Container(
                  width: 9,
                  height: 9,
                  decoration: BoxDecoration(
                    color: dashed ? Colors.transparent : color,
                    border: dashed ? Border.all(color: context.c.mutedLight, width: 1.5) : null,
                    borderRadius: BorderRadius.circular(3),
                  ),
                ),
                const SizedBox(width: 8),
              ],
              Expanded(
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: context.c.ink),
                ),
              ),
              Text(formatMoneyShort(amountMinor),
                  style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w700, color: context.c.ink)),
              const SizedBox(width: 5),
              Text(trailing ?? '${(fraction * 100).round()}%',
                  style: TextStyle(fontSize: 11.5, color: context.c.muted)),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: fraction.clamp(0.0, 1.0),
              minHeight: 11,
              backgroundColor: context.c.track,
              valueColor: AlwaysStoppedAnimation<Color>(color),
            ),
          ),
        ],
      ),
    );
  }
}

class _Trend extends StatelessWidget {
  final List<Map<String, dynamic>> points;
  final double maxHeight;

  const _Trend({required this.points, required this.maxHeight});

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) return const SizedBox.shrink();

    final peak = points
        .expand((p) => [p['spendMinor'] as int, p['incomeMinor'] as int])
        .fold<int>(1, (a, b) => a > b ? a : b);

    return Column(
      children: [
        SizedBox(
          height: maxHeight + 30,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: points.map((point) {
              final spend = point['spendMinor'] as int;
              final income = point['incomeMinor'] as int;
              final empty = spend == 0 && income == 0;
              final label = formatMonthLabel('${point['month']}').split(' ').first.substring(0, 3);

              return Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    if (empty)
                      Container(
                        width: 30,
                        height: 6,
                        decoration: BoxDecoration(
                          color: context.c.lineStrong,
                          borderRadius: BorderRadius.circular(3),
                        ),
                      )
                    else
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          _Bar(height: spend / peak * maxHeight, color: context.c.debit),
                          const SizedBox(width: 4),
                          _Bar(height: income / peak * maxHeight, color: context.c.credit),
                        ],
                      ),
                    const SizedBox(height: 6),
                    Text(label, style: TextStyle(fontSize: 11.5, color: context.c.muted, fontWeight: FontWeight.w600)),
                  ],
                ),
              );
            }).toList(),
          ),
        ),
        const SizedBox(height: 12),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            _LegendDot(color: context.c.debit, label: 'Spend'),
            const SizedBox(width: 16),
            _LegendDot(color: context.c.credit, label: 'Income'),
          ],
        ),
      ],
    );
  }
}

class _Bar extends StatelessWidget {
  final double height;
  final Color color;
  const _Bar({required this.height, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 14,
      height: height.clamp(2.0, double.infinity),
      decoration: BoxDecoration(
        color: color,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(4)),
      ),
    );
  }
}

class _LegendDot extends StatelessWidget {
  final Color color;
  final String label;
  const _LegendDot({required this.color, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 9,
          height: 9,
          decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3)),
        ),
        const SizedBox(width: 6),
        Text(label, style: TextStyle(fontSize: 12, color: context.c.muted)),
      ],
    );
  }
}

/// This month against the one before, per category as well as in total.
///
/// A month that came out level overall can still have doubled on one thing
/// and halved on another, and that is the version worth reading. Sorted by
/// how much each moved rather than how big it is, because the biggest
/// change is the thing to look at first.
class _Comparison extends StatelessWidget {
  final MonthComparison comparison;

  const _Comparison({required this.comparison});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final up = comparison.changeMinor > 0;

    final biggest = comparison.categories.isEmpty
        ? 1
        : comparison.categories
            .map((entry) => entry.changeMinor.abs())
            .reduce((a, b) => a > b ? a : b)
            .clamp(1, 1 << 62);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionTitle(
          title: 'Against ${formatMonthLabel(comparison.previousMonthLabel)}',
          sub: 'Per category as well as in total.',
        ),
        const SizedBox(height: 14),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: comparison.changeMinor == 0 ? c.chipNeutral : (up ? c.debit50 : c.credit50),
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              _Figure(label: 'This month', value: formatMoneyShort(comparison.totalSpendMinor)),
              _Figure(label: 'Last month', value: formatMoneyShort(comparison.previousSpendMinor)),
              _Figure(
                label: 'Change',
                value: '${up ? '+' : ''}${formatMoneyShort(comparison.changeMinor)}',
                colour: comparison.changeMinor == 0 ? null : (up ? c.debit : c.credit),
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        for (final entry in comparison.categories)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        entry.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: c.ink),
                      ),
                    ),
                    Text(
                      entry.changeMinor == 0
                          ? 'no change'
                          : '${entry.changeMinor > 0 ? '+' : '−'}'
                              '${formatMoneyShort(entry.changeMinor.abs())}',
                      style: entry.changeMinor == 0
                          ? TextStyle(fontSize: 12, color: c.muted)
                          : kNum.copyWith(
                              fontSize: 13,
                              fontWeight: FontWeight.w700,
                              color: entry.changeMinor > 0 ? c.debit : c.credit,
                            ),
                    ),
                    const SizedBox(width: 6),
                    // What it actually is now, so a change has something to
                    // be a change *of*.
                    Text(
                      entry.previousMinor == 0
                          ? 'new'
                          : entry.amountMinor == 0
                              ? 'stopped'
                              : formatMoneyShort(entry.amountMinor),
                      style: TextStyle(fontSize: 11.5, color: c.muted),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: LinearProgressIndicator(
                    value: entry.changeMinor.abs() / biggest,
                    minHeight: 9,
                    backgroundColor: c.track,
                    valueColor: AlwaysStoppedAnimation(
                      entry.changeMinor > 0 ? c.debit : c.credit,
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

class _Figure extends StatelessWidget {
  final String label;
  final String value;
  final Color? colour;

  const _Figure({required this.label, required this.value, this.colour});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: c.muted)),
        const SizedBox(height: 2),
        Text(
          value,
          style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: colour ?? c.ink),
        ),
      ],
    );
  }
}
