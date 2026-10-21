import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';
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
    backgroundColor: context.c.sf,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
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
      style: TextStyle(fontSize: 14, color: c.tx),
      // The in-page search: 44 h, a leading 20 px icon in tx3.
      decoration: InputDecoration(
        hintText: 'Search by merchant, note or amount',
        hintStyle: TextStyle(fontSize: 14, color: c.tx3),
        prefixIcon: Padding(
          padding: const EdgeInsets.only(left: 12, right: 8),
          child: DsIcon(DsIcons.search, size: 20, color: c.tx3),
        ),
        prefixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 44),
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
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
    final earmarked = widget.refund.isEarmarked;

    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsDragHandle(),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  DsSheetHeader(
                    icon: earmarked ? DsIcons.piggyBank : DsIcons.undo,
                    tone: DsTone.good,
                    title: earmarked ? 'What did this money pay for?' : 'What is this a refund of?',
                    subtitle: '${widget.refund.merchant ?? 'This credit'} · '
                        '${formatMoney(widget.refund.amountMinor)} '
                        '${earmarked ? 'set aside' : 'back'} · pick as many as it covers',
                  ),
                  const SizedBox(height: 16),
                  if (_candidates == null)
                    const DsSkeletonRows(count: 3)
                  else if (_candidates!.isEmpty)
                    DsEmpty(
                      icon: DsIcons.search,
                      // Either side, because money can arrive first and be
                      // spent afterwards - a deposit back before the new booking.
                      message: earmarked
                          ? 'No payment since this money came in to match it against yet.'
                          : 'No payment in the 30 days either side of this credit to match it against.',
                    )
                  else ...[
                    _searchField(),
                    const SizedBox(height: 8),
                    if (_hiddenPicks > 0)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text(
                          '$_hiddenPicks ticked ${_hiddenPicks == 1 ? 'purchase is' : 'purchases are'} '
                          'hidden by the search, and still counted.',
                          style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w500, color: c.ac),
                        ),
                      ),
                    if (_visible.isEmpty)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 16),
                        child: Text(
                          'Nothing here matches "${_query.trim()}".',
                          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
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
                            return _CandidateRow(
                              candidate: candidate,
                              picked: isPicked,
                              amountMinor: isPicked ? _picked[candidate.id]! : candidate.amountMinor,
                              onTap: () => _toggle(candidate),
                            );
                          },
                        ),
                      ),
                  ],
                  if (_picked.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    Container(
                      padding: const EdgeInsets.all(14),
                      decoration: BoxDecoration(
                        color: c.sf2,
                        border: Border.all(color: c.ln),
                        borderRadius: BorderRadius.circular(Ds.rLg),
                      ),
                      child: Row(
                        children: [
                          Expanded(
                            child: DsInlineStat(
                              compact: true,
                              label: _picked.length == 1 ? 'Covering 1' : 'Covering ${_picked.length}',
                              value: formatMoneyShort(_allocated),
                            ),
                          ),
                          Expanded(
                            child: DsInlineStat(
                              compact: true,
                              label: earmarked ? 'Paid by you' : 'Never came back',
                              value: formatMoneyShort(_lost),
                            ),
                          ),
                          Expanded(
                            child: DsInlineStat(
                              compact: true,
                              label: _unallocated < 0
                                  ? 'Over'
                                  : (earmarked ? 'Still set aside' : 'Left as income'),
                              value: formatMoneyShort(_unallocated.abs()),
                              valueColor: _unallocated < 0 ? c.crit : null,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: 12),
                  Text(
                    earmarked
                        ? 'Each purchase picked is paid for by this money, so it stops counting as your own '
                            'spending.'
                        : 'Whatever is allocated stops counting as income, and each purchase costs whatever '
                            'did not come back.',
                    style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    DsCallout(tone: DsTone.crit, title: _error!),
                  ],
                ],
              ),
            ),
          ),
          Container(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            decoration: BoxDecoration(color: c.sf2, border: Border(top: BorderSide(color: c.ln))),
            child: Row(
              children: [
                if (widget.refund.refundOf.isNotEmpty)
                  Flexible(
                    child: TextButton(
                      onPressed: _saving ? null : () => _save([]),
                      style: TextButton.styleFrom(foregroundColor: c.crit),
                      child: Text(earmarked ? 'Unlink all' : 'Not a refund'),
                    ),
                  ),
                const SizedBox(width: 8),
                Expanded(
                  child: OverflowBar(
                    alignment: MainAxisAlignment.end,
                    overflowAlignment: OverflowBarAlignment.end,
                    spacing: 8,
                    overflowSpacing: 8,
                    children: [
                      OutlinedButton(
                        onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                        style: OutlinedButton.styleFrom(minimumSize: const Size(64, 48)),
                        child: const Text('Cancel'),
                      ),
                      FilledButton(
                        onPressed: _saving || _picked.isEmpty || _unallocated < 0
                            ? null
                            : () => _save([
                                  for (final entry in _picked.entries)
                                    {'transactionId': entry.key, 'amountMinor': entry.value},
                                ]),
                        child: Text(_saving ? 'Saving…' : (earmarked ? 'Link' : 'Link refund')),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// One purchase the credit could be for: a check square, the merchant and
/// when, and the amount. Picked rows are the selected-list-item style.
class _CandidateRow extends StatelessWidget {
  final Transaction candidate;
  final bool picked;
  final int amountMinor;
  final VoidCallback onTap;

  const _CandidateRow({
    required this.candidate,
    required this.picked,
    required this.amountMinor,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final shape = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(Ds.rLg),
      side: BorderSide(color: picked ? c.acLine : c.ln),
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: picked ? c.acSoft : c.sf,
        shape: shape,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 56),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                Container(
                  width: 22,
                  height: 22,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: picked ? c.ac : c.sf,
                    borderRadius: BorderRadius.circular(6),
                    border: picked ? null : Border.all(color: c.ln2, width: 1.5),
                  ),
                  child: picked ? DsIcon(DsIcons.check, size: 14, color: c.acTx) : null,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        candidate.merchant ?? 'Unknown',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        formatDateTime(candidate.occurredAt),
                        style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  formatMoney(amountMinor),
                  style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: picked ? c.ac : c.tx),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
