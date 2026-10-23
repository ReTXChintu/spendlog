import 'dart:async';
import 'package:flutter/material.dart';
import '../models/fund_models.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../utils/loan_tab.dart';
import '../services/reminder_service.dart';
import '../widgets/card_picker.dart';
import '../widgets/commitment_amount.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/home/earmarks_tile.dart';
import '../widgets/home/home_grid.dart';
import '../widgets/home/investments_tile.dart';
import '../widgets/home/monthly_budget_card.dart';
import '../widgets/home/plan_warnings.dart';
import '../widgets/home/wallet.dart';
import '../widgets/pocket_money.dart';
import '../widgets/state_block.dart';
import '../widgets/what_came_in_sheet.dart';
import 'accounts_screen.dart';
import 'investments/investments_screen.dart';
import 'loans_screen.dart';
import 'monthly_budget_screen.dart';
import 'passbook_screen.dart';
import 'people_screen.dart';
import 'perks_screen.dart';
import 'statements_screen.dart';
import 'subscriptions_screen.dart';
import 'transactions_screen.dart';

/// The Dashboard tab of Home: what you need to know now.
///
/// Everything here passes one test — could you act on it before putting the
/// phone away? A card near its limit changes which card comes out; a chart
/// of last March changes nothing, and lives on the Analytics tab.
///
/// Laid out as compact tiles two to a row, so a phone screen shows half a
/// dozen answers at once instead of two long cards.
///
/// One request draws the whole thing. Seven round trips over mobile data to
/// paint the screen you land on is the worst place to spend them.
class DashboardScreen extends StatefulWidget {
  final VoidCallback? onOpenTransactions;
  final VoidCallback? onOpenSettings;

  /// Opens the savings plan on the Analytics tab, from a plan warning.
  final VoidCallback? onOpenPlan;

  /// Settings, at the assistant's card - from Investments' advice tab.
  final VoidCallback? onOpenAiSettings;

  const DashboardScreen({
    super.key,
    this.onOpenTransactions,
    this.onOpenSettings,
    this.onOpenPlan,
    this.onOpenAiSettings,
  });

  @override
  State<DashboardScreen> createState() => DashboardScreenState();
}

class DashboardScreenState extends State<DashboardScreen> with AutomaticKeepAliveClientMixin {
  DashboardData? _data;
  bool _failed = false;

  /// Who owes what, fetched on its own after the dashboard. It is one tile
  /// on this screen, and a slow or failed answer should cost that tile and
  /// nothing else.
  ContactBalance? _people;

  /// The mutual fund portfolio, also fetched on its own: NAVs come from a
  /// third party, and a slow answer should cost the investments tile only.
  FundPortfolio? _funds;
  bool _fundsFailed = false;

  // Kept alive so swiping to Analytics and back does not refetch and lose
  // the scroll position.
  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    try {
      final result = await ApiClient.instance.get('/dashboard');
      if (!mounted) return;
      final data = DashboardData.fromJson(result as Map<String, dynamic>);
      setState(() {
        _data = data;
        _failed = false;
      });

      // The follow-up reminders are armed and disarmed from here, because
      // this is where the count becomes known - every open and every pull
      // to refresh. Nothing waits on it.
      unawaited(ReminderService.instance.updateFollowUps(data.needsCategoryYesterday));
      unawaited(_loadPeople());
      unawaited(_loadFunds());
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _loadPeople() async {
    try {
      final json = await ApiClient.instance.get('/contacts') as Map<String, dynamic>;
      if (mounted) setState(() => _people = ContactBalance.fromJson(json));
    } catch (_) {
      // The tile falls back to the split-bill total from the dashboard.
    }
  }

  Future<void> _loadFunds() async {
    try {
      final json = await ApiClient.instance.get('/funds/portfolio') as Map<String, dynamic>;
      if (mounted) {
        setState(() {
          _funds = FundPortfolio.fromJson(json);
          _fundsFailed = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _fundsFailed = true);
    }
  }

  Future<void> _openInvestments() async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => InvestmentsScreen(onOpenAiSettings: widget.onOpenAiSettings)),
    );
    await _loadFunds();
  }

