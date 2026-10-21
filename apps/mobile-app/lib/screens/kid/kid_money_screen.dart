import 'package:flutter/material.dart';
import '../../models/kid_models.dart';
import '../../models/models.dart';
import '../../services/api_client.dart';
import '../../services/kid_service.dart';
import '../../utils/format.dart';
import '../../widgets/ds/ds.dart';
import '../../widgets/kid_transaction_sheet.dart';
import '../../widgets/pocket_money.dart';
import '../../widgets/state_block.dart';

/// "‹ 15 Sep – 14 Oct ›" - steps through the parent's pay-day months,
/// newest first, so going back in time is a higher index.
class KidMonthBar extends StatelessWidget {
  const KidMonthBar({super.key, required this.months, required this.index, required this.onChanged});

  final List<UserMonth> months;
  final int index;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    if (months.isEmpty) return const SizedBox.shrink();
    final month = months[index];
    final label = month.label.isNotEmpty ? readableMonth(month.label) : readableMonth(month.month);

    final earlier = index < months.length - 1;
    final later = index > 0;
    // The period stepper: 40 h, radius 12, ln2 border, 36 px chevrons.
    return Container(
      height: 48,
      padding: const EdgeInsets.symmetric(horizontal: 2),
      decoration: BoxDecoration(
        color: c.sf,
        borderRadius: BorderRadius.circular(Ds.rLg),
        border: Border.all(color: c.ln2),
      ),
      child: Row(
        children: [
          IconButton(
            tooltip: 'Earlier month',
            style: IconButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd))),
            icon: DsIcon(DsIcons.chevronLeft, size: 20, color: earlier ? c.tx2 : c.ln2),
            onPressed: earlier ? () => onChanged(index + 1) : null,
          ),
          Expanded(
            child: Text(
              index == 0 ? '$label · now' : label,
              textAlign: TextAlign.center,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
            ),
          ),
          IconButton(
            tooltip: 'Later month',
            style: IconButton.styleFrom(shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd))),
            icon: DsIcon(DsIcons.chevronRight, size: 20, color: later ? c.tx2 : c.ln2),
            onPressed: later ? () => onChanged(index - 1) : null,
          ),
        ],
      ),
    );
  }
}

/// "All" plus one chip per account, shown only when there is a choice.
class KidAccountChips extends StatelessWidget {
  const KidAccountChips({super.key, required this.accounts, required this.selected, required this.onChanged});

  final List<KidAccount> accounts;
  final String? selected;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    if (accounts.length < 2) return const SizedBox.shrink();
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: ChoiceChip(label: const Text('All'), selected: selected == null, onSelected: (_) => onChanged(null)),
          ),
          for (final account in accounts)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: ChoiceChip(
                label: Text(account.label),
                selected: selected == account.id,
                onSelected: (_) => onChanged(account.id),
              ),
            ),
        ],
      ),
    );
  }
}

class KidMoneyScreen extends StatefulWidget {
  const KidMoneyScreen({super.key});

  @override
  State<KidMoneyScreen> createState() => KidMoneyScreenState();
}

class KidMoneyScreenState extends State<KidMoneyScreen> {
  final _service = KidService.instance;
  final _scroll = ScrollController();

  KidProfile? _profile;
  List<UserMonth> _months = [];
  int _monthIndex = 0;
  String? _accountId;
  List<Category> _categories = [];
  List<MerchantPreset> _presets = [];

  List<DayGroup> _days = [];
  bool _hasMore = false;
  String? _nextBefore;
  bool _loading = true;
  bool _loadingMore = false;
  String? _error;

