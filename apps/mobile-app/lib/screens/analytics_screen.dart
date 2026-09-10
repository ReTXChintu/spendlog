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
  OwedSummary? _owed;

  @override
  void initState() {
    super.initState();
    _month = currentMonth();
    _loadSummary();
    _loadRest();
  }

  Future<void> _loadSummary() async {
    final result = await ApiClient.instance.get('/analytics/summary?month=$_month');
    if (!mounted) return;
    setState(() => _summary = AnalyticsSummary.fromJson(result as Map<String, dynamic>));
  }

  Future<void> _loadRest() async {
    final results = await Future.wait([
      ApiClient.instance.get('/analytics/trend?months=6'),
      ApiClient.instance.get('/categories'),
      // Not month-scoped: what people owe each other does not reset in January.
      ApiClient.instance.get('/analytics/owed'),
    ]);
    if (!mounted) return;
    setState(() {
      _trend = (results[0] as List<dynamic>).cast<Map<String, dynamic>>();
      _categories = (results[1] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
      _owed = OwedSummary.fromJson(results[2] as Map<String, dynamic>);
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
                        if (_owed != null && _owed!.splitCount > 0) ...[
                          const SizedBox(height: 26),
                          const _SectionTitle(
                            title: 'Split bills',
                            sub: 'Across all time, not just this month.',
                          ),
                          const SizedBox(height: 14),
                          _OwedCard(owed: _owed!),
                        ],
                        const SizedBox(height: 26),
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

  const _CategoryBar({
    required this.name,
    required this.amountMinor,
    required this.fraction,
    required this.color,
    required this.dashed,
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
              Text('${(fraction * 100).round()}%',
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

class _OwedCard extends StatelessWidget {
  final OwedSummary owed;
  const _OwedCard({required this.owed});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final positive = owed.balanceMinor >= 0;
    final caption = owed.balanceMinor > 0
        ? 'owed to you'
        : owed.balanceMinor < 0
            ? 'you owe'
            : 'all settled up';

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            formatMoney(owed.balanceMinor.abs()),
            style: kNum.copyWith(
              fontSize: 26,
              fontWeight: FontWeight.w800,
              color: positive ? c.credit : c.debit,
            ),
          ),
          const SizedBox(height: 2),
          Text(caption, style: TextStyle(fontSize: 12.5, color: c.muted)),
          const SizedBox(height: 12),
          Wrap(
            spacing: 14,
            runSpacing: 6,
            children: [
              _OwedStat(label: 'Paid for others', value: formatMoneyShort(owed.lentMinor)),
              _OwedStat(label: 'Paid back to you', value: formatMoneyShort(owed.settledInMinor)),
              _OwedStat(label: 'You paid back', value: formatMoneyShort(owed.settledOutMinor)),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            'Compare this with Splitwise. A gap usually means one bill needs its share correcting.',
            style: TextStyle(fontSize: 11.5, height: 1.45, color: c.mutedLight),
          ),
        ],
      ),
    );
  }
}

class _OwedStat extends StatelessWidget {
  final String label;
  final String value;

  const _OwedStat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('$label ', style: TextStyle(fontSize: 11.5, color: context.c.muted)),
        Text(
          value,
          style: kNum.copyWith(fontSize: 11.5, fontWeight: FontWeight.w700, color: context.c.ink70),
        ),
      ],
    );
  }
}
