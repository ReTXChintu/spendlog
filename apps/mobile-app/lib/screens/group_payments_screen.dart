import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/state_block.dart';
import 'group_add_payments_screen.dart';

/// Everything in a group, everyone's. The one place to see what is in it,
/// add earlier payments, and take out what does not belong: a row of the
/// user's own opens the edit sheet, whose group field takes it out.
/// Someone else's row is theirs to change.
///
/// Pops with true when anything changed, so the group's totals are redone.
class GroupPaymentsScreen extends StatefulWidget {
  final Group group;

  const GroupPaymentsScreen({super.key, required this.group});

  @override
  State<GroupPaymentsScreen> createState() => _GroupPaymentsScreenState();
}

/// One row of GET /groups/:id/transactions, with who paid.
class GroupPaymentRow {
  final Transaction transaction;
  final bool isMine;
  final String payer;

  GroupPaymentRow(this.transaction, this.isMine, this.payer);

  factory GroupPaymentRow.fromJson(Map<String, dynamic> json) {
    final user = json['userId'];
    final fromUser = user is Map<String, dynamic> ? (user['name'] ?? user['email']) as String? : null;
    // The server names whoever paid: the user, or the contact on a payment
    // someone else made.
    final payer = json['paidByName'] as String? ??
        (json['paidByContact'] as Map<String, dynamic>?)?['name'] as String? ??
        fromUser;
    return GroupPaymentRow(Transaction.fromJson(json), json['isMine'] == true, payer ?? 'Someone');
  }
}

class _GroupPaymentsScreenState extends State<GroupPaymentsScreen> {
  List<GroupPaymentRow>? _rows;
  bool _error = false;
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/groups/${widget.group.id}/transactions') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _rows = result.map((r) => GroupPaymentRow.fromJson(r as Map<String, dynamic>)).toList();
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _edit(GroupPaymentRow row) async {
    final saved = await showEditTransactionById(context, row.transaction.id);
    if (saved == true) {
      _changed = true;
      await _load();
    }
  }

  Future<void> _addEarlier() async {
    final messenger = ScaffoldMessenger.of(context);
    final added = await Navigator.of(context).push<int>(
      MaterialPageRoute(builder: (_) => GroupAddPaymentsScreen(group: widget.group)),
    );
    if (added == null || added == 0 || !mounted) return;
    _changed = true;
    messenger.showSnackBar(SnackBar(content: Text(addedToGroupMessage(added, widget.group.name))));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final rows = _rows;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        backgroundColor: c.bg,
        appBar: AppBar(
          title: Text(widget.group.name, maxLines: 1, overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(
              tooltip: 'Add earlier payments',
              onPressed: _addEarlier,
              icon: const DsIcon(DsIcons.plus),
            ),
            const SizedBox(width: 4),
          ],
        ),
        body: _error
            ? StateBlock(
                icon: Icons.wifi_off,
                warn: true,
                title: "Couldn't load the group's payments",
                body: 'The connection failed. Check your internet and try again.',
                actionLabel: 'Retry',
                onAction: _load,
              )
            : rows == null
                ? const Padding(
                    padding: EdgeInsets.fromLTRB(16, 16, 16, 0),
                    child: DsSkeletonRows(count: 5),
                  )
                : rows.isEmpty
                    ? StateBlock(
                        icon: Icons.group_outlined,
                        title: 'Nothing in this group yet',
                        body: 'Pick a group when you add or edit a payment, or add earlier ones here.',
                        actionLabel: 'Add earlier payments',
                        onAction: _addEarlier,
                      )
                    : RefreshIndicator(
                        onRefresh: _load,
                        child: ListView(
                          padding: kPagePad,
                          children: [
                            DsCard(
                              padding: EdgeInsets.zero,
                              clip: true,
                              child: Column(
                                children: [
                                  for (var i = 0; i < rows.length; i++)
                                    GroupPaymentTile(
                                      row: rows[i],
                                      last: i == rows.length - 1,
                                      onTap: rows[i].isMine ? () => _edit(rows[i]) : null,
                                    ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 12),
                            Text(
                              'Tap one of yours to change it, or to take it out of ${widget.group.name}.',
                              style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
                            ),
                          ],
                        ),
                      ),
      ),
    );
  }
}

/// The phone transaction row: monogram, two lines, the amount.
class GroupPaymentTile extends StatelessWidget {
  final GroupPaymentRow row;
  final VoidCallback? onTap;
  final bool last;

  const GroupPaymentTile({super.key, required this.row, required this.onTap, this.last = false});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final t = row.transaction;
    final isOut = t.type == 'DEBIT';
    final meta = [
      formatShortDate(t.occurredAt),
      if (!row.isMine || t.offLedger) 'Paid by ${row.payer}',
      if (row.isMine && t.category != null) t.category!.name,
    ].join(' · ');

    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 64),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
        child: Row(
          children: [
            DsMonogram(t.merchant ?? 'Payment', tone: row.isMine ? DsTone.ac : DsTone.neutral),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    t.merchant ?? 'Payment',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    meta,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            Text(
              '${isOut ? '' : '+'}${formatMoney(t.amountMinor)}',
              style: kNum.copyWith(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: isOut ? c.tx : c.good,
              ),
            ),
            const SizedBox(width: 6),
            // Yours open the editor; someone else's are theirs to change.
            if (onTap != null)
              DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3)
            else
              DsIcon(DsIcons.lock, size: 16, color: c.tx3),
          ],
        ),
      ),
    );
  }
}
