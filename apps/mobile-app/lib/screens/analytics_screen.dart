import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/charts/chart_utils.dart';
import '../widgets/charts/column_chart.dart';
import '../widgets/charts/daily_spend_chart.dart';
import '../widgets/charts/donut_chart.dart';
import '../widgets/home/ai_insights_card.dart';
import '../widgets/home/home_grid.dart';
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
    if (categoryId == null) return context.c.mutedLight;
    final match = _categories.where((c) => c.id == categoryId);
    return match.isEmpty ? context.c.muted : parseHexColor(match.first.color);
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
      (value: 'cash', label: 'Cash', icon: Icons.payments_outlined),
      for (final a in _accounts)
        (
          value: a.id,
          label: a.label,
          icon: a.accountType == 'CARD' ? Icons.credit_card : Icons.account_balance_outlined,
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
      (value: 'none', label: 'Uncategorised', icon: Icons.help_outline),
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
    List<({String? value, String label, IconData icon})> options,
    String? current,
  ) {
    final c = context.c;
    return showModalBottomSheet<({String? value})>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.only(bottom: 12),
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                child: Text(title, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: c.ink)),
              ),
              for (final option in options)
                ListTile(
                  leading: Icon(option.icon, size: 20, color: c.muted),
                  title: Text(option.label, style: TextStyle(fontSize: 14, color: c.ink)),
                  trailing: option.value == current ? Icon(Icons.check, color: c.brand) : null,
                  onTap: () => Navigator.of(context).pop((value: option.value)),
                ),
            ],
          ),
        ),
      ),
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
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (filtered)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Text(
                        'Filters apply to the figures, daily and weekday charts and merchants - not to the '
                        'comparison or the 6-month trend.',
                        style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
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
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else if (summary.transactionCount == 0)
                    _Message(
                      icon: Icons.trending_up,
                      text: filtered
                          ? 'Nothing this month matches these filters.'
                          : 'Nothing to analyse yet. Once a few payments come in from SMS or Gmail, '
                              'this fills in on its own.',
                    )
                  else
                    ..._monthContent(summary),

                  const SizedBox(height: 26),
                  AiInsightsCard(onOpenSettings: widget.onOpenSettings),
                  const SizedBox(height: 14),
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
      HomeGrid(squareness: 0, items: [
        GridItem(_Kpi(label: 'Spent', value: formatMoneyShort(summary.totalSpendMinor), colour: c.debit)),
        GridItem(_Kpi(label: 'Received', value: formatMoneyShort(summary.totalIncomeMinor), colour: c.credit)),
        GridItem(_Kpi(
          label: 'Net',
          value: '${net >= 0 ? '+' : '−'}${formatMoneyShort(net.abs())}',
          colour: net >= 0 ? c.credit : c.debit,
          sub: net >= 0 ? 'more in than out' : 'more out than in',
        )),
        GridItem(_Kpi(label: 'Average a day', value: formatMoneyShort(perDay), sub: 'over $days ${days == 1 ? 'day' : 'days'}')),
        GridItem(_Kpi(label: 'Transactions', value: '${summary.transactionCount}')),
        GridItem(_Kpi(
          label: 'Top category',
          value: top?.name ?? '—',
          sub: top == null ? null : formatMoneyShort(top.amountMinor),
          text: true,
        )),
      ]),
      const SizedBox(height: 12),
      HomeGrid(squareness: 0, items: [
        if (_daily.isNotEmpty)
          GridItem(
            HomeTile(label: 'Spending day by day', icon: Icons.show_chart, child: DailySpendChart(days: _daily)),
            span: 2,
          ),
        if (summary.byCategory.isNotEmpty) GridItem(_donut(summary), span: 2),
        if (_weekday.isNotEmpty)
          GridItem(HomeTile(
            label: 'By weekday',
            icon: Icons.view_week_outlined,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Average spent on each', style: TextStyle(fontSize: 11, color: c.muted)),
                const SizedBox(height: 8),
                ColumnChart(
                  values: _weekday.map((w) => w.averageMinor).toList(),
                  labels: _weekday.map((w) => w.day.length > 2 ? w.day.substring(0, 2) : w.day).toList(),
                  color: c.brand100,
                  highlight: c.brand,
                ),
              ],
            ),
          )),
        if (_byAccount.isNotEmpty) GridItem(_accountsTile()),
      ]),
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
      const SizedBox(height: 18),
      if (_view == 'categories') ...[
        const _SectionTitle(
          title: 'Spend by category',
          sub: "Transfers, settlements and the part of a split bill that wasn't yours are excluded.",
        ),
        const SizedBox(height: 14),
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
      if (_view == 'merchants') ...[
        const _SectionTitle(
          title: 'Spend by merchant',
          sub: 'Where the money actually went. "Food" is not a thing to cut back on; '
              'ordering from one app eleven times is.',
        ),
        const SizedBox(height: 14),
        if (_merchants.isEmpty)
          Text('Nothing this month has a merchant name on it yet.', style: TextStyle(fontSize: 12.8, color: c.muted))
        else
          ..._merchants.map((entry) => _CategoryBar(
                name: entry.merchant,
                amountMinor: entry.amountMinor,
                fraction: _merchants.first.amountMinor == 0 ? 0.0 : entry.amountMinor / _merchants.first.amountMinor,
                color: c.brand,
                trailing: '×${entry.count}',
              )),
      ],
      if (_view == 'compare' && _comparison != null) _Comparison(comparison: _comparison!),
      const SizedBox(height: 22),
      HomeTile(
        label: 'Last 6 months',
        icon: Icons.bar_chart,
        child: _Trend(points: _trend, maxHeight: _trendHeight),
      ),
    ];
  }

  /// The month's categories as a ring, the biggest five named and the rest
  /// gathered as "Other" so the ring stays readable.
  Widget _donut(AnalyticsSummary summary) {
    final c = context.c;
    final entries = summary.byCategory;
    final shown = entries.take(5).toList();
    final rest = entries.skip(5).fold<int>(0, (sum, e) => sum + e.amountMinor);
    final total = summary.totalSpendMinor == 0 ? 1 : summary.totalSpendMinor;

    final segments = [
      for (final e in shown) DonutSegment(value: e.amountMinor, color: _colorFor(e.categoryId), label: e.name),
      if (rest > 0) DonutSegment(value: rest, color: c.lineStrong, label: 'Other'),
    ];

    return HomeTile(
      label: 'Where it went',
      icon: Icons.donut_large_outlined,
      child: Row(
        children: [
          DonutChart(
            segments: segments,
            centerTop: compactMoney(summary.totalSpendMinor),
            centerBottom: 'spent',
            size: 128,
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final s in segments)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3),
                    child: Row(
                      children: [
                        Expanded(child: LegendDot(color: s.color, label: s.label, textColor: c.ink70)),
                        const SizedBox(width: 6),
                        Text(
                          '${(s.value / total * 100).round()}%',
                          style: kNum.copyWith(fontSize: 11.5, fontWeight: FontWeight.w700, color: c.ink),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _accountsTile() {
    final c = context.c;
    final shown = _byAccount.take(5).toList();
    final peak = shown.first.amountMinor == 0 ? 1 : shown.first.amountMinor;

    return HomeTile(
      label: 'By account',
      icon: Icons.account_balance_wallet_outlined,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final a in shown)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          a.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.ink70),
                        ),
                      ),
                      Text(compactMoney(a.amountMinor), style: kNum.copyWith(fontSize: 11.5, color: c.ink)),
                    ],
                  ),
                  const SizedBox(height: 4),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(100),
                    child: LinearProgressIndicator(
                      value: (a.amountMinor / peak).clamp(0.0, 1.0),
                      minHeight: 6,
                      backgroundColor: c.track,
                      valueColor: AlwaysStoppedAnimation(a.accountId == 'cash' ? c.credit : c.brand),
                    ),
                  ),
                ],
              ),
            ),
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
    final c = context.c;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Row(
        children: [
          _FilterChip(icon: Icons.account_balance_wallet_outlined, label: account, on: accountOn, onTap: onAccount),
          const SizedBox(width: 8),
          _FilterChip(icon: Icons.category_outlined, label: category, on: categoryOn, onTap: onCategory),
          if (onClear != null) ...[
            const SizedBox(width: 4),
            TextButton.icon(
              onPressed: onClear,
              icon: Icon(Icons.close, size: 15, color: c.muted),
              label: Text('Clear', style: TextStyle(fontSize: 12.5, color: c.muted)),
            ),
          ],
        ],
      ),
    );
  }
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({required this.icon, required this.label, required this.on, required this.onTap});

  final IconData icon;
  final String label;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(100),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: on ? c.brand50 : c.surface,
          border: Border.all(color: on ? c.brand : c.lineStrong),
          borderRadius: BorderRadius.circular(100),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: on ? c.brandDark : c.muted),
            const SizedBox(width: 6),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 160),
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: on ? c.brandDark : c.ink70),
              ),
            ),
            const SizedBox(width: 2),
            Icon(Icons.arrow_drop_down, size: 18, color: on ? c.brandDark : c.muted),
          ],
        ),
      ),
    );
  }
}

