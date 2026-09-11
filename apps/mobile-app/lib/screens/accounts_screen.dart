import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../widgets/edit_account_sheet.dart';
import '../widgets/state_block.dart';

/// The bank accounts and cards behind the ledger.
///
/// Most appear on their own the first time a bank texts, named however that
/// bank writes it — which is rarely what you would call it. This is where
/// they get a readable name, where duplicates get merged, and where the
/// card details are filled in.
class AccountsScreen extends StatefulWidget {
  const AccountsScreen({super.key});

  @override
  State<AccountsScreen> createState() => _AccountsScreenState();
}

class _AccountsScreenState extends State<AccountsScreen> {
  List<Account>? _accounts;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/accounts') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _accounts = result.map((a) => Account.fromJson(a as Map<String, dynamic>)).toList();
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _open({Account? account}) async {
    final changed = await showEditAccountSheet(
      context,
      account: account,
      accounts: _accounts ?? const [],
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
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _open(),
        tooltip: 'Add an account',
        child: const Icon(Icons.add),
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

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.builder(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 90),
        itemCount: _accounts!.length,
        itemBuilder: (context, i) => _AccountCard(
          account: _accounts![i],
          onTap: () => _open(account: _accounts![i]),
        ),
      ),
    );
  }
}

class _AccountCard extends StatelessWidget {
  final Account account;
  final VoidCallback onTap;

  const _AccountCard({required this.account, required this.onTap});

  String get _subtitle {
    if (account.aliases.isNotEmpty) {
      return 'Also ${account.aliases.map((a) => a.bankName).join(', ')}';
    }
    if (!account.isActive) return 'Closed';
    if (account.accountType == 'CASH') return 'For anything paid out of pocket';
    if (account.nickname?.trim().isNotEmpty ?? false) return account.bankName;
    return 'Detected from your messages';
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Opacity(
      opacity: account.isActive ? 1 : 0.55,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          margin: const EdgeInsets.only(bottom: 10),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
          decoration: BoxDecoration(
            color: c.surface,
            border: Border.all(color: c.line),
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Row(
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(color: c.brand50, borderRadius: BorderRadius.circular(9)),
                child: Icon(
                  switch (account.accountType) {
                    'BANK' => Icons.account_balance,
                    'CASH' => Icons.payments_outlined,
                    _ => Icons.credit_card,
                  },
                  size: 17,
                  color: c.brandDark,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      account.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.8, color: c.ink),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      _subtitle,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 12, color: c.muted),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                account.accountType,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.4,
                  color: c.muted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
