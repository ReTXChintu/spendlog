import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/charts/chart_utils.dart';
import '../widgets/charts/column_chart.dart';
import '../widgets/charts/daily_spend_chart.dart';
import '../widgets/charts/donut_chart.dart';
import '../widgets/ds/ds.dart';
import '../widgets/home/ai_insights_card.dart';
import '../widgets/home/savings_plan_card.dart';

/// The Analytics tab of Home: how the month went, and what to do about it.
///
/// Two things to a row wherever they fit, with filters for an account and a
/// category across the top. The filters apply to the month's own figures -
/// the summary, merchants, the daily line and the weekday bars; the
/// comparison and the 6-month trend are whole-of-spending by design.
class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key, this.onOpenSettings});

  /// Where the Gemini key is set, for the AI cards.
  final VoidCallback? onOpenSettings;

  @override
  State<AnalyticsScreen> createState() => AnalyticsScreenState();
}

class AnalyticsScreenState extends State<AnalyticsScreen> with AutomaticKeepAliveClientMixin {
  static const _trendHeight = 110.0;

  /// The month being looked at, as a user-month key. Null until the server
  /// has said which month "now" is - with a salary day set, 2 Oct can still
  /// belong to the month that began on 15 Sep, so the phone's calendar
  /// cannot answer that.
  String? _month;

  /// Every month there is to step through, newest first.
  List<UserMonth> _months = [];
  AnalyticsSummary? _summary;
  List<Map<String, dynamic>> _trend = [];
  List<Category> _categories = [];
  List<Account> _accounts = [];
  List<MerchantSpend> _merchants = [];
  MonthComparison? _comparison;
  List<DaySpend> _daily = [];
  List<WeekdaySpend> _weekday = [];
  List<AccountSpend> _byAccount = [];
  bool _loading = false;
  bool _failed = false;

  /// An account id, "cash", or null for every account.
  String? _accountFilter;

  /// A category id, "none" for uncategorised, or null for every category.
  String? _categoryFilter;

  /// categories | merchants | compare
  String _view = 'categories';

