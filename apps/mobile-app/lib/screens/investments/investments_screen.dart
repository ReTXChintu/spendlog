import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../services/api_client.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import '../../widgets/funds/fund_text.dart';
import '../../widgets/funds/fund_widgets.dart';
import '../../widgets/funds/goal_card.dart';
import '../../widgets/state_block.dart';
import 'add_fund_screen.dart';
import 'goal_editor_screen.dart';
import 'holding_detail_screen.dart';
import 'link_sheets.dart';

/// Mutual funds: what's held and what it's worth today, the goals it's
/// for, and the assistant's read on both.
///
/// Three tabs over three requests, each loaded on its own: a slow NAV
/// source costs the Portfolio tab, not the goals, and advice that can't be
/// made (no Gemini key) costs only the Advice tab.
class InvestmentsScreen extends StatefulWidget {
  const InvestmentsScreen({super.key, this.initialTab = 0, this.onOpenAiSettings});

  /// 0 Portfolio, 1 Goals, 2 Advice.
  final int initialTab;

  /// Settings, at the assistant's card - where the Gemini key goes.
  final VoidCallback? onOpenAiSettings;

  @override
  State<InvestmentsScreen> createState() => InvestmentsScreenState();
}

class InvestmentsScreenState extends State<InvestmentsScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 3, vsync: this, initialIndex: widget.initialTab.clamp(0, 2));

  FundPortfolio? _portfolio;
  bool _portfolioFailed = false;
  String? _portfolioError;
  LinkSuggestions _links = const LinkSuggestions();

  GoalsResponse? _goals;
  bool _goalsFailed = false;
  String? _goalsError;

  AdviceResponse? _advice;
  bool _adviceFailed = false;
  bool _adviceBusy = false;

  /// Why the last attempt to make advice failed.
  String? _adviceProblem;

  @override
  void initState() {
    super.initState();
    _tabs.addListener(() {
      if (!_tabs.indexIsChanging && mounted) setState(() {});
    });
    _loadPortfolio();
    _loadGoals();
    _loadAdvice();
  }

  @override
  void dispose() {
    _tabs.dispose();
    super.dispose();
  }

  Future<void> _loadPortfolio() async {
    unawaited(_loadLinks());
    try {
      final json = await ApiClient.instance.get('/funds/portfolio') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _portfolio = FundPortfolio.fromJson(json);
        _portfolioFailed = false;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _portfolioFailed = true;
          _portfolioError = error is ApiException ? error.message : null;
        });
      }
    }
  }

  /// Suggestions are a banner; failing to fetch them just leaves it off.
  Future<void> _loadLinks() async {
    try {
      final json = await ApiClient.instance.get('/funds/link-suggestions') as Map<String, dynamic>;
      if (mounted) setState(() => _links = LinkSuggestions.fromJson(json));
    } catch (_) {}
  }

  Future<void> _loadGoals() async {
    try {
      final json = await ApiClient.instance.get('/goals') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _goals = GoalsResponse.fromJson(json);
        _goalsFailed = false;
      });
    } catch (error) {
      if (mounted) {
        setState(() {
          _goalsFailed = true;
          _goalsError = error is ApiException ? error.message : null;
        });
      }
    }
  }

  Future<void> _loadAdvice() async {
    try {
      final json = await ApiClient.instance.get('/funds/advice') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _advice = AdviceResponse.fromJson(json);
        _adviceFailed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _adviceFailed = true);
    }
  }

  Future<void> _makeAdvice({bool refresh = false}) async {
    setState(() {
      _adviceBusy = true;
      _adviceProblem = null;
    });
    try {
      final json = await ApiClient.instance.post('/funds/advice${refresh ? '?refresh=1' : ''}') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() => _advice = AdviceResponse.fromJson(json));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _adviceProblem = error is ApiException ? error.message : "Couldn't reach the server. Try again.";
        // 409: there's no key after all.
        if (error is ApiException && error.statusCode == 409 && _advice != null) {
          final advice = _advice!;
          _advice = AdviceResponse(advice: advice.advice, day: advice.day, model: advice.model, cached: advice.cached);
        }
      });
    } finally {
      if (mounted) setState(() => _adviceBusy = false);
    }
  }

  /// Everything a fund change touches: the list, its suggestions, the goals.
  Future<void> _reloadAll() async {
    await Future.wait([_loadPortfolio(), _loadGoals()]);
  }

  Future<void> _addFund([SchemeResult? scheme]) async {
    if (await AddFundScreen.open(context, scheme: scheme)) {
      if (_tabs.index != 0) _tabs.animateTo(0);
      await _reloadAll();
    }
  }

  Future<void> _openHolding(String holdingId) async {
    final portfolio = _portfolio;
    FundHolding? initial;
    for (final holding in portfolio?.holdings ?? const <FundHolding>[]) {
      if (holding.id == holdingId) initial = holding;
    }
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => HoldingDetailScreen(
        holdingId: holdingId,
        initial: initial,
        rules: portfolio?.flagRules ?? const FlagRules(),
        peersAvailable: portfolio?.peers.available ?? true,
        links: _links,
      ),
    ));
    if (mounted) await _reloadAll();
  }

  Future<void> _openLinks() async {
    final changed = await showLinkSuggestionsSheet(
      context,
      links: _links,
      holdings: _portfolio?.holdings ?? const [],
    );
    if (changed) await _reloadAll();
  }

  Future<void> _editGoal([FundGoal? goal]) async {
    if (await GoalEditorScreen.open(context, goal: goal, holdings: _portfolio?.holdings ?? const [])) {
      await _loadGoals();
    }
  }

  void _openAiSettings() {
    final open = widget.onOpenAiSettings;
    if (open == null) return;
    Navigator.of(context).popUntil((route) => route.isFirst);
    open();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final fab = switch (_tabs.index) {
      0 when _portfolio != null && !_portfolio!.isEmpty => FloatingActionButton.extended(
          heroTag: 'add-fund',
          onPressed: _addFund,
          icon: const Icon(Icons.add),
          label: const Text('Add fund'),
        ),
      1 when _goals != null && _goals!.goals.isNotEmpty => FloatingActionButton.extended(
          heroTag: 'add-goal',
          onPressed: _editGoal,
          icon: const Icon(Icons.flag_outlined),
          label: const Text('Add goal'),
        ),
      _ => null,
    };

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text('Investments', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
        shape: Border(bottom: BorderSide(color: c.line)),
        bottom: TabBar(
          controller: _tabs,
          labelColor: c.brandDark,
          unselectedLabelColor: c.muted,
          indicatorColor: c.brand,
          indicatorSize: TabBarIndicatorSize.label,
          dividerColor: Colors.transparent,
          labelStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700),
          unselectedLabelStyle: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600),
          tabs: const [Tab(text: 'Portfolio', height: 42), Tab(text: 'Goals', height: 42), Tab(text: 'Advice', height: 42)],
        ),
      ),
      floatingActionButton: fab,
      body: TabBarView(
        controller: _tabs,
        children: [
          _portfolioTab(),
          _goalsTab(),
          _adviceTab(),
        ],
      ),
    );
  }

  // Portfolio.

  Widget _portfolioTab() {
    final c = context.c;
    final portfolio = _portfolio;
    if (portfolio == null) {
      if (_portfolioFailed) {
        return StateBlock(
          icon: Icons.wifi_off,
          warn: true,
          title: "Couldn't load your funds",
          body: _portfolioError ?? 'The connection failed. Check your internet and try again.',
          actionLabel: 'Retry',
          onAction: () {
            setState(() => _portfolioFailed = false);
            _loadPortfolio();
          },
        );
      }
      return const Center(child: CircularProgressIndicator());
    }

    if (portfolio.isEmpty) {
      return RefreshIndicator(
        onRefresh: _loadPortfolio,
        child: LayoutBuilder(
          builder: (context, constraints) => ListView(
            children: [
              ConstrainedBox(
                constraints: BoxConstraints(minHeight: constraints.maxHeight),
                child: StateBlock(
                  icon: Icons.savings_outlined,
                  title: 'Track your mutual funds',
                  body: 'Add the funds you invest in - a SIP, units you already hold, or both. See what they are '
                      'worth every day, how each does against its category, and which need a look.',
                  actionLabel: 'Add fund',
                  onAction: _addFund,
                ),
              ),
            ],
          ),
        ),
      );
    }

    final flagged = portfolio.holdings.where((holding) => holding.flags.isNotEmpty).length;
    return RefreshIndicator(
      onRefresh: _reloadAll,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 96),
        children: [
          if (portfolio.stale || portfolio.error != null) ...[
            FundBanner(
              icon: Icons.schedule,
              text: [
                portfolio.lastNavDate == null
                    ? 'No NAVs yet'
                    : 'Prices are from ${formatIsoLongDate(portfolio.lastNavDate!)}',
                if (portfolio.error != null) "couldn't refresh: ${portfolio.error}",
              ].join(' · '),
            ),
            const SizedBox(height: 12),
          ],
          PortfolioHeader(portfolio: portfolio),
          if (portfolio.allocation.any((slice) => slice.valueMinor > 0)) ...[
            const SizedBox(height: 12),
            FundCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Allocation', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: c.ink)),
                  const SizedBox(height: 10),
                  AllocationBar(slices: portfolio.allocation),
                ],
              ),
            ),
          ],
          if (!_links.isEmpty) ...[
            const SizedBox(height: 12),
            FundBanner(
              icon: Icons.link,
              tone: TagTone.brand,
              text: _linksBannerText(_links),
              actionLabel: 'Review',
              onTap: _openLinks,
            ),
          ],
          if (!portfolio.peers.available) ...[
            const SizedBox(height: 12),
            const RanksComingNote(),
          ],
          const SizedBox(height: 20),
          FundSectionHeader(
            title: 'Funds',
            count: portfolio.holdings.length,
            trailing: flagged == 0
                ? null
                : Text(
                    '$flagged need${flagged == 1 ? 's' : ''} a look',
                    style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: c.warn),
                  ),
          ),
          const SizedBox(height: 8),
          for (final (i, holding) in portfolio.holdings.indexed) ...[
            if (i > 0) const SizedBox(height: 10),
            HoldingCard(holding: holding, rules: portfolio.flagRules, onTap: () => _openHolding(holding.id)),
          ],
          const SizedBox(height: 18),
          Text(
            'NAVs are AMFI\'s, refreshed every day. XIRR is your own yearly return, counting when each rupee went '
            'in; it shows once a fund has three months of history. Category figures compare growth plans only.',
            style: TextStyle(fontSize: 11.5, height: 1.5, color: c.muted),
          ),
        ],
      ),
    );
  }

  static String _linksBannerText(LinkSuggestions links) {
    final debits = links.suggestions.length;
    final commitments = links.commitments.length;
    final parts = [
      if (debits > 0) '$debits ${debits == 1 ? 'payment looks' : 'payments look'} like SIP instalments',
      if (commitments > 0) '$commitments SIP ${commitments == 1 ? 'commitment' : 'commitments'} to connect',
    ];
    return 'Link SIP payments: ${parts.join(', ')}.';
  }

  // Goals.

  Widget _goalsTab() {
    final c = context.c;
    final goals = _goals;
    if (goals == null) {
      if (_goalsFailed) {
        return StateBlock(
          icon: Icons.wifi_off,
          warn: true,
          title: "Couldn't load your goals",
          body: _goalsError ?? 'The connection failed. Check your internet and try again.',
          actionLabel: 'Retry',
          onAction: () {
            setState(() => _goalsFailed = false);
            _loadGoals();
          },
        );
      }
      return const Center(child: CircularProgressIndicator());
    }

    final holdings = _portfolio?.holdings ?? const <FundHolding>[];
    return RefreshIndicator(
      onRefresh: _loadGoals,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 96),
        children: [
          if (goals.goals.isEmpty) ...[
            FundCard(
              padding: const EdgeInsets.fromLTRB(16, 20, 16, 20),
              child: Column(
                children: [
                  Container(
                    width: 52,
                    height: 52,
                    decoration: BoxDecoration(color: c.brand50, borderRadius: BorderRadius.circular(14)),
                    child: Icon(Icons.flag_outlined, size: 26, color: c.brand),
                  ),
                  const SizedBox(height: 14),
                  Text(
                    'Save up for something',
                    style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'A laptop for ₹2,00,000 by next June? Add it, and see how much to put in each month, and '
                    'in what kind of fund, to have it on time.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13.5, height: 1.5, color: c.ink70),
                  ),
                  const SizedBox(height: 16),
                  FilledButton.icon(
                    onPressed: _editGoal,
                    icon: const Icon(Icons.add, size: 18),
                    label: const Text('Add a goal'),
                  ),
                ],
              ),
            ),
          ] else
            for (final (i, goal) in goals.goals.indexed) ...[
              if (i > 0) const SizedBox(height: 12),
              GoalCard(
                goal: goal,
                holdings: holdings,
                onTap: () => _editGoal(goal),
                onExampleFund: (fund) => _addFund(SchemeResult.named(fund.schemeCode, fund.name)),
              ),
            ],
          const SizedBox(height: 16),
          AssumptionsCard(assumptions: goals.assumptions),
          if (!goals.peersAvailable && goals.goals.isNotEmpty) ...[
            const SizedBox(height: 12),
            const FundBanner(
              icon: Icons.leaderboard_outlined,
              tone: TagTone.neutral,
              text: 'Example funds for each plan come once category returns have been gathered.',
            ),
          ],
        ],
      ),
    );
  }

  // Advice.

  Widget _adviceTab() {
    final advice = _advice;
    if (advice == null) {
      if (_adviceFailed) {
        return StateBlock(
          icon: Icons.wifi_off,
          warn: true,
          title: "Couldn't load advice",
          body: 'The connection failed. Check your internet and try again.',
          actionLabel: 'Retry',
          onAction: () {
            setState(() => _adviceFailed = false);
            _loadAdvice();
          },
        );
      }
      return const Center(child: CircularProgressIndicator());
    }
    return AdviceView(
      response: advice,
      busy: _adviceBusy,
      problem: _adviceProblem,
      hasHoldings: !(_portfolio?.isEmpty ?? false),
      onGet: () => _makeAdvice(),
      onRefresh: () => _makeAdvice(refresh: true),
      onOpenSettings: widget.onOpenAiSettings == null ? null : _openAiSettings,
      onOpenHolding: _openHolding,
      onExampleFund: (fund) => _addFund(SchemeResult.named(fund.schemeCode, fund.name)),
      onReload: _loadAdvice,
    );
  }
}

