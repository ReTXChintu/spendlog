import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';

/// Says which purchases a credit gives money back from, and how much of it
/// belongs to each.
///
/// One credit routinely settles several cancelled orders at once, and it is
/// rarely the whole of what was paid — tax, delivery and cancellation fees
/// usually stay gone. What is left on each purchase is its real cost.
Future<bool?> showRefundSheet(BuildContext context, {required Transaction refund}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
    builder: (_) => _RefundSheet(refund: refund),
  );
}

class _RefundSheet extends StatefulWidget {
  final Transaction refund;
  const _RefundSheet({required this.refund});

  @override
  State<_RefundSheet> createState() => _RefundSheetState();
}

class _RefundSheetState extends State<_RefundSheet> {
  List<Transaction>? _candidates;

  /// How much of the credit goes to each purchase, by purchase id.
  final Map<String, int> _picked = {};

  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    for (final allocation in widget.refund.refundOf) {
      _picked[allocation.transactionId] = allocation.amountMinor;
    }
    _load();
  }

  Future<void> _load() async {
    try {
      final result =
          await ApiClient.instance.get('/transactions/${widget.refund.id}/refund-candidates')
              as List<dynamic>;
      if (!mounted) return;
      setState(() => _candidates =
          result.map((t) => Transaction.fromJson(t as Map<String, dynamic>)).toList());
    } catch (_) {
      if (mounted) setState(() => _candidates = []);
    }
  }

  int get _allocated => _picked.values.fold(0, (sum, amount) => sum + amount);

  int get _unallocated => widget.refund.amountMinor - _allocated;

  /// What never came back across everything ticked: the tax and delivery
  /// on each order that the refund did not cover.
  int get _lost => (_candidates ?? [])
      .where((candidate) => _picked.containsKey(candidate.id))
      .fold(0, (sum, c) => sum + (c.amountMinor - _picked[c.id]!).clamp(0, c.amountMinor));

  /// Ticking a purchase claims as much of what is left of the credit as
  /// that purchase could account for — its whole cost, or whatever remains
  /// of the credit when that is less.
  void _toggle(Transaction candidate) {
    setState(() {
      if (_picked.containsKey(candidate.id)) {
        _picked.remove(candidate.id);
        return;
      }
      final remaining = widget.refund.amountMinor - _allocated;
      if (remaining <= 0) return;
      _picked[candidate.id] = candidate.amountMinor < remaining ? candidate.amountMinor : remaining;
    });
  }

  Future<void> _save(List<Map<String, dynamic>> allocations) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ApiClient.instance
          .post('/transactions/${widget.refund.id}/refund-of', {'allocations': allocations});
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't link that refund.";
        _saving = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 38,
                height: 4,
                decoration: BoxDecoration(color: c.lineStrong, borderRadius: BorderRadius.circular(100)),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              'What is this a refund of?',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink),
            ),
            const SizedBox(height: 4),
            Text(
              '${widget.refund.merchant ?? 'This credit'} · '
              '${formatMoney(widget.refund.amountMinor)} back · pick as many as it covers',
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
            const SizedBox(height: 14),
            if (_candidates == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_candidates!.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 16),
                child: Text(
                  'No payment in the six months before this credit to match it against.',
                  style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
                ),
              )
            else
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 280),
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: _candidates!.length,
                  itemBuilder: (context, i) {
                    final candidate = _candidates![i];
                    final isPicked = _picked.containsKey(candidate.id);
                    return GestureDetector(
                      onTap: () => _toggle(candidate),
                      child: Container(
                        margin: const EdgeInsets.only(bottom: 6),
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                        decoration: BoxDecoration(
                          color: isPicked ? c.brand50 : c.surface,
                          border: Border.all(color: isPicked ? c.brand : c.line),
                          borderRadius: BorderRadius.circular(T.rMd),
                        ),
                        child: Row(
                          children: [
                            Icon(
                              isPicked ? Icons.check_circle : Icons.circle_outlined,
                              size: 18,
                              color: isPicked ? c.brand : c.mutedLight,
                            ),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    candidate.merchant ?? 'Unknown',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontWeight: FontWeight.w700,
                                      fontSize: 13.4,
                                      color: c.ink,
                                    ),
                                  ),
                                  const SizedBox(height: 2),
                                  Text(
                                    formatDateTime(candidate.occurredAt),
                                    style: TextStyle(fontSize: 11.8, color: c.muted),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 10),
                            Text(
                              isPicked
                                  ? formatMoney(_picked[candidate.id]!)
                                  : formatMoney(candidate.amountMinor),
                              style: kNum.copyWith(
                                fontWeight: FontWeight.w700,
                                fontSize: 13.4,
                                color: isPicked ? c.brandDark : c.ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),
            if (_picked.isNotEmpty) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(color: c.credit50, borderRadius: BorderRadius.circular(T.rMd)),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    _Stat(
                      label: _picked.length == 1 ? 'Covering 1' : 'Covering ${_picked.length}',
                      value: formatMoneyShort(_allocated),
                    ),
                    _Stat(label: 'Never came back', value: formatMoneyShort(_lost)),
                    _Stat(
                      label: _unallocated < 0 ? 'Over' : 'Left as income',
                      value: formatMoneyShort(_unallocated.abs()),
                    ),
                  ],
                ),
              ),
            ],
            const SizedBox(height: 12),
            Text(
              'Whatever is allocated stops counting as income, and each purchase costs whatever did '
              'not come back.',
              style: TextStyle(fontSize: 11.8, height: 1.45, color: c.mutedLight),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                if (widget.refund.refundOf.isNotEmpty)
                  TextButton(
                    onPressed: _saving ? null : () => _save([]),
                    child: const Text('Not a refund'),
                  ),
                const Spacer(),
                TextButton(
                  onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _saving || _picked.isEmpty || _unallocated < 0
                      ? null
                      : () => _save([
                            for (final entry in _picked.entries)
                              {'transactionId': entry.key, 'amountMinor': entry.value},
                          ]),
                  child: Text(_saving ? 'Saving…' : 'Link refund'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  final String label;
  final String value;

  const _Stat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c.muted)),
        const SizedBox(height: 2),
        Text(value, style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink)),
      ],
    );
  }
}
