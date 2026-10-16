import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import 'person_picker_sheet.dart';
import 'refund_sheet.dart';

/// "What came in?" - money the bank's own figures say arrived on an
/// account with no message saying so.
///
/// Until it is answered it counts as nothing: no income, nothing in the
/// savings bucket. The likely answers come first, one tap each (the
/// matching debit on another account, the salary, someone who owed that
/// much); then the five plain answers; then "Not sure", which dismisses it
/// and leaves the gap a gap.
///
/// Returns true when it was answered or dismissed, so the screen behind
/// reloads.
Future<bool?> showWhatCameInSheet(BuildContext context, {required MissingCredit credit}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
    builder: (_) => WhatCameInSheet(credit: credit),
  );
}

/// The same, from a passbook row that knows only the id.
Future<bool?> showWhatCameInById(BuildContext context, String id) async {
  final messenger = ScaffoldMessenger.of(context);
  try {
    final json = await ApiClient.instance.get('/accounts/missing-credits/$id') as Map<String, dynamic>;
    if (!context.mounted) return null;
    return await showWhatCameInSheet(context, credit: MissingCredit.fromJson(json));
  } catch (e) {
    messenger.showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : "Couldn't open that just now.")));
    return null;
  }
}

class WhatCameInSheet extends StatefulWidget {
  const WhatCameInSheet({super.key, required this.credit});

  final MissingCredit credit;

  @override
  State<WhatCameInSheet> createState() => _WhatCameInSheetState();
}

class _WhatCameInSheetState extends State<WhatCameInSheet> {
  bool _busy = false;
  String? _error;

  String get _base => '/accounts/missing-credits/${widget.credit.id}';