/// The portfolio's figures, at the top of the Portfolio tab.
class PortfolioHeader extends StatelessWidget {
  const PortfolioHeader({super.key, required this.portfolio});

  final FundPortfolio portfolio;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final t = portfolio.totals;
    final day = t.dayChangeMinor;
    return FundCard(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'CURRENT VALUE',
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 1, color: c.muted),
          ),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              formatMoneyShort(t.valueMinor),
              style: kNum.copyWith(fontSize: 32, fontWeight: FontWeight.w800, color: c.ink),
            ),
          ),
          const SizedBox(height: 2),
          Row(
            children: [
              Icon(
                day > 0 ? Icons.arrow_upward : (day < 0 ? Icons.arrow_downward : Icons.remove),
                size: 14,
                color: gainColor(c, day),
              ),
              const SizedBox(width: 4),
              Flexible(
                child: Text(
                  '${signedMoneyShort(day)} (${fundPercent(t.dayChangePercent, signed: true, digits: 2)}) today',
                  style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w700, color: gainColor(c, day)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Divider(height: 1, color: c.line),
          const SizedBox(height: 12),
          StatGrid(cells: [
            StatCell(label: 'Invested', value: formatMoneyShort(t.investedMinor)),
            StatCell(
              label: 'Gain',
              value: signedMoneyShort(t.gainMinor),
              sub: fundPercent(t.gainPercent, signed: true),
              color: gainColor(c, t.gainMinor),
            ),
            StatCell(
              label: 'XIRR (a year)',
              value: t.xirrPercent == null ? '—' : fundPercent(t.xirrPercent),
              sub: t.xirrPercent == null ? 'After 3 months' : null,
              color: t.xirrPercent == null ? null : gainColor(c, t.xirrPercent),
            ),
            StatCell(
              label: 'SIPs a month',
              value: t.monthlySipMinor > 0 ? formatMoneyShort(t.monthlySipMinor) : '—',
            ),
          ]),
          const SizedBox(height: 12),
          Text(
            portfolio.lastNavDate == null ? 'No NAV yet' : 'NAV as of ${formatIsoLongDate(portfolio.lastNavDate!)}',
            style: TextStyle(fontSize: 11.5, color: c.muted),
          ),
        ],
      ),
    );
  }
}

