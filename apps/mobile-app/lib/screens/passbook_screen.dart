import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/reconcile_sheet.dart';
import '../widgets/state_block.dart';
import '../widgets/transaction_tile.dart' show AutoLegChip;
import '../widgets/what_came_in_sheet.dart';
import 'start_fresh_screen.dart';

/// An account's passbook: every row that moved it, newest first, with what
/// SpendLog expected it to hold after each one beside what the bank said
/// it held - and where the two first parted.
///
/// A bank balance drifting from the app used to be a number that was
/// wrong with nothing to say why. This is the page that says where. The
/// bank's own figure comes from its SMS when it includes one, and from a
/// checkpoint typed in from the bank app when it does not; many banks
/// never send one, and the page says so rather than looking broken.
class PassbookScreen extends StatefulWidget {
  const PassbookScreen({
    super.key,
    required this.accountId,
    this.alertId,
    this.openReconcile = false,
  });

  final String accountId;

  /// The drift alert this was opened from, marked seen once the passbook
  /// is up - it has been looked at.
  final String? alertId;

  /// Opened to find the cause: the reconcile sheet comes up over the
  /// passbook as soon as it has loaded.
  final bool openReconcile;

  /// Pushes the passbook. A debit card has none of its own - it spends
  /// from its bank account - and the server says which; that account's
  /// passbook opens in its place, so a card tile is as good a way in.
  static Future<void> open(
    BuildContext context, {
    required String accountId,
    String? alertId,
    bool openReconcile = false,
  }) {
    return Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => PassbookScreen(accountId: accountId, alertId: alertId, openReconcile: openReconcile),
      ),
    );
  }

  @override
  State<PassbookScreen> createState() => PassbookScreenState();
}

class PassbookScreenState extends State<PassbookScreen> {
  static const _pageSize = 50;

  /// The server's most a page can be, for a reload of everything on screen.
  static const _maxPage = 200;

  /// How close to the end of the list the next page starts loading.
  static const _loadMoreWithin = 600.0;

  /// The account on show. A debit card hands over to its bank account.
  late String _accountId = widget.accountId;

  PassbookPage? _page;
  List<PassbookRow> _rows = const [];
  int? _nextBefore;
  bool _loadingMore = false;
  bool _loadMoreFailed = false;
  String? _error;
  PassbookRefusal? _refusal;

  /// Bumped by every fresh load, so a late page for the list that was
  /// replaced is dropped rather than appended.
  int _generation = 0;

  final _scroll = ScrollController();

  /// The row "Jump to it" is heading for, tinted for a moment on arrival.
  int? _highlightSeq;
  final _highlightKey = GlobalKey();
  Timer? _highlightTimer;

