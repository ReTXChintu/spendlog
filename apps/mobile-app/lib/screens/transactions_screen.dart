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
  /// A week a page: the list loads the latest days of the month first and
  /// pulls in the week before as you scroll, rather than the whole ledger.
  static const _daysPerPage = 7;

  /// How close to the end of the list the next week starts loading, so it
  /// is usually there before you reach it.
  static const _loadMoreWithin = 600.0;

  List<DayGroup>? _days;
  bool _hasMore = false;
  String? _nextBefore;
  bool _loadingMore = false;
  bool _loadMoreFailed = false;
  final _scroll = ScrollController();

  /// Bumped by every fresh load, so a reply for a month or filter that has
  /// since been left is dropped instead of landing on the wrong list.
  int _generation = 0;

  /// The user's months, newest first, pay day to pay day. The list only
  /// ever shows one of them (unless an account brings its own range), so
  /// the ledger never comes down whole.
  List<UserMonth> _months = [];
  String _currentMonthKey = '';
  int _monthIndex = 0;

  List<Category> _categories = [];
  List<Account> _accounts = [];
  AnalyticsSummary? _summary;
  bool _hasGmail = false;
  bool _error = false;

  List<CardStatus> _cards = [];

  /// The month on show against its budget, for the month bar. Null until
  /// it arrives, and for a month with no budget the bar simply says less.
  MonthlyBudgetStatus? _budget;

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
    _scroll.addListener(_maybeLoadMore);
    _loadContext();
    final initialAccountId = widget.initialAccountId;
    if (initialAccountId != null) {
      // Loads the ledger itself once the cycle is known, so the first rows
      // shown are already the current cycle's rather than all time's. The
      // months still load, for "Back to months".
      _loadMonths(thenLoadLedger: false);
      _pickAccount(initialAccountId);
    } else {
      // The ledger waits for the months, so the first load is one month
      // rather than everything.
      _loadMonths(thenLoadLedger: true);
    }
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  /// The month on show, or null when the months could not be loaded.
  UserMonth? get _month => _monthIndex < _months.length ? _months[_monthIndex] : null;

  int get _currentMonthIndex {
    final index = _months.indexWhere((m) => m.month == _currentMonthKey);
    return index < 0 ? 0 : index;
  }

  bool get _onCurrentMonth => _monthIndex == _currentMonthIndex;

  /// An account brings its own dates (a statement cycle, or all time),
  /// which stand in for the month.
  bool get _ownRange => _accountId != null;

  String _rangeLabel(String from, String to) => '${formatIsoShortDate(from)} – ${formatIsoShortDate(to)}';

  String get _monthLabel {
    final month = _month;
    if (month == null) return '';
    if (month.from.isEmpty || month.to.isEmpty) return readableMonth(month.label.isEmpty ? month.month : month.label);
    return _rangeLabel(month.from, month.to);
  }

  Future<void> _loadMonths({required bool thenLoadLedger}) async {
    try {
      final months = UserMonths.fromJson(
        await ApiClient.instance.get('/analytics/months') as Map<String, dynamic>,
      );
      if (!mounted) return;
      setState(() {
        _months = months.months;
        _currentMonthKey = months.current;
        _monthIndex = _currentMonthIndex;
      });
    } catch (_) {
      // Without the months there is no range to send, so the list falls
      // back to paging the whole ledger — slower, but still usable.
    }
    if (!mounted) return;
    unawaited(_loadSummary());
    unawaited(_loadBudget());
    if (thenLoadLedger) await load();
  }

  void _goToMonth(int index) {
    if (index < 0 || index >= _months.length || index == _monthIndex) return;
    setState(() => _monthIndex = index);
    _loadSummary();
    _loadBudget();
    load();
  }

  /// Drops the account (and its dates) and goes back to the month that
  /// was showing before it.
  void _backToMonths() => _setFilter(() {
        _accountId = null;
        _cycles = null;
        _cycle = null;
        _loadingCycles = false;
      });

  String _filterQuery() {
    final month = _month;
    final cycle = _cycle;
    final params = <String, String>{
      'days': '$_daysPerPage',
      if (_query.isNotEmpty) 'q': _query,
      if (_categoryId != null) 'categoryId': _categoryId!,
      if (_direction.isNotEmpty) 'type': _direction,
      if (_accountId != null) 'accountId': _accountId!,
      if (_ownRange && cycle != null) ...{'from': cycle.from, 'to': cycle.to},
      if (!_ownRange && month != null && month.from.isNotEmpty && month.to.isNotEmpty) ...{
        'from': month.from,
        'to': month.to,
      },
    };
    return Uri(queryParameters: params).query;
  }

  /// Narrows the ledger to one account, starting on its current cycle —
  /// "what went on this card this statement" is the question being asked
  /// far more often than "everything it ever did".
  Future<void> _pickAccount(String? id) async {
    // Any load still in flight was for the old range.
    _generation++;
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
        ApiClient.instance.get('/ingestion/email/status'),
      ]);
      if (!mounted) return;
      setState(() {
        _categories =
            (results[0] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
        _accounts = (results[1] as List<dynamic>).map((a) => Account.fromJson(a as Map<String, dynamic>)).toList();
        _hasGmail = (results[2] as List<dynamic>).any((c) => (c as Map<String, dynamic>)['needsReconnect'] != true);
      });
    } catch (_) {
      // The ledger still works without the rollup and the chips.
    }

    // Card cycles, for the strip above the list. Advisory, so it never
    // stops the ledger loading. The pace in that strip comes with the
    // month's budget instead.
    try {
      final cards = await ApiClient.instance.get('/cards') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _cards = cards.map((c) => CardStatus.fromJson(c as Map<String, dynamic>)).toList();
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
  /// The spent/received rollup for the month on show. Asked for by key, so
  /// stepping back a month moves the totals with the list.
  Future<void> _loadSummary() async {
    final key = _month?.month;
    try {
      final path = key == null || key.isEmpty
          ? '/analytics/summary'
          : '/analytics/summary?${Uri(queryParameters: {'month': key}).query}';
      final summary = AnalyticsSummary.fromJson(await ApiClient.instance.get(path) as Map<String, dynamic>);
      // Another month may have been picked while this one loaded.
      if (!mounted || _month?.month != key) return;
      setState(() => _summary = summary);
    } catch (_) {
      // The ledger still works without the rollup.
    }
  }

  /// The month on show against the budget it had, for the month bar.
  /// Asked for by key, like the rollup, so a past month shows what it came
  /// to against its own budget rather than this month's.
  Future<void> _loadBudget() async {
    final key = _month?.month;
    // A refresh of the same month keeps its bar up until the new figures
    // land; another month's must not linger under this one's name.
    if (mounted && _budget?.month.key != key) setState(() => _budget = null);
    try {
      final path = key == null || key.isEmpty ? '/budget/monthly' : '/budget/monthly/${Uri.encodeComponent(key)}';
      final budget = MonthlyBudgetStatus.fromJson(await ApiClient.instance.get(path) as Map<String, dynamic>);
      if (!mounted || _month?.month != key) return;
      setState(() => _budget = budget);
    } catch (_) {
      // The bar still steps through months without it.
    }
  }

  Future<void> load({bool keepVisible = false}) async {
    final generation = ++_generation;
    setState(() {
      if (!keepVisible) _days = null;
      _loadingMore = false;
      _loadMoreFailed = false;
    });
    try {
      final result = await ApiClient.instance.get('/transactions/by-day?${_filterQuery()}') as Map<String, dynamic>;
      if (!mounted || generation != _generation) return;
      setState(() {
        _days = (result['days'] as List<dynamic>).map((d) => DayGroup.fromJson(d as Map<String, dynamic>)).toList();
        _hasMore = result['hasMore'] as bool? ?? false;
        _nextBefore = result['nextBefore'] as String?;
        _error = false;
      });
      _checkAfterLayout();
    } catch (_) {
      if (mounted && generation == _generation) setState(() => _error = true);
    }
  }

  Future<void> _loadMore() async {
    final before = _nextBefore;
    if (before == null || _loadingMore) return;
    final generation = _generation;
    setState(() {
      _loadingMore = true;
      _loadMoreFailed = false;
    });
    try {
      final result = await ApiClient.instance
              .get('/transactions/by-day?${_filterQuery()}&before=${Uri.encodeQueryComponent(before)}')
          as Map<String, dynamic>;
      if (!mounted || generation != _generation) return;
      setState(() {
        _days = [
          ...?_days,
          ...(result['days'] as List<dynamic>).map((d) => DayGroup.fromJson(d as Map<String, dynamic>)),
        ];
        _hasMore = result['hasMore'] as bool? ?? false;
        _nextBefore = result['nextBefore'] as String?;
        _loadingMore = false;
      });
      _checkAfterLayout();
    } catch (_) {
      // Keep what's already on screen. Scrolling stops retrying on its own,
      // or a bad connection would be hit on every pixel scrolled; the row
      // at the bottom offers the retry instead.
      if (mounted && generation == _generation) {
        setState(() {
          _loadingMore = false;
          _loadMoreFailed = true;
        });
      }
    }
  }

  /// Infinite scroll: fetch the week before once the end of the list is
  /// close.
  void _maybeLoadMore() {
    if (!mounted || !_hasMore || _loadingMore || _loadMoreFailed || !_scroll.hasClients) return;
    if (_scroll.position.extentAfter < _loadMoreWithin) _loadMore();
  }

  /// A week with few rows may not fill the screen, and then there is no
  /// scrolling to trigger the next one — so check once it has been laid out.
  void _checkAfterLayout() => WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoadMore());

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

  /// Stays on the month (or range) already showing.
  Future<void> _refreshAll({bool keepVisible = false}) =>
      Future.wait([load(keepVisible: keepVisible), _loadContext(), _loadSummary(), _loadBudget()]);

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
          // On top of everything: which month this is decides what the rest
          // of the screen is about.
          const SizedBox(height: 10),
          _monthBar(c),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 2, 16, 10),
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
          CardStrip(cards: _cards, pace: currentMonthPace(_budget)),
          Expanded(child: _buildBody(uncategorized)),
        ],
      ),
    );
  }

  /// Which month the list is showing, stepped one at a time. An account's
  /// own dates take its place, and then the bar says so and offers the way
  /// back.
  Widget _monthBar(SpendColors c) {
    final String title;
    final String note;
    if (_ownRange) {
      final cycle = _cycle;
      if (_loadingCycles) {
        title = 'Loading…';
      } else if (cycle == null) {
        title = 'All time';
      } else {
        title = _rangeLabel(cycle.from, cycle.to);
      }
      note = 'your own range';
    } else {
      // The months could not be loaded: nothing to step through.
      if (_month == null) return const SizedBox.shrink();
      title = _monthLabel;
      note = _onCurrentMonth ? 'this month' : '';
    }

    final canGoBack = !_ownRange && _monthIndex + 1 < _months.length;
    final canGoForward = !_ownRange && _monthIndex > _currentMonthIndex;

    final budget = _ownRange ? null : _budget;

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 2, 16, 8),
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              if (!_ownRange)
                IconButton(
                  onPressed: canGoBack ? () => _goToMonth(_monthIndex + 1) : null,
                  icon: const Icon(Icons.chevron_left),
                  color: c.ink,
                  disabledColor: c.mutedLight,
                  tooltip: 'The month before',
                  visualDensity: VisualDensity.compact,
                )
              else
                const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: _ownRange ? CrossAxisAlignment.start : CrossAxisAlignment.center,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      title,
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: c.ink),
                    ),
                    if (note.isNotEmpty)
                      Text(note, style: TextStyle(fontSize: 11, color: c.muted, fontWeight: FontWeight.w600)),
                  ],
                ),
              ),
              if (!_ownRange)
                IconButton(
                  onPressed: canGoForward ? () => _goToMonth(_monthIndex - 1) : null,
                  icon: const Icon(Icons.chevron_right),
                  color: c.ink,
                  disabledColor: c.mutedLight,
                  tooltip: 'The month after',
                  visualDensity: VisualDensity.compact,
                ),
              if (_ownRange)
                TextButton(onPressed: _backToMonths, child: const Text('Back to months'))
              else if (!_onCurrentMonth)
                TextButton(onPressed: () => _goToMonth(_currentMonthIndex), child: const Text('This month')),
            ],
          ),
          if (budget != null && budget.configured) _monthBudget(c, budget),
        ],
      ),
    );
  }

  /// The month on show against its budget: a bar, what went, and what is
  /// left - or, once the month is over, what it put into savings.
  Widget _monthBudget(SpendColors c, MonthlyBudgetStatus budget) {
    final total = budget.budgetMinor ?? 0;
    final left = budget.leftMinor ?? total - budget.spentMinor;
    final over = left < 0;
    final tint = over ? c.debit : ((budget.pace?.isHigh ?? false) ? c.warn : c.brand);
    final fraction = total > 0 ? (budget.spentMinor / total).clamp(0.0, 1.0) : 0.0;

    final String outcome;
    if (over) {
      outcome = '${formatMoneyShort(-left)} over';
    } else if (budget.month.isClosed) {
      outcome = '${formatMoneyShort(left)} to savings';
    } else {
      outcome = '${formatMoneyShort(left)} left';
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(100),
            child: LinearProgressIndicator(
              value: fraction,
              minHeight: 5,
              backgroundColor: c.track,
              valueColor: AlwaysStoppedAnimation(tint),
            ),
          ),
          const SizedBox(height: 5),
          Row(
            children: [
              Expanded(
                child: Text(
                  '${formatMoneyShort(budget.spentMinor)} of ${formatMoneyShort(total)} budget',
                  style: kNum.copyWith(fontSize: 11.5, color: c.muted),
                ),
              ),
              Text(
                outcome,
                style: kNum.copyWith(fontSize: 11.5, fontWeight: FontWeight.w700, color: over ? c.debit : c.ink70),
              ),
            ],
          ),
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
        // If the months were what failed, try them again first, so a retry
        // does not fall back to the whole ledger.
        onAction: _months.isEmpty && !_ownRange ? () => _loadMonths(thenLoadLedger: true) : load,
      );
    }

    if (_days == null) return const Center(child: CircularProgressIndicator());

    final month = _month;
    final monthBefore = !_ownRange && _monthIndex + 1 < _months.length ? _monthIndex + 1 : null;

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
                      body: _ownRange
                          ? 'No transaction fits this combination. Clear a filter to see more.'
                          : 'No transaction in $_monthLabel fits this combination. Clear a filter, or try '
                              'another month.',
                      actionLabel: 'Clear filters',
                      onAction: _clearFilters,
                    )
                  // An empty past month is just a quiet month, not a sign
                  // that nothing is connected.
                  : month != null && !_onCurrentMonth
                      ? StateBlock(
                          icon: Icons.event_busy_outlined,
                          title: 'Nothing in $_monthLabel',
                          body: 'No transactions were recorded in this month.',
                          actionLabel: monthBefore == null ? null : 'Go to the month before',
                          onAction: monthBefore == null ? null : () => _goToMonth(monthBefore),
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
        controller: _scroll,
        // The pull-to-refresh and the near-the-end check both need it to
        // scroll even when a short week does not fill the screen.
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(top: 10, bottom: 90),
        children: [
          if (_summary != null && !_filtersActive) _MonthRollup(summary: _summary!, current: _onCurrentMonth),
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
                selectable: _selecting,
                selected: _selectedIds.contains(transaction.id),
                onToggleSelected: () => _toggleSelected(transaction),
                onLongPress: _selecting ? null : () => _startSelecting(transaction),
              ),
            const SizedBox(height: 22),
          ],
          if (_hasMore && _loadMoreFailed)
            _EndRow(
              text: "Couldn't load the week before. Tap to try again",
              icon: Icons.refresh,
              onTap: _loadMore,
            )
          else if (_hasMore)
            const _LoadingMoreRow()
          else if (!_ownRange && month != null)
            _EndRow(
              text: monthBefore == null
                  ? "That's all for $_monthLabel."
                  : "That's all for $_monthLabel. Go to the month before",
              icon: monthBefore == null ? null : Icons.chevron_left,
              onTap: monthBefore == null ? null : () => _goToMonth(monthBefore),
            ),
        ],
      ),
    );
  }
}

