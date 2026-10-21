import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/account_balance_panel.dart';
import '../widgets/card_vault_panel.dart';
import '../widgets/edit_account_sheet.dart';
import '../widgets/pocket_money.dart';
import '../widgets/state_block.dart';
import 'passbook_screen.dart';
import 'statements_screen.dart';
import 'transactions_screen.dart';

/// Every account, one at a time.
///
/// A single list told you almost nothing about any of them: to find out
/// where a card stood you opened a sheet, and to find its statements you
/// went somewhere else entirely. So each account gets a chip of its own,
/// and under it everything that belongs to it — what it is, where it
/// stands this cycle, when it bills, its stored details, and its
/// statements.
class AccountsScreen extends StatefulWidget {
  const AccountsScreen({super.key, this.initialAccountId, this.editOnOpen = false});

  /// The account to open on, when arriving from its face on Home - to add
  /// its card details, say - rather than on the first chip.
  final String? initialAccountId;

  /// Straight into [initialAccountId]'s editor once it has loaded - to set
  /// a card's credit limit from its face, say.
  final bool editOnOpen;

  @override
  State<AccountsScreen> createState() => _AccountsScreenState();
}

/// A credit card's own billing cycle and where it stands against its credit
/// limit. Null for anything that is not a credit card - a savings account
/// has no limit and no bill, and an empty bar drawn for one would mean
/// nothing.
class _Cycle {
  /// Whether the card has a statement day, stored or read off a statement.
  /// Without one there is no cycle, and the figures below are null.
  final bool cycleKnown;
  final int? floatDays;
  final int? unbilledMinor;
  final int? billedUnpaidMinor;
  final int? outstandingMinor;
  final bool outstandingIsEstimate;
  final int? creditLimitMinor;
  final int? usedMinor;
  final int? availableMinor;

  /// ok | close | over | unset - credit used against the limit.
  final String state;

  _Cycle({
    this.cycleKnown = true,
    this.floatDays,
    this.unbilledMinor,
    this.billedUnpaidMinor,
    this.outstandingMinor,
    this.outstandingIsEstimate = false,
    this.creditLimitMinor,
    this.usedMinor,
    this.availableMinor,
    this.state = 'unset',
  });

  factory _Cycle.fromJson(Map<String, dynamic> json) => _Cycle(
        cycleKnown: json['cycleKnown'] as bool? ?? true,
        floatDays: json['floatDays'] as int?,
        unbilledMinor: json['unbilledMinor'] as int?,
        billedUnpaidMinor: json['billedUnpaidMinor'] as int?,
        outstandingMinor: json['outstandingMinor'] as int?,
        outstandingIsEstimate: json['outstandingIsEstimate'] as bool? ?? false,
        creditLimitMinor: json['creditLimitMinor'] as int?,
        usedMinor: json['usedMinor'] as int?,
        availableMinor: json['availableMinor'] as int?,
        state: json['state'] as String? ?? 'unset',
      );
}

/// The last bill read off a statement — the only figure on the panel that
/// comes from the bank rather than from adding up messages.
class _Bill {
  final int totalDueMinor;
  final int? daysUntilDue;
  final bool isPaid;

  _Bill({required this.totalDueMinor, this.daysUntilDue, required this.isPaid});

  factory _Bill.fromJson(Map<String, dynamic> json) => _Bill(
        totalDueMinor: json['totalDueMinor'] as int? ?? 0,
        daysUntilDue: json['daysUntilDue'] as int?,
        isPaid: json['isPaid'] as bool? ?? false,
      );
}

class _Overview {
  final Account account;
  final _Cycle? cycle;
  final _Bill? bill;
  final bool hasCardDetails;

  /// Whether this can hold a balance at all (a bank account or cash), and
  /// what it should hold now when a starting balance has been given.
  final bool tracksBalance;
  final ExpectedBalance? balance;

