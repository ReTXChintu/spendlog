import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';

/// Add a loan, or change anything about one already added.
///
/// Unlike an EMI, there is no purchase to read a principal off - the money
/// most often never arrived as a transaction SpendLog has ever seen, so
/// everything here is typed in rather than taken from a debit already on
/// the ledger.
///
/// Shared by Settings and the dashboard, since the dashboard is where a
/// loan is actually seen. Pops `true` when something was saved, so the
/// caller knows to reload.
class LoanDialog extends StatefulWidget {
  /// null means "add a new one".
  final Loan? loan;

  const LoanDialog({super.key, this.loan});

  /// Opens the dialog and says whether anything changed.
  static Future<bool> show(BuildContext context, {Loan? loan}) async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => LoanDialog(loan: loan),
    );
    return saved == true;
  }

  @override
  State<LoanDialog> createState() => _LoanDialogState();
}

class _LoanDialogState extends State<LoanDialog> {
  late final Loan? _loan = widget.loan;

  late final _label = TextEditingController(text: _loan?.label ?? '');
  late final _principal = TextEditingController(
    text: _loan != null ? _rupees(_loan.principalMinor) : '',
  );
  late final _months = TextEditingController(text: _loan?.months.toString() ?? '12');
  late final _monthly = TextEditingController(
    text: _loan != null ? (_loan.monthlyAmountMinor / 100).toStringAsFixed(2) : '',
  );
  late final _rate = TextEditingController(text: _plainNumber(_loan?.interestRatePctAnnual));
  late final _paid = TextEditingController(text: _loan != null ? _loan.paidCount.toString() : '');

  /// A calendar date, with IST's fields. Only sent when it was changed.
  late final DateTime _originalStart = _dateOnly(
    _loan?.startDate != null ? istWallClock(_loan!.startDate!) : istWallClock(DateTime.now()),
  );
  late DateTime _startDate = _originalStart;

  bool _saving = false;
  String? _error;

  bool get _isNew => _loan == null;

  @override
  void dispose() {
    _label.dispose();
    _principal.dispose();
    _months.dispose();
    _monthly.dispose();
    _rate.dispose();
    _paid.dispose();
    super.dispose();
  }

  static DateTime _dateOnly(DateTime d) => DateTime(d.year, d.month, d.day);

  /// Whole rupees without a pointless ".00", paise when there are some.
  static String _rupees(int minor) =>
      minor % 100 == 0 ? (minor ~/ 100).toString() : (minor / 100).toStringAsFixed(2);

  /// 10.5 rather than 10.50, 12 rather than 12.0.
  static String _plainNumber(double? value) {
    if (value == null) return '';
    return value == value.roundToDouble() ? value.toInt().toString() : value.toString();
  }

  int _principalMinor() => ((double.tryParse(_principal.text.trim()) ?? 0) * 100).round();

  /// The reducing-balance formula the server uses, for the preview.
  int _computedMonthlyMinor() {
    final principalMinor = _principalMinor();
    final months = int.tryParse(_months.text.trim()) ?? 0;
    if (months <= 0) return 0;

    final annual = double.tryParse(_rate.text.trim());
    if (annual == null || annual <= 0) return (principalMinor / months).round();

    final r = annual / 12 / 100;
    final growth = math.pow(1 + r, months);
    return (principalMinor * r * growth / (growth - 1)).round();
  }

  int _monthlyMinor() {
    final typed = double.tryParse(_monthly.text.trim());
    return typed != null ? (typed * 100).round() : _computedMonthlyMinor();
  }

  Future<void> _pickStartDate() async {
    final today = _dateOnly(istWallClock(DateTime.now()));
    final picked = await showDatePicker(
      context: context,
      initialDate: _startDate,
      firstDate: DateTime(2000),
      // A little ahead, for a loan whose first instalment has not come round yet.
      lastDate: DateTime(today.year + 1, today.month, today.day),
    );
    if (picked != null) setState(() => _startDate = _dateOnly(picked));
  }

  /// Midnight UTC on the chosen day. The server steps the schedule forward
  /// month by month in UTC, so this keeps every due date on the day that
  /// was picked; IST midnight would be the evening before in UTC and a
  /// loan starting on the 1st would fall due on the last of each month.
  String _startDateIso() =>
      DateTime.utc(_startDate.year, _startDate.month, _startDate.day).toIso8601String();

  void _fail(String message) => setState(() {
        _error = message;
        _saving = false;
      });

  Future<void> _save() async {
    final label = _label.text.trim();
    if (label.isEmpty) {
      _fail("Give it a name — who it's from, or what it's for.");
      return;
    }

    final principalMinor = _principalMinor();
    final months = int.tryParse(_months.text.trim()) ?? 0;
    final monthlyMinor = _monthlyMinor();
    final rateText = _rate.text.trim();
    final rate = rateText.isEmpty ? null : double.tryParse(rateText);
    final paidText = _paid.text.trim();
    final paid = paidText.isEmpty ? 0 : int.tryParse(paidText);

    if (principalMinor <= 0) return _fail('Enter the amount borrowed.');
    if (months < 1 || months > 480) return _fail('The term needs to be between 1 and 480 months.');
    if (monthlyMinor <= 0) return _fail('The monthly amount needs to be more than zero.');
    if (rateText.isNotEmpty && (rate == null || rate < 0 || rate > 100)) {
      return _fail('The interest rate needs to be a number between 0 and 100.');
    }
    if (paid == null || paid < 0) return _fail('Instalments paid needs to be a whole number.');
    if (paid > months) {
      return _fail('A loan of $months ${months == 1 ? 'month' : 'months'} only has $months to pay.');
    }

    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);