  Future<void> _openPeople() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PeopleScreen()));
    await load();
  }

  /// Every account, or straight to one of them - to add a card's details
  /// from its face, say.
  Future<void> _openAccounts([String? accountId]) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => AccountsScreen(initialAccountId: accountId)),
    );
    await load();
  }

  /// An account's editor, over its page - to set a card's billing date or
  /// credit limit from its face.
  Future<void> _editAccount(String accountId) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => AccountsScreen(initialAccountId: accountId, editOnOpen: true)),
    );
    await load();
  }

  /// An account's passbook - from its tile, or from a drift alert, which
  /// is then marked seen and opens straight onto finding the cause.
  Future<void> _openPassbook(String accountId, {String? alertId, bool reconcile = false}) async {
    await PassbookScreen.open(context, accountId: accountId, alertId: alertId, openReconcile: reconcile);
    await load();
  }

  /// An "Unexplained difference" written in to match the bank: its editor,
  /// to say what it was.
  Future<void> _openUnexplained(String transactionId) async {
    await showEditTransactionById(context, transactionId);
    await load();
  }

  /// Money that came in without a text: "What came in?".
  Future<void> _openMissingCredit(MissingCredit credit) async {
    final changed = await showWhatCameInSheet(context, credit: credit);
    if (changed == true) await load();
  }

  /// A statement to fetch for a bank that never texts money in: that
  /// account's statements, asking for the month.
  Future<void> _openStatementDue(BalanceTodo todo) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => StatementsScreen(
          onlyAccountId: todo.accountId,
          title: 'Statements',
          dueMonth: todo.month,
        ),
      ),
    );
    await load();
  }

  /// The payments no account could be placed for, on their own.
  Future<void> _openUnknownAccount() async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => TransactionsScreen(initialAccountUnknown: true, onOpenSettings: widget.onOpenSettings),
      ),
    );
    await load();
  }

  /// A card's own transactions, starting on the statement cycle running now.
  Future<void> _openCard(CardFace card) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => TransactionsScreen(initialAccountId: card.accountId)),
    );
    await load();
  }

  Future<void> _editBudget() async {
    final data = _data;
    if (data == null) return;
    if (await MonthlyBudgetScreen.open(context, initial: data.budget)) await load();
  }

  Future<void> _togglePaid(FixedCommitment commitment, bool paid) async {
    await ApiClient.instance
        .post('/budget/commitments/${commitment.id}/paid', {'paid': paid})
        .catchError((_) => null);
    await load();
  }

  Future<void> _openPerks() async {
    await Navigator.of(context).push(MaterialPageRoute(builder: (_) => const PerksScreen()));
    await load();
  }

  /// Where the loan stands - its instalments and the payments towards it
  /// - with editing it one tap further in.
  Future<void> _openLoan(Loan loan) async {
    await LoansScreen.open(context, loanId: loan.id);
    await load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);

    if (_failed) {
      return StateBlock(
        icon: Icons.wifi_off,
        title: "Couldn't reach the server",
        body: 'Nothing is lost — this screen is built from what the server already knows.',
        actionLabel: 'Try again',
        onAction: load,
      );
    }

    final data = _data;
    if (data == null) return const Center(child: DsSpinner());

    final fixed = data.fixedCosts;
    // Pocket money already shows on its account's tile in the wallet; a
    // tile of its own is only for one that is not there.
    final walletIds = data.wallet.banks.map((bank) => bank.accountId).toSet();
    final loosePockets = data.pocketMoney.where((p) => !walletIds.contains(p.accountId));

    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: kPagePad,
        children: [
          // First on the screen because it is the thing you open the app
          // standing up to use. Everything else can wait for a scroll.
          _AskBar(onTap: _openPerks),
          const SizedBox(height: kCardGap),

          // Above the money, because a broken rule is the one thing here
          // meant to change what you do next.
          PlanWarnings(warnings: data.planWarnings, onOpenPlan: widget.onOpenPlan ?? () {}),

          // The month against its budget: the "Free to spend" hero. The
          // pace line is the one thing on this screen that should change
          // what you spend today.
          MonthlyBudgetCard(
            budget: data.budget,
            onEdit: _editBudget,
            subscriptions: data.subscriptions,
            onSubscriptions: () => SubscriptionsScreen.open(context).then((_) => load()),
          ),

          // The jobs: a calm queue, each with one verb.
          _Todos(
            data: data,
            onOpenTransactions: widget.onOpenTransactions,
            onOpenSettings: widget.onOpenSettings,
            onOpenPerks: _openPerks,
            onOpenAccounts: _openAccounts,
            onOpenPassbook: _openPassbook,
            onOpenUnexplained: _openUnexplained,
            onOpenUnknownAccount: _openUnknownAccount,
            onOpenMissingCredit: _openMissingCredit,
            onOpenStatementDue: _openStatementDue,
          ),

          // Every card and account, so where one stands is here rather
          // than two screens in.
          const _Group('Wallet'),
          WalletSection(
            money: data.money,
            wallet: data.wallet,
            onOpenCard: _openCard,
            onOpenAccount: _openAccounts,
            onEditAccount: _editAccount,
            onOpenPassbook: _openPassbook,
            onManage: _openAccounts,
          ),

          // What the money set aside is doing: the portfolio today, or the
          // way to start tracking one.
          const _Group('Investments'),
          InvestmentsTile(portfolio: _funds, failed: _fundsFailed, onTap: _openInvestments),

          // Then two groups, in the order the questions come. Today: which
          // card and what is set aside. This month: how the rest of it is
          // going.
          const _Group('Today'),
          HomeGrid(items: [
            if (data.earmarks.count > 0) GridItem(EarmarksTile(earmarks: data.earmarks)),
            for (final pocket in loosePockets) GridItem(_PocketTile(pocket: pocket, onTap: _openAccounts)),
            GridItem(
              HomeTile(
                label: 'Which card today',
                icon: DsIcons.creditCard,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'The card that gives you longest before the money actually has to leave.',
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: context.c.tx3),
                    ),
                    const SizedBox(height: 12),
                    CardPicker(picks: data.picks, onOpenAccounts: widget.onOpenSettings),
                  ],
                ),
              ),
              span: 2,
            ),
          ]),

          const _Group('This month'),
          HomeGrid(items: [
            GridItem(_SoFarTile(month: data.monthSoFar)),
            // No pace tile: the monthly budget card above is the one pace.
            if (fixed.configured && fixed.commitments.isNotEmpty)
              GridItem(_FixedCostsTile(fixed: fixed, onTogglePaid: _togglePaid), span: 2),
            if (data.emiCount > 0)
              GridItem(HomeTile(
                label: 'EMIs running',
                icon: DsIcons.repeat,
                // Each plan and its months are on Loans & EMIs.
                onTap: () => LoansScreen.open(context).then((_) => load()),
                child: _TileBody(
                  figure: formatMoney(data.emiMonthlyMinor),
                  sub: 'a month across ${data.emiCount == 1 ? 'one plan' : '${data.emiCount} plans'} · '
                      '${formatMoneyShort(data.emiRemainingMinor)} still to pay',
                ),
              )),
            // Always here, since it is the way in to People: the question
            // "who still owes me for that dinner" has nowhere else to go.
            GridItem(_PeopleTile(people: _people, splitBalanceMinor: data.owedBalanceMinor, onTap: _openPeople)),
            if (data.loans.isEmpty && data.loanCount > 0)
              GridItem(HomeTile(
                label: 'Loans',
                icon: DsIcons.bank,
                child: _TileBody(
                  figure: formatMoney(data.loanMonthlyMinor),
                  sub: 'a month across ${data.loanCount == 1 ? 'one loan' : '${data.loanCount} loans'} · '
                      '${formatMoneyShort(data.loanRemainingMinor)} still to repay',
                ),
              )),
          ]),

          // Each loan by name, rather than one total: when is the next one
          // and how much is a today question.
          if (data.loans.isNotEmpty) ...[
            const _Group('Loans'),
            _Heading(
              title: '${formatMoney(data.loanMonthlyMinor)} a month',
              sub: '${loanTotalLine(data.loanTotals.balanceMinor)} · '
                  '${formatMoneyShort(data.loanRemainingMinor)} still to repay across '
                  '${data.loanCount == 1 ? 'one loan' : '${data.loanCount} loans'}. Tap one for its instalments.',
            ),
            const SizedBox(height: 12),
            HomeGrid(items: [
              for (final loan in data.loans) GridItem(_LoanTile(loan: loan, onTap: () => _openLoan(loan))),
            ]),
          ],
        ],
      ),
    );
  }
}

