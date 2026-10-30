import 'dart:async';
import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../services/api_client.dart';
import '../../widgets/ds/ds.dart';
import '../../utils/format.dart';
import '../../widgets/funds/fund_text.dart';
import '../../widgets/funds/fund_widgets.dart';
import '../../widgets/funds/goal_card.dart';
import '../../widgets/state_block.dart';
import 'add_fund_screen.dart';
import 'deposits_tab.dart';
import 'metals_tab.dart';
import 'goal_editor_screen.dart';
import 'holding_detail_screen.dart';
import 'link_sheets.dart';

/// Mutual funds: what's held and what it's worth today, the RDs and FDs
/// beside them, the goals it's for, and the assistant's read on both.
///
/// Three tabs over three requests, each loaded on its own: a slow NAV
/// source costs the Portfolio tab, not the goals, and advice that can't be
/// made (no Gemini key) costs only the Advice tab.
class InvestmentsScreen extends StatefulWidget {
  const InvestmentsScreen({super.key, this.initialTab = 0, this.onOpenAiSettings});

  /// 0 Funds, 1 Deposits, 2 Gold (and silver), 3 Goals, 4 Advice.
  final int initialTab;

  /// Settings, at the assistant's card - where the Gemini key goes.
  final VoidCallback? onOpenAiSettings;

  @override
  State<InvestmentsScreen> createState() => InvestmentsScreenState();
}