  final _planAnchor = GlobalKey();
  final _plan = GlobalKey<SavingsPlanCardState>();

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _loadMonths();
    _loadRest();
  }

  /// Brings the savings plan into view, from a warning on the Dashboard.
  /// The plan is re-read too, since the warning may be newer than it.
  void showPlan() {
    _plan.currentState?.load();
    // After a frame, so a freshly built page has been laid out.
    Future.delayed(const Duration(milliseconds: 100), () {
      final target = _planAnchor.currentContext;
      if (target != null && target.mounted) {
        Scrollable.ensureVisible(target, duration: const Duration(milliseconds: 400), curve: Curves.easeOut);
      }
    });
  }

  Future<void> _loadMonths() async {
    try {
      final months = UserMonths.fromJson(
        await ApiClient.instance.get('/analytics/months') as Map<String, dynamic>,
      );
      if (!mounted) return;
      setState(() {
        _months = months.months;
        if (months.current.isNotEmpty) _month = months.current;
      });
    } catch (_) {
      // No list to step through; the summary below still opens on the
      // current month, because the server picks it when none is named.
    }
    await _loadSummary();
  }

  /// The query for one call: the month always, then whichever filters
  /// that endpoint understands.
  String _query({bool account = true, bool category = true}) {
    final params = <String, String>{
      if (_month != null) 'month': _month!,
      if (account && _accountFilter != null) 'account': _accountFilter!,
      if (category && _categoryFilter != null) 'category': _categoryFilter!,
    };
    return params.isEmpty ? '' : '?${Uri(queryParameters: params).query}';
  }

  /// A breakdown that failed comes back empty, so one slow endpoint costs
  /// one chart rather than the screen.
  Future<List<dynamic>> _list(String path) async {
    try {
      return await ApiClient.instance.get(path) as List<dynamic>? ?? const [];
    } catch (_) {
      return const [];
    }
  }

  /// Everything about the month, fetched together so switching between
  /// views is instant rather than a spinner each time.
  Future<void> _loadSummary() async {
    setState(() => _loading = true);
    try {
      final all = _query();
      final results = await Future.wait<dynamic>([
        ApiClient.instance.get('/analytics/summary$all'),
        _list('/analytics/merchants$all'),
        ApiClient.instance.get('/analytics/compare${_query(account: false, category: false)}').catchError((_) => null),
        _list('/analytics/daily$all'),
        _list('/analytics/weekday$all'),
        _list('/analytics/accounts${_query(account: false)}'),
      ]);
      if (!mounted) return;
      setState(() {
        final summary = AnalyticsSummary.fromJson(results[0] as Map<String, dynamic>);
        _summary = summary;
        if (_month == null && summary.month.isNotEmpty) _month = summary.month;
        _merchants = (results[1] as List<dynamic>)
            .map((m) => MerchantSpend.fromJson(m as Map<String, dynamic>))
            .toList();
        _comparison =
            results[2] is Map<String, dynamic> ? MonthComparison.fromJson(results[2] as Map<String, dynamic>) : null;
        _daily = (results[3] as List<dynamic>).map((d) => DaySpend.fromJson(d as Map<String, dynamic>)).toList();
        _weekday =
            (results[4] as List<dynamic>).map((d) => WeekdaySpend.fromJson(d as Map<String, dynamic>)).toList();
        _byAccount =
            (results[5] as List<dynamic>).map((d) => AccountSpend.fromJson(d as Map<String, dynamic>)).toList()
              ..sort((a, b) => b.amountMinor.compareTo(a.amountMinor));
        _failed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadRest() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/analytics/trend?months=6'),
        ApiClient.instance.get('/categories'),
        ApiClient.instance.get('/accounts'),
      ]);
      if (!mounted) return;
      setState(() {
        _trend = (results[0] as List<dynamic>).cast<Map<String, dynamic>>();
        _categories =
            (results[1] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
        _accounts = (results[2] as List<dynamic>)
            .map((a) => Account.fromJson(a as Map<String, dynamic>))
            // Bank accounts and credit cards: a debit card's spending is
            // its account's, and cash has its own option.
            .where((a) => a.isActive && (a.accountType == 'BANK' || a.accountType == 'CARD'))
            .toList();
      });
    } catch (_) {
      // The trend and the filter lists are extras; the month still shows.
    }
  }

  Future<void> _refresh() => Future.wait([_loadSummary(), _loadRest()]);

  Color _colorFor(String? categoryId) {
    if (categoryId == null) return context.c.ln2;
    final match = _categories.where((c) => c.id == categoryId);
    return match.isEmpty ? context.c.tx3 : parseHexColor(match.first.color);
  }

  /// Where the month being looked at sits in [_months]; -1 when unknown.
  int get _monthIndex => _months.indexWhere((m) => m.month == _month);

  /// Steps through the server's own list rather than doing calendar
  /// arithmetic: a pay-day month's key and span are the server's to say.
  /// Newest first, so going back in time is a higher index.
  void _step(int delta) {
    final index = _monthIndex;
    if (index < 0) return;
    final target = index - delta;
    if (target < 0 || target >= _months.length) return;
    setState(() => _month = _months[target].month);
    _loadSummary();
  }

  String get _accountLabel {
    if (_accountFilter == null) return 'All accounts';
    if (_accountFilter == 'cash') return 'Cash';
    final match = _accounts.where((a) => a.id == _accountFilter);
    return match.isEmpty ? 'Account' : match.first.label;
  }

  String get _categoryLabel {
    if (_categoryFilter == null) return 'All categories';
    if (_categoryFilter == 'none') return 'Uncategorised';
    final match = _categories.where((c) => c.id == _categoryFilter);
    return match.isEmpty ? 'Category' : match.first.name;
  }

  Future<void> _pickAccount() async {
    final picked = await _pick('Account', [
      (value: null, label: 'All accounts', icon: Icons.all_inclusive),
      (value: 'cash', label: 'Cash', icon: DsIcons.banknote),
      for (final a in _accounts)
        (
          value: a.id,
          label: a.label,
          icon: a.accountType == 'CARD' ? DsIcons.creditCard : DsIcons.bank,
        ),
    ], _accountFilter);
    if (picked == null || picked.value == _accountFilter) return;
    setState(() => _accountFilter = picked.value);
    _loadSummary();
  }

  Future<void> _pickCategory() async {
    final sorted = [..._categories]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    final picked = await _pick('Category', [
      (value: null, label: 'All categories', icon: Icons.all_inclusive),
      (value: 'none', label: 'Uncategorised', icon: DsIcons.tag),
      for (final c in sorted) (value: c.id, label: c.name, icon: categoryIcon(c.icon)),
    ], _categoryFilter);
    if (picked == null || picked.value == _categoryFilter) return;
    setState(() => _categoryFilter = picked.value);
    _loadSummary();
  }

  /// A sheet of options. Returns a record (so "all", which is null, can be
  /// told apart from the sheet being dismissed).
  Future<({String? value})?> _pick(
    String title,
    List<({String? value, String label, Object icon})> options,
    String? current,
  ) {
    return showModalBottomSheet<({String? value})>(
      context: context,
      isScrollControlled: true,
      builder: (context) {
        final c = context.c;
        return SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const DsDragHandle(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
                  child: Text(
                    title,
                    style: TextStyle(fontSize: 19, height: 24 / 19, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                ),
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    padding: const EdgeInsets.fromLTRB(8, 0, 8, 16),
                    children: [
                      for (final option in options)
                        ListTile(
                          minTileHeight: 48,
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
                          selected: option.value == current,
                          selectedTileColor: c.acSoft,
                          leading: dsIconOf(option.icon, size: 20, color: option.value == current ? c.ac : c.tx2),
                          title: Text(
                            option.label,
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: option.value == current ? FontWeight.w600 : FontWeight.w500,
                              color: option.value == current ? c.ac : c.tx,
                            ),
                          ),
                          trailing: option.value == current ? DsIcon(DsIcons.check, size: 20, color: c.ac) : null,
                          onTap: () => Navigator.of(context).pop((value: option.value)),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final c = context.c;
    final summary = _summary;
    final index = _monthIndex;
    final title = index >= 0
        ? _months[index].label
        : (summary?.label.isNotEmpty ?? false)
            ? summary!.label
            : 'This month';
    final filtered = _accountFilter != null || _categoryFilter != null;

    return Column(
      children: [
        _MonthPicker(
          title: title,
          canGoBack: index >= 0 && index < _months.length - 1,
          canGoForward: index > 0,
          onChange: _step,
        ),
        _Filters(
          account: _accountLabel,
          category: _categoryLabel,
          accountOn: _accountFilter != null,
          categoryOn: _categoryFilter != null,
          onAccount: _pickAccount,
          onCategory: _pickCategory,
          onClear: filtered
              ? () {
                  setState(() {
                    _accountFilter = null;
                    _categoryFilter = null;
                  });
                  _loadSummary();
                }
              : null,
        ),
        SizedBox(height: 2, child: _loading ? const LinearProgressIndicator(minHeight: 2) : null),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _refresh,
            // A plain column rather than a lazy list, so the savings plan at
            // the bottom exists to be scrolled to from a Dashboard warning.
            child: SingleChildScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 32),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (filtered)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(
                        'Filters apply to the figures, daily and weekday charts and merchants — not to the '
                        'comparison or the 6-month trend.',
                        style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                      ),
                    ),
                  if (_failed && summary == null)
                    const _Message(
                      icon: Icons.wifi_off,
                      text: "Couldn't load this month. Pull down to try again.",
                    )
                  else if (summary == null)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 40),
                      child: Center(child: DsSpinner()),
                    )
                  else if (summary.transactionCount == 0)
                    _Message(
                      icon: DsIcons.barChart,
                      text: filtered
                          ? 'Nothing this month matches these filters.'
                          : 'Nothing to analyse yet. Once a few payments come in from SMS or Gmail, '
                              'this fills in on its own.',
                    )
                  else
                    ..._monthContent(summary),

                  const SizedBox(height: 20),
                  AiInsightsCard(onOpenSettings: widget.onOpenSettings),
                  const SizedBox(height: kCardGap),
                  KeyedSubtree(
                    key: _planAnchor,
                    child: SavingsPlanCard(key: _plan, onOpenSettings: widget.onOpenSettings),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  List<Widget> _monthContent(AnalyticsSummary summary) {
    final c = context.c;
    final net = summary.totalIncomeMinor - summary.totalSpendMinor;

    // An average over the days that have happened: dividing by the whole
    // month on the 5th would make every day look cheap.
    final today = istToday();
    final elapsed = _daily.where((d) => d.day.compareTo(today) <= 0).length;
    final days = elapsed > 0 ? elapsed : (_daily.isEmpty ? 1 : _daily.length);
    final perDay = summary.totalSpendMinor ~/ days;
    final top = summary.byCategory.isEmpty ? null : summary.byCategory.first;

    return [
      _TileGrid(children: [
        // Spending is ink; only money in is green.
        DsStatTile(label: 'Spent', value: formatMoneyShort(summary.totalSpendMinor)),
        DsStatTile(label: 'Received', value: formatMoneyShort(summary.totalIncomeMinor), valueColor: c.good),
        DsStatTile(
          label: 'Net',
          value: '${net >= 0 ? '+' : '−'}${formatMoneyShort(net.abs())}',
          valueColor: net >= 0 ? c.good : c.tx,
          foot: net >= 0 ? 'more in than out' : 'more out than in',
        ),
        DsStatTile(
          label: 'Average a day',
          value: formatMoneyShort(perDay),
          foot: 'over $days ${days == 1 ? 'day' : 'days'}',
        ),
        DsStatTile(label: 'Transactions', value: '${summary.transactionCount}'),
        DsStatTile(
          label: 'Top category',
          value: top?.name ?? '—',
          foot: top == null ? null : formatMoneyShort(top.amountMinor),
        ),
      ]),
      const SizedBox(height: kCardGap),
      if (_daily.isNotEmpty) ...[
        _ChartCard(title: 'Spending day by day', child: DailySpendChart(days: _daily)),
        const SizedBox(height: kCardGap),
      ],
      if (summary.byCategory.isNotEmpty) ...[
        _donut(summary),
        const SizedBox(height: kCardGap),
      ],
      if (_weekday.isNotEmpty) ...[
        _ChartCard(
          title: 'By weekday',
          meta: 'Average spent on each',
          child: ColumnChart(
            values: _weekday.map((w) => w.averageMinor).toList(),
            labels: _weekday.map((w) => w.day.length > 2 ? w.day.substring(0, 2) : w.day).toList(),
            // Ink is the data colour; the busiest day is the one in full ink.
            color: c.ln2,
            highlight: c.tx,
          ),
        ),
        const SizedBox(height: kCardGap),
      ],
      if (_byAccount.isNotEmpty) ...[
        _accountsTile(),
        const SizedBox(height: kCardGap),
      ],
      const SizedBox(height: 8),
      DsSegmented<String>(
        segments: const [
          ('categories', 'Category'),
          ('merchants', 'Merchant'),
          ('compare', 'vs last'),
        ],
        selected: _view,
        onChanged: (view) => setState(() => _view = view),
      ),
      const SizedBox(height: kCardGap),
      if (_view == 'categories')
        DsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _SectionTitle(
                title: 'Spend by category',
                sub: "Transfers, settlements and the part of a split bill that wasn't yours are excluded.",
              ),
              const SizedBox(height: 16),
              ...summary.byCategory.map((entry) {
                final pct = summary.totalSpendMinor == 0 ? 0.0 : entry.amountMinor / summary.totalSpendMinor;
                return _CategoryBar(
                  name: entry.name,
                  amountMinor: entry.amountMinor,
                  fraction: pct,
                  color: _colorFor(entry.categoryId),
                  dashed: entry.categoryId == null,
                );
              }),
            ],
          ),
        ),
      if (_view == 'merchants')
        DsCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _SectionTitle(
                title: 'Spend by merchant',
                sub: 'Where the money actually went. "Food" is not a thing to cut back on; '
                    'ordering from one app eleven times is.',
              ),
              const SizedBox(height: 8),
              if (_merchants.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    'Nothing this month has a merchant name on it yet.',
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
                )
              else
                for (var i = 0; i < _merchants.length; i++)
                  _MerchantRow(entry: _merchants[i], last: i == _merchants.length - 1),
            ],
          ),
        ),
      if (_view == 'compare' && _comparison != null) DsCard(child: _Comparison(comparison: _comparison!)),
      const SizedBox(height: kCardGap),
      _ChartCard(
        title: 'Last 6 months',
        child: _Trend(points: _trend, maxHeight: AnalyticsScreenState._trendHeight),
      ),
    ];
  }

  /// The month's categories as a ring, the biggest five named and the rest
  /// gathered as "Other" so the ring stays readable.
  Widget _donut(AnalyticsSummary summary) {
    final c = context.c;
    final entries = summary.byCategory;
    final shown = entries.take(5).toList();
    final restEntries = entries.skip(5).toList();
    final rest = restEntries.fold<int>(0, (sum, e) => sum + e.amountMinor);
    final total = summary.totalSpendMinor == 0 ? 1 : summary.totalSpendMinor;

    // Each row's move against last month, when the figures are unfiltered
    // (the comparison is whole-of-spending, so a filtered row has none).
    final filtered = _accountFilter != null || _categoryFilter != null;
    final changes = filtered ? null : _comparison?.categories;
    int? changeFor(CategorySpend e) {
      final match = changes?.where((ch) => ch.categoryId == e.categoryId && ch.name == e.name);
      return match == null || match.isEmpty ? null : match.first.changeMinor;
    }

    final rows = [
      for (final e in shown)
        (
          segment: DonutSegment(value: e.amountMinor, color: _colorFor(e.categoryId), label: e.name),
          change: changeFor(e),
        ),
      if (rest > 0)
        (
          segment: DonutSegment(value: rest, color: c.chart.last, label: 'Other'),
          change: changes == null
              ? null
              : restEntries.fold<int>(0, (sum, e) => sum + (changeFor(e) ?? 0)),
        ),
    ];

    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DsSectionHeader('Where it went', meta: changes == null ? null : 'vs last month'),
          const SizedBox(height: 12),
          Center(
            child: DonutChart(
              segments: [for (final r in rows) r.segment],
              centerTop: formatMoneyShort(summary.totalSpendMinor),
              centerBottom: 'spent',
            ),
          ),
          const SizedBox(height: 12),
          for (var i = 0; i < rows.length; i++)
            _LegendRow(
              color: rows[i].segment.color,
              name: rows[i].segment.label,
              amountMinor: rows[i].segment.value,
              share: rows[i].segment.value / total,
              change: rows[i].change,
              last: i == rows.length - 1,
            ),
        ],
      ),
    );
  }

  Widget _accountsTile() {
    final c = context.c;
    final shown = _byAccount.take(5).toList();
    final peak = shown.first.amountMinor == 0 ? 1 : shown.first.amountMinor;

    return _ChartCard(
      title: 'By account',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final a in shown)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          a.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        formatMoneyShort(a.amountMinor),
                        style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  DsMeter(value: a.amountMinor / peak, color: c.tx),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Stat tiles two to a row (three when there is room), each row as tall as
/// its tallest tile.
class _TileGrid extends StatelessWidget {
  const _TileGrid({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final perRow = constraints.maxWidth >= 600 ? 3 : 2;
        final rows = <Widget>[];
        for (var i = 0; i < children.length; i += perRow) {
          if (rows.isNotEmpty) rows.add(const SizedBox(height: kCardGap));
          final slice = children.sublist(i, (i + perRow).clamp(0, children.length));
          rows.add(IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var j = 0; j < perRow; j++) ...[
                  if (j > 0) const SizedBox(width: kCardGap),
                  Expanded(child: j < slice.length ? slice[j] : const SizedBox.shrink()),
                ],
              ],
            ),
          ));
        }
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: rows);
      },
    );
  }
}