/// A heading between runs of sections: Wallet, Today, This month. So
/// figures on different timescales stop reading as one list.
class _Group extends StatelessWidget {
  const _Group(this.title);

  final String title;

  @override
  Widget build(BuildContext context) {
    return DsSectionHeader(title, padding: const EdgeInsets.only(top: 24, bottom: 12));
  }
}

/// The way into the perk lookup, made to look like what it is: a question.
class _AskBar extends StatelessWidget {
  final VoidCallback onTap;

  const _AskBar({required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Material(
      color: c.sf,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Ds.rMd),
        side: BorderSide(color: c.ln2),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          child: Row(
            children: [
              DsIcon(DsIcons.tag, size: 20, color: c.ac),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'Where are you? Check for a coupon or cashback',
                  style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx2),
                ),
              ),
              const SizedBox(width: 8),
              DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
            ],
          ),
        ),
      ),
    );
  }
}

/// One job in the "Needs you" queue.
typedef _Job = ({
  DsGlyph icon,
  DsTone tone,
  String text,
  String? meta,
  String verb,
  VoidCallback? onTap,
});

/// The jobs: the "Needs you" queue.
///
/// Renders nothing when there is nothing to do — a row that is always on
/// screen stops being read, and then so does the real one.
class _Todos extends StatelessWidget {
  final DashboardData data;
  final VoidCallback? onOpenTransactions;
  final VoidCallback? onOpenSettings;
  final VoidCallback onOpenPerks;
  final VoidCallback onOpenAccounts;