  bool _seenSent = false;
  bool _reconcileOpened = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadMore);
    _load();
  }

  @override
  void dispose() {
    _highlightTimer?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  String get _base => '/accounts/$_accountId';

  Future<Map<String, dynamic>> _fetch({int? before, int limit = _pageSize}) async {
    final params = <String, String>{'limit': '$limit', if (before != null) 'before': '$before'};
    return await ApiClient.instance.get('$_base/passbook?${Uri(queryParameters: params).query}') as Map<String, dynamic>;
  }

  /// The first page - or, after an edit, every page already on screen
  /// again, so a changed row updates in place without losing the scroll.
  Future<void> _load({bool keepVisible = false}) async {
    final generation = ++_generation;
    final limit = keepVisible ? _rows.length.clamp(_pageSize, _maxPage) : _pageSize;
    if (!keepVisible) {
      setState(() {
        _page = null;
        _rows = const [];
        _error = null;
        _refusal = null;
        _loadingMore = false;
        _loadMoreFailed = false;
      });
    }
    try {
      final json = await _fetch(limit: limit);
      if (!mounted || generation != _generation) return;
      final page = PassbookPage.fromJson(json);
      setState(() {
        _page = page;
        _rows = page.rows;
        _nextBefore = page.nextBefore;
        _error = null;
        _refusal = null;
        _loadingMore = false;
        _loadMoreFailed = false;
      });
      _afterFirstLoad();
      _checkAfterLayout();
    } on ApiException catch (e) {
      if (!mounted || generation != _generation) return;
      // A 400 is the server's own sentence: a debit card (with the bank
      // account to open instead), a credit card, or no starting balance.
      final body = e.body;
      final refusal = e.statusCode == 400
          ? PassbookRefusal.fromJson(body is Map<String, dynamic> ? body : {'error': e.message})
          : null;
      if (refusal?.accountId != null && refusal!.accountId != _accountId) {
        _accountId = refusal.accountId!;
        unawaited(_load());
        return;
      }
      setState(() {
        _refusal = refusal;
        _error = e.message;
      });
    } catch (_) {
      if (mounted && generation == _generation) setState(() => _error = "Couldn't reach the server.");
    }
  }

  void _afterFirstLoad() {
    final alertId = widget.alertId;
    if (alertId != null && !_seenSent) {
      _seenSent = true;
      // Looked at: the dashboard's to-do goes. Nothing waits on it.
      unawaited(ApiClient.instance.post('/accounts/alerts/$alertId/seen').catchError((_) => null));
    }
    if (widget.openReconcile && !_reconcileOpened) {
      _reconcileOpened = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _findTheCause());
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
      final json = await _fetch(before: before);
      if (!mounted || generation != _generation) return;
      final page = PassbookPage.fromJson(json);
      setState(() {
        _rows = [..._rows, ...page.rows];
        _nextBefore = page.nextBefore;
        _loadingMore = false;
      });
      _checkAfterLayout();
    } catch (_) {
      if (mounted && generation == _generation) {
        setState(() {
          _loadingMore = false;
          _loadMoreFailed = true;
        });
      }
    }
  }

  void _maybeLoadMore() {
    if (!mounted || _nextBefore == null || _loadingMore || _loadMoreFailed || !_scroll.hasClients) return;
    if (_scroll.position.extentAfter < _loadMoreWithin) _loadMore();
  }

  /// A short history may not fill the screen, so check once laid out.
  void _checkAfterLayout() => WidgetsBinding.instance.addPostFrameCallback((_) => _maybeLoadMore());

  // ---- Jumping to where it went wrong ----------------------------------

  /// Pages back until the row is loaded, then scrolls to it.
  Future<void> _jumpTo(FirstDrift drift) async {
    // Older rows have lower seqs; the page cursor is the oldest loaded.
    var guard = 0;
    while (mounted && !_rows.any((row) => row.seq == drift.seq) && _nextBefore != null && guard < 40) {
      guard += 1;
      await _loadMore();
      if (_loadMoreFailed) return;
    }
    if (!mounted) return;
    final index = _items.indexWhere((item) => item.row?.seq == drift.seq);
    if (index < 0) return;

    _highlightTimer?.cancel();
    setState(() => _highlightSeq = drift.seq);
    _highlightTimer = Timer(const Duration(seconds: 4), () {
      if (mounted) setState(() => _highlightSeq = null);
    });

    // Rows off screen are not built, so there is nothing to measure yet:
    // land near it by estimate, then let the built row pull itself into
    // view on the next frame.
    if (_scroll.hasClients) {
      final estimate = _kHeaderEstimate + index * _kRowEstimate;
      _scroll.jumpTo(estimate.clamp(0.0, _scroll.position.maxScrollExtent));
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final context = _highlightKey.currentContext;
      if (context != null) {
        Scrollable.ensureVisible(context, alignment: 0.25, duration: const Duration(milliseconds: 250));
      }
    });
  }

  static const _kHeaderEstimate = 200.0;
  static const _kRowEstimate = 68.0;

  // ---- Actions ---------------------------------------------------------

  Future<void> _findTheCause() async {
    final changed = await showReconcileSheet(context, accountId: _accountId);
    if (changed == true && mounted) await _load(keepVisible: true);
  }

  Future<void> _openRow(PassbookRow row) async {
    final creditId = row.missingCreditId;
    if (row.isMissingCredit && creditId != null) {
      final changed = await showWhatCameInById(context, creditId);
      if (changed == true && mounted) await _load(keepVisible: true);
      return;
    }
    final id = row.transactionId;
    if (id == null) return;
    final changed = await showEditTransactionById(context, id);
    if (changed == true && mounted) await _load(keepVisible: true);
  }

  Future<void> _addCheckpoint() async {
    final page = _page;
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => _CheckpointDialog(isCash: page?.account.isCash ?? false),
    );
    if (result == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.post('$_base/checkpoints', result);
      await _load(keepVisible: true);
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "Couldn't save that checkpoint.")),
      );
    }
  }

  /// This account alone, started again from what the bank shows now.
  Future<void> _startFresh() async {
    final page = _page;
    if (page == null) return;
    final stated = page.lastStated;
    final today = stated != null && formatShortDate(stated.at) == formatShortDate(DateTime.now()) ? stated.minor : null;
    final minor = await showDialog<int>(
      context: context,
      builder: (_) => _FreshStartDialog(isCash: page.account.isCash, initialMinor: today),
    );
    if (minor == null || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await ApiClient.instance.post('$_base/start-fresh', {'balanceMinor': minor}) as Map<String, dynamic>?;
      final note = result?['note'];
      messenger.showSnackBar(SnackBar(
        content: Text(['Started fresh from ${formatMoney(minor)}.', if (note is String) note].join(' ')),
      ));
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : "Couldn't start fresh just now.")));
    }
  }

  Future<void> _startFreshEverywhere() async {
    final changed = await StartFreshScreen.open(context);
    if (changed == true && mounted) await _load();
  }

  Future<void> _undoFreshStart() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Undo the fresh start?'),
        content: const Text('The starting balance before it comes back, with the alerts and to-dos it cleared.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Undo')),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.post('$_base/start-fresh/undo');
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : "Couldn't undo that.")));
    }
  }

  Future<void> _deleteCheckpoint(PassbookRow row) async {
    final id = row.checkpointId;
    if (id == null) return;
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Forget this checkpoint?'),
        content: Text(
          'The ${formatMoney(row.statedMinor ?? 0)} you noted on ${formatShortDate(row.on)} is removed. '
          'Nothing else changes.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Forget')),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.delete('$_base/checkpoints/$id');
      await _load(keepVisible: true);
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "Couldn't remove that.")),
      );
    }
  }

  // ---- Layout ----------------------------------------------------------

  /// The list, flattened: a day header before each day's rows.
  List<_Item> get _items {
    final items = <_Item>[];
    String? day;
    for (final row in _rows) {
      if (row.day != day) {
        day = row.day;
        items.add(_Item.header(day));
      }
      items.add(_Item.row(row));
    }
    return items;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final page = _page;

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Passbook', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
            if (page != null)
              Text(page.account.label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: c.muted)),
          ],
        ),
        shape: Border(bottom: BorderSide(color: c.line)),
        actions: [
          if (page != null)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: TextButton.icon(
                onPressed: _addCheckpoint,
                icon: const Icon(Icons.flag_outlined, size: 18),
                label: const Text('Add checkpoint'),
              ),
            ),
          if (page != null)
            PopupMenuButton<String>(
              key: const ValueKey('passbook-menu'),
              tooltip: 'More',
              onSelected: (value) {
                if (value == 'fresh') _startFresh();
                if (value == 'fresh-all') _startFreshEverywhere();
                if (value == 'undo') _undoFreshStart();
              },
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'fresh', child: Text('Start fresh from today')),
                const PopupMenuItem(value: 'fresh-all', child: Text('Start fresh for every account…')),
                if (page.account.canUndoFreshStart) const PopupMenuItem(value: 'undo', child: Text('Undo fresh start')),
              ],
            ),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    final page = _page;

    if (page == null) {
      final refusal = _refusal;
      if (refusal != null) {
        return StateBlock(
          icon: Icons.menu_book_outlined,
          title: 'No passbook here',
          body: refusal.error,
          actionLabel: 'Back',
          onAction: () => Navigator.of(context).maybePop(),
        );
      }
      if (_error != null) {
        return StateBlock(
          icon: Icons.wifi_off,
          warn: true,
          title: "Couldn't load the passbook",
          body: _error!,
          actionLabel: 'Try again',
          onAction: _load,
        );
      }
      return const Center(child: CircularProgressIndicator());
    }

    final items = _items;
    final drift = page.firstDrift;

    return RefreshIndicator(
      onRefresh: () => _load(keepVisible: true),
      child: CustomScrollView(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: _Header(page: page, onAddCheckpoint: _addCheckpoint, onFindTheCause: _findTheCause),
          ),
          // Pinned under the header: where it went wrong stays in sight
          // however far back the ledger is scrolled.
          if (drift != null)
            SliverPersistentHeader(
              pinned: true,
              delegate: _StripDelegate(
                child: _DriftStrip(
                  drift: drift,
                  onJump: () => _jumpTo(drift),
                  onFindTheCause: _findTheCause,
                ),
              ),
            ),
          SliverPadding(
            padding: const EdgeInsets.only(top: 6, bottom: 40),
            sliver: SliverList.builder(
              itemCount: items.length + 1,
              itemBuilder: (context, index) {
                if (index == items.length) return _tail();
                final item = items[index];
                final header = item.day;
                if (header != null) return _DayHeader(day: header);
                final row = item.row!;
                final highlighted = row.seq == _highlightSeq;
                return _PassbookRowTile(
                  key: highlighted ? _highlightKey : ValueKey('row-${row.seq}'),
                  row: row,
                  isCash: page.account.isCash,
                  startedFresh: page.account.canUndoFreshStart,
                  highlighted: highlighted,
                  onTap: row.isTransaction || row.isMissingCredit ? () => _openRow(row) : null,
                  onLongPress: row.isCheckpoint ? () => _deleteCheckpoint(row) : null,
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _tail() {
    final c = context.c;
    if (_loadMoreFailed) {
      return _EndRow(text: "Couldn't load the rows before. Tap to try again", icon: Icons.refresh, onTap: _loadMore);
    }
    if (_nextBefore != null) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: c.muted)),
            const SizedBox(width: 10),
            Text('Loading earlier rows…', style: TextStyle(fontSize: 12, color: c.muted, fontWeight: FontWeight.w600)),
          ],
        ),
      );
    }
    return const _EndRow(text: 'That is the whole history since the starting balance.');
  }
}