  /// What a debit card draws on, named rather than referenced.
  final String? linkedAccount;

  /// For a bank account, the debit cards that reach it. Its own spending
  /// includes theirs, which a total does not say.
  final List<({String name, String? last4})> debitCards;

  /// This month's spending against the limit, for a pocket-money account.
  final PocketStatus? pocket;

  _Overview({
    required this.account,
    this.cycle,
    this.bill,
    required this.hasCardDetails,
    this.tracksBalance = false,
    this.balance,
    this.linkedAccount,
    this.debitCards = const [],
    this.pocket,
  });

  factory _Overview.fromJson(Map<String, dynamic> json) => _Overview(
        account: Account.fromJson(json),
        cycle: json['cycle'] == null ? null : _Cycle.fromJson(json['cycle'] as Map<String, dynamic>),
        bill: json['bill'] == null ? null : _Bill.fromJson(json['bill'] as Map<String, dynamic>),
        hasCardDetails: json['hasCardDetails'] as bool? ?? false,
        tracksBalance: json['tracksBalance'] as bool? ?? false,
        balance: json['balance'] is Map<String, dynamic>
            ? ExpectedBalance.fromJson(json['balance'] as Map<String, dynamic>)
            : null,
        linkedAccount: json['linkedAccount'] as String?,
        debitCards: ((json['debitCards'] as List?) ?? const [])
            .map((card) => (
                  name: (card as Map<String, dynamic>)['name'] as String? ?? 'A card',
                  last4: card['last4'] as String?,
                ))
            .toList(),
        pocket: json['pocket'] is Map<String, dynamic>
            ? PocketStatus.fromJson(json['pocket'] as Map<String, dynamic>)
            : null,
      );
}

