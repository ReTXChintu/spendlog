import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';

/// Bottom sheet for setting a transaction's category — the mobile
/// counterpart of the web popover.
Future<void> showCategorySheet(
  BuildContext context, {
  required Transaction transaction,
  required List<Category> categories,
  required ValueChanged<Transaction> onUpdated,
}) {
  return showModalBottomSheet<void>(
    context: context,
    builder: (sheetContext) => _CategorySheet(
      transaction: transaction,
      categories: categories,
      onUpdated: onUpdated,
    ),
  );
}

class _CategorySheet extends StatefulWidget {
  final Transaction transaction;
  final List<Category> categories;
  final ValueChanged<Transaction> onUpdated;

  const _CategorySheet({
    required this.transaction,
    required this.categories,
    required this.onUpdated,
  });

  @override
  State<_CategorySheet> createState() => _CategorySheetState();
}

class _CategorySheetState extends State<_CategorySheet> {
  bool _saving = false;

  Future<void> _pick(Category category) async {
    if (_saving) return;
    setState(() => _saving = true);

    try {
      final result = await ApiClient.instance
          .patch('/transactions/${widget.transaction.id}', {'categoryId': category.id});
      final updated = Transaction.fromJson(result as Map<String, dynamic>);
      widget.onUpdated(updated);

      if (!mounted) return;
      Navigator.of(context).pop();

      // Offer to remember the merchant, so the next payment to it files
      // itself. Without this the same UPI code has to be re-categorized
      // every time it appears.
      final merchant = widget.transaction.merchant;
      if (merchant != null && merchant.isNotEmpty) {
        _offerToRemember(merchant, category);
      }
    } catch (_) {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _offerToRemember(String merchant, Category category) {
    final shown = merchant.length > 22 ? '${merchant.substring(0, 22)}…' : merchant;
    final messenger = ScaffoldMessenger.of(context);
    final c = context.c;

    // The inverse toast (§7.12): ink fill, paper text, underlined action.
    messenger.showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 8),
        content: Row(
          children: [
            DsIcon(DsIcons.tag, size: 20, color: c.bg),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'Categorized as ${category.name}. Apply to future "$shown" payments?',
                style: TextStyle(fontSize: 14, height: 20 / 14, color: c.bg),
              ),
            ),
          ],
        ),
        action: SnackBarAction(
          label: 'Yes',
          textColor: c.bg,
          onPressed: () {
            ApiClient.instance.post('/categories/rules', {
              'categoryId': category.id,
              'matchType': 'MERCHANT_CONTAINS',
              'pattern': merchant,
              // Beats the built-in keyword rules, which are all priority 0.
              'priority': 10,
            }).catchError((_) => null);
          },
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final merchant = widget.transaction.merchant;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const DsDragHandle(),
            const SizedBox(height: 4),
            DsSheetHeader(
              title: 'Set category',
              subtitle: merchant == null || merchant.isEmpty ? null : merchant,
              icon: DsIcons.tag,
            ),
            const SizedBox(height: 12),
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  // Money out is never income, and a refund is never a
                  // way of spending, so offering either is offering a
                  // mistake.
                  children: categoriesFor(widget.categories, widget.transaction.type).map((category) {
                    final selected = widget.transaction.category?.id == category.id;
                    final tint = parseHexColor(category.color);
                    return Container(
                      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.ln))),
                      child: ListTile(
                        contentPadding: EdgeInsets.zero,
                        minTileHeight: 56,
                        enabled: !_saving,
                        onTap: () => _pick(category),
                        leading: DsIconTile(
                          categoryIcon(category.icon),
                          color: tint,
                          background: tint.withValues(alpha: 0.14),
                        ),
                        title: Text(
                          category.name,
                          style: TextStyle(
                            fontSize: 15,
                            height: 20 / 15,
                            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                            color: c.tx,
                          ),
                        ),
                        trailing: selected ? DsIcon(DsIcons.check, size: 20, color: c.ac) : null,
                      ),
                    );
                  }).toList(),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