class _Item {
  final String? day;
  final PassbookRow? row;
  const _Item.header(this.day) : row = null;
  const _Item.row(this.row) : day = null;
}

/// The account at a glance: what SpendLog expects now, what the bank last
/// said, and how far apart they are - or that the bank has never said.
class _Header extends StatelessWidget {
  const _Header({required this.page, required this.onAddCheckpoint, required this.onFindTheCause});

  final PassbookPage page;
  final VoidCallback onAddCheckpoint;
  final VoidCallback onFindTheCause;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final stated = page.lastStated;
    final where = page.account.isCash ? 'Your wallet' : 'Bank';

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 14, 16, 8),
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
            'SPENDLOG EXPECTS',
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted),
          ),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              formatMoney(page.expectedNowMinor),
              style: kNum.copyWith(
                fontSize: 28,
                fontWeight: FontWeight.w800,
                color: page.expectedNowMinor < 0 ? c.debit : c.ink,
              ),
            ),
          ),
          if (page.provisionalMinor > 0) ...[
            const SizedBox(height: 2),
            Text(
              'Includes ${formatMoney(page.provisionalMinor)} not yet explained',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.warn),
            ),
          ],
          const SizedBox(height: 10),
          if (stated == null) ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.info_outline, size: 16, color: c.muted),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    page.account.isCash
                        ? 'Nothing says what your wallet really holds. Count it and add a checkpoint.'
                        : "This bank doesn't send balances in its SMS. Add a checkpoint from your bank app.",
                    style: TextStyle(fontSize: 12.8, height: 1.45, color: c.ink70),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            OutlinedButton.icon(
              onPressed: onAddCheckpoint,
              icon: const Icon(Icons.flag_outlined, size: 17),
              label: const Text('Add a checkpoint'),
            ),
          ] else ...[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: RichText(
                    text: TextSpan(
                      style: TextStyle(fontSize: 13, height: 1.4, color: c.ink70),
                      children: [
                        TextSpan(text: '$where said '),
                        TextSpan(
                          text: formatMoney(stated.minor),
                          style: kNum.copyWith(fontWeight: FontWeight.w800, color: c.ink),
                        ),
                        TextSpan(text: ' on ${formatShortDate(stated.at)}'),
                      ],
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                _DriftChip(driftMinor: stated.driftMinor, large: true),
              ],
            ),
            if (stated.isOff) ...[
              const SizedBox(height: 6),
              Text(
                stated.driftMinor < 0
                    ? 'SpendLog shows more than the bank: a payment is probably missing.'
                    : 'The bank shows more than SpendLog: money in is probably missing.',
                style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
              ),
              // The strip under this header is the usual way in; when the
              // ledger cannot say where the figures parted there is no
              // strip, so the offer is made here.
              if (page.firstDrift == null) ...[
                const SizedBox(height: 10),
                FilledButton.tonal(onPressed: onFindTheCause, child: const Text('Find the cause')),
              ],
            ],
          ],
        ],
      ),
    );
  }
}

