import 'package:flutter/material.dart';
import '../models/models.dart';
import '../theme.dart';
import '../utils/format.dart';
import 'category_sheet.dart';
import 'raw_message_sheet.dart';

/// One transaction. The category is set from the round chip on the left,
/// matching the web app — a list of these reads as a ledger rather than a
/// column of form controls.
class TransactionTile extends StatelessWidget {
  final Transaction transaction;
  final List<Category> categories;
  final ValueChanged<Transaction> onUpdated;
  /// Opens the full edit form. Parsing gets most things right but not all,
  /// so every row has to be correctable by hand.
  final VoidCallback? onEdit;
  /// While picking rows to merge, the whole tile becomes the checkbox.
  final bool selectable;
  final bool selected;
  final VoidCallback? onToggleSelected;
  final VoidCallback? onLongPress;

  const TransactionTile({
    super.key,
    required this.transaction,
    required this.categories,
    required this.onUpdated,
    this.onEdit,
    this.selectable = false,
    this.selected = false,
    this.onToggleSelected,
    this.onLongPress,
  });

  String get _meta {
    final account = transaction.account;
    final parts = <String>[
      if (account != null) account.label else transaction.source,
      formatTime(transaction.occurredAt),
    ];
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final isDebit = transaction.type == 'DEBIT';
    final isTransfer = transaction.isTransfer;

    final amountColor = isTransfer
        ? context.c.transfer
        : isDebit
            ? context.c.debit
            : context.c.credit;

    return GestureDetector(
      onTap: selectable ? onToggleSelected : null,
      onLongPress: onLongPress,
      child: Container(
        decoration: BoxDecoration(
          color: selected ? context.c.brand50 : null,
          border: Border(
            bottom: BorderSide(color: context.c.line),
            left: BorderSide(color: selected ? context.c.brand : Colors.transparent, width: 3),
          ),
        ),
        padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            if (selectable) ...[
              Icon(
                selected ? Icons.check_circle : Icons.circle_outlined,
                size: 20,
                color: selected ? context.c.brand : context.c.mutedLight,
              ),
              const SizedBox(width: 10),
            ],
            _CategoryChip(
            transaction: transaction,
            categories: categories,
            onUpdated: onUpdated,
          ),
          const SizedBox(width: 13),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        transaction.merchant ?? 'Unknown',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13.8, color: context.c.ink),
                      ),
                    ),
                    if (onEdit != null) ...[
                      const SizedBox(width: 6),
                      GestureDetector(
                        onTap: onEdit,
                        child: Icon(Icons.edit_outlined, size: 14, color: context.c.mutedLight),
                      ),
                    ],
                    if (transaction.rawText != null) ...[
                      const SizedBox(width: 6),
                      GestureDetector(
                        onTap: () => showRawMessageSheet(context, transaction),
                        child: Icon(Icons.info_outline, size: 14, color: context.c.mutedLight),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    // One per kind, so a row seen by both SMS and email
                    // says so without being opened.
                    for (final kind in transaction.sourceKinds) ...[
                      Icon(
                        kind == 'EMAIL'
                            ? Icons.mail_outline
                            : kind == 'MANUAL'
                                ? Icons.edit_outlined
                                : Icons.sms_outlined,
                        size: 12,
                        color: context.c.muted,
                      ),
                      const SizedBox(width: 3),
                    ],
                    const SizedBox(width: 2),
                    Flexible(
                      child: Text(
                        _meta,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 12, color: context.c.muted),
                      ),
                    ),
                  ],
                ),
                if (isTransfer || transaction.editedAt != null) ...[
                  const SizedBox(height: 5),
                  Wrap(
                    spacing: 6,
                    children: [
                      if (isTransfer)
                        _Badge(
                          label: 'Not counted',
                          background: context.c.chipNeutral,
                          foreground: context.c.transfer,
                        ),
                      // Says plainly that these figures are the user's, not
                      // the bank's, so a corrected row isn't second-guessed.
                      if (transaction.editedAt != null)
                        _Badge(
                          label: 'Edited',
                          background: context.c.chipNeutral,
                          foreground: context.c.muted,
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
            const SizedBox(width: 10),
            Text(
              '${isDebit ? '−' : '+'}${formatMoney(transaction.amountMinor, transaction.currency)}',
              style: kNum.copyWith(fontWeight: FontWeight.w700, fontSize: 14.5, color: amountColor),
            ),
          ],
        ),
      ),
    );
  }
}

class _CategoryChip extends StatelessWidget {
  final Transaction transaction;
  final List<Category> categories;
  final ValueChanged<Transaction> onUpdated;

  const _CategoryChip({
    required this.transaction,
    required this.categories,
    required this.onUpdated,
  });

  @override
  Widget build(BuildContext context) {
    if (transaction.isTransfer) {
      return Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(color: context.c.chipNeutral, shape: BoxShape.circle),
        child: Icon(Icons.arrow_forward, size: 17, color: context.c.transfer),
      );
    }

    final category = transaction.category;
    final uncategorized = category == null;

    return GestureDetector(
      onTap: () => showCategorySheet(
        context,
        transaction: transaction,
        categories: categories,
        onUpdated: onUpdated,
      ),
      child: Container(
        width: 36,
        height: 36,
        decoration: BoxDecoration(
          color: uncategorized ? context.c.surface : parseHexColor(category.color),
          shape: BoxShape.circle,
          border: uncategorized ? Border.all(color: context.c.mutedLight, width: 1.6) : null,
        ),
        child: Icon(
          uncategorized ? Icons.add : categoryIcon(category.icon),
          size: 17,
          color: uncategorized ? context.c.mutedLight : Colors.white,
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  final String label;
  final Color background;
  final Color foreground;

  const _Badge({required this.label, required this.background, required this.foreground});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(100)),
      child: Text(
        label,
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: foreground),
      ),
    );
  }
}