  /// A drift alert: the account's passbook, the alert marked seen, and
  /// the reconcile sheet offered on top.
  final Future<void> Function(String accountId, {String? alertId, bool reconcile}) onOpenPassbook;

  /// An unexplained difference: that row's editor.
  final Future<void> Function(String transactionId) onOpenUnexplained;

  /// The payments with no account: the ledger narrowed to them.
  final VoidCallback onOpenUnknownAccount;

  /// Money in without a text: "What came in?".
  final Future<void> Function(MissingCredit credit) onOpenMissingCredit;

  /// A statement due: that account's statements.
  final Future<void> Function(BalanceTodo todo) onOpenStatementDue;

  const _Todos({
    required this.data,
    this.onOpenTransactions,
    this.onOpenSettings,
    required this.onOpenPerks,
    required this.onOpenAccounts,
    required this.onOpenPassbook,
    required this.onOpenUnexplained,
    required this.onOpenUnknownAccount,
    required this.onOpenMissingCredit,
    required this.onOpenStatementDue,
  });

  @override
  Widget build(BuildContext context) {
    final jobs = <_Job>[];
    String? meta(String body) => body.trim().isEmpty ? null : body;

    // Money the app and the bank disagree about comes first: everything
    // else on this screen is built on the balances being right. The tone
    // of each tile says how much it matters: red only for a problem.
    for (final todo in data.todos) {
      if (todo.isAlert && todo.accountId != null) {
        jobs.add((
          icon: DsIcons.bank,
          tone: DsTone.crit,
          text: todo.title,
          meta: meta(todo.body),
          verb: 'Find the cause',
          onTap: () => onOpenPassbook(todo.accountId!, alertId: todo.alertId, reconcile: true),
        ));
      } else if (todo.isMissingCredit) {
        final credit = todo.missingCredit!;
        jobs.add((
          icon: DsIcons.arrowDownLeft,
          tone: DsTone.warn,
          text: todo.title,
          meta: meta(todo.body),
          verb: 'Answer',
          onTap: () => onOpenMissingCredit(credit),
        ));
      } else if (todo.isStatementDue) {
        jobs.add((
          icon: DsIcons.mail,
          tone: DsTone.neutral,
          text: todo.title,
          meta: meta(todo.body),
          verb: 'Get the statement',
          onTap: () => onOpenStatementDue(todo),
        ));
      } else if (todo.isUnexplained && todo.transactionId != null) {
        jobs.add((
          icon: DsIcons.info,
          tone: DsTone.warn,
          text: todo.title,
          meta: meta(todo.body),
          verb: 'Say what it was',
          onTap: () => onOpenUnexplained(todo.transactionId!),
        ));
      } else if (todo.isUnknownAccount) {
        jobs.add((
          icon: DsIcons.info,
          tone: DsTone.ac,
          text: todo.title,
          meta: meta(todo.body),
          verb: 'Pick account',
          onTap: onOpenUnknownAccount,
        ));
      }
    }

    if (data.needsCategoryYesterday > 0) {
      final count = data.needsCategoryYesterday;
      jobs.add((
        icon: DsIcons.tag,
        tone: DsTone.warn,
        text: '$count from yesterday ${count == 1 ? 'needs' : 'need'} a category',
        meta: null,
        verb: 'Pick categories',
        onTap: onOpenTransactions,
      ));
    } else if (data.needsCategoryMonth > 0) {
      final count = data.needsCategoryMonth;
      jobs.add((
        icon: DsIcons.tag,
        tone: DsTone.ac,
        text: '$count this month still ${count == 1 ? 'needs' : 'need'} a category',
        meta: null,
        verb: 'Pick categories',
        onTap: onOpenTransactions,
      ));
    }

    for (final bill in data.bills) {
      final soon = (bill.daysUntilDue ?? 99) <= 3;
      jobs.add((
        icon: DsIcons.creditCard,
        tone: soon ? DsTone.warn : DsTone.neutral,
        text: '${bill.cardName} bill ${formatMoney(bill.totalDueMinor)}${bill.whenDue}',
        meta: null,
        verb: 'See payments',
        onTap: onOpenTransactions,
      ));
    }

    // Only until the money goes in: a top-up seen on the account clears it.
    for (final pocket in data.pocketMoney.where((p) => p.topUpDue)) {
      jobs.add((
        icon: DsIcons.piggyBank,
        tone: DsTone.warn,
        text: 'Top up ${pocketTitle(pocket.holder)} ${formatMoney(pocket.lastMonthSpentMinor)} today',
        meta: null,
        verb: 'Open account',
        onTap: onOpenAccounts,
      ));
    }

    if (data.stuckStatements.isNotEmpty) {
      final count = data.stuckStatements.length;
      jobs.add((
        icon: DsIcons.alertTriangle,
        tone: DsTone.crit,
        text: '$count ${count == 1 ? 'statement' : 'statements'} could not be read',
        meta: null,
        verb: 'Open settings',
        onTap: onOpenSettings,
      ));
    }

    if (data.expiringPerks.isNotEmpty) {
      final count = data.expiringPerks.length;
      jobs.add((
        icon: DsIcons.tag,
        tone: DsTone.ac,
        text: '$count ${count == 1 ? 'perk' : 'perks'} expiring soon',
        meta: null,
        verb: 'See perks',
        onTap: onOpenPerks,
      ));
    }

    if (jobs.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: kCardGap),
      child: DsCard(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DsSectionHeader('Needs you', badge: DsCountBadge(jobs.length)),
            const SizedBox(height: 4),
            for (var i = 0; i < jobs.length; i++) _JobRow(job: jobs[i], last: i == jobs.length - 1),
          ],
        ),
      ),
    );
  }
}