/// Where the figures first parted, pinned under the header.
class _DriftStrip extends StatelessWidget {
  const _DriftStrip({required this.drift, required this.onJump, required this.onFindTheCause});

  final FirstDrift drift;
  final VoidCallback onJump;
  final VoidCallback onFindTheCause;

  static const height = 76.0;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      height: height,
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 6),
      decoration: BoxDecoration(
        color: c.warnBg,
        border: Border(bottom: BorderSide(color: c.line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(Icons.call_split, size: 16, color: c.warn),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'The figures part on ${formatShortDate(drift.on)} (${formatMoneyShort(drift.driftMinor.abs())})',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.warn),
                ),
              ),
            ],
          ),
          const SizedBox(height: 2),
          // The two actions on their own line, right-aligned; shrunk
          // rather than clipped on a narrow phone.
          Align(
            alignment: Alignment.centerRight,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerRight,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextButton(
                    onPressed: onJump,
                    style: TextButton.styleFrom(
                      foregroundColor: c.warn,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      minimumSize: const Size(0, 36),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      textStyle: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
                    ),
                    child: const Text('Jump to it'),
                  ),
                  const SizedBox(width: 4),
                  FilledButton.tonal(
                    onPressed: onFindTheCause,
                    style: FilledButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      minimumSize: const Size(0, 36),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      textStyle: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700),
                    ),
                    child: const Text('Find the cause'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _StripDelegate extends SliverPersistentHeaderDelegate {
  const _StripDelegate({required this.child});

  final Widget child;

  @override
  double get minExtent => _DriftStrip.height;

  @override
  double get maxExtent => _DriftStrip.height;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) => child;

  @override
  bool shouldRebuild(covariant _StripDelegate oldDelegate) => oldDelegate.child != child;
}