/// A section card holding one chart: a 17/24 title, an optional meta line
/// and the chart under it.
class _ChartCard extends StatelessWidget {
  const _ChartCard({required this.title, required this.child, this.meta});

  final String title;
  final String? meta;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DsSectionHeader(title, meta: meta),
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}

class _Filters extends StatelessWidget {
  const _Filters({
    required this.account,
    required this.category,
    required this.accountOn,
    required this.categoryOn,
    required this.onAccount,
    required this.onCategory,
    this.onClear,
  });

  final String account;
  final String category;
  final bool accountOn;
  final bool categoryOn;
  final VoidCallback onAccount;
  final VoidCallback onCategory;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    // A chip row scrolls sideways on a phone rather than wrapping (§6.3).
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
      child: Row(
        children: [
          _FilterChip(icon: DsIcons.bank, label: account, on: accountOn, onTap: onAccount),
          const SizedBox(width: 8),
          _FilterChip(icon: DsIcons.tag, label: category, on: categoryOn, onTap: onCategory),
          if (onClear != null) ...[
            const SizedBox(width: 4),
            TextButton.icon(
              onPressed: onClear,
              icon: const DsIcon(DsIcons.x, size: 16),
              label: const Text('Clear'),
            ),
          ],
        ],
      ),
    );
  }
}

