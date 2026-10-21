import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';
import '../utils/format.dart';

/// What a bank account or cash should hold, from a balance typed in once.
///
/// SpendLog only ever sees money move; it has never known what is actually
/// in an account. Given one real figure to start from, everything it has
/// seen since adds up to what should be there now - and when the bank says
/// something different, the gap is a transaction it missed.
class AccountBalancePanel extends StatefulWidget {
  const AccountBalancePanel({
    super.key,
    required this.accountId,
    required this.balance,
    required this.onChanged,
    this.isCash = false,
  });

  final String accountId;
  final ExpectedBalance? balance;
  final VoidCallback onChanged;
  final bool isCash;

  @override
  State<AccountBalancePanel> createState() => _AccountBalancePanelState();
}

class _AccountBalancePanelState extends State<AccountBalancePanel> {
  bool _busy = false;

  String get _where => widget.isCash ? 'your wallet' : 'your bank';

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

  Future<void> _setOpening() async {
    final result = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (_) => _OpeningDialog(existing: widget.balance, isCash: widget.isCash),
    );
    if (result != null) await _patch(result);
  }

  Future<void> _check() async {
    final bankMinor = await showDialog<int>(
      context: context,
      builder: (_) => _CheckDialog(expectedMinor: widget.balance!.expectedMinor, isCash: widget.isCash),
    );
    // Only comes back with a figure when it is to become the new start.
    // No moment is sent: "now" is what the figure just typed means.
    if (bankMinor != null) await _patch({'openingBalanceMinor': bankMinor});
  }

  Future<void> _remove() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Stop tracking the balance?'),
        content: const Text(
          'The starting balance is forgotten. Transactions stay exactly as they are.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (sure == true) await _patch({'openingBalanceMinor': null});
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final balance = widget.balance;

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.sf2,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rLg),
      ),
      child: balance == null ? _prompt() : _tracked(balance),
    );
  }

  Widget _prompt() {
    final c = context.c;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const DsLabel('Balance'),
        const SizedBox(height: 4),
        Text(
          widget.isCash
              ? "Add what's in your wallet, and SpendLog will keep track of what it should be — so a "
                  'missing transaction shows up.'
              : 'Add the balance your bank shows, and SpendLog will keep track of what it should be — '
                  'so a missing transaction shows up.',
          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: _busy ? null : _setOpening,
          icon: const DsIcon(DsIcons.plus, size: 18),
          label: const Text('Add the balance'),
        ),
      ],
    );
  }

  Widget _tracked(ExpectedBalance balance) {
    final c = context.c;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const DsLabel('Should have'),
        const SizedBox(height: 4),
        Text(
          formatMoney(balance.expectedMinor),
          style: kNum.copyWith(
            fontSize: 22,
            height: 28 / 22,
            fontWeight: FontWeight.w600,
            // Overdrawn is a problem; a balance is otherwise ink.
            color: balance.expectedMinor < 0 ? c.crit : c.tx,
          ),
        ),
        if (balance.provisionalMinor > 0) ...[
          const SizedBox(height: 2),
          Text(
            'Includes ${formatMoney(balance.provisionalMinor)} not yet explained',
            style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.warn),
          ),
        ],
        const SizedBox(height: 6),
        Text.rich(
          TextSpan(
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3, fontFeatures: Ds.tabular),
            children: [
              TextSpan(text: '${formatMoney(balance.openingMinor)} on ${formatShortDate(balance.since)} · '),
              TextSpan(text: '+${formatMoney(balance.inMinor)} in', style: TextStyle(color: c.good)),
              const TextSpan(text: ' · '),
              TextSpan(text: '−${formatMoney(balance.outMinor)} out', style: TextStyle(color: c.tx2)),
              TextSpan(
                text: ' · ${balance.transactionCount} '
                    '${balance.transactionCount == 1 ? 'transaction' : 'transactions'}',
              ),
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
              onPressed: _busy ? null : _check,
              style: OutlinedButton.styleFrom(minimumSize: const Size(0, 40)),
              child: Text(widget.isCash ? 'Check against wallet' : 'Check against bank'),
            ),
            TextButton(onPressed: _busy ? null : _setOpening, child: const Text('Change')),
            TextButton(
              onPressed: _busy ? null : _remove,
              style: TextButton.styleFrom(foregroundColor: c.crit),
              child: const Text('Remove'),
            ),
          ],
        ),
        const SizedBox(height: 4),
        Text(
          'Counts every payment in and out of $_where since then, debit cards on it included.',
          style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
        ),
      ],
    );
  }
}

/// Digits, one minus sign at the front, and a decimal point: a balance can
/// be overdrawn, so unlike every other amount it can be negative.
final _signedAmount = FilteringTextInputFormatter.allow(RegExp(r'^-?[\d,]*\.?\d{0,2}'));