/// The gap, as a small chip: red when past a rupee, green within it.
class _DriftChip extends StatelessWidget {
  const _DriftChip({required this.driftMinor, this.large = false});

  final int driftMinor;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final off = driftIsOff(driftMinor);
    final label = off
        ? '${large ? formatMoney(driftMinor.abs()) : formatMoneyShort(driftMinor.abs())} off'
        : driftMinor == 0
            ? 'Matches'
            : '${formatMoney(driftMinor.abs())} · matches';
    return Container(
      padding: EdgeInsets.symmetric(horizontal: large ? 9 : 6, vertical: large ? 4 : 1.5),
      decoration: BoxDecoration(
        color: off ? c.debit50 : c.credit50,
        borderRadius: BorderRadius.circular(100),
      ),
      child: Text(
        label,
        style: kNum.copyWith(
          fontSize: large ? 12.5 : 10.5,
          fontWeight: FontWeight.w800,
          color: off ? c.debit : c.credit,
        ),
      ),
    );
  }
}

/// One line of the passbook: what moved, and the two balances after it.
///
/// Right-hand column, top to bottom: the amount, the running balance in
/// tabular figures so the column lines up down the page, and - when the
/// bank said a figure here - that figure, with the gap as a chip.
class _PassbookRowTile extends StatelessWidget {
  const _PassbookRowTile({
    super.key,
    required this.row,
    required this.isCash,
    this.startedFresh = false,
    this.highlighted = false,
    this.onTap,
    this.onLongPress,
  });

