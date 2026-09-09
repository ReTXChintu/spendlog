import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/state_block.dart';
import '../widgets/transaction_tile.dart';

/// The ledger — day-grouped, filterable, and the only list in the app.
///
/// Browsing by day and searching used to be two tabs over the same data;
/// they are one screen now, with the filters narrowing the same day-grouped
/// list. Days are paged rather than transactions, so a day's spent and
/// received totals are always complete.
class TransactionsScreen extends StatefulWidget {
  /// Set when arriving from the "needs a category" nudge.
  final bool startUncategorized;
  final VoidCallback? onOpenSettings;

  const TransactionsScreen({super.key, this.startUncategorized = false, this.onOpenSettings});

  @override
  State<TransactionsScreen> createState() => TransactionsScreenState();
}

class TransactionsScreenState extends State<TransactionsScreen> {
  static const _daysPerPage = 30;

  List<DayGroup>? _days;
  bool _hasMore = false;
  String? _nextBefore;
  bool _loadingMore = false;

  List<Category> _categories = [];
  List<Account> _accounts = [];
  AnalyticsSummary? _summary;
  bool _hasGmail = false;
  bool _error = false;

  String _query = '';
  String? _categoryId;
  String _direction = '';
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    if (widget.startUncategorized) _categoryId = 'none';
    _loadContext();
    load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  String _filterQuery() {
    final params = <String, String>{
      'days': '$_daysPerPage',
      if (_query.isNotEmpty) 'q': _query,
      if (_categoryId != null) 'categoryId': _categoryId!,
      if (_direction.isNotEmpty) 'type': _direction,
    };
    return Uri(queryParameters: params).query;
  }