/// The Advice tab: the assistant's read on the funds and goals, or the way
/// to get one, and always the disclaimer.
class AdviceView extends StatelessWidget {
  const AdviceView({
    super.key,
    required this.response,
    this.busy = false,
    this.problem,
    this.hasHoldings = true,
    required this.onGet,
    required this.onRefresh,
    this.onOpenSettings,
    required this.onOpenHolding,
    required this.onExampleFund,
    required this.onReload,
  });

  final AdviceResponse response;
  final bool busy;
  final String? problem;
  final bool hasHoldings;
  final VoidCallback onGet;
  final VoidCallback onRefresh;
  final VoidCallback? onOpenSettings;
  final ValueChanged<String> onOpenHolding;
  final ValueChanged<FundRef> onExampleFund;
  final Future<void> Function() onReload;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final advice = response.advice;
    final made = response.day == null
        ? null
        : response.day == istToday()
            ? 'Made today'
            : 'Made ${formatIsoLongDate(response.day!)}';

    return RefreshIndicator(
      onRefresh: onReload,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 32),
        children: [
          if (!response.hasKey) ...[
            _NoKeyCard(onOpenSettings: onOpenSettings),
            const SizedBox(height: 12),
          ],
          if (advice == null && response.hasKey)
            FundCard(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
              child: Column(
                children: [
                  Icon(Icons.auto_awesome_outlined, size: 28, color: c.brand),
                  const SizedBox(height: 10),
                  Text(
                    'A second look at your funds',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: c.ink),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    hasHoldings
                        ? 'Which SIPs are lagging and why, what to add or switch, and where each goal\'s monthly '
                            'amount should go - from your XIRR, category ranks and goals.'
                        : 'Add a fund or a goal first: the advice works from what you hold and what you are '
                            'saving for.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 13, height: 1.5, color: c.ink70),
                  ),
                  const SizedBox(height: 14),
                  FilledButton.icon(
                    onPressed: busy ? null : onGet,
                    icon: const Icon(Icons.auto_awesome, size: 18),
                    label: const Text('Get advice'),
                  ),
                ],
              ),
            ),
          if (advice != null)
            Row(
              children: [
                Expanded(
                  child: Text(
                    [if (made != null) made, if (response.model != null) response.model!].join(' · '),
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.muted),
                  ),
                ),
                TextButton.icon(
                  onPressed: busy || !response.hasKey ? null : onRefresh,
                  icon: const Icon(Icons.refresh, size: 18),
                  label: const Text('Refresh'),
                ),
              ],
            ),
          if (busy) ...[
            const SizedBox(height: 10),
            const LinearProgressIndicator(),
            const SizedBox(height: 6),
            Text(
              'Reading your funds and goals. This can take up to half a minute.',
              style: TextStyle(fontSize: 12, color: c.muted),
            ),
          ],
          if (problem != null) ...[
            const SizedBox(height: 10),
            FundBanner(icon: Icons.error_outline, text: problem!),
          ],
          if (advice != null) ..._adviceSections(context, advice),
          const SizedBox(height: 20),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(padding: const EdgeInsets.only(top: 1), child: Icon(Icons.info_outline, size: 14, color: c.muted)),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  advice?.disclaimer ?? kAdviceDisclaimer,
                  key: const ValueKey('advice-disclaimer'),
                  style: TextStyle(fontSize: 11.5, height: 1.5, color: c.muted),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  List<Widget> _adviceSections(BuildContext context, FundAdvice advice) {
    final c = context.c;
    return [
      if (advice.summary.isNotEmpty) ...[
        const SizedBox(height: 8),
        FundCard(
          child: Text(advice.summary, style: TextStyle(fontSize: 13.5, height: 1.55, color: c.ink)),
        ),
      ],
      const SizedBox(height: 20),
      FundSectionHeader(title: 'Not performing well', count: advice.underperformers.length),
      const SizedBox(height: 8),
      if (advice.underperformers.isEmpty)
        Text('Nothing stands out as lagging.', style: TextStyle(fontSize: 12.5, color: c.muted))
      else
        for (final item in advice.underperformers) ...[
          FundCard(
            onTap: item.holdingId.isEmpty ? null : () => onOpenHolding(item.holdingId),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(padding: const EdgeInsets.only(top: 1), child: Icon(Icons.trending_down, size: 17, color: c.warn)),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        shortSchemeName(item.schemeName),
                        style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w800, color: c.ink),
                      ),
                      const SizedBox(height: 2),
                      Text(item.reason, style: TextStyle(fontSize: 12.5, height: 1.45, color: c.ink70)),
                    ],
                  ),
                ),
                if (item.holdingId.isNotEmpty) Icon(Icons.chevron_right, size: 18, color: c.mutedLight),
              ],
            ),
          ),
          const SizedBox(height: 8),
        ],
      if (advice.actions.isNotEmpty) ...[
        const SizedBox(height: 12),
        FundSectionHeader(title: 'What to do', count: advice.actions.length),
        const SizedBox(height: 8),
        for (final action in advice.actions) ...[
          FundCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (action.title.isNotEmpty)
                  Text(action.title, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: c.ink)),
                if (action.detail.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(action.detail, style: TextStyle(fontSize: 12.5, height: 1.5, color: c.ink70)),
                ],
                if (action.amountMinor != null || action.category != null) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: [
                      if (action.amountMinor != null) FundTag(formatMoneyShort(action.amountMinor!), tone: TagTone.brand),
                      if (action.category != null) FundTag(action.category!),
                    ],
                  ),
                ],
                for (final fund in action.exampleFunds)
                  InkWell(
                    onTap: () => onExampleFund(fund),
                    child: Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Row(
                        children: [
                          Icon(Icons.north_east, size: 14, color: c.mutedLight),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              shortSchemeName(fund.name),
                              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: c.brandDark),
                            ),
                          ),
                          Icon(Icons.add_circle_outline, size: 18, color: c.brand),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 8),
        ],
      ],
      if (advice.goals.isNotEmpty) ...[
        const SizedBox(height: 12),
        const FundSectionHeader(title: 'For your goals'),
        const SizedBox(height: 8),
        FundCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final (i, line) in advice.goals.indexed) ...[
                if (i > 0) const SizedBox(height: 10),
                Text(line.name, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800, color: c.ink)),
                Text(line.line, style: TextStyle(fontSize: 12.5, height: 1.45, color: c.ink70)),
              ],
            ],
          ),
        ),
      ],
    ];
  }
}

/// No Gemini key: what that means, and where one goes.
class _NoKeyCard extends StatelessWidget {
  const _NoKeyCard({this.onOpenSettings});

  final VoidCallback? onOpenSettings;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
      decoration: BoxDecoration(color: c.warnBg, borderRadius: BorderRadius.circular(T.rMd)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.key_outlined, size: 17, color: c.warn),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'Advice needs a Gemini key',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: c.warn),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            'It runs on Google Gemini with a key of your own. Get one free from Google AI Studio, then paste it '
            'under Settings → You → AI assistant.',
            style: TextStyle(fontSize: 12.5, height: 1.5, color: c.ink70),
          ),
          if (onOpenSettings != null) ...[
            const SizedBox(height: 10),
            OutlinedButton(onPressed: onOpenSettings, child: const Text('Go to Settings')),
          ],
        ],
      ),
    );
  }
}
