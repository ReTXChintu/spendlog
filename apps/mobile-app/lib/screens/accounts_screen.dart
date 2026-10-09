import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/account_balance_panel.dart';
import '../widgets/card_vault_panel.dart';
import '../widgets/edit_account_sheet.dart';
import '../widgets/pocket_money.dart';
import '../widgets/state_block.dart';
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
  const AccountsScreen({super.key, this.initialAccountId});

  /// The account to open on, when arriving from its face on Home - to add
  /// its card details, say - rather than on the first chip.
  final String? initialAccountId;

  @override
  State<AccountsScreen> createState() => _AccountsScreenState();
}

/// What a card has spent this cycle, and against what. Null for anything
/// without a billing cycle — a savings account has no limit and no month,
/// and an empty bar drawn for one would mean nothing.
class _Cycle {
  final int spentMinor;
  final int? limitMinor;
  final int? floatDays;

  _Cycle({required this.spentMinor, this.limitMinor, this.floatDays});

  factory _Cycle.fromJson(Map<String, dynamic> json) => _Cycle(
        spentMinor: json['spentMinor'] as int? ?? 0,
        limitMinor: json['limitMinor'] as int?,
        floatDays: json['floatDays'] as int?,
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
            TextField(
              controller: controller,
              autofocus: true,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Password that opens the statement PDF'),
            ),
            const SizedBox(height: 10),
            Text(
              'Usually built from your date of birth and name - the statement email says the format. '
              "It's stored encrypted and never shown again.",
              style: TextStyle(fontSize: 12, color: context.c.muted),
            ),
          ],
        ),
        actions: [
          if (account.hasStatementPassword)
            TextButton(
              onPressed: () => Navigator.of(context).pop(''),
              style: TextButton.styleFrom(foregroundColor: context.c.debit),
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
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text(
          'Accounts and cards',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink),
        ),
        shape: Border(bottom: BorderSide(color: c.line)),
        actions: [
          IconButton(
            tooltip: 'Read statements from the mailbox',
            onPressed: _reading ? null : _readStatements,
            icon: _reading
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Icon(Icons.sync),
          ),
          IconButton(
            tooltip: 'Add a card or account',
            onPressed: () => _open(),
            icon: const Icon(Icons.add),
          ),
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

    if (_accounts == null) return const Center(child: CircularProgressIndicator());

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
              padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
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
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.line))),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
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

    return GestureDetector(
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
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: c.warnBg,
          border: Border.all(color: c.warn),
          borderRadius: BorderRadius.circular(T.rMd),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.help_outline, size: 16, color: c.warn),
            const SizedBox(width: 8),
            Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Not on an account',
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: c.warn,
                    )),
                Text('$_unfiled statement${_unfiled == 1 ? '' : 's'}',
                    style: TextStyle(fontSize: 10.5, color: c.warn)),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _chip(_Overview row) {
    final c = context.c;
    final on = row.account.id == _selectedId;

    return Opacity(
      opacity: row.account.isActive ? 1 : 0.55,
      child: GestureDetector(
        onTap: () => setState(() => _selectedId = row.account.id),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: on ? c.surface : c.paper,
            border: Border.all(color: on ? c.brand : c.line, width: on ? 1.5 : 1),
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                switch (row.account.accountType) {
                  'BANK' => Icons.account_balance,
                  'CASH' => Icons.payments_outlined,
                  'DEBIT' => Icons.credit_card_outlined,
                  _ => Icons.credit_card,
                },
                size: 16,
                color: on ? c.brandDark : c.muted,
              ),
              const SizedBox(width: 8),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    row.account.nickname?.trim().isNotEmpty ?? false
                        ? row.account.nickname!.trim()
                        : row.account.bankName,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w700,
                      color: on ? c.ink : c.ink70,
                    ),
                  ),
                  if (row.account.last4 != null)
                    Text('•••• ${row.account.last4}',
                        style: kNum.copyWith(fontSize: 10.5, color: c.muted)),
                ],
              ),
            ],
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

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      account.label,
                      style: const TextStyle(fontSize: 16.5, fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 3),
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
                      style: TextStyle(fontSize: 12, color: c.muted),
                    ),
                  ],
                ),
              ),
              TextButton.icon(
                onPressed: () => _open(account: account),
                icon: const Icon(Icons.edit_outlined, size: 16),
                label: const Text('Edit'),
              ),
              // Cash is a fixture rather than something that was added -
              // every account needs somewhere to put a payment that came
              // out of a pocket - so it is closed rather than deleted.
              if (account.accountType != 'CASH')
                IconButton(
                  tooltip: 'Remove this account',
                  onPressed: () => _remove(account),
                  icon: Icon(Icons.delete_outline, size: 19, color: c.debit),
                ),
            ],
          ),
          const SizedBox(height: 14),

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

          // The emergency pot: still tracked here, but left out of the
          // money-on-hand total on Home so it never looks spendable.
          if (isBank)
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: account.isSavings,
              onChanged: (value) => _setSavings(account, value),
              title: Text(
                'This is my savings account',
                style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink),
              ),
              subtitle: Text(
                'Kept out of money on hand. Only one account can be the savings account.',
                style: TextStyle(fontSize: 11.5, color: c.muted),
              ),
            ),

          // A credit card bills you rather than holding money someone can
          // be handed, so pocket money is for everything else.
          if (!isCard) ...[
            _pocket(row),
            const SizedBox(height: 10),
          ],

          if (isCard && row.cycle != null)
            _meter(row.cycle!, account)
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
            const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: _dates(account, row.cycle)),
                const SizedBox(width: 10),
                Expanded(child: _latestBill(row.bill)),
              ],
            ),
          ],

          if (row.debitCards.isNotEmpty) ...[
            const SizedBox(height: 10),
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
          const SizedBox(height: 14),
          _row(
            Icons.receipt_outlined,
            'Transactions',
            account.accountType == 'CARD' && account.statementDay != null ? 'This statement cycle' : 'This month',
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
          const SizedBox(height: 14),
          _row(
            Icons.receipt_long_outlined,
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

  /// Pocket money: off, a line saying what it is for and a way to turn it
  /// on; on, this month's spending against the limit and the top-up due.
  Widget _pocket(_Overview row) {
    final c = context.c;
    final account = row.account;
    final setting = account.pocketMoney;

    final frame = BoxDecoration(
      color: c.paper,
      border: Border.all(color: c.line),
      borderRadius: BorderRadius.circular(T.rMd),
    );
    final label = TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted);

    if (setting == null) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(13, 12, 13, 8),
        decoration: frame,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('POCKET MONEY', style: label),
            const SizedBox(height: 5),
            Text(
              'For an account someone else spends from - a child without UPI, say. Give it a '
              'monthly limit and a day it renews, and every payment from it is marked as theirs.',
              style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                style: TextButton.styleFrom(padding: EdgeInsets.zero),
                onPressed: () => _editPocket(account),
                icon: const Icon(Icons.savings_outlined, size: 16),
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
      padding: const EdgeInsets.fromLTRB(13, 12, 13, 6),
      decoration: frame,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(pocketTitle(status.holder).toUpperCase(), style: label),
          const SizedBox(height: 6),
          PocketMeter(status: status),
          const SizedBox(height: 4),
          Text(
            '${status.transactionCount} ${status.transactionCount == 1 ? 'payment' : 'payments'} this month · '
            '${pocketRenews(status)}',
            style: TextStyle(fontSize: 11.5, color: c.muted),
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
              TextButton(
                style: TextButton.styleFrom(foregroundColor: c.debit),
                onPressed: () => _stopPocket(account),
                child: const Text('Stop being pocket money'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  /// Renewal day: what has to go in, or what already did.
  Widget _topUp(PocketStatus status) {
    final c = context.c;
    final done = status.toppedUpMinor > 0;
    final text = done
        ? 'Topped up ${formatMoney(status.toppedUpMinor)}'
        : status.lastMonthSpentMinor > 0
            ? 'Top up ${formatMoney(status.lastMonthSpentMinor)} today'
            : 'Renews today - nothing was spent last month, so nothing to top up';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
      decoration: BoxDecoration(
        color: done ? c.credit50 : c.warnBg,
        borderRadius: BorderRadius.circular(T.rSm),
      ),
      child: Row(
        children: [
          Icon(done ? Icons.check_circle_outline : Icons.add_card_outlined,
              size: 16, color: done ? c.credit : c.warn),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              text,
              style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700, color: done ? c.credit : c.warn),
            ),
          ),
        ],
      ),
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

  /// How much of this cycle is gone.
  ///
  /// Drawn against whichever limit was set for this card, falling back to
  /// the bank's. Those are different things — one is what you allow and the
  /// other is what you are allowed — and showing 40% of a credit limit
  /// while already past your own budget would be reassuring and wrong.
  Widget _meter(_Cycle cycle, Account account) {
    final c = context.c;
    final capIsMine = account.spendLimitMinor != null;
    final cap = account.spendLimitMinor ?? cycle.limitMinor;

    final used = (cap != null && cap > 0) ? (cycle.spentMinor / cap).clamp(0.0, 1.0) : null;
    final over = cap != null && cycle.spentMinor > cap;
    final close = used != null && used >= 0.8 && !over;
    final tint = over ? c.debit : (close ? c.warn : c.brand);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'THIS CYCLE',
            style: TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.6,
              color: c.muted,
            ),
          ),
          const SizedBox(height: 5),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Text(formatMoney(cycle.spentMinor), style: kNum.copyWith(fontSize: 21)),
              if (cap != null) ...[
                const SizedBox(width: 7),
                Text('of ${formatMoney(cap)}',
                    style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: c.muted)),
              ],
            ],
          ),
          if (used != null) ...[
            const SizedBox(height: 9),
            ClipRRect(
              borderRadius: BorderRadius.circular(100),
              child: LinearProgressIndicator(
                value: used,
                minHeight: 6,
                backgroundColor: c.track,
                valueColor: AlwaysStoppedAnimation(tint),
              ),
            ),
            const SizedBox(height: 7),
            Text(
              _meterNote(cycle.spentMinor, cap!, capIsMine: capIsMine, over: over),
              style: TextStyle(
                fontSize: 11.5,
                color: over || close ? tint : c.muted,
                fontWeight: over ? FontWeight.w700 : FontWeight.w400,
              ),
            ),
          ] else ...[
            const SizedBox(height: 6),
            Text('Set a limit to see how much is left',
                style: TextStyle(fontSize: 11.5, color: c.muted)),
          ],
        ],
      ),
    );
  }

  String _meterNote(int spentMinor, int cap, {required bool capIsMine, required bool over}) {
    if (over) {
      return '${formatMoney(spentMinor - cap)} over your ${capIsMine ? 'own cap' : 'limit'}';
    }
    return '${formatMoney(cap - spentMinor)} left${capIsMine ? ' on your cap' : ''}';
  }

  Widget _dates(Account account, _Cycle? cycle) {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('DATES',
              style: TextStyle(
                fontSize: 9.5,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.6,
                color: c.muted,
              )),
          const SizedBox(height: 7),
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
                  Text(label, style: TextStyle(fontSize: 11.5, color: c.muted)),
                  Text(value, style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w700)),
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
      'LATEST BILL',
      bill == null ? '—' : formatMoney(bill.totalDueMinor),
      _billNote(bill),
      valueColor: (bill?.isPaid ?? false) ? c.credit : null,
    );
  }

  String _billNote(_Bill? bill) {
    if (bill == null) return 'No statement read yet';
    if (bill.isPaid) return 'Paid';

    final days = bill.daysUntilDue;
    if (days == null) return 'Read from a statement';

    return days < 0 ? '${days.abs()} days overdue' : 'Due in $days days';
  }

  Widget _figure(String label, String value, String note, {Color? valueColor}) {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.all(13),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label.toUpperCase(),
              style: TextStyle(
                fontSize: 9.5,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.6,
                color: c.muted,
              )),
          const SizedBox(height: 5),
          Text(value, style: kNum.copyWith(fontSize: 17, color: valueColor ?? c.ink)),
          const SizedBox(height: 4),
          Text(note, style: TextStyle(fontSize: 11, height: 1.35, color: c.muted)),
        ],
      ),
    );
  }

  Widget _row(IconData icon, String label, String value, {required bool on, required Widget action}) {
    final c = context.c;

    return Container(
      padding: const EdgeInsets.fromLTRB(13, 7, 7, 7),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Row(
        children: [
          Icon(icon, size: 16, color: c.muted),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                Text(value,
                    style: TextStyle(fontSize: 11.5, color: on ? c.credit : c.muted)),
              ],
            ),
          ),
          action,
        ],
      ),
    );
  }

}
