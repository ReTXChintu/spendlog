import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import 'ds/ds.dart';

/// My share of a group payment somebody else on SpendLog made.
///
/// Everything about the row follows their payment - the amount, the date,
/// the group, who it was shared with - and the server refuses to change
/// any of it from here. What a dinner is *to me* is my business, so the
/// category is the one thing offered, with why in plain words. There is
/// no Delete: the row goes when they take me off the payment, or take the
/// payment out of the group.
Future<bool?> showMirrorShareSheet(
  BuildContext context, {
  required Transaction transaction,
  required List<Category> categories,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.sf,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl))),
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: MirrorShareSheet(transaction: transaction, categories: categories),
    ),
  );
}

class MirrorShareSheet extends StatefulWidget {
  const MirrorShareSheet({super.key, required this.transaction, required this.categories});

  final Transaction transaction;
  final List<Category> categories;

  @override
  State<MirrorShareSheet> createState() => _MirrorShareSheetState();
}

class _MirrorShareSheetState extends State<MirrorShareSheet> {
  late String? _categoryId = widget.transaction.category?.id;
  bool _saving = false;
  String? _error;

  Transaction get t => widget.transaction;
  String get _payer => t.paidByName ?? 'someone else';

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ApiClient.instance.patch('/transactions/${t.id}', {'categoryId': _categoryId});
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't save. Check your connection and try again.");
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final share = t.split?.myShareMinor ?? t.amountMinor;
    final categories = categoriesFor(widget.categories, 'DEBIT');

    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Center(child: DsDragHandle()),
            const SizedBox(height: 8),
            DsSheetHeader(
              title: 'Your share of ${t.merchant ?? 'a payment'}',
              subtitle: 'Paid by $_payer${t.groupName != null ? ' · ${t.groupName}' : ''}',
              icon: DsIcons.users,
              onClose: () => Navigator.of(context).pop(),
            ),
            const SizedBox(height: 16),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const DsLabel('Your share'),
                      const SizedBox(height: 2),
                      Text(
                        formatMoney(share),
                        style: kNum.copyWith(fontSize: 28, height: 34 / 28, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                    ],
                  ),
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    const DsLabel('The whole bill'),
                    const SizedBox(height: 2),
                    Text(
                      formatMoney(t.amountMinor),
                      style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w500, color: c.tx2),
                    ),
                    Text(formatDateTime(t.occurredAt), style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 16),
            DsCallout(
              tone: DsTone.ac,
              icon: DsIcons.info,
              title: 'Counts in your month; moves none of your accounts',
              detail: "This follows $_payer's payment - its amount, date and group are theirs to change. "
                  'What you owe them settles up in the group. Only the category is yours here.',
            ),
            const SizedBox(height: 20),
            const DsLabel('Category'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                DsChip(
                  label: 'None',
                  selected: _categoryId == null,
                  onTap: _saving ? null : () => setState(() => _categoryId = null),
                ),
                for (final category in categories)
                  DsChip(
                    key: ValueKey('mirror-category-${category.id}'),
                    label: category.name,
                    selected: _categoryId == category.id,
                    onTap: _saving ? null : () => setState(() => _categoryId = category.id),
                  ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              DsCallout(tone: DsTone.crit, title: _error!),
            ],
            const SizedBox(height: 20),
            Row(
              children: [
                const Spacer(),
                TextButton(onPressed: _saving ? null : () => Navigator.of(context).pop(), child: const Text('Cancel')),
                const SizedBox(width: 8),
                FilledButton(
                  key: const ValueKey('mirror-save'),
                  onPressed: _saving || _categoryId == t.category?.id ? null : _save,
                  child: Text(_saving ? 'Saving…' : 'Save'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