class _AccountsScreenState extends State<AccountsScreen> {
  List<_Overview>? _accounts;
  late String? _selectedId = widget.initialAccountId;
  late bool _editPending = widget.editOnOpen && widget.initialAccountId != null;
  bool _error = false;
  int _unfiled = 0;
  bool _reading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/accounts/overview'),
        ApiClient.instance.get('/statements/filed'),
      ]);
      if (!mounted) return;
      setState(() {
        _accounts = (results[0] as List<dynamic>)
            .map((a) => _Overview.fromJson(a as Map<String, dynamic>))
            .toList();

        final orphans = (results[1] as List<dynamic>).cast<Map<String, dynamic>>().where(
              (group) => group['accountId'] == 'unfiled',
            );
        _unfiled = orphans.isEmpty
            ? 0
            : ((orphans.first['months'] as List<dynamic>?) ?? []).fold<int>(
                0,
                (sum, month) =>
                    sum + (((month as Map<String, dynamic>)['statements'] as List?)?.length ?? 0),
              );

        _error = false;
        // Keep whatever was being looked at, unless it has gone.
        if (!_accounts!.any((row) => row.account.id == _selectedId)) {
          _selectedId = _accounts!.isEmpty ? null : _accounts!.first.account.id;
        }
      });

      // Once only: the editor asked for on the way in, not after every reload.
      if (_editPending) {
        _editPending = false;
        final wanted = _accounts!.where((row) => row.account.id == widget.initialAccountId);
        if (wanted.isNotEmpty) await _open(account: wanted.first.account);
      }
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _remove(Account account) async {
    int inUse = 0;
    try {
      await ApiClient.instance.delete('/accounts/${account.id}');
      await _load();
      return;
    } catch (error) {
      if (error is ApiException && error.statusCode == 409) {
        inUse = int.tryParse(RegExp(r'^(\d+)').firstMatch(error.message)?.group(1) ?? '') ?? 0;
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
        }
        return;
      }
    }

    if (!mounted) return;
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove ${account.label}?'),
        content: Text(
          '$inUse ${inUse == 1 ? 'transaction is' : 'transactions are'} filed under it. Removing '
          'it keeps them and leaves them without an account — or merge it into another account '
          'instead, from Edit, to move them across.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (sure != true) return;

    try {
      await ApiClient.instance.delete('/accounts/${account.id}?unassign=true');
      await _load();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$error')));
      }
    }
  }

  /// Read the mailbox for new statements, from the screen they get filed on.
  Future<void> _readStatements() async {
    if (_reading) return;
    setState(() => _reading = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await ApiClient.instance.post('/statements/sync') as Map<String, dynamic>;
      final scanned = result['scanned'] as int? ?? 0;
      final read = result['read'] as int? ?? 0;
      final added = result['added'] as int? ?? 0;
      final unidentified = result['unidentified'] as int? ?? 0;
      messenger.showSnackBar(SnackBar(
        content: Text(scanned == 0
            ? 'No statements found in the mailbox.'
            : 'Read $read of $scanned. $added transactions added'
                '${unidentified > 0 ? ', $unidentified on an unknown card' : ''}.'),
      ));
      await _load();
    } catch (error) {
      messenger.showSnackBar(SnackBar(
        content: Text(error is ApiException ? error.message : "That didn't work just now."),
      ));
    } finally {
      if (mounted) setState(() => _reading = false);
    }
  }

  /// Marking one account as savings unmarks any other on the server, so the
  /// whole list is reloaded rather than this one row patched.
  Future<void> _setSavings(Account account, bool isSavings) async {
    try {
      await ApiClient.instance.patch('/accounts/${account.id}', {'isSavings': isSavings});
      await _load();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(error is ApiException ? error.message : "That didn't save just now."),
        ));
      }
    }
  }

  /// Set, change or stop pocket money. Null stops it; its past payments
  /// stay where they are, only the badge and the monthly limit go.
  Future<void> _savePocket(Account account, PocketMoney? pocket) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.patch('/accounts/${account.id}', {'pocketMoney': pocket?.toJson()});
      await _load();
    } catch (error) {
      messenger.showSnackBar(SnackBar(
        content: Text(error is ApiException ? error.message : "That didn't save just now."),
      ));
    }
  }

  Future<void> _editPocket(Account account) async {
    final pocket = await showPocketMoneyDialog(context, current: account.pocketMoney);
    if (pocket != null) await _savePocket(account, pocket);
  }

  Future<void> _stopPocket(Account account) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Stop being pocket money?'),
        content: Text(
          '${account.label} goes back to being an ordinary account. Its payments stay, '
          'without the pocket money mark.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep it')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Stop')),
        ],
      ),
    );
    if (sure == true) await _savePocket(account, null);
  }

  /// The statement password on its own, rather than inside the whole edit
  /// sheet - it is the one setting people come to this row to change.
  Future<void> _editStatementPassword(Account account) async {
    final controller = TextEditingController();
    final messenger = ScaffoldMessenger.of(context);
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(account.hasStatementPassword ? 'Change statement password' : 'Statement password'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DsPasswordField(
              controller: controller,
              autofocus: true,
              decoration: const InputDecoration(labelText: 'Password that opens the statement PDF'),
            ),
            const SizedBox(height: 10),
            Text(
              'Usually built from your date of birth and name - the statement email says the format. '
              "It's stored encrypted and never shown again.",
              style: TextStyle(fontSize: 12, height: 16 / 12, color: context.c.tx3),
            ),
          ],
        ),
        actions: [
          if (account.hasStatementPassword)
            TextButton(
              onPressed: () => Navigator.of(context).pop(''),
              style: TextButton.styleFrom(foregroundColor: context.c.crit),
              child: const Text('Remove'),
            ),
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final value = controller.text.trim();
              if (value.isNotEmpty) Navigator.of(context).pop(value);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (result == null) return;

    try {
      await ApiClient.instance.put('/statements/password/${account.id}', {'password': result});
      messenger.showSnackBar(SnackBar(content: Text(result.isEmpty ? 'Password removed.' : 'Password saved.')));
      await _load();
    } catch (error) {
      messenger.showSnackBar(
        SnackBar(content: Text(error is ApiException ? error.message : "Couldn't save the password.")),
      );
    }
  }

  Future<void> _open({Account? account}) async {
    final changed = await showEditAccountSheet(
      context,
      account: account,
      accounts: (_accounts ?? const []).map((row) => row.account).toList(),
    );
    if (changed == true) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Accounts and cards'),
        actions: [
          IconButton(
            tooltip: 'Read statements from the mailbox',
            onPressed: _reading ? null : _readStatements,
            icon: _reading ? const DsSpinner(size: 18) : const DsIcon(DsIcons.refresh),
          ),
          IconButton(
            tooltip: 'Add a card or account',
            onPressed: () => _open(),
            icon: const DsIcon(DsIcons.plus),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_error) {
      return StateBlock(
        icon: Icons.wifi_off,
        warn: true,
        title: "Couldn't load your accounts",
        body: 'The connection failed. Check your internet and try again.',
        actionLabel: 'Retry',
        onAction: _load,
      );
    }

    if (_accounts == null) {
      return ListView(
        padding: kPagePad,
        children: const [DsSkeletonRows(count: 5, caption: 'Loading your accounts…')],
      );
    }

    if (_accounts!.isEmpty) {
      return StateBlock(
        icon: Icons.account_balance_outlined,
        title: 'No accounts yet',
        body: 'These appear on their own the first time a bank texts you. Add one by hand for anything '
            "that doesn't — cash, or an account that never sends alerts.",
        actionLabel: 'Add an account',
        onAction: () => _open(),
      );
    }

    final selected = _accounts!.firstWhere(
      (row) => row.account.id == _selectedId,
      orElse: () => _accounts!.first,
    );

    return Column(
      children: [
        _chips(),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              padding: kPagePad,
              children: [_panel(selected)],
            ),
          ),
        ),
      ],
    );
  }

  Widget _chips() {
    final c = context.c;

    return Container(
      decoration: BoxDecoration(color: c.bg, border: Border(bottom: BorderSide(color: c.ln))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
        child: Row(
          children: [
            for (final row in _accounts!)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: _chip(row),
              ),
            // Last, and only while there is something in it: the
            // statements no account could be found for. A to-do list
            // rather than a place, so it says how long it is.
            if (_unfiled > 0) _unfiledChip(),
          ],
        ),
      ),
    );
  }

  Widget _unfiledChip() {
    final c = context.c;

    return Material(
      color: c.warnSoft,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rLg)),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () async {
          await Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => const StatementsScreen(
                onlyAccountId: 'unfiled',
                title: 'Not on an account',
              ),
            ),
          );
          await _load();
        },
        child: Container(
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              DsIcon(DsIcons.alertTriangle, size: 18, color: c.warn),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    'Not on an account',
                    style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.warn),
                  ),
                  Text(
                    '$_unfiled statement${_unfiled == 1 ? '' : 's'}',
                    style: TextStyle(fontSize: 12, height: 16 / 12, color: c.warn, fontFeatures: Ds.tabular),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The icon for a kind of account, from the design set.
  static DsGlyph _kindIcon(String accountType) => switch (accountType) {
        'BANK' => DsIcons.bank,
        'CASH' => DsIcons.banknote,
        _ => DsIcons.creditCard,
      };

  /// One account in the selector: a selected list item is `acSoft` with an
  /// `acLine` ring (§5.3).
  Widget _chip(_Overview row) {
    final c = context.c;
    final on = row.account.id == _selectedId;

    return Opacity(
      opacity: row.account.isActive ? 1 : 0.55,
      child: Material(
        color: on ? c.acSoft : c.sf,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Ds.rLg),
          side: BorderSide(color: on ? c.acLine : c.ln),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: () => setState(() => _selectedId = row.account.id),
          child: Container(
            constraints: const BoxConstraints(minHeight: 52),
            padding: const EdgeInsets.fromLTRB(8, 8, 14, 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                DsIconTile(
                  _kindIcon(row.account.accountType),
                  size: 32,
                  iconSize: 18,
                  tone: on ? DsTone.ac : DsTone.neutral,
                  onTinted: on,
                ),
                const SizedBox(width: 10),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      row.account.nickname?.trim().isNotEmpty ?? false
                          ? row.account.nickname!.trim()
                          : row.account.bankName,
                      style: TextStyle(
                        fontSize: 13,
                        height: 18 / 13,
                        fontWeight: FontWeight.w600,
                        color: on ? c.ac : c.tx,
                      ),
                    ),
                    if (row.account.last4 != null)
                      Text('•••• ${row.account.last4}',
                          style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: on ? c.ac : c.tx3)),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _panel(_Overview row) {
    final c = context.c;
    final account = row.account;

    // A credit card, and only that. A debit card has no cycle, no limit,
    // no due date and no statement of its own - its spending is the
    // account's - so every figure below that assumes one would be an
    // empty box on a debit card's page.
    final isCard = account.accountType == 'CARD';
    final isDebit = account.accountType == 'DEBIT';
    final isBank = account.accountType == 'BANK';

    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DsIconTile(_kindIcon(account.accountType), tone: DsTone.ac),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      account.label,
                      style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      [
                        switch (account.accountType) {
                          'CARD' => 'Credit card',
                          'DEBIT' => 'Debit card',
                          'BANK' => 'Bank account',
                          'CASH' => 'Cash',
                          _ => account.accountType,
                        },
                        if (account.cardNetwork != null) account.cardNetwork!,
                        if (isDebit)
                          row.linkedAccount == null
                              ? 'not linked to an account'
                              : 'draws on ${row.linkedAccount}',
                        if (!account.isActive) 'closed',
                      ].join(' · '),
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                    ),
                  ],
                ),
              ),
              TextButton.icon(
                onPressed: () => _open(account: account),
                icon: const DsIcon(DsIcons.pencil, size: 16),
                label: const Text('Edit'),
              ),
              // Cash is a fixture rather than something that was added -
              // every account needs somewhere to put a payment that came
              // out of a pocket - so it is closed rather than deleted.
              if (account.accountType != 'CASH')
                IconButton(
                  tooltip: 'Remove this account',
                  onPressed: () => _remove(account),
                  icon: DsIcon(DsIcons.trash, size: 18, color: c.crit),
                ),
            ],
          ),
          const SizedBox(height: 16),

          // First among the figures when there is one: it is the only one
          // here that says whether anything has gone missing.
          if (row.tracksBalance)
            AccountBalancePanel(
              key: ValueKey('balance-${account.id}'),
              accountId: account.id,
              balance: row.balance,
              isCash: account.accountType == 'CASH',
              onChanged: _load,
            ),

          // Row by row, the app's figure beside the bank's - and where
          // the two parted, when they have.
          if (row.tracksBalance && row.balance != null) ...[
            _row(
              Icons.menu_book_outlined,
              'Passbook',
              row.balance!.drift == null
                  ? 'Every row, with the running balance'
                  : '${formatMoneyShort(row.balance!.drift!.minor.abs())} off from the bank'
                      '${row.balance!.drift!.since == null ? '' : ' since ${formatShortDate(row.balance!.drift!.since!)}'}',
              on: true,
              warn: row.balance!.drift != null,
              action: TextButton(
                onPressed: () async {
                  await PassbookScreen.open(context, accountId: account.id);
                  await _load();
                },
                child: const Text('Open'),
              ),
            ),
            const SizedBox(height: 12),
          ],

          // The emergency pot: still tracked here, but left out of the
          // money-on-hand total on Home so it never looks spendable.
          if (isBank) ...[
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: account.isSavings,
              onChanged: (value) => _setSavings(account, value),
              title: Text(
                'This is my savings account',
                style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
              ),
              subtitle: Text(
                'Kept out of money on hand. Only one account can be the savings account.',
                style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
              ),
            ),
            const SizedBox(height: 4),
          ],

          // A credit card bills you rather than holding money someone can
          // be handed, so pocket money is for everything else.
          if (!isCard) ...[
            _pocket(row),
            const SizedBox(height: 12),
          ],

          if (isCard && row.cycle != null && row.cycle!.cycleKnown)
            _meter(row.cycle!)
          else
            _figure(
              'This account',
              switch (account.accountType) {
                'BANK' => 'Bank account',
                'DEBIT' => 'Debit card',
                'CASH' => 'Cash',
                _ => 'Credit card',
              },
              _standingNote(row, isCard: isCard, isDebit: isDebit),
            ),

          if (!isDebit) ...[
            const SizedBox(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: _dates(account, row.cycle)),
                const SizedBox(width: 12),
                Expanded(child: _latestBill(row.bill)),
              ],
            ),
          ],

          if (row.debitCards.isNotEmpty) ...[
            const SizedBox(height: 12),
            _figure(
              'Debit cards on it',
              row.debitCards
                  .map((card) => card.last4 == null ? card.name : '${card.name} ••${card.last4}')
                  .join('\n'),
              'This account is where their spending is counted.',
            ),
          ],

          // A bank account's number and IFSC are asked for as often as a
          // card's number is - every time someone sends you money.
          if (isCard || isDebit || isBank)
            CardVaultPanel(
              key: ValueKey(account.id),
              accountId: account.id,
              last4: account.last4,
              hasDetails: row.hasCardDetails,
              isBank: isBank,
              onChanged: _load,
            ),

          // Every account has payments on it, debit cards included, so this
          // is the one row they all get.
          const SizedBox(height: 16),
          _row(
            DsIcons.list,
            'Transactions',
            !isCard
                ? 'This month'
                : row.cycle?.cycleKnown == true
                    ? 'This statement cycle'
                    : 'All of it - no billing date yet',
            on: true,
            action: TextButton(
              onPressed: () async {
                await Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => TransactionsScreen(initialAccountId: account.id)),
                );
                // An edit or a new payment there moves this page's figures.
                await _load();
              },
              child: const Text('Open'),
            ),
          ),

          // A debit card emails no statement, so there is no password for
          // one and nothing filed under it. The account it draws on has
          // both, and that is where its spending shows.
          if (!isDebit) ...[
            const SizedBox(height: 8),
            _row(
              DsIcons.lock,
              'Statement password',
              account.hasStatementPassword ? 'Set' : 'Not set',
              on: account.hasStatementPassword,
              action: TextButton(
                onPressed: () => _editStatementPassword(account),
                child: Text(account.hasStatementPassword ? 'Change' : 'Add'),
              ),
            ),
            const SizedBox(height: 8),
            _row(
              Icons.folder_outlined,
              'Statements',
              'Filed by month',
              on: true,
              action: TextButton(
                onPressed: () async {
                  await Navigator.of(context).push(
                    MaterialPageRoute(
                      builder: (_) => StatementsScreen(
                        onlyAccountId: account.id,
                        title: account.label,
                      ),
                    ),
                  );
                  await _load();
                },
                child: const Text('Open'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// An inner tile: `sf2`, 1 px `ln`, radius 12.
  BoxDecoration _tile() {
    final c = context.c;
    return BoxDecoration(
      color: c.sf2,
      border: Border.all(color: c.ln),
      borderRadius: BorderRadius.circular(Ds.rLg),
    );
  }

  /// Pocket money: off, a line saying what it is for and a way to turn it
  /// on; on, this month's spending against the limit and the top-up due.
  Widget _pocket(_Overview row) {
    final c = context.c;
    final account = row.account;
    final setting = account.pocketMoney;

    if (setting == null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 6),
        decoration: _tile(),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const DsLabel('Pocket money'),
            const SizedBox(height: 4),
            Text(
              'For an account someone else spends from - a child without UPI, say. Give it a '
              'monthly limit and a day it renews, and every payment from it is marked as theirs.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                style: TextButton.styleFrom(padding: EdgeInsets.zero),
                onPressed: () => _editPocket(account),
                icon: const DsIcon(DsIcons.piggyBank, size: 16),
                label: const Text('Make this pocket money'),
              ),
            ),
          ],
        ),
      );
    }

    // The overview always sends a status with a setting; this only covers
    // an older server that sent the setting alone.
    final status = row.pocket ??
        PocketStatus(
          holder: setting.holder,
          limitMinor: setting.limitMinor,
          renewDay: setting.renewDay,
          spentMinor: 0,
          leftMinor: setting.limitMinor,
        );

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
      decoration: _tile(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsLabel(pocketTitle(status.holder)),
          const SizedBox(height: 6),
          PocketMeter(status: status),
          const SizedBox(height: 6),
          Text(
            '${status.transactionCount} ${status.transactionCount == 1 ? 'payment' : 'payments'} this month · '
            '${pocketRenews(status)}',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
          if (status.renewsToday) ...[
            const SizedBox(height: 10),
            _topUp(status),
          ],
          Row(
            children: [
              TextButton(
                style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 4)),
                onPressed: () => _editPocket(account),
                child: const Text('Edit'),
              ),
              const Spacer(),
              Flexible(
                flex: 4,
                child: TextButton(
                  style: TextButton.styleFrom(foregroundColor: c.crit),
                  onPressed: () => _stopPocket(account),
                  child: const Text('Stop being pocket money', maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// Renewal day: what has to go in, or what already did.
  Widget _topUp(PocketStatus status) {
    final done = status.toppedUpMinor > 0;
    final text = done
        ? 'Topped up ${formatMoney(status.toppedUpMinor)}'
        : status.lastMonthSpentMinor > 0
            ? 'Top up ${formatMoney(status.lastMonthSpentMinor)} today'
            : 'Renews today - nothing was spent last month, so nothing to top up';

    return DsCallout(
      tone: done ? DsTone.good : DsTone.warn,
      icon: done ? DsIcons.check : DsIcons.banknote,
      title: text,
    );
  }

  /// What this account is, for anything with no cycle to show instead.
  String _standingNote(_Overview row, {required bool isCard, required bool isDebit}) {
    if (isDebit) {
      return row.linkedAccount == null
          ? 'Not linked to an account, so it is counted on its own'
          : 'Spends ${row.linkedAccount} money, and is counted there';
    }

    return isCard ? 'Set a statement day to see a cycle' : 'No billing cycle to track';
  }

  /// What the card owes and how much of its credit limit that is: the
  /// unpaid part of the last bill and everything charged since, on the
  /// card's own cycle.
  Widget _meter(_Cycle cycle) {
    final c = context.c;
    final limit = cycle.creditLimitMinor;
    final owed = cycle.outstandingMinor ?? 0;
    final used = cycle.usedMinor ?? owed;
    final fraction = limit != null && limit > 0 ? (used / limit).clamp(0.0, 1.0) : null;
    // Ink for ordinary use; amber close to the limit; red only past it.
    final (Color fill, Color note) = switch (cycle.state) {
      'over' => (c.critFill, c.crit),
      'close' => (c.warnFill, c.warn),
      _ => (c.tx, c.tx3),
    };

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: _tile(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const DsLabel('Owed on this card'),
          const SizedBox(height: 4),
          Wrap(
            crossAxisAlignment: WrapCrossAlignment.end,
            spacing: 8,
            children: [
              Text(
                formatMoney(owed),
                style: kNum.copyWith(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
              ),
              if (limit != null && limit > 0)
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Text(
                    'of ${formatMoney(limit)} limit',
                    style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w500, color: c.tx3),
                  ),
                ),
            ],
          ),
          if (fraction != null) ...[
            const SizedBox(height: 10),
            DsMeter(value: fraction, color: fill),
          ],
          const SizedBox(height: 8),
          Text(
            _meterNote(cycle),
            style: TextStyle(
              fontSize: 12,
              height: 16 / 12,
              color: note,
              fontWeight: cycle.state == 'over' ? FontWeight.w600 : FontWeight.w400,
              fontFeatures: Ds.tabular,
            ),
          ),
        ],
      ),
    );
  }

  /// What is left, what of the last bill is unpaid, and what this cycle has
  /// charged so far.
  String _meterNote(_Cycle cycle) {
    final billed = cycle.billedUnpaidMinor ?? 0;
    return [
      if (cycle.availableMinor != null)
        '${formatMoney(cycle.availableMinor!)} available'
      else
        'Set a credit limit to see what is left',
      if (billed > 0) '${cycle.outstandingIsEstimate ? 'about ' : ''}${formatMoney(billed)} of the last bill unpaid',
      '${formatMoney(cycle.unbilledMinor ?? 0)} spent since statement',
    ].join(' · ');
  }

  Widget _dates(Account account, _Cycle? cycle) {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: _tile(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const DsLabel('Dates'),
          const SizedBox(height: 8),
          for (final (label, value) in [
            ('Statement', account.statementDay == null ? '—' : ordinalDay(account.statementDay!)),
            ('Due', account.dueDay == null ? '—' : ordinalDay(account.dueDay!)),
            if (cycle?.floatDays != null) ('Float', '${cycle!.floatDays} days'),
          ])
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Flexible(child: Text(label, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3))),
                  Text(
                    value,
                    style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _latestBill(_Bill? bill) {
    final c = context.c;

    return _figure(
      'Latest bill',
      bill == null ? '—' : formatMoney(bill.totalDueMinor),
      _billNote(bill),
      valueColor: (bill?.isPaid ?? false) ? c.good : null,
      noteColor: bill != null && !bill.isPaid && (bill.daysUntilDue ?? 99) < 0 ? c.crit : null,
    );
  }

  String _billNote(_Bill? bill) {
    if (bill == null) return 'No statement read yet';
    if (bill.isPaid) return 'Paid';

    final days = bill.daysUntilDue;
    if (days == null) return 'Read from a statement';

    return days < 0 ? '${days.abs()} days overdue' : 'Due in $days days';
  }

  Widget _figure(String label, String value, String note, {Color? valueColor, Color? noteColor}) {
    final c = context.c;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: _tile(),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsLabel(label),
          const SizedBox(height: 4),
          Text(
            value,
            style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: valueColor ?? c.tx),
          ),
          const SizedBox(height: 4),
          Text(note, style: TextStyle(fontSize: 12, height: 16 / 12, color: noteColor ?? c.tx3)),
        ],
      ),
    );
  }

  /// A link row in an inner tile: icon tile, label and state, and the way in.
  /// [warn] marks a mismatch, which is a problem, so it reads in `crit`.
  Widget _row(Object icon, String label, String value, {required bool on, bool warn = false, required Widget action}) {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
      decoration: _tile(),
      child: Row(
        children: [
          DsIconTile(icon, size: 36, tone: warn ? DsTone.crit : DsTone.neutral, onTinted: !warn),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(label, style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx)),
                Text(
                  value,
                  style: TextStyle(
                    fontSize: 13,
                    height: 18 / 13,
                    fontWeight: warn ? FontWeight.w600 : FontWeight.w400,
                    color: warn ? c.crit : (on ? c.good : c.tx3),
                    fontFeatures: Ds.tabular,
                  ),
                ),
              ],
            ),
          ),
          action,
        ],
      ),
    );
  }
}