  // Bumped on every fresh list load, so a page that arrives after the month
  // or account changed is dropped instead of mixed in.
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.extentAfter < 400) _loadMore();
    });
    load();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// Everything on the page, from the server's current figures.
  Future<void> load() async {
    setState(() {
      _loading = _profile == null;
      _error = null;
    });
    try {
      final results = await Future.wait([
        _service.me(),
        _service.months(),
        _service.categories(),
        _service.presets(),
      ]);
      if (!mounted) return;
      final months = (results[1] as UserMonths).months;
      setState(() {
        _profile = results[0] as KidProfile;
        // Keep the month being looked at if it is still on the list.
        final current = _months.isEmpty ? null : _months[_monthIndex].month;
        _months = months;
        final kept = months.indexWhere((m) => m.month == current);
        _monthIndex = kept < 0 ? 0 : kept;
        _categories = results[2] as List<Category>;
        _presets = results[3] as List<MerchantPreset>;
        if (_accountId != null && !_profile!.accounts.any((a) => a.id == _accountId)) _accountId = null;
      });
      await _loadPage(reset: true);
    } catch (e) {
      if (mounted) setState(() => _error = _message(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  /// Pull-to-refresh and the refresh button: ask the parent's phone to read
  /// new messages, then reload what the server has now.
  Future<void> refresh() async {
    try {
      final hint = (await _service.refresh()).hint;
      if (hint != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(hint)));
      }
    } catch (_) {
      // Waking the other phone is a bonus; the reload below still matters.
    }
    await load();
  }

  Future<void> _loadPage({required bool reset}) async {
    final generation = reset ? ++_generation : _generation;
    final month = _months.isEmpty ? null : _months[_monthIndex];
    if (reset) {
      _nextBefore = null;
      _hasMore = false;
    }
    final page = await _service.transactions(
      accountId: _accountId,
      from: month?.from,
      to: month?.to,
      before: reset ? null : _nextBefore,
    );
    if (!mounted || generation != _generation) return;
    setState(() {
      _days = reset ? page.days : _mergeDays(_days, page.days);
      _hasMore = page.hasMore;
      _nextBefore = page.nextBefore;
    });
  }

  /// A day can straddle two pages only in theory; join it rather than
  /// show the same date twice.
  static List<DayGroup> _mergeDays(List<DayGroup> current, List<DayGroup> more) {
    final merged = List.of(current);
    for (final day in more) {
      final at = merged.indexWhere((d) => d.date == day.date);
      if (at < 0) {
        merged.add(day);
      } else {
        final old = merged[at];
        merged[at] = DayGroup(
          date: old.date,
          spendMinor: old.spendMinor + day.spendMinor,
          incomeMinor: old.incomeMinor + day.incomeMinor,
          transactions: [...old.transactions, ...day.transactions],
        );
      }
    }
    return merged;
  }

  Future<void> _loadMore() async {
    if (!_hasMore || _loadingMore || _loading) return;
    setState(() => _loadingMore = true);
    try {
      await _loadPage(reset: false);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("Couldn't load more: ${_message(e)}")));
      }
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _reloadList() async {
    setState(() => _days = []);
    try {
      await _loadPage(reset: true);
    } catch (e) {
      if (mounted) setState(() => _error = _message(e));
    }
  }

  static String _message(Object e) => e is ApiException ? e.message : 'Check your internet and try again.';

  Future<void> _openSheet([Transaction? transaction]) async {
    final profile = _profile;
    if (profile == null || profile.accounts.isEmpty) return;
    final saved = await showKidTransactionSheet(
      context,
      transaction: transaction,
      accounts: profile.accounts,
      categories: _categories,
      presets: _presets,
      accountId: _accountId,
    );
    // Spent and left change too, so the whole page reloads, not just the list.
    if (saved == true) await load();
  }

  @override
  Widget build(BuildContext context) {
    final profile = _profile;

    if (_loading && profile == null) return const Center(child: DsSpinner());
    if (profile == null) {
      return StateBlock(
        icon: Icons.cloud_off_outlined,
        title: "Couldn't load your money",
        body: _error ?? 'Something went wrong.',
        actionLabel: 'Try again',
        onAction: load,
        warn: true,
      );
    }
    if (profile.accounts.isEmpty) {
      return RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: const [
            SizedBox(height: 120),
            StateBlock(
              icon: Icons.savings_outlined,
              title: 'No pocket money yet',
              body: 'Ask your parent to set up pocket money for you. It will show here once they do.',
            ),
          ],
        ),
      );
    }

    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openSheet(),
        icon: const DsIcon(DsIcons.plus, size: 20),
        label: const Text('Add'),
      ),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
          children: [
            for (final account in profile.accounts)
              Padding(padding: const EdgeInsets.only(bottom: kCardGap), child: _AccountCard(account: account)),
            KidAccountChips(
              accounts: profile.accounts,
              selected: _accountId,
              onChanged: (id) {
                setState(() => _accountId = id);
                _reloadList();
              },
            ),
            if (profile.accounts.length > 1) const SizedBox(height: 12),
            KidMonthBar(
              months: _months,
              index: _monthIndex,
              onChanged: (i) {
                setState(() => _monthIndex = i);
                _reloadList();
              },
            ),
            const SizedBox(height: 12),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: DsCallout(tone: DsTone.crit, title: _error!),
              ),
            if (_days.isEmpty && !_loading)
              const DsEmpty(
                icon: DsIcons.list,
                message: 'Nothing in this month yet. Tap Add to put something in.',
              ),
            for (final day in _days) _DaySection(day: day, onTap: _openSheet),
            if (_hasMore) _LoadMoreFooter(onVisible: _loadMore),
          ],
        ),
      ),
    );
  }
}