  /// Sends one answer. A refund with no purchase named opens the refund
  /// picker over this sheet, so the purchase can be linked the usual way.
  Future<void> _answer(Map<String, dynamic> body) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await ApiClient.instance.post('$_base/resolve', body) as Map<String, dynamic>?;
      final leg = TransferLeg.maybe(result?['transferLeg']);
      if (leg != null) messenger.showSnackBar(SnackBar(content: Text(leg.message)));
      final row = result?['transaction'];
      if (body['as'] == 'refund' && row is Map<String, dynamic> && mounted) {
        await showRefundSheet(context, refund: Transaction.fromJson(row));
      }
      navigator.pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is ApiException ? e.message : "Couldn't save that just now.";
      });
    }
  }

  Future<void> _dismiss() async {
    if (_busy) return;
    setState(() => _busy = true);
    final navigator = Navigator.of(context);
    try {
      await ApiClient.instance.post('$_base/dismiss');
      navigator.pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e is ApiException ? e.message : "Couldn't dismiss that just now.";
      });
    }
  }

  Future<void> _fromAccount() async {
    final List<Account> accounts;
    try {
      accounts = (await ApiClient.instance.get('/accounts') as List<dynamic>)
          .map((a) => Account.fromJson(a as Map<String, dynamic>))
          .where((a) =>
              a.isActive && a.id != widget.credit.accountId && (a.accountType == 'BANK' || a.accountType == 'CASH'))
          .toList();
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't load your accounts.");
      return;
    }
    if (!mounted) return;
    final picked = await _pick<Account>(
      title: 'Which account did it come from?',
      items: accounts,
      label: (a) => a.accountType == 'CASH' ? 'Cash' : a.label,
      empty: 'No other bank account or cash to pick.',
    );
    if (picked != null) await _answer({'as': 'transfer', 'fromAccountId': picked.id});
  }

  Future<void> _paidBack() async {
    final contact = await showPersonPicker(context);
    if (contact != null) await _answer({'as': 'paid_back', 'contactId': contact.id});
  }

  Future<void> _otherIncome() async {
    final List<Category> categories;
    try {
      categories = categoriesFor(
        (await ApiClient.instance.get('/categories') as List<dynamic>)
            .map((c) => Category.fromJson(c as Map<String, dynamic>))
            .toList(),
        'CREDIT',
      );
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't load the categories.");
      return;
    }
    if (!mounted) return;
    final picked = await _pick<Category>(
      title: 'What kind of income?',
      items: categories,
      label: (c) => c.name,
      empty: 'No income categories yet.',
    );
    if (picked != null) await _answer({'as': 'income', 'categoryId': picked.id});
  }

  /// A plain list to choose one from.
  Future<I?> _pick<I>({
    required String title,
    required List<I> items,
    required String Function(I) label,
    required String empty,
  }) {
    return showModalBottomSheet<I>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.c.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
      ),
      builder: (sheet) {
        final c = sheet.c;
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink)),
                const SizedBox(height: 8),
                if (items.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(empty, style: TextStyle(fontSize: 12.5, color: c.muted)),
                  )
                else
                  Flexible(
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        for (final item in items)
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            dense: true,
                            title: Text(label(item), style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ink)),
                            onTap: () => Navigator.of(sheet).pop(item),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final credit = widget.credit;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 10, 16, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(color: c.lineStrong, borderRadius: BorderRadius.circular(100)),
            ),
          ),
          const SizedBox(height: 14),
          Text('What came in?', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink)),
          const SizedBox(height: 6),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              '+${formatMoney(credit.amountMinor)}',
              style: kNum.copyWith(fontSize: 26, fontWeight: FontWeight.w800, color: c.credit),
            ),
          ),
          if (credit.title.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(credit.title, style: TextStyle(fontSize: 12.8, height: 1.4, color: c.ink70)),
          ],
          const SizedBox(height: 6),
          Text(
            "Your bank's balance went up by this much without a message saying why. "
            "It doesn't count as income until you say what it was.",
            style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
          ),
          if (credit.suggestions.isNotEmpty) ...[
            const SizedBox(height: 16),
            _label(context, 'MOST LIKELY'),
            const SizedBox(height: 6),
            for (final suggestion in credit.suggestions)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: _SuggestionChip(
                  suggestion: suggestion,
                  onTap: _busy ? null : () => _answer(suggestion.toBody()),
                ),
              ),
          ],
          const SizedBox(height: 14),
          _label(context, credit.suggestions.isEmpty ? 'IT WAS' : 'OR IT WAS'),
          const SizedBox(height: 4),
          _Answer(icon: Icons.swap_horiz, text: 'From my other account', onTap: _busy ? null : _fromAccount),
          _Answer(icon: Icons.work_outline, text: 'Salary', onTap: _busy ? null : () => _answer({'as': 'salary'})),
          _Answer(icon: Icons.replay, text: 'A refund', onTap: _busy ? null : () => _answer({'as': 'refund'})),
          _Answer(icon: Icons.people_outline, text: 'Someone paid me back', onTap: _busy ? null : _paidBack),
          _Answer(icon: Icons.trending_up, text: 'Other income', onTap: _busy ? null : _otherIncome),
          if (_error != null) ...[
            const SizedBox(height: 10),
            Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
          ],
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _busy ? null : _dismiss,
              style: TextButton.styleFrom(foregroundColor: c.muted),
              child: const Text('Not sure — dismiss'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _label(BuildContext context, String text) => Text(
        text,
        style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: context.c.muted),
      );
}

/// A likely answer, one tap.
class _SuggestionChip extends StatelessWidget {
  const _SuggestionChip({required this.suggestion, this.onTap});

  final MissingCreditSuggestion suggestion;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final icon = switch (suggestion.as) {
      'transfer' => Icons.swap_horiz,
      'salary' => Icons.work_outline,
      'paid_back' => Icons.people_outline,
      'refund' => Icons.replay,
      _ => Icons.trending_up,
    };
    return Material(
      color: c.brand50,
      borderRadius: BorderRadius.circular(T.rSm),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(T.rSm),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
          child: Row(
            children: [
              Icon(icon, size: 17, color: c.brandDark),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  suggestion.label,
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.brandDark),
                ),
              ),
              Icon(Icons.chevron_right, size: 17, color: c.brandDark),
            ],
          ),
        ),
      ),
    );
  }
}

/// One of the five plain answers.
class _Answer extends StatelessWidget {
  const _Answer({required this.icon, required this.text, this.onTap});

  final IconData icon;
  final String text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(T.rSm),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.line))),
        child: Row(
          children: [
            Icon(icon, size: 18, color: c.ink70),
            const SizedBox(width: 12),
            Expanded(child: Text(text, style: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: c.ink))),
            Icon(Icons.chevron_right, size: 17, color: c.mutedLight),
          ],
        ),
      ),
    );
  }
}
