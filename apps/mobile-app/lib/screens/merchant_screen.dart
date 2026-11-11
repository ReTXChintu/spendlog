import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/charts/column_chart.dart';
import '../widgets/ds/ds.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/state_block.dart';
import '../widgets/transaction_tile.dart';

/// One merchant up close: what Swiggy has had in all, how often, whether
/// it is growing month by month, and every payment behind the figure.
///
/// The merchant list answers "who got the money"; this answers the next
/// question, which is the one worth acting on. Opened from the Merchant
/// view in Analytics.
class MerchantScreen extends StatefulWidget {
  const MerchantScreen({super.key, required this.merchant, this.range = MerchantRange.sixMonths, this.month});

  /// The merchant's name as the list gave it; matched without case.
  final String merchant;

  /// Where the list was looking when this was opened, so the figures
  /// carry on from what was on screen.
  final MerchantRange range;

  /// The month the list was on, for [MerchantRange.month].
  final String? month;

  @override
  State<MerchantScreen> createState() => _MerchantScreenState();
}

class _MerchantScreenState extends State<MerchantScreen> {
  MerchantDetail? _detail;
  List<Category> _categories = const [];
  bool _loading = true;
  bool _failed = false;
  late MerchantRange _range = widget.range;

  @override
  void initState() {
    super.initState();
    _load();
  }