  /// Categories, accounts and the month rollup — everything the ledger shows
  /// around the list itself. A failure here still leaves the list usable.
  Future<void> _loadContext() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/categories'),
        ApiClient.instance.get('/accounts'),
        ApiClient.instance.get('/analytics/summary?month=${currentMonth()}'),
        ApiClient.instance.get('/ingestion/email/status'),
      ]);
      if (!mounted) return;
      setState(() {
        _categories =
            (results[0] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
        _accounts = (results[1] as List<dynamic>).map((a) => Account.fromJson(a as Map<String, dynamic>)).toList();
        _summary = AnalyticsSummary.fromJson(results[2] as Map<String, dynamic>);
        _hasGmail = (results[3] as List<dynamic>).isNotEmpty;
      });
    } catch (_) {
      // The ledger still works without the rollup and the chips.
    }
  }

  Future<void> load() async {
    setState(() => _days = null);
    try {
      final result = await ApiClient.instance.get('/transactions/by-day?${_filterQuery()}') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _days = (result['days'] as List<dynamic>).map((d) => DayGroup.fromJson(d as Map<String, dynamic>)).toList();
        _hasMore = result['hasMore'] as bool? ?? false;
        _nextBefore = result['nextBefore'] as String?;
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _loadMore() async {
    final before = _nextBefore;
    if (before == null) return;
    setState(() => _loadingMore = true);
    try {
      final result = await ApiClient.instance
              .get('/transactions/by-day?${_filterQuery()}&before=${Uri.encodeQueryComponent(before)}')
          as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _days = [
          ...?_days,
          ...(result['days'] as List<dynamic>).map((d) => DayGroup.fromJson(d as Map<String, dynamic>)),
        ];
        _hasMore = result['hasMore'] as bool? ?? false;
        _nextBefore = result['nextBefore'] as String?;
      });
    } catch (_) {
      // Keep what's already on screen; the button stays for another try.
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _refreshAll() => Future.wait([load(), _loadContext()]);

  void _search(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      _query = value;
      load();
    });
  }

  void _setFilter(void Function() apply) {
    setState(apply);
    load();
  }

  /// A category picked from the tile changes only that row, so patch it in
  /// place instead of reloading the whole ledger.
  void _replace(Transaction updated) {
    setState(() {
      _days = _days
          ?.map((day) => DayGroup(
                date: day.date,
                spendMinor: day.spendMinor,
                incomeMinor: day.incomeMinor,
                transactions: day.transactions.map((t) => t.id == updated.id ? updated : t).toList(),
              ))
          .toList();
    });
  }

  Future<void> _openEditor({Transaction? transaction}) async {
    final changed = await showEditTransactionSheet(
      context,
      transaction: transaction,
      categories: _categories,
      accounts: _accounts,
    );
    // An edit can move the amount, the date or the direction, so the day
    // totals and the grouping have to come back from the server.
    if (changed == true) await _refreshAll();
  }

  bool get _filtersActive => _query.isNotEmpty || _categoryId != null || _direction.isNotEmpty;

  void _clearFilters() => _setFilter(() {
        _query = '';
        _categoryId = null;
        _direction = '';
      });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final uncategorized = _summary?.byCategory.where((x) => x.categoryId == null).toList() ?? const <CategorySpend>[];

    return Scaffold(
      backgroundColor: c.paper,
      floatingActionButton: FloatingActionButton(
        onPressed: () => _openEditor(),
        tooltip: 'Add a transaction by hand',
        child: const Icon(Icons.add),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
            child: TextField(
              onChanged: _search,
              style: TextStyle(color: c.ink),
              decoration: InputDecoration(
                hintText: 'Merchant or note',
                hintStyle: TextStyle(color: c.mutedLight),
                prefixIcon: Icon(Icons.search, size: 18, color: c.mutedLight),
                isDense: true,
                filled: true,
                fillColor: c.surface,
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(T.rSm),
                  borderSide: BorderSide(color: c.lineStrong),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(T.rSm),
                  borderSide: BorderSide(color: c.brand),
                ),
              ),
            ),
          ),
          SizedBox(
            height: 38,
            child: ListView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              children: [
                _FilterChip(label: 'All', on: !_filtersActive, onTap: _clearFilters),
                _FilterChip(
                  label: 'Needs a category',
                  on: _categoryId == 'none',
                  onTap: () => _setFilter(() => _categoryId = _categoryId == 'none' ? null : 'none'),
                ),
                _FilterChip(
                  label: 'Debit',
                  on: _direction == 'DEBIT',
                  onTap: () => _setFilter(() => _direction = _direction == 'DEBIT' ? '' : 'DEBIT'),
                ),
                _FilterChip(
                  label: 'Credit',
                  on: _direction == 'CREDIT',
                  onTap: () => _setFilter(() => _direction = _direction == 'CREDIT' ? '' : 'CREDIT'),
                ),
                for (final category in _categories)
                  _FilterChip(
                    label: category.name,
                    on: _categoryId == category.id,
                    color: parseHexColor(category.color),
                    onTap: () => _setFilter(() => _categoryId = _categoryId == category.id ? null : category.id),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Expanded(child: _buildBody(uncategorized)),
        ],
      ),
    );
  }

  Widget _buildBody(List<CategorySpend> uncategorized) {
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

    if (_days == null) return const Center(child: CircularProgressIndicator());

    if (_days!.isEmpty) {
      return RefreshIndicator(
        onRefresh: _refreshAll,
        child: ListView(
          children: [
            SizedBox(
              height: MediaQuery.of(context).size.height * 0.65,
              child: _filtersActive
                  ? StateBlock(
                      icon: Icons.search_off,
                      title: 'Nothing matches those filters',
                      body: 'No transaction fits this combination. Clear a filter to see more.',
                      actionLabel: 'Clear filters',
                      onAction: _clearFilters,
                    )
                  : _hasGmail
                      ? StateBlock(
                          icon: Icons.mail_outline,
                          title: 'No bank emails found yet',
                          body: "Your Gmail is connected and we've checked it, but no transaction email from your "
                              'bank has turned up. Many Indian banks only send SMS for card and UPI payments — '
                              'turn on SMS access to catch those, or add one by hand.',
                          actionLabel: 'Add by hand',
                          onAction: () => _openEditor(),
                        )
                      : StateBlock(
                          icon: Icons.receipt_long_outlined,
                          title: 'Nothing here yet',
                          body: 'SpendLog fills in on its own once a bank message arrives. Turn on SMS access or '
                              'connect Gmail in Settings — or add a transaction by hand.',
                          actionLabel: 'Add by hand',
                          onAction: () => _openEditor(),
                        ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _refreshAll,
      child: ListView(
        padding: const EdgeInsets.only(top: 10, bottom: 90),
        children: [
          if (_summary != null && !_filtersActive) _MonthRollup(summary: _summary!),
          if (uncategorized.isNotEmpty && _categoryId != 'none')
            _NudgeStrip(
              amountMinor: uncategorized.first.amountMinor,
              onReview: () => _setFilter(() => _categoryId = 'none'),
            ),
          for (final day in _days!) ...[
            _DayHeader(day: day),
            for (final transaction in day.transactions)
              TransactionTile(
                transaction: transaction,
                categories: _categories,
                onUpdated: _replace,
                onEdit: () => _openEditor(transaction: transaction),
              ),
            const SizedBox(height: 22),
          ],
          if (_hasMore)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
              child: OutlinedButton(
                onPressed: _loadingMore ? null : _loadMore,
                child: Text(_loadingMore ? 'Loading…' : 'Load earlier days'),
              ),
            ),
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
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: context.c.surface,
        border: Border.all(color: context.c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          _RollupItem(
            label: 'Spent ($month)',
            value: formatMoneyShort(summary.totalSpendMinor),
            color: context.c.debit,
          ),
          _RollupItem(
            label: 'Received',
            value: formatMoneyShort(summary.totalIncomeMinor),
            color: context.c.credit,
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
        Text(label, style: TextStyle(fontSize: 11, color: context.c.muted, fontWeight: FontWeight.w600)),
        const SizedBox(height: 2),
        Text(value, style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: color)),
      ],
    );
  }
}

class _NudgeStrip extends StatelessWidget {
  final int amountMinor;
  final VoidCallback onReview;

  const _NudgeStrip({required this.amountMinor, required this.onReview});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 11),
      decoration: BoxDecoration(
        color: context.c.brand50,
        border: Border.all(color: context.c.brand100),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Row(
        children: [
          Icon(Icons.help_outline, size: 16, color: context.c.brandDark),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              '${formatMoneyShort(amountMinor)} needs a category',
              style: TextStyle(fontSize: 12, color: context.c.ink70),
            ),
          ),
          GestureDetector(
            onTap: onReview,
            child: Text(
              'Review',
              style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: context.c.brandDark),
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
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: context.c.ink, width: 2)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            formatDayLabel(day.date),
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14.5, color: context.c.ink),
          ),
          Row(
            children: [
              if (day.spendMinor > 0)
                Text(
                  '−${formatMoney(day.spendMinor)}',
                  style: kNum.copyWith(fontSize: 12.8, fontWeight: FontWeight.w700, color: context.c.debit),
                ),
              if (day.spendMinor > 0 && day.incomeMinor > 0)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: Text('·', style: TextStyle(color: context.c.mutedLight)),
                ),
              if (day.incomeMinor > 0)
                Text(
                  '+${formatMoney(day.incomeMinor)}',
                  style: kNum.copyWith(fontSize: 12.8, fontWeight: FontWeight.w700, color: context.c.credit),
                ),
            ],
          ),
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  final String label;
  final bool on;
  final Color? color;
  final VoidCallback onTap;

  const _FilterChip({required this.label, required this.on, required this.onTap, this.color});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: 8),
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 7),
          decoration: BoxDecoration(
            color: on ? context.c.brand50 : context.c.surface,
            border: Border.all(color: on ? context.c.brand : context.c.lineStrong),
            borderRadius: BorderRadius.circular(100),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (color != null) ...[
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(2)),
                ),
                const SizedBox(width: 6),
              ],
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: on ? context.c.brandDark : context.c.ink70,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