/// Sits at the end of the list while the week before is on its way.
class _LoadingMoreRow extends StatelessWidget {
  const _LoadingMoreRow();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          SizedBox(
            width: 14,
            height: 14,
            child: CircularProgressIndicator(strokeWidth: 2, color: context.c.muted),
          ),
          const SizedBox(width: 10),
          Text(
            'Loading the week before…',
            style: TextStyle(fontSize: 12, color: context.c.muted, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

/// The last row of the list: the end of the month, with the way into the
/// one before, or a retry when the next week failed to load.
class _EndRow extends StatelessWidget {
  final String text;
  final IconData? icon;
  final VoidCallback? onTap;

  const _EndRow({required this.text, this.icon, this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(T.rSm),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 12),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[
                Icon(icon, size: 16, color: c.brandDark),
                const SizedBox(width: 6),
              ],
              Flexible(
                child: Text(
                  text,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600,
                    color: onTap == null ? c.muted : c.brandDark,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MonthRollup extends StatelessWidget {
  final AnalyticsSummary summary;

  /// A past month is over, so "since 15 Sep" would misdescribe it; the
  /// month bar above already names its dates.
  final bool current;
  const _MonthRollup({required this.summary, this.current = true});

  @override
  Widget build(BuildContext context) {
    // The rollup names the month it covers: "Spent (Sep)" for a calendar
    // month, "Spent since 15 Sep" for one that runs pay day to pay day -
    // calling that one "Oct" on the 2nd would be wrong.
    final from = summary.from;
    final String spentLabel;
    if (!current) {
      spentLabel = 'Spent';
    } else if (from.isEmpty) {
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