/// A "Needs you" row: a 40 icon tile, the title, a meta line, and one
/// verb-led accent action. The whole row is the tap target.
class _JobRow extends StatelessWidget {
  const _JobRow({required this.job, required this.last});

  final _Job job;
  final bool last;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: job.onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DsIconTile(job.icon, tone: job.tone),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    job.text,
                    style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  if (job.meta != null) ...[
                    const SizedBox(height: 2),
                    Text(job.meta!, style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3)),
                  ],
                  if (job.onTap != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Flexible(
                            child: Text(
                              job.verb,
                              style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: c.ac),
                            ),
                          ),
                          const SizedBox(width: 4),
                          DsIcon(DsIcons.chevronRight, size: 16, color: c.ac),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A figure and a line under it: the body of most tiles.
class _TileBody extends StatelessWidget {
  const _TileBody({required this.figure, required this.sub, this.colour});

  final String figure;
  final String sub;
  final Color? colour;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TileFigure(figure, color: colour),
        const SizedBox(height: 4),
        Text(sub, style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: context.c.tx3)),
      ],
    );
  }
}

/// Spent so far against the same point last month - not the whole of last
/// month, which would look like overspending every time.
class _SoFarTile extends StatelessWidget {
  final MonthSoFar month;

  const _SoFarTile({required this.month});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final change = month.changeMinor;
    // More spend than last time is the bad delta (§3.2); less is good.
    final colour = change > 0 ? c.crit : (change < 0 ? c.good : c.tx3);

