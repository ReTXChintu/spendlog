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
    // Lifted over the keyboard, which the search box now brings up.
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
      child: _RefundSheet(refund: refund),
    ),
  );
}

/// Whether a purchase matches what was typed into the refund picker's
/// search: its merchant, its note, or its amount however it was written -
/// "499", "499.00", "₹499" and "1,499" all find ₹1,499.00.
bool refundCandidateMatches(Transaction candidate, String query) {
  final wanted = query.trim().toLowerCase();
  if (wanted.isEmpty) return true;

  final rupees = (candidate.amountMinor / 100).toStringAsFixed(2);
  final haystack = [
    candidate.merchant ?? '',
    candidate.note ?? '',
    rupees,
    formatMoney(candidate.amountMinor, candidate.currency),
  ].join(' ').toLowerCase();
  if (haystack.contains(wanted)) return true;

  // Typed as an amount, with or without the symbol and the grouping.
  final bare = wanted.replaceAll(RegExp(r'[₹,\s]'), '');
  return bare.isNotEmpty && RegExp(r'^[\d.]+$').hasMatch(bare) && rupees.contains(bare);
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

  /// Narrows what is on screen only. A purchase ticked and then searched
  /// out of view is still ticked, and still in the totals below.
  String _query = '';

  /// Filtered once per keystroke rather than on every build: there can be
  /// a few hundred candidates, and the list reads this once per row.
  List<Transaction> _visible = [];

  void _filter() {
    _visible = (_candidates ?? const []).where((c) => refundCandidateMatches(c, _query)).toList();
  }

  /// Ticked, but searched out of view.
  int get _hiddenPicks {
    if (_query.trim().isEmpty) return 0;
    final shown = _visible.map((c) => c.id).toSet();
    return _picked.keys.where((id) => !shown.contains(id)).length;
  }

  Widget _searchField() {
    final c = context.c;
    return TextField(
      onChanged: (value) => setState(() {
        _query = value;
        _filter();
      }),
      style: TextStyle(fontSize: 13.5, color: c.ink),
      decoration: InputDecoration(
        hintText: 'Search by merchant, note or amount',
        hintStyle: TextStyle(color: c.mutedLight),
        prefixIcon: Icon(Icons.search, size: 18, color: c.muted),
        isDense: true,
        filled: true,
        fillColor: c.surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(T.rSm),
          borderSide: BorderSide(color: c.lineStrong),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(T.rSm),
          borderSide: BorderSide(color: c.brand),
        ),
      ),
    );
  }

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
      setState(() {
        _candidates = result.map((t) => Transaction.fromJson(t as Map<String, dynamic>)).toList();
        _filter();
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _candidates = [];
          _filter();
        });
      }
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
                  // Either side, because money can arrive first and be
                  // spent afterwards - a deposit back before the new booking.
                  'No payment in the 30 days either side of this credit to match it against.',
                  style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
                ),
              )
            else ...[
              _searchField(),
              const SizedBox(height: 8),
              if (_hiddenPicks > 0)
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(
                    '$_hiddenPicks ticked ${_hiddenPicks == 1 ? 'purchase is' : 'purchases are'} '
                    'hidden by the search, and still counted.',
                    style: TextStyle(fontSize: 11.5, color: c.brandDark),
                  ),
                ),
              if (_visible.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  child: Text(
                    'Nothing here matches "${_query.trim()}".',
                    style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
                  ),
                )
              else
                ConstrainedBox(
                  constraints: const BoxConstraints(maxHeight: 300),
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: _visible.length,
                    itemBuilder: (context, i) {
                      final candidate = _visible[i];
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
            ],
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