    try {
      final loan = _loan;
      if (loan == null) {
        await ApiClient.instance.post('/loans', {
          'label': label,
          'principalMinor': principalMinor,
          'months': months,
          'monthlyAmountMinor': monthlyMinor,
          'interestRatePctAnnual': rate,
          'startDate': _startDateIso(),
          if (paid > 0) 'alreadyPaidCount': paid,
        });
      } else {
        // Only what changed. The server re-lays the schedule when the term,
        // start or monthly figure moves, and there is no reason to have it
        // do that because a name was corrected.
        final changes = <String, dynamic>{
          if (label != loan.label) 'label': label,
          if (principalMinor != loan.principalMinor) 'principalMinor': principalMinor,
          if (months != loan.months) 'months': months,
          if (monthlyMinor != loan.monthlyAmountMinor) 'monthlyAmountMinor': monthlyMinor,
          if (rate != loan.interestRatePctAnnual) 'interestRatePctAnnual': rate,
          if (_startDate != _originalStart) 'startDate': _startDateIso(),
          if (paid != loan.paidCount) 'paidCount': paid,
        };
        if (changes.isEmpty) {
          navigator.pop(false);
          return;
        }
        await ApiClient.instance.patch('/loans/${loan.id}', changes);
      }
      navigator.pop(true);
    } catch (error) {
      if (mounted) _fail(_explain(error));
    }
  }

  /// Close early, or reopen one that was.
  Future<void> _setStatus(String status) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      await ApiClient.instance.patch('/loans/${_loan!.id}', {'status': status});
      navigator.pop(true);
    } catch (error) {
      if (mounted) _fail(_explain(error));
    }
  }

  /// The server's own sentence when it wrote one for a person to read - "a
  /// shorter term would lose them" - rather than a generic failure.
  String _explain(Object error) {
    if (error is ApiException && error.message.isNotEmpty && !error.message.startsWith('{')) {
      return error.message;
    }
    return "Couldn't save that loan.";
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final loan = _loan;
    final computed = _computedMonthlyMinor();

    return AlertDialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      title: Text(_isNew ? 'Add a loan' : 'Edit loan'),
      content: SizedBox(
        width: double.maxFinite,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (loan != null) ...[
                Text(
                  '${loan.paidCount} of ${loan.months} paid, ${formatMoney(loan.remainingMinor)} left.'
                  '${loan.status == 'CLOSED' ? ' Closed.' : ''}',
                  style: TextStyle(fontSize: 12.5, height: 1.4, color: c.ink70),
                ),
                const SizedBox(height: 6),
              ],
              TextField(
                controller: _label,
                autofocus: _isNew,
                decoration: const InputDecoration(
                  labelText: "Who it's from, or what it's for",
                  hintText: 'HDFC personal loan',
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _principal,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Amount borrowed', prefixText: '₹ '),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _months,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Months', hintText: '24'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _monthly,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: InputDecoration(
                  labelText: 'Monthly repayment',
                  prefixText: '₹ ',
                  hintText: computed > 0 ? (computed / 100).toStringAsFixed(2) : null,
                ),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _rate,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Interest rate (% a year)', hintText: 'Optional'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: _paid,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: 'Instalments already paid',
                  hintText: '0',
                  helperText: _isNew
                      ? 'Already running before you added it? Say how many are paid.'
                      : 'All told, including any matched to a payment on the ledger.',
                  helperMaxLines: 3,
                ),
              ),
              const SizedBox(height: 6),
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('First instalment'),
                // Already IST's calendar date, so formatted as it stands
                // rather than shifted again by formatShortDate.
                subtitle: Text(DateFormat('d MMM yyyy').format(_startDate)),
                trailing: const Icon(Icons.calendar_today_outlined, size: 18),
                onTap: _pickStartDate,
              ),
              Text(
                _isNew
                    ? 'Take the monthly figure off the paperwork if you can — a calculated one rarely '
                        "lands to the rupee once the lender's own rounding is in it."
                    : 'A new term, start or monthly figure re-lays the schedule. Anything already paid '
                        'stays paid.',
                style: TextStyle(fontSize: 11.5, height: 1.4, color: c.mutedLight),
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(_error!, style: TextStyle(fontSize: 12, height: 1.4, color: c.debit)),
              ],
            ],
          ),
        ),
      ),
      actions: [
        if (loan != null && loan.status == 'ACTIVE')
          TextButton(
            onPressed: _saving ? null : () => _setStatus('CLOSED'),
            child: const Text('Close early'),
          ),
        if (loan != null && loan.status == 'CLOSED')
          TextButton(
            onPressed: _saving ? null : () => _setStatus('ACTIVE'),
            child: const Text('Reopen'),
          ),
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_isNew ? 'Add' : 'Save'),
        ),
      ],
    );
  }
}
