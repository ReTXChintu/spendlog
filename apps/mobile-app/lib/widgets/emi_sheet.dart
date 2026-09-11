import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';

const _terms = [3, 6, 9, 12, 18, 24];

/// Turns a purchase into an EMI plan.
///
/// The months and the amount billed are what the statement will show; the
/// rate is only a way to arrive at an amount when the statement isn't to
/// hand, so anything typed into the amount field stands.
Future<bool?> showEmiSheet(BuildContext context, {required Transaction transaction}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: _EmiSheet(transaction: transaction),
    ),
  );
}

class _EmiSheet extends StatefulWidget {
  final Transaction transaction;
  const _EmiSheet({required this.transaction});

  @override
  State<_EmiSheet> createState() => _EmiSheetState();
}

class _EmiSheetState extends State<_EmiSheet> {
  final _monthly = TextEditingController();
  final _rate = TextEditingController();
  final _fee = TextEditingController();

  int _months = 12;
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _monthly.dispose();
    _rate.dispose();
    _fee.dispose();
    super.dispose();
  }

  /// The same reducing-balance formula the server uses, for the preview.
  int get _computedMonthlyMinor {
    final annual = double.tryParse(_rate.text.trim()) ?? 0;
    if (annual <= 0) return (widget.transaction.amountMinor / _months).round();

    final r = annual / 12 / 100;
    final growth = math.pow(1 + r, _months).toDouble();
    return (widget.transaction.amountMinor * r * growth / (growth - 1)).round();
  }

  int get _monthlyMinor {
    final typed = double.tryParse(_monthly.text.trim());
    if (typed != null && typed > 0) return (typed * 100).round();
    return _computedMonthlyMinor;
  }

  Future<void> _save() async {
    if (_monthlyMinor <= 0) {
      setState(() => _error = 'The monthly amount needs to be more than zero.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    final feeRupees = double.tryParse(_fee.text.trim());
    try {
      await ApiClient.instance.post('/emi/from/${widget.transaction.id}', {
        'months': _months,
        'monthlyAmountMinor': _monthlyMinor,
        'interestRatePctAnnual':
            _rate.text.trim().isEmpty ? null : double.tryParse(_rate.text.trim()),
        'processingFeeMinor': feeRupees == null ? null : (feeRupees * 100).round(),
      });
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't set up that EMI.";
        _saving = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final total = _monthlyMinor * _months;
    final extra = math.max(0, total - widget.transaction.amountMinor);

    return SafeArea(
      child: SingleChildScrollView(
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
              'Convert to EMI',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink),
            ),
            const SizedBox(height: 4),
            Text(
              '${widget.transaction.merchant ?? 'This purchase'} · '
              '${formatMoney(widget.transaction.amountMinor)}',
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
            const SizedBox(height: 18),

            Text('Months', style: _label(c)),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final term in _terms)
                  GestureDetector(
                    onTap: () => setState(() => _months = term),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                      decoration: BoxDecoration(
                        color: _months == term ? c.brand50 : c.surface,
                        border: Border.all(color: _months == term ? c.brand : c.lineStrong),
                        borderRadius: BorderRadius.circular(100),
                      ),
                      child: Text(
                        '$term',
                        style: TextStyle(
                          fontSize: 12.5,
                          fontWeight: FontWeight.w700,
                          color: _months == term ? c.brandDark : c.ink70,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 16),

            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _SheetField(
                    label: 'Monthly amount',
                    child: TextField(
                      controller: _monthly,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      style: kNum.copyWith(fontWeight: FontWeight.w700, color: c.ink),
                      decoration: _decoration(
                        c,
                        hint: (_computedMonthlyMinor / 100).toStringAsFixed(2),
                        prefix: '₹ ',
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _SheetField(
                    label: 'Rate (% a year)',
                    child: TextField(
                      controller: _rate,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      onChanged: (_) => setState(() {}),
                      style: TextStyle(color: c.ink),
                      decoration: _decoration(c, hint: '14'),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),

            _SheetField(
              label: 'Processing fee',
              child: TextField(
                controller: _fee,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                style: TextStyle(color: c.ink),
                decoration: _decoration(c, hint: 'Optional', prefix: '₹ '),
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'Take the monthly amount off your statement if you can — card EMIs are quoted flat with '
              'GST on the interest, so a calculated figure usually lands a few rupees out.',
              style: TextStyle(fontSize: 11.8, height: 1.45, color: c.mutedLight),
            ),
            const SizedBox(height: 16),

            Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              decoration: BoxDecoration(color: c.brand50, borderRadius: BorderRadius.circular(T.rMd)),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _Preview(label: 'Each month', value: formatMoney(_monthlyMinor)),
                  _Preview(label: 'Total', value: formatMoneyShort(total)),
                  _Preview(label: 'Extra', value: formatMoneyShort(extra)),
                ],
              ),
            ),
            const SizedBox(height: 12),
            Text(
              "The purchase stops counting as this month's spending. Each payment counts instead, as "
              'it is billed.',
              style: TextStyle(fontSize: 11.8, height: 1.45, color: c.muted),
            ),

            if (_error != null) ...[
              const SizedBox(height: 14),
              Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
            ],

            const SizedBox(height: 18),
            Row(
              children: [
                const Spacer(),
                TextButton(
                  onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: Text(_saving ? 'Saving…' : 'Set up EMI'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

TextStyle _label(SpendColors c) =>
    TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.muted);

InputDecoration _decoration(SpendColors c, {String? hint, String? prefix}) => InputDecoration(
      hintText: hint,
      prefixText: prefix,
      hintStyle: TextStyle(color: c.mutedLight, fontSize: 13),
      isDense: true,
      filled: true,
      fillColor: c.surface,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(T.rSm),
        borderSide: BorderSide(color: c.lineStrong),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(T.rSm),
        borderSide: BorderSide(color: c.brand),
      ),
    );

class _SheetField extends StatelessWidget {
  final String label;
  final Widget child;

  const _SheetField({required this.label, required this.child});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: _label(context.c)),
        const SizedBox(height: 6),
        child,
      ],
    );
  }
}

class _Preview extends StatelessWidget {
  final String label;
  final String value;

  const _Preview({required this.label, required this.value});

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