  final PassbookRow row;
  final bool isCash;

  /// The opening row is a fresh start's, and says so.
  final bool startedFresh;
  final bool highlighted;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final amount = row.amountMinor;
    final stated = row.statedMinor;

    final (IconData icon, Color iconBg, Color iconFg) = switch (row.kind) {
      'opening' => (Icons.play_arrow_rounded, c.brand50, c.brandDark),
      'checkpoint' => (Icons.flag_outlined, c.brand50, c.brandDark),
      'missing_credit' => (Icons.help_outline, c.warnBg, c.warn),
      'adjustment' => (Icons.help_outline, row.needsExplanation ? c.warnBg : c.chipNeutral, row.needsExplanation ? c.warn : c.muted),
      _ => row.isTransfer
          ? (Icons.swap_horiz, c.chipNeutral, c.transfer)
          : row.isDebit
              ? (Icons.arrow_outward, c.debit50, c.debit)
              : (Icons.south_west, c.credit50, c.credit),
    };

    final String title;
    final String subtitle;
    switch (row.kind) {
      case 'opening':
        title = startedFresh ? 'Started fresh on ${formatShortDate(row.on)}' : 'Starting balance';
        subtitle = formatTime(row.on);
      case 'missing_credit':
        // Provisional: in the running balance so it matches the bank, and
        // nowhere else until the user says what it was.
        title = 'Came in without a text';
        final from = row.windowStart;
        final window = from == null || formatShortDate(from) == formatShortDate(row.on)
            ? 'on ${formatShortDate(row.on)}'
            : 'between ${formatShortDate(from)} and ${formatShortDate(row.on)}';
        subtitle = '$window · not counted yet · tap to say what it was';
      case 'checkpoint':
        title = '${isCash ? 'Counted' : 'Bank app said'} ${formatMoney(stated ?? 0)}';
        subtitle = [formatTime(row.on), if (row.note != null) row.note!, 'hold to remove'].join(' · ');
      case 'adjustment':
        title = row.merchant ?? 'Unexplained difference';
        subtitle = [formatTime(row.on), row.needsExplanation ? 'not yet explained' : 'explained'].join(' · ');
      default:
        title = row.merchant ?? 'Unknown';
        subtitle = [
          formatTime(row.on),
          if (row.source != null) row.source!,
          if (row.isTransfer) 'transfer',
        ].join(' · ');
    }

    final amountColor = row.isMissingCredit
        ? c.warn
        : (row.isTransfer ? c.transfer : (row.isDebit ? c.debit : c.credit));
    final isAdjustmentOpen = (row.isAdjustment && row.needsExplanation) || row.isMissingCredit;

