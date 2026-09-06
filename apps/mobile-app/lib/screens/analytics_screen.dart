import 'package:flutter/material.dart';
import '../theme.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';

class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key});

  @override
  State<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

class _AnalyticsScreenState extends State<AnalyticsScreen> {
  late String _month;
  AnalyticsSummary? _summary;
  List<Map<String, dynamic>> _trend = [];

  @override
  void initState() {
    super.initState();
    final now = DateTime.now();
    _month = '${now.year}-${now.month.toString().padLeft(2, '0')}';
    _loadSummary();
    _loadTrend();
  }

  Future<void> _loadSummary() async {
    final result = await ApiClient.instance.get('/analytics/summary?month=$_month');
    setState(() => _summary = AnalyticsSummary.fromJson(result as Map<String, dynamic>));
  }

  Future<void> _loadTrend() async {
    final result = await ApiClient.instance.get('/analytics/trend?months=6') as List<dynamic>;
    setState(() => _trend = result.cast<Map<String, dynamic>>());
  }

  @override
  Widget build(BuildContext context) {
    final summary = _summary;
    final maxCategorySpend =
        summary == null || summary.byCategory.isEmpty ? 1 : summary.byCategory.map((c) => c.amountMinor).reduce((a, b) => a > b ? a : b);
    final maxTrendSpend = _trend.isEmpty
        ? 1
        : _trend.map((t) => t['spendMinor'] as int).reduce((a, b) => a > b ? a : b).clamp(1, 1 << 62);

    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        if (summary != null) ...[
          Row(
            children: [
              _SummaryCard(label: 'Spent', value: formatMoney(summary.totalSpendMinor)),
              const SizedBox(width: 12),
              _SummaryCard(label: 'Received', value: formatMoney(summary.totalIncomeMinor)),
            ],
          ),
          const SizedBox(height: 24),
          const Text('Spend by category', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 12),
          if (summary.byCategory.isEmpty)
            const Text('No spend recorded this month.')
          else
            ...summary.byCategory.map(
              (c) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(c.name),
                        Text(formatMoney(c.amountMinor), style: const TextStyle(fontWeight: FontWeight.w600)),
                      ],
                    ),
                    const SizedBox(height: 4),
                    FractionallySizedBox(
                      alignment: Alignment.centerLeft,
                      widthFactor: c.amountMinor / maxCategorySpend,
                      child: Container(
                        height: 8,
                        decoration: BoxDecoration(color: brandBlue, borderRadius: BorderRadius.circular(4)),
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
        const SizedBox(height: 32),
        const Text('Last 6 months', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
        const SizedBox(height: 12),
        SizedBox(
          height: 160,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: _trend
                .map(
                  (point) => Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          Container(
                            height: 120 * ((point['spendMinor'] as int) / maxTrendSpend),
                            decoration: BoxDecoration(color: brandBlue, borderRadius: BorderRadius.circular(4)),
                          ),
                          const SizedBox(height: 6),
                          Text(
                            (point['month'] as String).substring(5),
                            style: const TextStyle(fontSize: 11),
                          ),
                        ],
                      ),
                    ),
                  ),
                )
                .toList(),
          ),
        ),
      ],
    );
  }
}

class _SummaryCard extends StatelessWidget {
  final String label;
  final String value;
  const _SummaryCard({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(border: Border.all(color: Colors.grey.shade300), borderRadius: BorderRadius.circular(8)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label, style: TextStyle(color: Colors.grey.shade600, fontSize: 13)),
            const SizedBox(height: 4),
            Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
          ],
        ),
      ),
    );
  }
}