    return HomeTile(
      label: 'So far',
      icon: DsIcons.calendar,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TileFigure(formatMoney(month.spentMinor)),
          const SizedBox(height: 6),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: change == 0
                    ? Icon(Icons.remove, size: 12, color: colour)
                    : DsIcon(change > 0 ? DsIcons.arrowUpRight : DsIcons.arrowDownLeft, size: 12, color: colour),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Text(
                  change == 0
                      ? 'Level with this point last month'
                      : '${formatMoneyShort(change.abs())} ${change > 0 ? 'more' : 'less'} than this point '
                          'last month',
                  style: kNum.copyWith(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: colour),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          // "Your month", not the calendar's: with a salary day set it runs
          // pay day to pay day, and day 1 is the pay day.
          Text(
            month.label.isEmpty
                ? 'Day ${month.dayOfMonth} of your month'
                : 'Day ${month.dayOfMonth} · ${month.label}',
            style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}

/// The fixed costs as a checklist, ticked off as they go out. They count
/// against the monthly budget like anything else; the ticks are what say
/// which are still to come.
class _FixedCostsTile extends StatelessWidget {
  final FixedCosts fixed;
  final Future<void> Function(FixedCommitment, bool) onTogglePaid;

  const _FixedCostsTile({required this.fixed, required this.onTogglePaid});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return HomeTile(
      label: fixed.commitmentsRemainingMinor > 0
          ? 'Fixed each month · ${formatMoneyShort(fixed.commitmentsRemainingMinor)} still to go out'
          : 'Fixed each month',
      icon: DsIcons.listChecks,
      child: Column(
        children: [
          for (final commitment in fixed.commitments)
            CheckboxListTile(
              value: commitment.isPaid,
              onChanged: (value) => onTogglePaid(commitment, value ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              visualDensity: VisualDensity.compact,
              title: Text(
                commitment.isPartial
                    ? '${commitment.name}  ·  ${formatMoneyShort(commitment.shortfallMinor)} short'
                    : commitment.name,
                style: kNum.copyWith(
                  fontSize: 14,
                  height: 20 / 14,
                  color: commitment.isPaid ? c.tx3 : (commitment.isPartial ? c.warn : c.tx),
                  decoration: commitment.isPaid ? TextDecoration.lineThrough : null,
                ),
              ),
              // Partly paid is measured against this period's figure: a
              // raise agreed after the rent went out does not make that
              // rent short.
              secondary: commitment.isPartial
                  ? Text(
                      '${formatMoneyShort(commitment.paidMinor)}/'
                      '${formatMoneyShort(commitment.thisPeriodAmountMinor)}',
                      style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w600, color: c.tx),
                    )
                  : CommitmentAmount(commitment: commitment),
            ),
        ],
      ),
    );
  }
}

/// Who owes what, by person, as one tappable tile.
class _PeopleTile extends StatelessWidget {
  final ContactBalance? people;

  /// The dashboard's own split-bill balance, for before anyone has been
  /// named on a bill - or when the people list could not be fetched.
  final int splitBalanceMinor;
  final VoidCallback onTap;

  const _PeopleTile({required this.people, required this.splitBalanceMinor, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final owed = people?.owedToYouMinor ?? 0;
    final owe = people?.youOweMinor ?? 0;

    // Owed to you is money coming in (green); what you owe is ink - money
    // going out, not a problem.
    final String figure;
    final String sub;
    Color? colour;
    if (owed > 0) {
      figure = formatMoney(owed);
      colour = c.good;
      sub = owe > 0 ? 'owed to you · you owe ${formatMoney(owe)}' : 'owed to you';
    } else if (owe > 0) {
      figure = formatMoney(owe);
      colour = c.tx;
      sub = 'you owe';
    } else if (splitBalanceMinor != 0) {
      figure = formatMoney(splitBalanceMinor.abs());
      colour = splitBalanceMinor > 0 ? c.good : c.tx;
      sub = '${splitBalanceMinor > 0 ? 'owed to you' : 'you owe'} on split bills - say who, on each one';
    } else {
      figure = '';
      sub = 'Money lent and bills split, kept by person.';
    }

    return HomeTile(
      label: 'People',
      icon: DsIcons.users,
      onTap: onTap,
      child: figure.isEmpty
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Who owes what',
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
                const SizedBox(height: 4),
                Text(sub, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
              ],
            )
          : _TileBody(figure: figure, sub: sub, colour: colour),
    );
  }
}

/// One loan: how far through it is, and what comes out next and when.
class _LoanTile extends StatelessWidget {
  final Loan loan;
  final VoidCallback onTap;

  const _LoanTile({required this.loan, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final progress = loan.months > 0 ? (loan.paidCount / loan.months).clamp(0.0, 1.0) : 0.0;
    final next = loan.nextDue;

    // Past its date and still not marked: either it was missed, or it was
    // paid and never matched. Worth a different colour either way.
    final overdue = next != null &&
        istWallClock(next.dueDate).toIso8601String().substring(0, 10).compareTo(istToday()) < 0;
    final meta = kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3);

    return HomeTile(
      label: loan.label,
      icon: DsIcons.bank,
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TileFigure(formatMoney(loan.monthlyAmountMinor), size: 19),
          Text('a month', style: meta),
          const SizedBox(height: 10),
          DsMeter(value: progress, color: c.ac),
          const SizedBox(height: 6),
          Text(
            '${loan.paidCount} of ${loan.months} paid · ${formatMoneyShort(loan.remainingMinor)} left',
            style: meta,
          ),
          // Ahead or behind on what has fallen due: the figure a single
          // payment across every loan each month most needs checking.
          if (loan.balanceMinor != 0)
            Text(
              loanTabShort(loan.balanceMinor),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: meta.copyWith(
                fontWeight: FontWeight.w600,
                color: loan.balanceMinor < 0 ? c.warn : c.good,
              ),
            ),
          if (next != null)
            Text(
              // What is still short on it: part may already be paid.
              overdue
                  ? '${formatMoneyShort(next.shortMinor)} was due ${formatShortDate(next.dueDate)}'
                  : 'Next ${formatMoneyShort(next.shortMinor)} on ${formatShortDate(next.dueDate)}',
              style: meta.copyWith(
                fontWeight: overdue ? FontWeight.w600 : FontWeight.w500,
                color: overdue ? c.warn : c.tx2,
              ),
            ),
        ],
      ),
    );
  }
}

/// One pocket-money account: whose it is, how much of the month's limit is
/// gone, and when it renews.
class _PocketTile extends StatelessWidget {
  final PocketStatus pocket;
  final VoidCallback onTap;

  const _PocketTile({required this.pocket, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final due = pocket.topUpDue;

    return HomeTile(
      label: pocketTitle(pocket.holder),
      icon: DsIcons.piggyBank,
      onTap: onTap,
      background: due ? c.warnSoft : null,
      accent: due ? c.warn : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PocketMeter(status: pocket, compact: true),
          const SizedBox(height: 4),
          Text(
            due ? 'Top up ${formatMoneyShort(pocket.lastMonthSpentMinor)} today' : pocketRenews(pocket),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: kNum.copyWith(
              fontSize: 12,
              height: 16 / 12,
              fontWeight: due ? FontWeight.w600 : FontWeight.w500,
              color: due ? c.warn : c.tx2,
            ),
          ),
        ],
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  final String title;
  final String sub;

  const _Heading({required this.title, required this.sub});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: kNum.copyWith(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
        ),
        const SizedBox(height: 4),
        Text(sub, style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3)),
      ],
    );
  }
}