/// A dropdown chip: a 36 h pill with a trailing chevron, ink-filled while
/// its filter is on.
class _FilterChip extends StatelessWidget {
  const _FilterChip({required this.icon, required this.label, required this.on, required this.onTap});

  final Object icon;
  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 220),
      child: DsChip(label: label, icon: icon, selected: on, onTap: onTap, dropdown: true),
    );
  }
}

/// A full-width empty or error state: a 48 icon tile and one sentence,
/// centred in the content area.
class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text});

  final Object icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 12),
      child: Column(
        children: [
          DsIconTile(icon, size: 48, iconSize: 24, color: c.tx3),
          const SizedBox(height: 12),
          Text(text, textAlign: TextAlign.center, style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2)),
        ],
      ),
    );
  }
}

/// The period stepper (§6.1): 40 h, radius 12, `ln2` outline, two 36×36
/// icon buttons and a 14/600 tabular label.
class _MonthPicker extends StatelessWidget {
  final String title;
  final bool canGoBack;
  final bool canGoForward;
  final ValueChanged<int> onChange;

  const _MonthPicker({
    required this.title,
    required this.canGoBack,
    required this.canGoForward,
    required this.onChange,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    Widget arrow(DsGlyph glyph, bool enabled, int delta, String tip) => SizedBox(
          width: 36,
          height: 36,
          child: IconButton(
            tooltip: tip,
            padding: EdgeInsets.zero,
            style: IconButton.styleFrom(
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
              minimumSize: const Size(36, 36),
            ),
            icon: DsIcon(glyph, size: 20, color: enabled ? c.tx2 : c.ln2),
            onPressed: enabled ? () => onChange(delta) : null,
          ),
        );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 10),
      child: Container(
        height: 40,
        padding: const EdgeInsets.symmetric(horizontal: 1),
        decoration: BoxDecoration(
          color: c.sf,
          border: Border.all(color: c.ln2),
          borderRadius: BorderRadius.circular(Ds.rLg),
        ),
        child: Row(
          children: [
            arrow(DsIcons.chevronLeft, canGoBack, -1, 'Previous month'),
            Expanded(
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: kNum.copyWith(fontWeight: FontWeight.w600, fontSize: 14, color: c.tx),
              ),
            ),
            arrow(DsIcons.chevronRight, canGoForward, 1, 'Next month'),
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
        Text(title, style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: context.c.tx)),
        const SizedBox(height: 2),
        Text(sub, style: TextStyle(fontSize: 13, height: 18 / 13, color: context.c.tx3)),
      ],
    );
  }
}

