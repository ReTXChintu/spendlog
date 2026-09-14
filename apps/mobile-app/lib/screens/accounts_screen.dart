import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/card_vault_panel.dart';
import '../widgets/edit_account_sheet.dart';
import '../widgets/state_block.dart';
import 'statements_screen.dart';

/// Every account, one at a time.
///
/// A single list told you almost nothing about any of them: to find out
/// where a card stood you opened a sheet, and to find its statements you
/// went somewhere else entirely. So each account gets a chip of its own,
/// and under it everything that belongs to it — what it is, where it
/// stands this cycle, when it bills, its stored details, and its
/// statements.
class AccountsScreen extends StatefulWidget {
  const AccountsScreen({super.key});

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

  _Overview({required this.account, this.cycle, this.bill, required this.hasCardDetails});

  factory _Overview.fromJson(Map<String, dynamic> json) => _Overview(
        account: Account.fromJson(json),
        cycle: json['cycle'] == null ? null : _Cycle.fromJson(json['cycle'] as Map<String, dynamic>),
        bill: json['bill'] == null ? null : _Bill.fromJson(json['bill'] as Map<String, dynamic>),
        hasCardDetails: json['hasCardDetails'] as bool? ?? false,
      );
}

class _AccountsScreenState extends State<AccountsScreen> {
  List<_Overview>? _accounts;
  String? _selectedId;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/accounts/overview') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _accounts = result.map((a) => _Overview.fromJson(a as Map<String, dynamic>)).toList();
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
    final isCard = account.accountType == 'CARD';

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
                          'BANK' => 'Bank account',
                          'CASH' => 'Cash',
                          _ => account.accountType,
                        },
                        if (account.cardNetwork != null) account.cardNetwork!,
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
            ],
          ),
          const SizedBox(height: 14),

          if (isCard && row.cycle != null)
            _meter(row.cycle!, account)
          else
            _figure('This account', switch (account.accountType) {
              'BANK' => 'Bank account',
              'CASH' => 'Cash',
              _ => 'Credit card',
            }, isCard ? 'Set a statement day to see a cycle' : 'No billing cycle to track'),

          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: _dates(account, row.cycle)),
              const SizedBox(width: 10),
              Expanded(child: _latestBill(row.bill)),
            ],
          ),

          if (isCard)
            CardVaultPanel(
              key: ValueKey(account.id),
              accountId: account.id,
              last4: account.last4,
              hasDetails: row.hasCardDetails,
              onChanged: _load,
            ),

          const SizedBox(height: 14),
          _row(
            Icons.receipt_long_outlined,
            'Statement password',
            account.hasStatementPassword ? 'Set' : 'Not set',
            on: account.hasStatementPassword,
            action: TextButton(
              onPressed: () => _open(account: account),
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
                  MaterialPageRoute(builder: (_) => const StatementsScreen()),
                );
                await _load();
              },
              child: const Text('Open'),
            ),
          ),
        ],
      ),
    );
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
            ('Statement', account.statementDay == null ? '—' : _ordinal(account.statementDay!)),
            ('Due', account.dueDay == null ? '—' : _ordinal(account.dueDay!)),
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

  String _ordinal(int day) {
    final suffix = day > 3 && day < 21 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10];
    return '$day$suffix';
  }
}
