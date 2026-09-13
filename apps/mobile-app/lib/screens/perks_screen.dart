import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/perk_sheet.dart';
import '../widgets/state_block.dart';

/// "I am at Gucci. Do I have anything?"
///
/// The search is the whole point of the screen, so it holds focus from the
/// moment it opens — this is the one place in the app you use standing up,
/// with a queue behind you.
class PerksScreen extends StatefulWidget {
  const PerksScreen({super.key});

  @override
  State<PerksScreen> createState() => _PerksScreenState();
}

class _PerksScreenState extends State<PerksScreen> {
  final _query = TextEditingController();
  final _amount = TextEditingController();

  PerkLookup? _answer;
  bool _asking = false;

  List<Perk> _perks = [];
  List<Account> _accounts = [];
  List<Category> _categories = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _query.dispose();
    _amount.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/perks'),
        ApiClient.instance.get('/accounts'),
        ApiClient.instance.get('/categories'),
      ]);
      if (!mounted) return;
      setState(() {
        _perks = (results[0] as List<dynamic>).map((p) => Perk.fromJson(p as Map<String, dynamic>)).toList();
        _accounts =
            (results[1] as List<dynamic>).map((a) => Account.fromJson(a as Map<String, dynamic>)).toList();
        _categories =
            (results[2] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
      });
    } catch (_) {
      // The list is not the point of the screen; the search still works.
    }
  }

  Future<void> _ask() async {
    final query = _query.text.trim();
    if (query.isEmpty) return;

    FocusScope.of(context).unfocus();
    setState(() => _asking = true);

    try {
      final rupees = double.tryParse(_amount.text.trim());
      final params = <String, String>{'q': query};
      if (rupees != null && rupees > 0) params['amountMinor'] = (rupees * 100).round().toString();

      final result = await ApiClient.instance.get('/perks/lookup?${Uri(queryParameters: params).query}');
      if (!mounted) return;
      setState(() => _answer = PerkLookup.fromJson(result as Map<String, dynamic>));
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("Couldn't check just now.")),
        );
      }
    } finally {
      if (mounted) setState(() => _asking = false);
    }
  }

  Future<void> _setUsed(Perk perk, bool used) async {
    await ApiClient.instance.post('/perks/${perk.id}/used', {'used': used}).catchError((_) => null);
    if (!mounted) return;

    // The answer on screen is now out of date about this one.
    final answer = _answer;
    if (answer != null && used) {
      setState(() {
        _answer = PerkLookup(
          query: answer.query,
          matches: answer.matches.where((match) => match.id != perk.id).toList(),
          floatAlternative: answer.floatAlternative,
          verdict: answer.verdict,
        );
      });
    }
    await _load();
  }

  Future<void> _edit(Perk? perk) async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => PerkSheet(perk: perk, accounts: _accounts, categories: _categories),
    );
    if (saved == true) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: const Text('Perks'),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _edit(null),
        child: const Icon(Icons.add),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 90),
        children: [
          TextField(
            controller: _query,
            autofocus: true,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _ask(),
            style: TextStyle(color: c.ink, fontSize: 15),
            decoration: InputDecoration(
              hintText: 'Where are you?',
              hintStyle: TextStyle(color: c.mutedLight),
              prefixIcon: Icon(Icons.search, size: 19, color: c.mutedLight),
              filled: true,
              fillColor: c.surface,
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(T.rSm),
                borderSide: BorderSide(color: c.lineStrong),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(T.rSm),
                borderSide: BorderSide(color: c.brand),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _amount,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  style: TextStyle(color: c.ink),
                  decoration: InputDecoration(
                    hintText: 'About to spend (optional)',
                    hintStyle: TextStyle(color: c.mutedLight),
                    prefixText: '₹ ',
                    isDense: true,
                    filled: true,
                    fillColor: c.surface,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(T.rSm),
                      borderSide: BorderSide(color: c.lineStrong),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(T.rSm),
                      borderSide: BorderSide(color: c.brand),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              FilledButton(
                onPressed: _asking ? null : _ask,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 16),
                ),
                child: Text(_asking ? '…' : 'Ask'),
              ),
            ],
          ),

          if (_answer != null) ...[
            const SizedBox(height: 18),
            _Answer(answer: _answer!, onUsed: (perk) => _setUsed(perk, true)),
          ],

          const SizedBox(height: 26),
          Text(
            "EVERYTHING YOU'RE HOLDING",
            style: TextStyle(
              fontSize: 10.5,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
              color: c.muted,
            ),
          ),
          const SizedBox(height: 10),

          if (_perks.isEmpty)
            StateBlock(
              icon: Icons.local_offer_outlined,
              title: 'Nothing saved yet',
              body: 'Add the cashback your cards give at particular shops, and any coupon codes you are '
                  'sitting on. Then you can ask this screen before you pay for anything.',
              actionLabel: 'Add the first one',
              onAction: () => _edit(null),
            )
          else
            for (final perk in _perks)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _PerkRow(
                  perk: perk,
                  onEdit: () => _edit(perk),
                  onUsed: () => _setUsed(perk, perk.usedAt == null),
                  onRemove: () async {
                    await ApiClient.instance.delete('/perks/${perk.id}').catchError((_) => null);
                    await _load();
                  },
                ),
              ),
        ],
      ),
    );
  }
}

/// The answer, with the cashback first and the float underneath.
///
/// Settled deliberately: money back is certain and immediate, float is
/// timing. Both numbers stay in view and the decision is yours.
class _Answer extends StatelessWidget {
  final PerkLookup answer;
  final void Function(Perk) onUsed;

