import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'account_balance_panel.dart' show endOfIstDay;
import 'ds/ds.dart';
import '../utils/format.dart';

/// What a credit card has left of its limit, from a figure typed in once.
///
/// The card's own rows only add up to what SpendLog has seen, which misses
/// every purchase before it started reading messages. Given what the
/// bank's app shows as available, everything charged and paid on the card
/// since is carried forward from there - and a newer "Avl Lmt" in one of
/// the bank's own messages takes over by itself.
class CardAvailablePanel extends StatefulWidget {
  const CardAvailablePanel({
    super.key,
    required this.accountId,
    required this.availability,
    required this.onChanged,
    this.sharedWith = const [],
    this.now,
  });

  final String accountId;
  final CardAvailability availability;
  final VoidCallback onChanged;

  /// The other cards on the same limit, named. The bank's figure is the
  /// pot's, so it is said once for all of them.
  final List<String> sharedWith;

  /// The clock, for saying how long ago a message came. Tests pin it.
  final DateTime Function()? now;

  @override
  State<CardAvailablePanel> createState() => _CardAvailablePanelState();
}

class _CardAvailablePanelState extends State<CardAvailablePanel> {
  bool _busy = false;

  Future<void> _patch(Map<String, dynamic> body) async {
    setState(() => _busy = true);
    try {
      await ApiClient.instance.patch('/accounts/${widget.accountId}', body);
      widget.onChanged();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(error is ApiException ? error.message : "Couldn't save that."),
        ));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _set() async {
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => AvailableLimitDialog(creditLimitMinor: widget.availability.creditLimitMinor),
    );
    if (result != null) await _patch(result);
  }

  Future<void> _stop() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Stop using this figure?'),
        content: const Text(
          "SpendLog goes back to adding up the card's own payments - or to your bank's "
          '"Avl Lmt" when one of its messages states it.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Stop')),
        ],
      ),
    );
    if (sure == true) await _patch({'availableLimitMinor': null});
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final availability = widget.availability;

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.sf2,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rLg),
      ),
      child: availability.isStated ? _stated(availability) : _prompt(),
    );
  }

  Widget _prompt() {
    final c = context.c;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const DsLabel('Available limit'),
        const SizedBox(height: 4),
        Text(
          'Add what your bank app shows as available, and SpendLog keeps it up to date from your '
          'payments and SMS.',
          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: _busy ? null : _set,
          icon: const DsIcon(DsIcons.plus, size: 18),
          label: const Text('Add available limit'),
        ),
      ],
    );
  }

  /// Where the figure came from, said as the user would: their own figure
  /// on a day, or the bank's message some time ago.
  String _origin(CardAvailability availability) {
    final at = availability.asOf;
    if (availability.source == 'sms') {
      return at == null ? "From your bank's SMS" : "From your bank's SMS · ${_ago(at)}";
    }
    final figure = availability.anchorMinor == null ? 'it' : formatMoney(availability.anchorMinor!);
    if (at == null) return 'You set $figure';
    final now = (widget.now ?? DateTime.now)();
    return istDayOf(at) == istDayOf(now) ? 'You set $figure today' : 'You set $figure on ${formatShortDate(at)}';
  }

  String _ago(DateTime at) {
    final elapsed = (widget.now ?? DateTime.now)().difference(at);
    if (elapsed.inMinutes < 1) return 'just now';
    if (elapsed.inMinutes < 60) return '${elapsed.inMinutes} min ago';
    if (elapsed.inHours < 24) return '${elapsed.inHours} h ago';
    return 'on ${formatShortDate(at)}';
  }

  Widget _stated(CardAvailability availability) {
    final c = context.c;
    final charged = availability.chargedSinceMinor ?? 0;
    final paid = availability.paidSinceMinor ?? 0;
    final shared = widget.sharedWith;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const DsLabel('Available now'),
        const SizedBox(height: 4),
        Text(
          formatMoney(availability.availableMinor!),
          style: kNum.copyWith(
            fontSize: 22,
            height: 28 / 22,
            fontWeight: FontWeight.w600,
            // Nothing left is a problem; any other figure is ink.
            color: availability.availableMinor! <= 0 ? c.crit : c.tx,
          ),
        ),
        const SizedBox(height: 6),
        Text.rich(
          TextSpan(
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3, fontFeatures: Ds.tabular),
            children: [
              TextSpan(text: _origin(availability)),
              // Refunds net off purchases, so "spent" can come out below
              // nothing: said as money back rather than a negative spend.
              if (charged > 0) TextSpan(text: ' · −${formatMoney(charged)} spent', style: TextStyle(color: c.tx2)),
              if (charged < 0) TextSpan(text: ' · +${formatMoney(-charged)} refunded', style: TextStyle(color: c.good)),
              if (paid > 0) TextSpan(text: ' · +${formatMoney(paid)} paid', style: TextStyle(color: c.good)),
              if (charged != 0 || paid != 0) const TextSpan(text: ' since'),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Wrap(
          spacing: 4,
          runSpacing: 4,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            OutlinedButton(
              onPressed: _busy ? null : _set,
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
              child: const Text('Update'),
            ),
            // Only the user's own figure can be taken back; the bank's
            // message stands until a newer figure replaces it.
            if (availability.source == 'you')
              TextButton(
                onPressed: _busy ? null : _stop,
                style: TextButton.styleFrom(foregroundColor: c.crit),
                child: const Text('Stop'),
              ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          [
            'Purchases since take away from it; refunds and bill payments add back. A newer '
                '"Avl Lmt" in your bank\'s SMS takes over by itself.',
            if (shared.isNotEmpty) 'Shared with ${shared.join(', ')}: the figure is for the whole limit.',
          ].join(' '),
          style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
        ),
      ],
    );
  }
}