    return Material(
      color: highlighted ? c.brand50 : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
          decoration: BoxDecoration(
            color: isAdjustmentOpen && !highlighted ? c.warnBg.withValues(alpha: 0.6) : null,
            border: Border(bottom: BorderSide(color: c.line)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 32,
                height: 32,
                margin: const EdgeInsets.only(top: 1),
                decoration: BoxDecoration(color: iconBg, shape: BoxShape.circle),
                child: Icon(icon, size: 16, color: iconFg),
              ),
              const SizedBox(width: 11),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w700,
                        color: isAdjustmentOpen ? c.warn : c.ink,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11.5, color: c.muted)),
                    // The far side of a transfer, written in because this
                    // bank never texted it.
                    if (row.autoLeg) ...[
                      const SizedBox(height: 4),
                      const AutoLegChip(),
                    ],
                  ],
                ),
              ),
              const SizedBox(width: 10),
              // The figures column. Capped so a long merchant name still
              // gets room, and each line shrinks rather than wraps: an
              // amount broken over two lines is unreadable.
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 168),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    if (amount != null && row.type != null)
                      _Fit(
                        Text(
                          '${row.isDebit ? '−' : '+'}${formatMoney(amount)}',
                          style: kNum.copyWith(fontSize: 13.5, fontWeight: FontWeight.w700, color: amountColor),
                        ),
                      )
                    else
                      const SizedBox(height: 2),
                    _Fit(
                      Text(
                        formatMoney(row.runningMinor),
                        style: kNum.copyWith(
                          fontSize: amount == null ? 13.5 : 12,
                          fontWeight: amount == null ? FontWeight.w800 : FontWeight.w600,
                          color: row.runningMinor < 0 ? c.debit : (amount == null ? c.ink : c.ink70),
                        ),
                      ),
                    ),
                    if (stated != null && !row.isOpening && !row.isCheckpoint) ...[
                      const SizedBox(height: 3),
                      _Fit(
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              '${isCash ? 'wallet' : 'bank'} ${formatMoney(stated)}',
                              style: kNum.copyWith(fontSize: 11, color: c.muted),
                            ),
                            if (row.driftMinor != null && row.driftMinor != 0) ...[
                              const SizedBox(width: 5),
                              _DriftChip(driftMinor: row.driftMinor!),
                            ],
                          ],
                        ),
                      ),
                    ] else if (row.isCheckpoint && row.driftMinor != null) ...[
                      const SizedBox(height: 3),
                      _DriftChip(driftMinor: row.driftMinor!),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Shrinks a figure to the width it has rather than letting it wrap.
class _Fit extends StatelessWidget {
  const _Fit(this.child);

  final Widget child;

  @override
  Widget build(BuildContext context) =>
      FittedBox(fit: BoxFit.scaleDown, alignment: Alignment.centerRight, child: child);
}

class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.day});

  final String day;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 14, 16, 0),
      padding: const EdgeInsets.only(bottom: 6),
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.ink, width: 2))),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(formatDayLabel(day), style: TextStyle(fontWeight: FontWeight.w800, fontSize: 14, color: c.ink)),
          Text('balance after', style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: c.mutedLight)),
        ],
      ),
    );
  }
}

class _EndRow extends StatelessWidget {
  const _EndRow({required this.text, this.icon, this.onTap});

  final String text;
  final IconData? icon;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
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
                  style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: onTap == null ? c.muted : c.brandDark),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Start fresh from today" for this account: what the bank shows now.
class _FreshStartDialog extends StatefulWidget {
  const _FreshStartDialog({this.isCash = false, this.initialMinor});

  final bool isCash;
  final int? initialMinor;

  @override
  State<_FreshStartDialog> createState() => _FreshStartDialogState();
}

