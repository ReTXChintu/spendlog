import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/sms_service.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/card_strip.dart';
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

  /// Set when opened from an account's page: the ledger starts narrowed to
  /// that account's current cycle, and gets an app bar to go back with,
  /// since it is then a pushed page rather than a tab.
  final String? initialAccountId;

  const TransactionsScreen({
    super.key,
    this.startUncategorized = false,
    this.onOpenSettings,
    this.initialAccountId,
  });

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

  List<CardStatus> _cards = [];
  BudgetPace? _pace;
  DailyBudget? _daily;

  String _query = '';
  String? _categoryId;
  String _direction = '';
  Timer? _debounce;

  /// The account filter, and the cycle within it. A null [_cycle] with an
  /// account picked means all time on that account.
  String? _accountId;
  AccountCycles? _cycles;
  AccountCycle? _cycle;
  bool _loadingCycles = false;

  /// Rows picked for merging. Entered by long-pressing a row.
  bool _selecting = false;
  final List<String> _selectedIds = [];
  bool _merging = false;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    if (widget.startUncategorized) _categoryId = 'none';
    _loadContext();
    final initialAccountId = widget.initialAccountId;
    if (initialAccountId != null) {
      // Loads the ledger itself once the cycle is known, so the first rows
      // shown are already the current cycle's rather than all time's.
      _pickAccount(initialAccountId);
    } else {
      load();
    }
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
      if (_accountId != null) 'accountId': _accountId!,
      if (_accountId != null && _cycle != null) ...{'from': _cycle!.from, 'to': _cycle!.to},
    };
    return Uri(queryParameters: params).query;
  }

  /// Narrows the ledger to one account, starting on its current cycle —
  /// "what went on this card this statement" is the question being asked
  /// far more often than "everything it ever did".
  Future<void> _pickAccount(String? id) async {
    setState(() {
      _accountId = id;
      _cycles = null;
      _cycle = null;
      _loadingCycles = id != null;
      _days = null;
    });
    if (id == null) {
      await load();
      return;
    }
    try {
      final json = await ApiClient.instance.get('/accounts/$id/cycles?count=12') as Map<String, dynamic>;
      // A different account may have been picked while this one loaded.
      if (!mounted || _accountId != id) return;
      final cycles = AccountCycles.fromJson(json);
      setState(() {
        _cycles = cycles;
        _cycle = cycles.cycles.where((c) => c.current).firstOrNull ?? cycles.cycles.firstOrNull;
      });
    } catch (_) {
      // Without cycles the account filter still works, over all time.
    } finally {
      if (mounted && _accountId == id) setState(() => _loadingCycles = false);
    }
    if (mounted && _accountId == id) await load();
  }

  Future<void> _chooseAccount() async {
    // A closed account stays listed when it is the one already picked, so
    // arriving from its page does not leave a filter you cannot see.
    final shown = _accounts.where((a) => a.isActive || a.id == _accountId).toList();
    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            _sheetOption(sheetContext, label: 'All accounts', value: '', on: _accountId == null),
            for (final account in shown)
              _sheetOption(sheetContext, label: account.label, value: account.id, on: account.id == _accountId),
          ],
        ),
      ),
    );
    if (picked == null) return;
    final id = picked.isEmpty ? null : picked;
    if (id == _accountId) return;
    await _pickAccount(id);
  }

  Future<void> _chooseCycle() async {
    final cycles = _cycles;
    if (cycles == null) return;
    // The sheet hands back an index; -1 is "All time".
    final picked = await showModalBottomSheet<int>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(sheetContext).size.height * 0.7),
          child: ListView(
            shrinkWrap: true,
            children: [
              for (var i = 0; i < cycles.cycles.length; i++)
                _sheetOption(
                  sheetContext,
                  label: _cycleLabel(cycles.cycles[i]),
                  value: i,
                  on: identical(cycles.cycles[i], _cycle),
                ),
              _sheetOption(sheetContext, label: 'All time', value: -1, on: _cycle == null),
            ],
          ),
        ),
      ),
    );
    if (picked == null) return;
    _setFilter(() => _cycle = picked < 0 ? null : cycles.cycles[picked]);
  }

  Widget _sheetOption<V>(BuildContext sheetContext, {required String label, required V value, required bool on}) {
    final c = context.c;
    return ListTile(
      title: Text(
        label,
        style: TextStyle(fontSize: 14, fontWeight: on ? FontWeight.w700 : FontWeight.w500, color: c.ink),
      ),
      trailing: on ? Icon(Icons.check, size: 18, color: c.brand) : null,
      onTap: () => Navigator.of(sheetContext).pop(value),
    );
  }

  String _cycleLabel(AccountCycle cycle) {
    final range = '${formatIsoShortDate(cycle.from)} – ${formatIsoShortDate(cycle.to)}';
    return cycle.current ? '$range (current)' : range;
  }

  String get _accountLabel =>
      _accounts.where((a) => a.id == _accountId).firstOrNull?.label ?? 'Account';

  /// Categories, accounts and the month rollup — everything the ledger shows
  /// around the list itself. A failure here still leaves the list usable.
  Future<void> _loadContext() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/categories'),
        ApiClient.instance.get('/accounts'),
        ApiClient.instance.get('/analytics/summary'),
        ApiClient.instance.get('/ingestion/email/status'),
      ]);
      if (!mounted) return;
      setState(() {
        _categories =
            (results[0] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
        _accounts = (results[1] as List<dynamic>).map((a) => Account.fromJson(a as Map<String, dynamic>)).toList();
        _summary = AnalyticsSummary.fromJson(results[2] as Map<String, dynamic>);
        _hasGmail = (results[3] as List<dynamic>).any((c) => (c as Map<String, dynamic>)['needsReconnect'] != true);
      });
    } catch (_) {
      // The ledger still works without the rollup and the chips.
    }

    // Card cycles, the spending pace, and the daily savings bucket, for the
    // strip above the list. All advisory, so none of them stops the ledger
    // loading.
    try {
      final extras = await Future.wait([
        ApiClient.instance.get('/cards'),
        ApiClient.instance.get('/budget/pace'),
        ApiClient.instance.get('/budget/daily'),
      ]);
      if (!mounted) return;
      setState(() {
        _cards = (extras[0] as List<dynamic>)
            .map((c) => CardStatus.fromJson(c as Map<String, dynamic>))
            .toList();
        _pace = BudgetPace.fromJson(extras[1] as Map<String, dynamic>);
        _daily = DailyBudget.fromJson(extras[2] as Map<String, dynamic>);
      });
    } catch (_) {
      // Advisory only.
    }
  }

  /// Fetches the ledger.
  ///
  /// [keepVisible] refreshes in place, leaving the rows on screen until the
  /// new ones arrive. Blanking the list first collapses it to a spinner, and
  /// the scroll position goes with it — so editing a payment from the 1st
  /// would land you back at today's rows every time. Changing a filter still
  /// blanks it, because there the view really is starting over.
  Future<void> load({bool keepVisible = false}) async {
    if (!keepVisible) setState(() => _days = null);
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

  /// One button for both: the phone's inbox and the connected mailbox.
  Future<void> _syncEverything() async {
    setState(() => _syncing = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await SmsService.instance.syncEverything();
      await _refreshAll(keepVisible: true);
      final imported = result.foundNothingNew
          ? 'Checked messages — nothing new.'
          : 'Imported ${result.created} ${result.created == 1 ? 'transaction' : 'transactions'}.';
      final problem = result.mailProblem;
      messenger.showSnackBar(
        SnackBar(
          // A mailbox that could not be read is said, not swallowed: "nothing
          // new" from a sync that never reached Gmail would be a lie.
          content: Text(problem == null
              ? (result.foundNothingNew ? 'Checked messages and email — nothing new.' : imported)
              : '$imported Email: $problem'),
          duration: Duration(seconds: problem == null ? 4 : 8),
          action: problem != null && widget.onOpenSettings != null
              ? SnackBarAction(label: 'Settings', onPressed: widget.onOpenSettings!)
              : null,
        ),
      );
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "Couldn't sync just now.")),
      );
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  Future<void> _refreshAll({bool keepVisible = false}) =>
      Future.wait([load(keepVisible: keepVisible), _loadContext()]);

  /// Keyed by IST day, so a day header can show what that day did to the
  /// savings bucket alongside spend/income. Only covers the current pay
  /// period — `by-day` can page further back than that, and those older
  /// days simply show no second row.
  Map<String, DailyBudgetDay> get _bucketByDate {
    final daily = _daily;
    if (daily == null || !daily.configured) return const {};
    return {for (final day in daily.days) day.day: day};
  }

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

  void _startSelecting(Transaction transaction) {
    setState(() {
      _selecting = true;
      _selectedIds
        ..clear()
        ..add(transaction.id);
    });
  }

  void _toggleSelected(Transaction transaction) {
    setState(() {
      if (_selectedIds.contains(transaction.id)) {
        _selectedIds.remove(transaction.id);
      } else {
        _selectedIds.add(transaction.id);
      }
    });
  }

  void _stopSelecting() {
    setState(() {
      _selecting = false;
      _selectedIds.clear();
    });
  }

  /// The first row picked survives; the rest are absorbed into it, so their
  /// messages and any fields it lacks move across.
  Future<void> _mergeSelected() async {
    if (_selectedIds.length < 2) return;
    final targetId = _selectedIds.first;
    final sourceIds = _selectedIds.sublist(1);
    final messenger = ScaffoldMessenger.of(context);

    setState(() => _merging = true);
    try {
      await ApiClient.instance.post('/transactions/$targetId/merge', {'sourceIds': sourceIds});
      _stopSelecting();
      await _refreshAll(keepVisible: true);
      messenger.showSnackBar(
        SnackBar(content: Text('Merged ${sourceIds.length + 1} rows into one.')),
      );
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "Couldn't merge those rows.")),
      );
    } finally {
      if (mounted) setState(() => _merging = false);
    }
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
    if (changed == true) await _refreshAll(keepVisible: true);
  }

  bool get _filtersActive =>
      _query.isNotEmpty || _categoryId != null || _direction.isNotEmpty || _accountId != null;

  void _clearFilters() => _setFilter(() {
        _query = '';
        _categoryId = null;
        _direction = '';
        // The dates belong to the account, so they go with it.
        _accountId = null;
        _cycles = null;
        _cycle = null;
        _loadingCycles = false;
      });

  Widget _searchField(SpendColors c) => TextField(
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
      );

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final uncategorized = _summary?.byCategory.where((x) => x.categoryId == null).toList() ?? const <CategorySpend>[];

    return Scaffold(
      backgroundColor: c.paper,
      // Only as a pushed page; as a tab the shell's own chrome is enough.
      appBar: widget.initialAccountId != null
          ? AppBar(
              title: Text('Transactions', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
              shape: Border(bottom: BorderSide(color: c.line)),
            )
          : null,
      floatingActionButton: _selecting
          ? null
          : FloatingActionButton(
              onPressed: () => _openEditor(),
              tooltip: 'Add a transaction by hand',
              child: const Icon(Icons.add),
            ),
      // Replaces the search box while picking, so the bar that appears is
      // about the one thing being done.
      bottomNavigationBar: _selecting
          ? SafeArea(
              child: Container(
                padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                decoration: BoxDecoration(
                  color: c.surface,
                  border: Border(top: BorderSide(color: c.line)),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        _selectedIds.length < 2
                            ? 'Pick the rows that are the same payment'
                            : '${_selectedIds.length} selected',
                        style: TextStyle(fontSize: 12.8, color: c.muted, fontWeight: FontWeight.w600),
                      ),
                    ),
                    TextButton(onPressed: _stopSelecting, child: const Text('Cancel')),
                    const SizedBox(width: 6),
                    FilledButton(
                      onPressed: _selectedIds.length < 2 || _merging ? null : _mergeSelected,
                      child: Text(_merging ? 'Merging…' : 'Merge'),
                    ),
                  ],
                ),
              ),
            )
          : null,
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
            child: Row(
              children: [
                Expanded(child: _searchField(c)),
                const SizedBox(width: 10),
                _SyncButton(busy: _syncing, onTap: _syncEverything),
              ],
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
                  label: _accountId == null ? 'All accounts' : _accountLabel,
                  on: _accountId != null,
                  dropdown: true,
                  onTap: _chooseAccount,
                ),
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
          if (_accountId != null) _cycleBar(c),
          CardStrip(cards: _cards, pace: _pace),
          Expanded(child: _buildBody(uncategorized)),
        ],
      ),
    );
  }

  /// Which stretch of the picked account is showing, and what it came to.
  Widget _cycleBar(SpendColors c) {
    final cycles = _cycles;
    final cycle = _cycle;
    final String value;
    if (_loadingCycles) {
      value = 'Loading…';
    } else if (cycle == null) {
      value = 'All time';
    } else {
      value = _cycleLabel(cycle);
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                cycles?.byStatement == false ? 'Month' : 'Statement cycle',
                style: TextStyle(fontSize: 12, color: c.muted, fontWeight: FontWeight.w600),
              ),
              const SizedBox(width: 10),
              // No cycles came back (or none yet): nothing to switch between.
              if (cycles != null && cycles.cycles.isNotEmpty)
                _FilterChip(label: value, on: cycle != null, dropdown: true, onTap: _chooseCycle)
              else
                Text(value, style: TextStyle(fontSize: 12, color: c.ink70, fontWeight: FontWeight.w600)),
            ],
          ),
          if (cycle != null) ...[
            const SizedBox(height: 4),
            Text(
              '${formatMoney(cycle.spentMinor)} spent across ${cycle.count} '
              '${cycle.count == 1 ? 'payment' : 'payments'}',
              style: kNum.copyWith(fontSize: 11.5, color: c.muted),
            ),
          ],
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
            _DayHeader(day: day, bucketDay: _bucketByDate[day.date]),
            for (final transaction in day.transactions)
              TransactionTile(
                transaction: transaction,
                categories: _categories,
                onUpdated: _replace,
                onEdit: () => _openEditor(transaction: transaction),
                selectable: _selecting,
                selected: _selectedIds.contains(transaction.id),
                onToggleSelected: () => _toggleSelected(transaction),
                onLongPress: _selecting ? null : () => _startSelecting(transaction),
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
    // The rollup names the month it covers: "Spent (Sep)" for a calendar
    // month, "Spent since 15 Sep" for one that runs pay day to pay day -
    // calling that one "Oct" on the 2nd would be wrong.
    final from = summary.from;
    final String spentLabel;
    if (from.isEmpty) {
      spentLabel = 'Spent this month';
    } else if (from.endsWith('-01')) {
      spentLabel = 'Spent (${formatMonthLabel(from.substring(0, 7)).substring(0, 3)})';
    } else {
      spentLabel = 'Spent since ${formatIsoShortDate(from)}';
    }
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
            label: spentLabel,
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
  final DailyBudgetDay? bucketDay;
  const _DayHeader({required this.day, this.bucketDay});

  @override
  Widget build(BuildContext context) {
    final bucketDay = this.bucketDay;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 4),
      padding: const EdgeInsets.only(bottom: 8),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: context.c.ink, width: 2)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
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
          if (bucketDay != null) ...[
            const SizedBox(height: 4),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                Text(
                  'SAVINGS  ',
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.4,
                    color: context.c.mutedLight,
                  ),
                ),
                Text(
                  bucketDay.deltaMinor >= 0
                      ? '+ ${formatMoney(bucketDay.deltaMinor)} put by'
                      : '− ${formatMoney(-bucketDay.deltaMinor)} drawn out',
                  style: kNum.copyWith(
                    fontSize: 11.5,
                    fontWeight: FontWeight.w700,
                    color: bucketDay.deltaMinor >= 0 ? context.c.credit : context.c.debit,
                  ),
                ),
              ],
            ),
          ],
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

  /// Opens a list to pick from rather than toggling, so it says so.
  final bool dropdown;

  const _FilterChip({required this.label, required this.on, required this.onTap, this.color, this.dropdown = false});

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
              if (dropdown) ...[
                const SizedBox(width: 2),
                Icon(Icons.arrow_drop_down, size: 16, color: on ? context.c.brandDark : context.c.muted),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

/// Scans the inbox and the mailbox together — from the outside it is one
/// question, "have I missed anything?", so it is one button.
class _SyncButton extends StatelessWidget {
  final bool busy;
  final VoidCallback onTap;

  const _SyncButton({required this.busy, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return GestureDetector(
      onTap: busy ? null : onTap,
      child: Container(
        width: 44,
        height: 44,
        decoration: BoxDecoration(
          color: c.surface,
          border: Border.all(color: c.lineStrong),
          borderRadius: BorderRadius.circular(T.rSm),
        ),
        child: busy
            ? Padding(
                padding: const EdgeInsets.all(13),
                child: CircularProgressIndicator(strokeWidth: 2, color: c.muted),
              )
            : Icon(Icons.sync, size: 19, color: c.ink70),
      ),
    );
  }
}
