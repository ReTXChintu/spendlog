import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/state_block.dart';
import 'trip_add_payments_screen.dart';

/// Everything on a trip, everyone's. The one place to see what is on it,
/// add what was paid before it started, and take off what does not belong:
/// a row of the user's own opens the edit sheet, whose "On <trip>" switch
/// takes it off. Someone else's row is theirs to change.
///
/// Pops with true when anything changed, so the trip's totals are redone.
class TripPaymentsScreen extends StatefulWidget {
  final Trip trip;

  const TripPaymentsScreen({super.key, required this.trip});

  @override
  State<TripPaymentsScreen> createState() => _TripPaymentsScreenState();
}

/// One row of GET /trips/:id/transactions, with who paid.
class _TripRow {
  final Transaction transaction;
  final bool isMine;
  final String payer;

  _TripRow(this.transaction, this.isMine, this.payer);

  factory _TripRow.fromJson(Map<String, dynamic> json) {
    final user = json['userId'];
    final payer = user is Map<String, dynamic> ? (user['name'] ?? user['email']) as String? : null;
    return _TripRow(Transaction.fromJson(json), json['isMine'] == true, payer ?? 'Someone');
  }
}

class _TripPaymentsScreenState extends State<TripPaymentsScreen> {
  List<_TripRow>? _rows;
  bool _error = false;
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/trips/${widget.trip.id}/transactions') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _rows = result.map((r) => _TripRow.fromJson(r as Map<String, dynamic>)).toList();
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _edit(_TripRow row) async {
    final saved = await showEditTransactionById(context, row.transaction.id);
    if (saved == true) {
      _changed = true;
      await _load();
    }
  }

  Future<void> _addEarlier() async {
    final messenger = ScaffoldMessenger.of(context);
    final added = await Navigator.of(context).push<int>(
      MaterialPageRoute(builder: (_) => TripAddPaymentsScreen(trip: widget.trip)),
    );
    if (added == null || added == 0 || !mounted) return;
    _changed = true;
    messenger.showSnackBar(SnackBar(content: Text(addedToTripMessage(added, widget.trip.name))));
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
          title: Text(widget.trip.name, maxLines: 1, overflow: TextOverflow.ellipsis),
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
                title: "Couldn't load the trip's payments",
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
                        icon: Icons.luggage_outlined,
                        title: 'Nothing on this trip yet',
                        body: 'Payments made while it runs go on by themselves. Tickets and bookings '
                            'paid before it started can be added by hand.',
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
                                    _PaymentRow(
                                      row: rows[i],
                                      last: i == rows.length - 1,
                                      onTap: rows[i].isMine ? () => _edit(rows[i]) : null,
                                    ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 12),
                            Text(
                              'Tap one of yours to change it, or switch "On ${widget.trip.name}" off to '
                              'take it off the trip.',
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
class _PaymentRow extends StatelessWidget {
  final _TripRow row;
  final VoidCallback? onTap;
  final bool last;

  const _PaymentRow({required this.row, required this.onTap, this.last = false});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final t = row.transaction;
    final isOut = t.type == 'DEBIT';
    final meta = [
      formatShortDate(t.occurredAt),
      if (!row.isMine) 'Paid by ${row.payer}',
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
