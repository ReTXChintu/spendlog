import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';

/// Start the balances again from what the banks show today.
///
/// For when the old mismatches are not worth chasing: each bank account
/// and cash, SpendLog's figure beside a box for what the bank shows now.
/// Whatever is filled in becomes that account's new starting balance, as
/// of now; whatever is left empty is left alone. Transactions and spending
/// stay exactly as they are - only the balance tracking restarts.
///
/// The savings account's figures stay hidden until tapped, as they are on
/// Home. Returns true once anything was started fresh.
class StartFreshScreen extends StatefulWidget {
  const StartFreshScreen({super.key});

  static Future<bool?> open(BuildContext context) =>
      Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => const StartFreshScreen()));

  @override
  State<StartFreshScreen> createState() => StartFreshScreenState();
}

/// Digits, one minus sign at the front, and a decimal point: a balance can
/// be overdrawn.
final _signedAmount = FilteringTextInputFormatter.allow(RegExp(r'^-?[\d,]*\.?\d{0,2}'));

class StartFreshScreenState extends State<StartFreshScreen> {
  List<FreshStartAccount>? _accounts;
  String? _error;
  bool _saving = false;
  final Map<String, TextEditingController> _inputs = {};

  /// Savings accounts the user has tapped to show.
  final Set<String> _revealed = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final controller in _inputs.values) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final rows = (await ApiClient.instance.get('/accounts/start-fresh') as List<dynamic>)
          .whereType<Map<String, dynamic>>()
          .map(FreshStartAccount.fromJson)
          .toList();
      if (!mounted) return;
      for (final row in rows) {
        final prefill = row.prefillMinor;
        _inputs[row.accountId] ??=
            TextEditingController(text: prefill == null ? '' : (prefill / 100).toStringAsFixed(2));
      }
      setState(() {
        _accounts = rows;
        _error = null;
      });
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.message : "Couldn't reach the server.");
    }
  }

  /// The accounts with a figure typed in (or filled in from today's word
  /// from the bank), and that figure. Empty ones are skipped.
  List<({FreshStartAccount account, int minor})> get _filled => [
        for (final account in _accounts ?? const <FreshStartAccount>[])
          if (parseRupees(_inputs[account.accountId]?.text ?? '', allowNegative: true) case final minor?)
            (account: account, minor: minor),
      ];

  Future<void> _confirm() async {
    final filled = _filled;
    if (filled.isEmpty || _saving) return;
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Start ${filled.length == 1 ? '1 account' : '${filled.length} accounts'} fresh?'),
        content: const Text(
          'Your transactions and spending stay as they are. Only the balances start again from these '
          'figures, as of now. You can undo it from each passbook.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Start fresh')),
        ],
      ),
    );
    if (sure != true || !mounted) return;

    setState(() => _saving = true);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await ApiClient.instance.post('/accounts/start-fresh', {
        'accounts': [
          for (final entry in filled) {'accountId': entry.account.accountId, 'balanceMinor': entry.minor},
        ],
      }) as Map<String, dynamic>?;
      final notes = ((result?['accounts'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map((entry) => entry['note'])
          .whereType<String>()
          .toList();
      messenger.showSnackBar(SnackBar(
        content: Text(['Balances start fresh from today.', ...notes].join(' ')),
      ));
      navigator.pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      messenger.showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : "Couldn't start fresh just now.")));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text('Start fresh from today', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: _body(),
      bottomNavigationBar: _accounts == null || _accounts!.isEmpty
          ? null
          : SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                child: FilledButton(
                  onPressed: _filled.isEmpty || _saving ? null : _confirm,
                  child: Text(_saving
                      ? 'Starting fresh…'
                      : _filled.isEmpty
                          ? 'Fill in at least one account'
                          : 'Start ${_filled.length == 1 ? '1 account' : '${_filled.length} accounts'} fresh'),
                ),
              ),
            ),
    );
  }

  Widget _body() {
    final c = context.c;
    final accounts = _accounts;
    if (accounts == null) {
      if (_error != null) {
        return StateBlock(
          icon: Icons.wifi_off,
          warn: true,
          title: "Couldn't load your accounts",
          body: _error!,
          actionLabel: 'Try again',
          onAction: _load,
        );
      }
      return const Center(child: CircularProgressIndicator());
    }
    if (accounts.isEmpty) {
      return const StateBlock(
        icon: Icons.account_balance_outlined,
        title: 'No bank accounts yet',
        body: 'Bank accounts and cash appear here once SpendLog knows about them.',
      );
    }

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: c.brand50,
            borderRadius: BorderRadius.circular(T.rMd),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.restart_alt, size: 18, color: c.brandDark),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Your transactions and spending stay as they are. Only the balances start again from these '
                  'figures. Leave an account empty to keep it as it is.',
                  style: TextStyle(fontSize: 12.8, height: 1.45, color: c.ink70),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        for (final account in accounts) ...[
          _row(account),
          const SizedBox(height: 10),
        ],
      ],
    );
  }

  Widget _row(FreshStartAccount account) {
    final c = context.c;
    final masked = account.isSavings && !_revealed.contains(account.accountId);
    final expected = account.expectedMinor;
    final controller = _inputs[account.accountId]!;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                account.isSavings
                    ? Icons.lock_outline
                    : (account.isCash ? Icons.payments_outlined : Icons.account_balance_outlined),
                size: 17,
                color: c.muted,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  account.isCash ? 'Cash' : account.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink),
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          if (masked)
            InkWell(
              key: ValueKey('reveal-${account.accountId}'),
              onTap: () => setState(() => _revealed.add(account.accountId)),
              borderRadius: BorderRadius.circular(T.rSm),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 10),
                child: Row(
                  children: [
                    Text('₹ • • • •', style: kNum.copyWith(fontSize: 16, fontWeight: FontWeight.w800, color: c.muted)),
                    const SizedBox(width: 10),
                    Flexible(
                      child: Text(
                        'Savings · tap to show',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, color: c.mutedLight),
                      ),
                    ),
                  ],
                ),
              ),
            )
          else ...[
            Text(
              expected == null
                  ? 'Not tracked yet'
                  : 'SpendLog shows ${formatMoney(expected)}'
                      '${account.provisionalMinor > 0 ? ' (incl. ${formatMoney(account.provisionalMinor)} not yet explained)' : ''}',
              style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
            ),
            const SizedBox(height: 8),
            TextField(
              key: ValueKey('input-${account.accountId}'),
              controller: controller,
              keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
              inputFormatters: [_signedAmount],
              style: kNum.copyWith(fontSize: 16, fontWeight: FontWeight.w700, color: c.ink),
              decoration: InputDecoration(
                labelText: account.isCash ? 'What your wallet holds now' : 'What your bank shows now',
                helperText: account.prefillMinor != null ? "From the bank's message today" : null,
                prefixText: '₹ ',
                isDense: true,
                border: const OutlineInputBorder(),
              ),
              onChanged: (_) => setState(() {}),
            ),
          ],
        ],
      ),
    );
  }
}