/// This month's limit, spent and left for one account.
class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.account});

  final KidAccount account;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final pocket = account.pocket;

    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const DsIconTile(DsIcons.piggyBank, tone: DsTone.ac, size: 36),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      account.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    if (pocket != null)
                      Text(
                        pocketRenews(pocket),
                        style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                      ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (pocket == null)
            Text("This month's figures aren't ready yet.", style: TextStyle(fontSize: 13, color: c.tx3))
          else ...[
            DsLabel('Monthly limit ${formatMoney(pocket.limitMinor)}'),
            const SizedBox(height: 6),
            PocketMeter(status: pocket),
          ],
        ],
      ),
    );
  }
}

class _DaySection extends StatelessWidget {
  const _DaySection({required this.day, required this.onTap});

  final DayGroup day;
  final ValueChanged<Transaction> onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    const net = TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, fontFeatures: Ds.tabular);
    return Padding(
      padding: const EdgeInsets.only(bottom: kCardGap),
      child: DsCard(
        padding: EdgeInsets.zero,
        clip: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DsDayHeader(
              label: formatDayLabel(day.date),
              trailing: Text.rich(
                TextSpan(
                  style: net.copyWith(color: c.tx2),
                  children: [
                    if (day.spendMinor > 0) TextSpan(text: '−${formatMoney(day.spendMinor)}'),
                    if (day.spendMinor > 0 && day.incomeMinor > 0) const TextSpan(text: ' · '),
                    if (day.incomeMinor > 0)
                      TextSpan(text: '+${formatMoney(day.incomeMinor)}', style: TextStyle(color: c.good)),
                  ],
                ),
              ),
            ),
            for (var i = 0; i < day.transactions.length; i++) ...[
              if (i > 0) const Divider(height: 1),
              _KidTransactionRow(transaction: day.transactions[i], onTap: onTap),
            ],
          ],
        ),
      ),
    );
  }
}

class _KidTransactionRow extends StatelessWidget {
  const _KidTransactionRow({required this.transaction, required this.onTap});

  final Transaction transaction;
  final ValueChanged<Transaction> onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final t = transaction;
    final category = t.category;
    final isDebit = t.type == 'DEBIT';
    final tint = parseHexColor(category?.color, fallback: c.tx3);
    final title = (t.merchant?.trim().isNotEmpty ?? false) ? t.merchant!.trim() : (category?.name ?? 'Something');
    final detail = [formatTime(t.occurredAt), if (category != null) category.name, if (t.note?.isNotEmpty ?? false) t.note!];

    return InkWell(
      onTap: () => onTap(t),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Row(
          children: [
            DsIconTile(
              categoryIcon(category?.icon),
              color: tint,
              background: tint.withValues(alpha: 0.14),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    detail.join(' · '),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
              '${isDebit ? '−' : '+'}${formatMoney(t.amountMinor)}',
              style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: isDebit ? c.tx : c.good),
            ),
          ],
        ),
      ),
    );
  }
}

/// The end of the list while there are older days: asks for them as soon
/// as it is on screen, for when the first page is too short to scroll.
class _LoadMoreFooter extends StatelessWidget {
  const _LoadMoreFooter({required this.onVisible});

  final VoidCallback onVisible;

  @override
  Widget build(BuildContext context) {
    WidgetsBinding.instance.addPostFrameCallback((_) => onVisible());
    return const Padding(
      padding: EdgeInsets.all(16),
      child: Center(child: DsSpinner(size: 22)),
    );
  }
}
