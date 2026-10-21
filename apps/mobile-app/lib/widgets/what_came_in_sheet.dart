import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';
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
      builder: (sheet) {
        final c = sheet.c;
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const DsDragHandle(),
                const SizedBox(height: 4),
                Text(title, style: TextStyle(fontSize: 19, height: 24 / 19, fontWeight: FontWeight.w600, color: c.tx)),
                const SizedBox(height: 8),
                if (items.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    child: Text(empty, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3)),
                  )
                else
                  Flexible(
                    child: ListView(
                      shrinkWrap: true,
                      children: [
                        for (final item in items)
                          DsLinkRow(
                            label: label(item),
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
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsDragHandle(),
          const SizedBox(height: 4),
          Row(
            children: [
              const DsIconTile(DsIcons.arrowDownLeft, tone: DsTone.warn),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  'What came in?',
                  style: TextStyle(fontSize: 19, height: 24 / 19, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              '+${formatMoney(credit.amountMinor)}',
              style: kNum.copyWith(
                fontSize: 28,
                height: 34 / 28,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.56,
                color: c.good,
              ),
            ),
          ),
          if (credit.title.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              credit.title,
              style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
            ),
          ],
          const SizedBox(height: 4),
          Text(
            "Your bank's balance went up by this much without a message saying why. "
            "It doesn't count as income until you say what it was.",
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
          ),
          if (credit.suggestions.isNotEmpty) ...[
            const SizedBox(height: 20),
            const DsLabel('Most likely'),
            const SizedBox(height: 8),
            for (final suggestion in credit.suggestions)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: _SuggestionChip(
                  suggestion: suggestion,
                  onTap: _busy ? null : () => _answer(suggestion.toBody()),
                ),
              ),
          ],
          const SizedBox(height: 16),
          DsLabel(credit.suggestions.isEmpty ? 'It was' : 'Or it was'),
          const SizedBox(height: 4),
          _Answer(icon: DsIcons.transfer, text: 'From my other account', onTap: _busy ? null : _fromAccount),
          _Answer(icon: DsIcons.briefcase, text: 'Salary', onTap: _busy ? null : () => _answer({'as': 'salary'})),
          _Answer(icon: DsIcons.undo, text: 'A refund', onTap: _busy ? null : () => _answer({'as': 'refund'})),
          _Answer(icon: DsIcons.users, text: 'Someone paid me back', onTap: _busy ? null : _paidBack),
          _Answer(icon: DsIcons.trendingUp, text: 'Other income', onTap: _busy ? null : _otherIncome),
          if (_error != null) ...[
            const SizedBox(height: 12),
            DsCallout(tone: DsTone.crit, title: _error!),
          ],
          const SizedBox(height: 8),
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton(
              onPressed: _busy ? null : _dismiss,
              style: TextButton.styleFrom(foregroundColor: c.tx2, padding: EdgeInsets.zero),
              child: const Text('Not sure — dismiss'),
            ),
          ),
        ],
      ),
    );
  }
}

/// A likely answer, one tap: an accent-tinted row.
class _SuggestionChip extends StatelessWidget {
  const _SuggestionChip({required this.suggestion, this.onTap});

  final MissingCreditSuggestion suggestion;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final icon = switch (suggestion.as) {
      'transfer' => DsIcons.transfer,
      'salary' => DsIcons.briefcase,
      'paid_back' => DsIcons.users,
      'refund' => DsIcons.undo,
      _ => DsIcons.trendingUp,
    };
    return Material(
      color: c.acSoft,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Ds.rLg),
        side: BorderSide(color: c.acLine),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 52),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              DsIconTile(icon, tone: DsTone.ac, onTinted: true, size: 32, iconSize: 18),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  suggestion.label,
                  style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              const SizedBox(width: 6),
              DsIcon(DsIcons.chevronRight, size: 18, color: c.ac),
            ],
          ),
        ),
      ),
    );
  }
}

/// One of the five plain answers: a link row.
class _Answer extends StatelessWidget {
  const _Answer({required this.icon, required this.text, this.onTap});

  final DsGlyph icon;
  final String text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 52),
        padding: const EdgeInsets.symmetric(vertical: 8),
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.ln))),
        child: Row(
          children: [
            DsIconTile(icon, size: 36),
            const SizedBox(width: 12),
            Expanded(
              child: Text(text, style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx)),
            ),
            DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
          ],
        ),
      ),
    );
  }
}