class InvestmentsScreenState extends State<InvestmentsScreen> with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 5, vsync: this, initialIndex: widget.initialTab.clamp(0, 4));
  final GlobalKey<DepositsTabState> _deposits = GlobalKey<DepositsTabState>();

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
          icon: const DsIcon(DsIcons.plus, size: 20),
          label: const Text('Add fund'),
        ),
      1 => FloatingActionButton.extended(
          heroTag: 'add-deposit',
          onPressed: () => _deposits.currentState?.edit(),
          icon: const DsIcon(DsIcons.plus, size: 20),
          label: const Text('Add deposit'),
        ),
      3 when _goals != null && _goals!.goals.isNotEmpty => FloatingActionButton.extended(
          heroTag: 'add-goal',
          onPressed: _editGoal,
          icon: const DsIcon(DsIcons.target, size: 20),
          label: const Text('Add goal'),
        ),
      _ => null,
    };

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Investments'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(56),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            // The tab controller still drives the pages, so swiping works;
            // this is just the system's one tab style.
            child: AnimatedBuilder(
              animation: _tabs,
              builder: (context, _) => DsSegmented<int>(
                height: 32,
                segments: const [(0, 'Funds'), (1, 'Deposits'), (2, 'Gold'), (3, 'Goals'), (4, 'Advice')],
                selected: _tabs.index,
                onChanged: (index) {
                  _tabs.animateTo(index);
                  setState(() {});
                },
              ),
            ),
          ),
        ),
      ),
      floatingActionButton: fab,
      body: TabBarView(
        controller: _tabs,
        children: [
          _portfolioTab(),
          DepositsTab(key: _deposits),
          const MetalsTab(),
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
      return const Center(child: DsSpinner());
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
                  icon: DsIcons.piggyBank,
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
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
        children: [
          if (portfolio.stale || portfolio.error != null) ...[
            // Stale data is a neutral notice with a way to try again (§7.11).
            FundBanner(
              icon: DsIcons.refresh,
              tone: TagTone.neutral,
              actionLabel: 'Retry',
              onTap: _reloadAll,
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
                  const FundSectionHeader(title: 'Allocation'),
                  const SizedBox(height: 12),
                  AllocationBar(slices: portfolio.allocation),
                ],
              ),
            ),
          ],
          if (!_links.isEmpty) ...[
            const SizedBox(height: 12),
            FundBanner(
              icon: DsIcons.link,
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
          const SizedBox(height: 24),
          FundSectionHeader(
            title: 'Funds',
            count: portfolio.holdings.length,
            trailing: flagged == 0
                ? null
                : DsBadge('$flagged need${flagged == 1 ? 's' : ''} a look', tone: DsTone.warn),
          ),
          const SizedBox(height: 12),
          for (final (i, holding) in portfolio.holdings.indexed) ...[
            if (i > 0) const SizedBox(height: kCardGap),
            HoldingCard(holding: holding, rules: portfolio.flagRules, onTap: () => _openHolding(holding.id)),
          ],
          const SizedBox(height: 16),
          Text(
            'NAVs are AMFI\'s, refreshed every day. XIRR is your own yearly return, counting when each rupee went '
            'in; it shows once a fund has three months of history. Category figures compare growth plans only.',
            style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
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
      return const Center(child: DsSpinner());
    }

    final holdings = _portfolio?.holdings ?? const <FundHolding>[];
    return RefreshIndicator(
      onRefresh: _loadGoals,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
        children: [
          if (goals.goals.isEmpty) ...[
            FundCard(
              padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
              child: Column(
                children: [
                  const DsIconTile(DsIcons.target, tone: DsTone.ac, size: 48, iconSize: 24),
                  const SizedBox(height: 16),
                  Text(
                    'Save up for something',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    'A laptop for ₹2,00,000 by next June? Add it, and see how much to put in each month, and '
                    'in what kind of fund, to have it on time.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2),
                  ),
                  const SizedBox(height: 20),
                  FilledButton.icon(
                    onPressed: _editGoal,
                    icon: const DsIcon(DsIcons.plus, size: 18),
                    label: const Text('Add a goal'),
                  ),
                ],
              ),
            ),
          ] else
            for (final (i, goal) in goals.goals.indexed) ...[
              if (i > 0) const SizedBox(height: kCardGap),
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
              icon: DsIcons.barChart,
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
      return const Center(child: DsSpinner());
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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsLabel('Current value'),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              formatMoneyShort(t.valueMinor),
              style: kNum.copyWith(
                fontSize: 34,
                height: 40 / 34,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.68,
                color: c.tx,
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '${signedMoneyShort(day)} (${fundPercent(t.dayChangePercent, signed: true, digits: 2)}) today',
            style: kNum.copyWith(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: gainColor(c, day)),
          ),
          const SizedBox(height: 16),
          Divider(height: 1, color: c.ln),
          const SizedBox(height: 16),
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
          const SizedBox(height: 16),
          Text(
            portfolio.lastNavDate == null ? 'No NAV yet' : 'NAV as of ${formatIsoLongDate(portfolio.lastNavDate!)}',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
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
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          if (!response.hasKey) ...[
            _NoKeyCard(onOpenSettings: onOpenSettings),
            const SizedBox(height: 12),
          ],
          if (advice == null && response.hasKey)
            FundCard(
              padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
              child: Column(
                children: [
                  const DsIconTile(DsIcons.sparkles, tone: DsTone.ac, size: 48, iconSize: 24),
                  const SizedBox(height: 16),
                  Text(
                    'A second look at your funds',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    hasHoldings
                        ? 'Which SIPs are lagging and why, what to add or switch, and where each goal\'s monthly '
                            'amount should go - from your XIRR, category ranks and goals.'
                        : 'Add a fund or a goal first: the advice works from what you hold and what you are '
                            'saving for.',
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2),
                  ),
                  const SizedBox(height: 20),
                  FilledButton.icon(
                    onPressed: busy ? null : onGet,
                    icon: const DsIcon(DsIcons.sparkles, size: 18),
                    label: const Text('Get advice'),
                  ),
                ],
              ),
            ),
          if (advice != null)
            Row(
              children: [
                const DsIconTile(DsIcons.sparkles, tone: DsTone.ac, size: 36),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'AI advice',
                        style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                      Text(
                        [if (made != null) made, if (response.model != null) response.model!].join(' · '),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                      ),
                    ],
                  ),
                ),
                TextButton.icon(
                  onPressed: busy || !response.hasKey ? null : onRefresh,
                  icon: const DsIcon(DsIcons.refresh, size: 18),
                  label: const Text('Refresh'),
                ),
              ],
            ),
          if (busy) ...[
            const SizedBox(height: 12),
            const LinearProgressIndicator(),
            const SizedBox(height: 8),
            Text(
              'Reading your funds and goals. This can take up to half a minute.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ],
          if (problem != null) ...[
            const SizedBox(height: 12),
            DsCallout(tone: DsTone.crit, title: problem!),
          ],
          if (advice != null) ..._adviceSections(context, advice),
          const SizedBox(height: 20),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(color: c.sunk, borderRadius: BorderRadius.circular(Ds.rLg)),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DsIcon(DsIcons.info, size: 18, color: c.tx2),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    advice?.disclaimer ?? kAdviceDisclaimer,
                    key: const ValueKey('advice-disclaimer'),
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _adviceSections(BuildContext context, FundAdvice advice) {
    final c = context.c;
    return [
      if (advice.summary.isNotEmpty) ...[
        const SizedBox(height: 12),
        FundCard(
          child: Text(advice.summary, style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx)),
        ),
      ],
      const SizedBox(height: 24),
      FundSectionHeader(title: 'Not performing well', count: advice.underperformers.length),
      const SizedBox(height: 12),
      if (advice.underperformers.isEmpty)
        Text('Nothing stands out as lagging.', style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2))
      else
        for (final item in advice.underperformers) ...[
          FundCard(
            onTap: item.holdingId.isEmpty ? null : () => onOpenHolding(item.holdingId),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const DsIconTile(Icons.trending_down, tone: DsTone.warn),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        shortSchemeName(item.schemeName),
                        style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                      const SizedBox(height: 2),
                      Text(item.reason, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2)),
                    ],
                  ),
                ),
                if (item.holdingId.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  Padding(
                    padding: const EdgeInsets.only(top: 1),
                    child: DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: kCardGap),
        ],
      if (advice.actions.isNotEmpty) ...[
        const SizedBox(height: 12),
        FundSectionHeader(title: 'What to do', count: advice.actions.length),
        const SizedBox(height: 12),
        for (final action in advice.actions) ...[
          FundCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (action.title.isNotEmpty)
                  Text(
                    action.title,
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                if (action.detail.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(action.detail, style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2)),
                ],
                if (action.amountMinor != null || action.category != null) ...[
                  const SizedBox(height: 10),
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
                    borderRadius: BorderRadius.circular(Ds.rMd),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Row(
                        children: [
                          DsIcon(DsIcons.arrowUpRight, size: 16, color: c.tx3),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              shortSchemeName(fund.name),
                              style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: c.ac),
                            ),
                          ),
                          DsIcon(DsIcons.plus, size: 18, color: c.ac),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: kCardGap),
        ],
      ],
      if (advice.goals.isNotEmpty) ...[
        const SizedBox(height: 12),
        const FundSectionHeader(title: 'For your goals'),
        const SizedBox(height: 12),
        FundCard(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (final (i, line) in advice.goals.indexed)
                Container(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  decoration: BoxDecoration(
                    border: i == 0 ? null : Border(top: BorderSide(color: c.ln)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        line.name,
                        style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                      Text(line.line, style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2)),
                    ],
                  ),
                ),
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
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: c.warnSoft, borderRadius: BorderRadius.circular(Ds.rXl)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const DsIconTile(Icons.key_outlined, tone: DsTone.warn, onTinted: true, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Advice needs a Gemini key',
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.warn),
                ),
                const SizedBox(height: 4),
                Text(
                  'It runs on Google Gemini with a key of your own. Get one free from Google AI Studio, then paste it '
                  'under Settings → You → AI assistant.',
                  style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                ),
                if (onOpenSettings != null) ...[
                  const SizedBox(height: 12),
                  OutlinedButton(
                    onPressed: onOpenSettings,
                    style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
                    child: const Text('Go to Settings'),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}