  const _Answer({required this.answer, required this.onUsed});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Container(
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
            color: c.brand50,
            child: Text(
              answer.verdict,
              style: TextStyle(fontSize: 13.8, fontWeight: FontWeight.w700, color: c.brandDark, height: 1.4),
            ),
          ),
          for (final match in answer.matches) _MatchRow(match: match, onUsed: () => onUsed(match)),
          if (answer.floatAlternative != null)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(border: Border(top: BorderSide(color: c.line))),
              child: Row(
                children: [
                  Icon(Icons.account_balance_wallet_outlined, size: 15, color: c.muted),
                  const SizedBox(width: 9),
                  Expanded(
                    child: Text(
                      'Longest to pay: ${answer.floatAlternative!.name}, '
                      '${answer.floatAlternative!.floatDays} days'
                      '${answer.matches.isNotEmpty ? ' — but no offer here.' : '.'}',
                      style: TextStyle(fontSize: 12.3, height: 1.45, color: c.muted),
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

class _MatchRow extends StatelessWidget {
  final PerkMatch match;
  final VoidCallback onUsed;

  const _MatchRow({required this.match, required this.onUsed});

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    final detail = <String>[
      if (match.valueMinor != null && match.valueMinor! > 0) '${formatMoney(match.valueMinor!)} back',
      if (match.minSpendMinor != null) 'over ${formatMoneyShort(match.minSpendMinor!)}',
      if (match.maxDiscountMinor != null) 'up to ${formatMoneyShort(match.maxDiscountMinor!)}',
      if (match.card?.floatDays != null) '${match.card!.floatDays} days to pay',
      if (match.daysLeft != null && match.daysLeft! <= 10)
        'expires in ${match.daysLeft} ${match.daysLeft == 1 ? 'day' : 'days'}',
    ];

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: match.isCoupon ? c.paper : c.surface,
        border: Border(top: BorderSide(color: c.line)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text.rich(
                  TextSpan(
                    children: [
                      TextSpan(
                        text: match.title,
                        style: TextStyle(fontSize: 13.8, fontWeight: FontWeight.w700, color: c.ink),
                      ),
                      if (match.card != null)
                        TextSpan(
                          text: '  on ${match.card!.name}',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: c.muted),
                        ),
                      if (match.reach == 'ANYWHERE')
                        TextSpan(
                          text: '  everywhere',
                          style: TextStyle(fontSize: 11, color: c.mutedLight),
                        ),
                    ],
                  ),
                ),
              ),
              if (match.isCoupon)
                TextButton(onPressed: onUsed, child: const Text('Used it')),
            ],
          ),
          if (detail.isNotEmpty) ...[
            const SizedBox(height: 3),
            Text(
              '${detail.join(' · ')}.',
              style: TextStyle(fontSize: 12.3, height: 1.45, color: c.ink70),
            ),
          ],
          if (match.code != null) ...[
            const SizedBox(height: 8),
            // Tappable because the next thing after reading a code is
            // typing it somewhere else.
            InkWell(
              onTap: () {
                Clipboard.setData(ClipboardData(text: match.code!));
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(content: Text('Copied ${match.code}')),
                );
              },
              borderRadius: BorderRadius.circular(T.rSm),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                decoration: BoxDecoration(color: c.track, borderRadius: BorderRadius.circular(T.rSm)),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      match.code!,
                      style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink),
                    ),
                    const SizedBox(width: 7),
                    Icon(Icons.copy, size: 13, color: c.muted),
                  ],
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _PerkRow extends StatelessWidget {
  final Perk perk;
  final VoidCallback onEdit;
  final VoidCallback onUsed;
  final VoidCallback onRemove;

  const _PerkRow({
    required this.perk,
    required this.onEdit,
    required this.onUsed,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    final sub = <String>[
      perk.merchants.isNotEmpty ? perk.merchants.join(', ') : 'anywhere',
      if (perk.cardName != null) perk.cardName!,
      if (perk.code != null) perk.code!,
      if (perk.usedAt != null)
        'used'
      else if (perk.daysLeft != null)
        perk.daysLeft! < 0 ? 'expired' : '${perk.daysLeft} ${perk.daysLeft == 1 ? 'day' : 'days'} left',
    ];

    return Dismissible(
      key: ValueKey(perk.id),
      direction: DismissDirection.endToStart,
      onDismissed: (_) => onRemove(),
      background: Container(
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.only(right: 16),
        decoration: BoxDecoration(color: c.debit50, borderRadius: BorderRadius.circular(T.rMd)),
        child: Icon(Icons.delete_outline, size: 18, color: c.debit),
      ),
      child: Opacity(
        opacity: perk.isLive ? 1 : 0.5,
        child: InkWell(
          onTap: onEdit,
          borderRadius: BorderRadius.circular(T.rMd),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 12),
            decoration: BoxDecoration(
              color: c.surface,
              border: Border.all(color: c.line),
              borderRadius: BorderRadius.circular(T.rMd),
            ),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: perk.isCoupon ? c.credit50 : c.brand50,
                    borderRadius: BorderRadius.circular(100),
                  ),
                  child: Text(
                    perk.isCoupon ? 'COUPON' : 'OFFER',
                    style: TextStyle(
                      fontSize: 8.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.4,
                      color: perk.isCoupon ? c.credit : c.brandDark,
                    ),
                  ),
                ),
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              perk.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700, color: c.ink),
                            ),
                          ),
                          if (perk.worth.isNotEmpty) ...[
                            const SizedBox(width: 7),
                            Text(
                              perk.worth,
                              style: kNum.copyWith(fontSize: 12.3, color: c.brand),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 2),
                      Text(
                        sub.join(' · '),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 11.8, color: c.muted),
                      ),
                    ],
                  ),
                ),
                if (perk.isCoupon)
                  TextButton(
                    onPressed: onUsed,
                    style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8)),
                    child: Text(perk.usedAt != null ? 'Unuse' : 'Used'),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
