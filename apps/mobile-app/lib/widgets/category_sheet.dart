import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';

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
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
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

    messenger.showSnackBar(
      SnackBar(
        duration: const Duration(seconds: 8),
        backgroundColor: context.c.ink,
        behavior: SnackBarBehavior.floating,
        content: Text('Categorized as ${category.name}. Apply to future "$shown" payments?'),
        action: SnackBarAction(
          label: 'Yes',
          textColor: const Color(0xFF9DB6FF),
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
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(
                  color: context.c.lineStrong,
                  borderRadius: BorderRadius.circular(100),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              'Set category',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: context.c.ink),
            ),
            const SizedBox(height: 12),
            Flexible(
              child: SingleChildScrollView(
                child: Column(
                  children: widget.categories.map((category) {
                    final selected = widget.transaction.category?.id == category.id;
                    return ListTile(
                      contentPadding: EdgeInsets.zero,
                      enabled: !_saving,
                      onTap: () => _pick(category),
                      leading: Container(
                        width: 34,
                        height: 34,
                        decoration: BoxDecoration(
                          color: parseHexColor(category.color),
                          shape: BoxShape.circle,
                        ),
                        child: Icon(categoryIcon(category.icon), size: 17, color: Colors.white),
                      ),
                      title: Text(
                        category.name,
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: context.c.ink),
                      ),
                      trailing: selected ? Icon(Icons.check, size: 18, color: context.c.brand) : null,
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