class _FreshStartDialogState extends State<_FreshStartDialog> {
  late final _amount = TextEditingController(
    text: widget.initialMinor == null ? '' : (widget.initialMinor! / 100).toStringAsFixed(2),
  );

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final minor = parseRupees(_amount.text, allowNegative: true);
    return AlertDialog(
      title: const Text('Start fresh from today'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Your transactions and spending stay as they are. Only this balance starts again from the figure '
            'below, as of now.',
            style: TextStyle(fontSize: 13, height: 1.45, color: c.ink70),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _amount,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
            inputFormatters: [_signedAmount],
            style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w700, color: c.ink),
            decoration: InputDecoration(
              labelText: widget.isCash ? 'What your wallet holds now' : 'What your bank shows now',
              prefixText: '₹ ',
              border: const OutlineInputBorder(),
            ),
            onChanged: (_) => setState(() {}),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(
          onPressed: minor == null ? null : () => Navigator.of(context).pop(minor),
          child: const Text('Start fresh'),
        ),
      ],
    );
  }
}

/// Digits, one minus sign at the front, and a decimal point: a balance can
/// be overdrawn, so unlike every other amount it can be negative.
final _signedAmount = FilteringTextInputFormatter.allow(RegExp(r'^-?[\d,]*\.?\d{0,2}'));

/// "My bank app shows ₹X on this date." The date is a day in IST; the
/// figure is taken as the end of that day, after everything that happened
/// in it - except today, where it means now, so a payment later this
/// evening is not set against a balance read this afternoon.
class _CheckpointDialog extends StatefulWidget {
  const _CheckpointDialog({this.isCash = false});

  final bool isCash;

  @override
  State<_CheckpointDialog> createState() => _CheckpointDialogState();
}

class _CheckpointDialogState extends State<_CheckpointDialog> {
  final _amount = TextEditingController();
  final _note = TextEditingController();

  /// A plain IST day, YYYY-MM-DD.
  String _day = istToday();

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickDay() async {
    final current = DateTime.parse(_day);
    final picked = await showDatePicker(
      context: context,
      initialDate: current,
      firstDate: DateTime(2015),
      lastDate: DateTime.parse(istToday()),
    );
    if (picked != null) setState(() => _day = picked.toIso8601String().substring(0, 10));
  }

  /// When the figure is for: the instant the day ends, in IST, or now for
  /// today.
  DateTime get _on {
    if (_day == istToday()) return DateTime.now().toUtc();
    final d = DateTime.parse(_day);
    return fromIstWallClock(DateTime(d.year, d.month, d.day, 23, 59, 59));
  }

  void _save() {
    final minor = parseRupees(_amount.text, allowNegative: true);
    if (minor == null) return;
    final note = _note.text.trim();
    Navigator.of(context).pop({
      'balanceMinor': minor,
      'on': _on.toUtc().toIso8601String(),
      if (note.isNotEmpty) 'note': note,
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final valid = parseRupees(_amount.text, allowNegative: true) != null;
    final dayLabel = _day == istToday() ? 'Today' : DateFormat('EEE, d MMM yyyy').format(DateTime.parse(_day));

    return AlertDialog(
      title: const Text('Add a checkpoint'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            widget.isCash
                ? 'Count what is in your wallet. SpendLog sets its own figure against it.'
                : 'The balance your bank app shows. SpendLog sets its own figure against it, the same as a balance '
                    'in an SMS.',
            style: TextStyle(fontSize: 13, height: 1.45, color: c.ink70),
          ),
          const SizedBox(height: 14),
          TextField(
            controller: _amount,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
            inputFormatters: [_signedAmount],
            style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w700, color: c.ink),
            decoration: InputDecoration(
              labelText: widget.isCash ? 'In the wallet' : 'Balance shown',
              prefixText: '₹ ',
              border: const OutlineInputBorder(),
            ),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Text('On', style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.muted)),
              const SizedBox(width: 8),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _pickDay,
                  icon: const Icon(Icons.calendar_today_outlined, size: 15),
                  label: Align(alignment: Alignment.centerLeft, child: Text(dayLabel, maxLines: 1, overflow: TextOverflow.ellipsis)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _note,
            maxLength: 120,
            style: TextStyle(fontSize: 14, color: c.ink),
            decoration: const InputDecoration(labelText: 'Note (optional)', border: OutlineInputBorder(), counterText: ''),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: valid ? _save : null, child: const Text('Save')),
      ],
    );
  }
}