InputDecoration _amountDecoration(BuildContext context, String label) => InputDecoration(
      labelText: label,
      prefixText: '₹ ',
      hintText: '0.00',
      prefixStyle: TextStyle(fontSize: 15, color: context.c.tx3, fontWeight: FontWeight.w500),
    );
/// The instant a day ends in India: 23:59:59.999 IST, which is 18:29:59.999
/// UTC. A balance read "at the end of the 3rd" already includes everything
/// on the 3rd, and nothing after it.
DateTime endOfIstDay(DateTime day) => DateTime.utc(day.year, day.month, day.day, 18, 29, 59, 999);

enum _AsOf { now, before, endOfDay }

/// Setting or changing the starting balance. Pops with the PATCH body.
class _OpeningDialog extends StatefulWidget {
  const _OpeningDialog({this.existing, required this.isCash});

  final ExpectedBalance? existing;
  final bool isCash;

  @override
  State<_OpeningDialog> createState() => _OpeningDialogState();
}

class _OpeningDialogState extends State<_OpeningDialog> {
  late final _amount = TextEditingController(
    text: widget.existing == null ? '' : (widget.existing!.openingMinor / 100).toStringAsFixed(2),
  );

  /// Changing the figure keeps the moment it was read at, unless told
  /// otherwise - the likeliest edit is a typo in the amount.
  late _AsOf _asOf = widget.existing == null ? _AsOf.now : _AsOf.before;
  DateTime? _day;
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
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
    final minor = parseRupees(_amount.text, allowNegative: true);
    if (minor == null) return setState(() => _error = 'Type the balance as a number.');
    if (_asOf == _AsOf.endOfDay && _day == null) {
      return setState(() => _error = 'Pick the day it was the balance at the end of.');
    }

    Navigator.of(context).pop(<String, dynamic>{
      'openingBalanceMinor': minor,
      // Left out for "right now": the server takes that as this moment.
      if (_asOf == _AsOf.before) 'openingBalanceAt': widget.existing!.since.toUtc().toIso8601String(),
      if (_asOf == _AsOf.endOfDay) 'openingBalanceAt': endOfIstDay(_day!).toIso8601String(),
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final existing = widget.existing;

    return AlertDialog(
      title: Text(existing == null ? 'Starting balance' : 'Change the starting balance'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: _amount,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
              inputFormatters: [_signedAmount],
              style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w600),
              decoration: _amountDecoration(
                context,
                widget.isCash ? 'In your wallet' : 'What your bank shows',
              ),
            ),
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
                  if (existing != null)
                    RadioListTile<_AsOf>(
                      value: _AsOf.before,
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      title: Text('As before — ${formatDateTime(existing.since)}'),
                    ),
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
              '"Right now" means the figure already includes everything so far. Pick the end of a '
              'day for a figure off a statement or an older passbook entry.',
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

/// Typing in what the bank says now, and seeing at once how far apart the
/// two are. Pops with the bank's figure only when it is to become the new
/// starting balance.
class _CheckDialog extends StatefulWidget {
  const _CheckDialog({required this.expectedMinor, required this.isCash});

  final int expectedMinor;
  final bool isCash;

  @override
  State<_CheckDialog> createState() => _CheckDialogState();
}

class _CheckDialogState extends State<_CheckDialog> {
  final _amount = TextEditingController();

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final bankMinor = parseRupees(_amount.text, allowNegative: true);
    final matches = bankMinor == widget.expectedMinor;

    return AlertDialog(
      title: Text(widget.isCash ? 'Check against your wallet' : 'Check against your bank'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'SpendLog expects ${formatMoney(widget.expectedMinor)}.',
            style: TextStyle(fontSize: 15, height: 22 / 15, color: c.tx2),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _amount,
            autofocus: true,
            keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
            inputFormatters: [_signedAmount],
            onChanged: (_) => setState(() {}),
            style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w600),
            decoration: _amountDecoration(
              context,
              widget.isCash ? "What's in your wallet now" : 'What your bank shows now',
            ),
          ),
          if (bankMinor != null) ...[
            const SizedBox(height: 12),
            Text(
              describeBalanceCheck(expectedMinor: widget.expectedMinor, bankMinor: bankMinor),
              style: TextStyle(
                fontSize: 13,
                height: 18 / 13,
                fontWeight: FontWeight.w600,
                color: matches ? c.good : c.crit,
              ),
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(bankMinor != null && matches ? 'Done' : 'Close'),
        ),
        if (bankMinor != null && !matches)
          FilledButton(
            onPressed: () => Navigator.of(context).pop(bankMinor),
            child: Text('Use ${formatMoney(bankMinor)} as the new starting balance'),
          ),
      ],
    );
  }
}