/// One legend row under the donut: a 10×10 swatch, the name, the amount,
/// the share, and how it moved against last month.
class _LegendRow extends StatelessWidget {
  const _LegendRow({
    required this.color,
    required this.name,
    required this.amountMinor,
    required this.share,
    required this.last,
    this.change,
  });

  final Color color;
  final String name;
  final int amountMinor;
  final double share;
  final int? change;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final change = this.change;
    // More spend than last time is the only "bad" delta, so it alone is red.
    final changeColour = change == null || change == 0 ? c.tx3 : (change > 0 ? c.crit : c.good);
    return Container(
      constraints: const BoxConstraints(minHeight: 40),
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
      child: Row(
        children: [
          Container(
            width: 10,
            height: 10,
            decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(3)),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            formatMoneyShort(amountMinor),
            style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
          ),
          SizedBox(
            width: 44,
            child: Text(
              '${(share * 100).round()}%',
              textAlign: TextAlign.end,
              style: kNum.copyWith(fontSize: 12, color: c.tx3),
            ),
          ),
          if (change != null)
            SizedBox(
              width: 72,
              child: Align(
                alignment: Alignment.centerRight,
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: change == 0
                      ? Text('same', style: TextStyle(fontSize: 12, color: c.tx3))
                      : Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            DsIcon(change > 0 ? DsIcons.chevronUp : DsIcons.chevronDown, size: 12, color: changeColour),
                            const SizedBox(width: 2),
                            Text(
                              formatMoneyShort(change.abs()),
                              style: kNum.copyWith(fontSize: 12, fontWeight: FontWeight.w600, color: changeColour),
                            ),
                          ],
                        ),
                ),
              ),
            ),
        ],
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
    this.dashed = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  color: dashed ? Colors.transparent : color,
                  border: dashed ? Border.all(color: c.ln2, width: 1.5) : null,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                formatMoneyShort(amountMinor),
                style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
              ),
              SizedBox(
                width: 44,
                child: Text(
                  '${(fraction * 100).round()}%',
                  textAlign: TextAlign.end,
                  style: kNum.copyWith(fontSize: 12, color: c.tx3),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          DsMeter(value: fraction, color: dashed ? c.tx3 : color, height: 10),
        ],
      ),
    );
  }
}

