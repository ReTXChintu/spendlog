import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';

/// Points a credit at the payment it gives money back from.
///
/// Refunds are rarely whole — tax, delivery and cancellation fees usually
/// stay gone — so the purchase keeps whatever did not come back as its real
/// cost, rather than vanishing from the month entirely.
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
  String? _picked;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _picked = widget.refund.refundOfId;
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

  Future<void> _save(String? purchaseId) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ApiClient.instance
          .post('/transactions/${widget.refund.id}/refund-of', {'purchaseId': purchaseId});
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
    final chosen = _candidates?.where((t) => t.id == _picked).firstOrNull;
    final lost = chosen == null
        ? 0
        : (chosen.amountMinor - widget.refund.amountMinor).clamp(0, chosen.amountMinor);

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
              '${formatMoney(widget.refund.amountMinor)} back',
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
                  'No payment within the last six months is large enough to have produced this refund.',
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
                    final isPicked = candidate.id == _picked;
                    return GestureDetector(
                      onTap: () => setState(() => _picked = candidate.id),
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
                              formatMoney(candidate.amountMinor),
                              style: kNum.copyWith(
                                fontWeight: FontWeight.w700,
                                fontSize: 13.4,
                                color: c.ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
              ),

            if (chosen != null) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(color: c.credit50, borderRadius: BorderRadius.circular(T.rMd)),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    _Stat(label: 'Paid', value: formatMoneyShort(chosen.amountMinor)),
                    _Stat(label: 'Coming back', value: formatMoneyShort(widget.refund.amountMinor)),
                    _Stat(label: 'Never came back', value: formatMoneyShort(lost)),
                  ],
                ),
              ),
            ],

            const SizedBox(height: 12),
            Text(
              'The credit stops counting as income, and the purchase costs whatever did not come back.',
              style: TextStyle(fontSize: 11.8, height: 1.45, color: c.mutedLight),
            ),

            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
            ],

            const SizedBox(height: 16),
            Row(
              children: [
                if (widget.refund.refundOfId != null)
                  TextButton(
                    onPressed: _saving ? null : () => _save(null),
                    child: const Text('Not a refund'),
                  ),
                const Spacer(),
                TextButton(
                  onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _saving || _picked == null ? null : () => _save(_picked),
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
