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

  const TransactionTile({
    super.key,
    required this.transaction,
    required this.categories,
    required this.onUpdated,
  });

  String get _meta {
    final account = transaction.account;
    final parts = <String>[
      if (account != null)
        '${account.bankName}${account.last4 != null ? ' ••${account.last4}' : ''}'
      else
        transaction.source,
      formatTime(transaction.occurredAt),
    ];
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final isDebit = transaction.type == 'DEBIT';
    final isTransfer = transaction.isTransfer;

    final amountColor = isTransfer
        ? T.transfer
        : isDebit
            ? T.debit
            : T.credit;

    return Container(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: T.line)),
      ),
      padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
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
                        style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13.8, color: T.ink),
                      ),
                    ),
                    if (transaction.rawText != null) ...[
                      const SizedBox(width: 6),
                      GestureDetector(
                        onTap: () => showRawMessageSheet(context, transaction),
                        child: const Icon(Icons.info_outline, size: 14, color: T.mutedLight),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Icon(
                      transaction.source == 'EMAIL' ? Icons.mail_outline : Icons.sms_outlined,
                      size: 12,
                      color: T.muted,
                    ),
                    const SizedBox(width: 5),
                    Flexible(
                      child: Text(
                        _meta,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12, color: T.muted),
                      ),
                    ),
                  ],
                ),
                if (isTransfer) ...[
                  const SizedBox(height: 5),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF1F5F9),
                      borderRadius: BorderRadius.circular(100),
                    ),
                    child: const Text(
                      'Not counted',
                      style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: T.transfer),
                    ),
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
        decoration: const BoxDecoration(color: Color(0xFFF1F5F9), shape: BoxShape.circle),
        child: const Icon(Icons.arrow_forward, size: 17, color: T.transfer),
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
          color: uncategorized ? T.surface : parseHexColor(category.color),
          shape: BoxShape.circle,
          border: uncategorized ? Border.all(color: T.mutedLight, width: 1.6) : null,
        ),
        child: Icon(
          uncategorized ? Icons.add : categoryIcon(category.icon),
          size: 17,
          color: uncategorized ? T.mutedLight : Colors.white,
        ),
      ),
    );
  }
}