/// A merchant: monogram, name, how many times, and what it came to.
class _MerchantRow extends StatelessWidget {
  const _MerchantRow({required this.entry, required this.last});

  final MerchantSpend entry;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      constraints: const BoxConstraints(minHeight: 56),
      padding: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
      child: Row(
        children: [
          DsMonogram(entry.merchant, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  entry.merchant,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                ),
                Text(
                  '×${entry.count}',
                  style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Text(
            formatMoneyShort(entry.amountMinor),
            style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: c.tx),
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
    final c = context.c;
    if (points.isEmpty) {
      return Text('No history yet.', style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3));
    }

    final peak = points
        .expand((p) => [p['spendMinor'] as int? ?? 0, p['incomeMinor'] as int? ?? 0])
        .fold<int>(1, (a, b) => a > b ? a : b);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 16,
          runSpacing: 6,
          children: [
            LegendDot(color: c.tx, label: 'Spend'),
            LegendDot(color: c.good, label: 'Income'),
          ],
        ),
        const SizedBox(height: 12),
        SizedBox(
          height: maxHeight + 30,
          child: DecoratedBox(
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: c.ln2)),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: points.map((point) {
                final spend = point['spendMinor'] as int? ?? 0;
                final income = point['incomeMinor'] as int? ?? 0;
                final empty = spend == 0 && income == 0;
                // Named by the day each month starts ("15 Sep"): with a salary
                // day set, a bar is not a calendar month and "Sep" would lie.
                // An older server sends no start date, only the key.
                final from = point['from'] as String? ?? '';
                final label = from.isNotEmpty
                    ? formatIsoShortDate(from)
                    : formatMonthLabel('${point['month']}').split(' ').first.substring(0, 3);

                return Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      if (empty)
                        Container(
                          width: 30,
                          height: 6,
                          decoration: BoxDecoration(
                            color: c.sunk,
                            border: Border.all(color: c.ln2),
                            borderRadius: BorderRadius.circular(3),
                          ),
                        )
                      else
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            _Bar(height: spend / peak * maxHeight, color: c.tx),
                            const SizedBox(width: 3),
                            _Bar(height: income / peak * maxHeight, color: c.good),
                          ],
                        ),
                      const SizedBox(height: 6),
                      Text(
                        label,
                        maxLines: 1,
                        style: kNum.copyWith(fontSize: 11, height: 14 / 11, color: c.tx3),
                      ),
                      const SizedBox(height: 4),
                    ],
                  ),
                );
              }).toList(),
            ),
          ),
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
      width: 12,
      height: height.clamp(2.0, double.infinity),
      decoration: BoxDecoration(
        color: color,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(2)),
      ),
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
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _SectionTitle(
          title: 'Against ${readableMonth(comparison.previousMonthLabel)}',
          sub: 'Per category as well as in total.',
        ),
        const SizedBox(height: 14),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: c.sf2,
            border: Border.all(color: c.ln),
            borderRadius: BorderRadius.circular(Ds.rLg),
          ),
          child: Row(
            children: [
              Expanded(
                child: DsInlineStat(
                  label: 'This month',
                  value: formatMoneyShort(comparison.totalSpendMinor),
                  compact: true,
                ),
              ),
              Expanded(
                child: DsInlineStat(
                  label: 'Last month',
                  value: formatMoneyShort(comparison.previousSpendMinor),
                  compact: true,
                ),
              ),
              Expanded(
                child: DsInlineStat(
                  label: 'Change',
                  value: '${up ? '+' : ''}${formatMoneyShort(comparison.changeMinor)}',
                  // More spend is the bad direction, so it alone is red.
                  valueColor: comparison.changeMinor == 0 ? null : (up ? c.crit : c.good),
                  compact: true,
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 16),
        for (final entry in comparison.categories)
          Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        entry.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      entry.changeMinor == 0
                          ? 'no change'
                          : '${entry.changeMinor > 0 ? '+' : '−'}'
                              '${formatMoneyShort(entry.changeMinor.abs())}',
                      style: entry.changeMinor == 0
                          ? TextStyle(fontSize: 12, color: c.tx3)
                          : kNum.copyWith(
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                              color: entry.changeMinor > 0 ? c.crit : c.good,
                            ),
                    ),
                    const SizedBox(width: 8),
                    // What it actually is now, so a change has something to
                    // be a change *of*.
                    Text(
                      entry.previousMinor == 0
                          ? 'new'
                          : entry.amountMinor == 0
                              ? 'stopped'
                              : formatMoneyShort(entry.amountMinor),
                      style: kNum.copyWith(fontSize: 12, color: c.tx3),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                DsMeter(
                  value: entry.changeMinor.abs() / biggest,
                  color: entry.changeMinor > 0 ? c.critFill : c.good,
                ),
              ],
            ),
          ),
      ],
    );
  }
}