  String get _query {
    final params = <String, String>{
      'name': widget.merchant,
      'range': _range.key,
      if (_range == MerchantRange.month && widget.month != null) 'month': widget.month!,
    };
    return Uri(queryParameters: params).query;
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/analytics/merchant?$_query'),
        // For the category chip on each row; an empty list only costs the
        // chip, so it never fails the screen.
        ApiClient.instance.get('/categories').catchError((_) => const <dynamic>[]),
      ]);
      if (!mounted) return;
      setState(() {
        _detail = MerchantDetail.fromJson(results[0] as Map<String, dynamic>);
        _categories = (results[1] as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .map(Category.fromJson)
            .toList();
        _failed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _setRange(MerchantRange range) {
    if (range == _range) return;
    setState(() => _range = range);
    _load();
  }

  /// A row changed in place, so the list need not be fetched again - but
  /// the totals above it would now be stale, so they are.
  void _replace(Transaction updated) {
    final detail = _detail;
    if (detail == null) return;
    setState(() {
      _detail = MerchantDetail(
        merchant: detail.merchant,
        label: detail.label,
        totalMinor: detail.totalMinor,
        count: detail.count,
        averageMinor: detail.averageMinor,
        firstOn: detail.firstOn,
        lastOn: detail.lastOn,
        byMonth: detail.byMonth,
        byCategory: detail.byCategory,
        transactions: [
          for (final row in detail.transactions) row.id == updated.id ? updated : row,
        ],
      );
    });
  }

  Future<void> _edit(Transaction row) async {
    final saved = await showEditTransactionById(context, row.id);
    if (saved == true) await _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: context.c.bg,
      appBar: AppBar(title: Text(_detail?.merchant.isNotEmpty == true ? _detail!.merchant : widget.merchant)),
      body: Column(
        children: [
          _RangeBar(range: _range, onChanged: _setRange),
          SizedBox(height: 2, child: _loading ? const LinearProgressIndicator(minHeight: 2) : null),
          Expanded(child: RefreshIndicator(onRefresh: _load, child: _body())),
        ],
      ),
    );
  }

  Widget _body() {
    final detail = _detail;
    if (detail == null) {
      return ListView(
        children: [
          SizedBox(
            height: MediaQuery.of(context).size.height * 0.6,
            child: _failed
                ? StateBlock(
                    icon: Icons.wifi_off,
                    title: "Couldn't load this merchant",
                    body: 'Check your internet and try again.',
                    actionLabel: 'Retry',
                    onAction: _load,
                  )
                : const Center(child: DsSpinner()),
          ),
        ],
      );
    }

    if (detail.isEmpty) {
      return ListView(
        children: [
          SizedBox(
            height: MediaQuery.of(context).size.height * 0.6,
            child: StateBlock(
              icon: DsIcons.barChart,
              title: 'Nothing in ${detail.label.toLowerCase()}',
              body: 'No payment to ${detail.merchant} in this stretch. Try a longer one.',
              actionLabel: _range == MerchantRange.all ? null : 'See all time',
              onAction: _range == MerchantRange.all ? null : () => _setRange(MerchantRange.all),
            ),
          ),
        ],
      );
    }

    final c = context.c;
    final months = detail.byMonth;
    final busiest = months.isEmpty
        ? null
        : months.reduce((a, b) => b.amountMinor > a.amountMinor ? b : a);

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        _Tiles(children: [
          DsStatTile(label: 'Paid in all', value: formatMoneyShort(detail.totalMinor), foot: detail.label),
          DsStatTile(
            label: 'Payments',
            value: '${detail.count}',
            foot: detail.lastOn == null ? null : 'last on ${formatDayLabel(_iso(detail.lastOn!))}',
          ),
          DsStatTile(label: 'Average payment', value: formatMoneyShort(detail.averageMinor)),
          if (months.length > 1)
            DsStatTile(
              label: 'A month',
              value: formatMoneyShort(detail.perActiveMonthMinor),
              foot: 'over the months you paid them',
            ),
        ]),
        if (detail.firstOn != null) ...[
          const SizedBox(height: 10),
          Text(
            detail.count == 1
                ? 'Paid once, on ${formatDayLabel(_iso(detail.firstOn!))}.'
                : 'First paid ${formatDayLabel(_iso(detail.firstOn!))}, most recently '
                    '${formatDayLabel(_iso(detail.lastOn!))}.',
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
          ),
        ],
        if (months.length > 1) ...[
          const SizedBox(height: kCardGap),
          DsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DsSectionHeader(
                  'Month by month',
                  meta: busiest == null || busiest.amountMinor == 0
                      ? null
                      : 'Most in ${_shortMonth(busiest.month)}',
                ),
                const SizedBox(height: 12),
                ColumnChart(
                  values: months.map((month) => month.amountMinor).toList(),
                  labels: months.map((month) => _shortMonth(month.month)).toList(),
                  color: c.ln2,
                  highlight: c.tx,
                ),
              ],
            ),
          ),
        ],
        if (detail.byCategory.length > 1) ...[
          const SizedBox(height: kCardGap),
          DsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const DsSectionHeader('What it counted as'),
                const SizedBox(height: 4),
                for (final category in detail.byCategory)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            category.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Text(
                          '${formatMoneyShort(category.amountMinor)} · ×${category.count}',
                          style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.tx2),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
        const SizedBox(height: kCardGap),
        DsSectionHeader(
          'Every payment',
          meta: detail.transactions.length < detail.count ? 'The latest ${detail.transactions.length}' : null,
        ),
        const SizedBox(height: 4),
        for (final row in detail.transactions)
          TransactionTile(
            transaction: row,
            categories: _categories,
            onUpdated: _replace,
            onEdit: () => _edit(row),
          ),
      ],
    );
  }

  static String _iso(DateTime at) => at.toIso8601String().substring(0, 10);

  /// "Sep" from a YYYY-MM month key, for a bar's label.
  static String _shortMonth(String month) {
    if (month.length < 7) return month;
    final name = formatMonthLabel(month);
    return name.length > 3 ? name.substring(0, 3) : name;
  }
}

/// How far back the figures reach, as chips - the one thing on this screen
/// that changes every number on it, so it sits above them all.
class _RangeBar extends StatelessWidget {
  const _RangeBar({required this.range, required this.onChanged});

  final MerchantRange range;
  final ValueChanged<MerchantRange> onChanged;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 44,
      child: ListView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
        children: [
          for (final option in MerchantRange.values)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: DsChip(
                key: ValueKey('merchant-range-${option.key}'),
                label: option.label,
                selected: option == range,
                showCheck: false,
                height: 32,
                onTap: () => onChanged(option),
              ),
            ),
        ],
      ),
    );
  }
}

/// The figures as a grid that uses the whole width: two across on a phone,
/// four on anything wider.
class _Tiles extends StatelessWidget {
  const _Tiles({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = constraints.maxWidth >= 620 ? 4 : 2;
        const gap = 10.0;
        final width = (constraints.maxWidth - gap * (columns - 1)) / columns;
        return Wrap(
          spacing: gap,
          runSpacing: gap,
          children: [
            for (final child in children) SizedBox(width: width, child: child),
          ],
        );
      },
    );
  }
}
