import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';

class TransactionTile extends StatefulWidget {
  final Transaction transaction;
  final List<Category> categories;
  final ValueChanged<Transaction> onUpdated;

  const TransactionTile({super.key, required this.transaction, required this.categories, required this.onUpdated});

  @override
  State<TransactionTile> createState() => _TransactionTileState();
}

class _TransactionTileState extends State<TransactionTile> {
  bool _saving = false;

  Future<void> _changeCategory(String? categoryId) async {
    setState(() => _saving = true);
    try {
      final result = await ApiClient.instance.patch('/transactions/${widget.transaction.id}', {'categoryId': categoryId});
      widget.onUpdated(Transaction.fromJson(result as Map<String, dynamic>));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final tx = widget.transaction;
    final isDebit = tx.type == 'DEBIT';
    final amountColor = isDebit ? Colors.red.shade700 : Colors.green.shade700;
    final sign = isDebit ? '-' : '+';

    return Opacity(
      opacity: tx.isTransfer ? 0.6 : 1,
      child: Card(
        margin: const EdgeInsets.symmetric(vertical: 4),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            tx.merchant ?? 'Unknown',
                            style: const TextStyle(fontWeight: FontWeight.w600),
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        if (tx.isTransfer) const _Badge(label: 'Transfer'),
                        if (tx.pending) const _Badge(label: 'Pending'),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '${tx.account != null ? "${tx.account!.bankName} ••${tx.account!.last4 ?? '----'}" : tx.source} · ${formatTime(tx.occurredAt)}',
                      style: TextStyle(color: Colors.grey.shade600, fontSize: 12),
                    ),
                    const SizedBox(height: 6),
                    DropdownButton<String>(
                      value: tx.category?.id,
                      hint: const Text('Uncategorized'),
                      isDense: true,
                      onChanged: _saving ? null : _changeCategory,
                      items: widget.categories
                          .map((c) => DropdownMenuItem(value: c.id, child: Text(c.name)))
                          .toList(),
                    ),
                  ],
                ),
              ),
              Text(
                '$sign${formatMoney(tx.amountMinor, tx.currency)}',
                style: TextStyle(color: amountColor, fontWeight: FontWeight.bold, fontSize: 16),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  final String label;
  const _Badge({required this.label});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(color: Colors.grey.shade300, borderRadius: BorderRadius.circular(4)),
      child: Text(label, style: const TextStyle(fontSize: 10)),
    );
  }
}