/// Digits and one decimal point: what is left of a limit is never negative.
final _amount = FilteringTextInputFormatter.allow(RegExp(r'^[\d,]*\.?\d{0,2}'));

InputDecoration _amountDecoration(BuildContext context, String label, {String? helper}) => InputDecoration(
      labelText: label,
      helperText: helper,
      helperMaxLines: 2,
      prefixText: '₹ ',
      hintText: '0.00',
      prefixStyle: TextStyle(fontSize: 15, color: context.c.tx3, fontWeight: FontWeight.w500),
    );

enum _AsOf { now, endOfDay }

/// Setting what a card has left of its limit - and its credit limit too,
/// when it has none yet. Pops with the PATCH body.
class AvailableLimitDialog extends StatefulWidget {
  const AvailableLimitDialog({super.key, this.creditLimitMinor});

  /// The card's limit, when known: the figure cannot be more than it.
  final int? creditLimitMinor;

  @override
  State<AvailableLimitDialog> createState() => _AvailableLimitDialogState();
}

class _AvailableLimitDialogState extends State<AvailableLimitDialog> {
  final _available = TextEditingController();
  final _limit = TextEditingController();
  _AsOf _asOf = _AsOf.now;
  DateTime? _day;
  String? _error;

  @override
  void dispose() {
    _available.dispose();
    _limit.dispose();
    super.dispose();
  }

  Future<void> _pickDay() async {
    final today = istWallClock(DateTime.now());
    final picked = await showDatePicker(
      context: context,
      initialDate: _day ?? DateTime(today.year, today.month, today.day),
      firstDate: DateTime(2000),
      lastDate: DateTime(today.year, today.month, today.day),
    );
    if (picked != null) {
      setState(() {
        _day = picked;
        _asOf = _AsOf.endOfDay;
      });
    }
  }

  void _save() {
    final available = parseRupees(_available.text);
    if (available == null) return setState(() => _error = 'Type the available limit as a number.');

    final askLimit = widget.creditLimitMinor == null;
    int? limit;
    if (askLimit && _limit.text.trim().isNotEmpty) {
      limit = parseRupees(_limit.text);
      if (limit == null || limit <= 0) return setState(() => _error = 'Type the credit limit as a number.');
    }
    final ceiling = widget.creditLimitMinor ?? limit;
    if (ceiling != null && available > ceiling) {
      return setState(() => _error = "That's more than the card's ${formatMoney(ceiling)} limit.");
    }
    if (_asOf == _AsOf.endOfDay && _day == null) {
      return setState(() => _error = 'Pick the day it was the figure at the end of.');
    }

    Navigator.of(context).pop(<String, dynamic>{
      'availableLimitMinor': available,
      // Left out for "right now": the server takes that as this moment.
      if (_asOf == _AsOf.endOfDay) 'availableLimitAt': endOfIstDay(_day!).toIso8601String(),
      if (limit != null) 'creditLimitMinor': limit,
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return AlertDialog(
      title: const Text('Available limit'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              key: const ValueKey('available-amount'),
              controller: _available,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [_amount],
              style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w600),
              decoration: _amountDecoration(context, 'What your bank app shows as available'),
            ),
            if (widget.creditLimitMinor == null) ...[
              const SizedBox(height: 12),
              TextField(
                key: const ValueKey('credit-limit'),
                controller: _limit,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [_amount],
                style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w600),
                decoration: _amountDecoration(
                  context,
                  'Credit limit',
                  helper: "Optional. With it, SpendLog shows what's owed and how much of the limit is used.",
                ),
              ),
            ],
            const SizedBox(height: 14),
            const DsLabel('As of'),
            RadioGroup<_AsOf>(
              groupValue: _asOf,
              onChanged: (value) {
                if (value == _AsOf.endOfDay && _day == null) {
                  _pickDay();
                } else if (value != null) {
                  setState(() => _asOf = value);
                }
              },
              child: Column(
                children: [
                  const RadioListTile<_AsOf>(
                    value: _AsOf.now,
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text('Right now'),
                  ),
                  RadioListTile<_AsOf>(
                    value: _AsOf.endOfDay,
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(_day == null
                        ? 'End of a day…'
                        : 'End of ${formatDayLabel(_day!.toIso8601String().substring(0, 10))}'),
                    secondary: _asOf == _AsOf.endOfDay
                        ? TextButton(onPressed: _pickDay, child: const Text('Pick'))
                        : null,
                  ),
                ],
              ),
            ),
            Text(
              '"Right now" means the figure already includes every purchase so far. Pick the end of a '
              'day for a figure off a statement.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.crit)),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _save, child: const Text('Save')),
      ],
    );
  }
}