class _Kpi extends StatelessWidget {
  const _Kpi({required this.label, required this.value, this.colour, this.sub, this.text = false});

  final String label;
  final String value;
  final Color? colour;
  final String? sub;

  /// A name rather than a number, so not set in the figures' font.
  final bool text;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: c.muted)),
          const SizedBox(height: 5),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              maxLines: 1,
              style: text
                  ? TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: colour ?? c.ink)
                  : kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w800, color: colour ?? c.ink),
            ),
          ),
          if (sub != null) ...[
            const SizedBox(height: 2),
            Text(sub!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: c.mutedLight)),
          ],
        ],
      ),
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 30, horizontal: 12),
      child: Column(
        children: [
          Icon(icon, size: 30, color: c.mutedLight),
          const SizedBox(height: 10),
          Text(text, textAlign: TextAlign.center, style: TextStyle(fontSize: 13, height: 1.45, color: c.muted)),
        ],
      ),
    );
  }
}

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
              icon: Icon(Icons.chevron_left, color: canGoBack ? context.c.muted : context.c.lineStrong),
              onPressed: canGoBack ? () => onChange(-1) : null,
            ),
            Flexible(
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.5, color: context.c.ink),
              ),
            ),
            IconButton(
              iconSize: 18,
              visualDensity: VisualDensity.compact,
              icon: Icon(Icons.chevron_right, color: canGoForward ? context.c.muted : context.c.lineStrong),
              onPressed: canGoForward ? () => onChange(1) : null,
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
    if (points.isEmpty) {
      return Text('No history yet.', style: TextStyle(fontSize: 12, color: context.c.muted));
    }

    final peak = points
        .expand((p) => [p['spendMinor'] as int? ?? 0, p['incomeMinor'] as int? ?? 0])
        .fold<int>(1, (a, b) => a > b ? a : b);

    return Column(
      children: [
        SizedBox(
          height: maxHeight + 30,
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
                    Text(label,
                        style: TextStyle(fontSize: 11, color: context.c.muted, fontWeight: FontWeight.w600)),
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
            LegendDot(color: context.c.debit, label: 'Spend', textColor: context.c.muted),
            const SizedBox(width: 16),
            LegendDot(color: context.c.credit, label: 'Income', textColor: context.c.muted),
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
      width: 12,
      height: height.clamp(2.0, double.infinity),
      decoration: BoxDecoration(
        color: color,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(4)),
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
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionTitle(
          title: 'Against ${readableMonth(comparison.previousMonthLabel)}',
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
                    valueColor: AlwaysStoppedAnimation(entry.changeMinor > 0 ? c.debit : c.credit),
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
