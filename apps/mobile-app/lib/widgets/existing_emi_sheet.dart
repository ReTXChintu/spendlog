import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import 'ds/ds.dart';

final _amount = FilteringTextInputFormatter.allow(RegExp(r'^[\d,]*\.?\d{0,2}'));

/// The same calendar date `months` later, clamped to the end of a shorter
/// month - as the server lays a schedule out.
DateTime addCalendarMonths(DateTime date, int months) {
  final first = DateTime(date.year, date.month + months, 1);
  final lastDay = DateTime(first.year, first.month + 1, 0).day;
  return DateTime(first.year, first.month, date.day > lastDay ? lastDay : date.day);
}

/// Adds an EMI that began before SpendLog was tracking, so its purchase was
/// never seen. Pops `true` once one was saved.
///
/// [accountId] picks the card in advance - opened from a card's own page.
/// [accounts] can be handed in; otherwise the cards and bank accounts are
/// loaded here.
Future<bool> showExistingEmiSheet(BuildContext context, {String? accountId, List<Account>? accounts}) async {
  final saved = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: ExistingEmiSheet(accountId: accountId, accounts: accounts),
    ),
  );
  return saved == true;
}

class ExistingEmiSheet extends StatefulWidget {
  const ExistingEmiSheet({super.key, this.accountId, this.accounts, this.today});

  final String? accountId;
  final List<Account>? accounts;

  /// The day it is, as a calendar date. Tests pin it.
  final DateTime? today;

  @override
  State<ExistingEmiSheet> createState() => _ExistingEmiSheetState();
}

class _ExistingEmiSheetState extends State<ExistingEmiSheet> {
  final _label = TextEditingController();
  final _monthly = TextEditingController();
  final _months = TextEditingController(text: '12');
  final _principal = TextEditingController();
  final _rate = TextEditingController();

  List<Account>? _accounts;
  String? _accountId;
  int _paid = 0;
  late DateTime _nextDue;
  bool _saving = false;
  bool _loadFailed = false;
  String? _error;

  DateTime get _today {
    final now = widget.today ?? istWallClock(DateTime.now());
    return DateTime(now.year, now.month, now.day);
  }

  @override
  void initState() {
    super.initState();
    // The commonest case: due again on today's day, next month.
    _nextDue = addCalendarMonths(_today, 1);
    _accountId = widget.accountId;
    if (widget.accounts != null) {
      _accounts = _eligible(widget.accounts!);
    } else {
      _loadAccounts();
    }
    for (final field in [_monthly, _months]) {
      field.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    for (final field in [_label, _monthly, _months, _principal, _rate]) {
      field.dispose();
    }
    super.dispose();
  }

  /// An EMI is billed to a credit card or taken from a bank account.
  List<Account> _eligible(List<Account> all) => all
      .where((a) => a.isActive && (a.accountType == 'CARD' || a.accountType == 'BANK'))
      .toList()
    ..sort((a, b) => (a.accountType == 'CARD' ? 0 : 1).compareTo(b.accountType == 'CARD' ? 0 : 1));

  Future<void> _loadAccounts() async {
    try {
      final rows = await ApiClient.instance.get('/accounts') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _accounts = _eligible(rows.map((row) => Account.fromJson(row as Map<String, dynamic>)).toList());
        _accountId ??= _accounts!.isEmpty ? null : _accounts!.first.id;
      });
    } catch (_) {
      if (mounted) setState(() => _loadFailed = true);
    }
  }

  int? get _monthsValue {
    final value = int.tryParse(_months.text.trim());
    return value == null || value < 1 || value > 120 ? null : value;
  }

  Future<void> _pickNextDue() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _nextDue,
      firstDate: _today.subtract(const Duration(days: 60)),
      lastDate: _today.add(const Duration(days: 395)),
      helpText: 'Next instalment due',
    );
    if (picked != null) setState(() => _nextDue = picked);
  }

  /// "7 left · ₹37,100 to go · ends Apr 2027", from what is typed so far.
  String? get _summary {
    final months = _monthsValue;
    final monthly = parseRupees(_monthly.text);
    if (months == null || monthly == null || monthly <= 0 || _paid >= months) return null;
    final left = months - _paid;
    final ends = addCalendarMonths(_nextDue, left - 1);
    return '$left left · ${formatMoneyShort(monthly * left)} to go · ends ${DateFormat('MMM y').format(ends)}';
  }

  Future<void> _save({bool force = false}) async {
    final months = _monthsValue;
    final monthly = parseRupees(_monthly.text);
    final principal = _principal.text.trim().isEmpty ? null : parseRupees(_principal.text);
    final rate = _rate.text.trim().isEmpty ? null : double.tryParse(_rate.text.trim());

    String? problem;
    if (_accountId == null) {
      problem = 'Pick the card or account it is billed to.';
    } else if (_label.text.trim().isEmpty) {
      problem = 'Say what the EMI is for.';
    } else if (monthly == null || monthly <= 0) {
      problem = 'Type the monthly amount as a number.';
    } else if (months == null) {
      problem = 'The term is a number of months, from 1 to 120.';
    } else if (_paid >= months) {
      problem = 'At least one instalment has to be left to pay.';
    } else if (_principal.text.trim().isNotEmpty && (principal == null || principal <= 0)) {
      problem = 'Type the amount borrowed as a number, or leave it empty.';
    } else if (_rate.text.trim().isNotEmpty && (rate == null || rate < 0 || rate > 100)) {
      problem = 'The interest rate is a yearly percentage, or leave it empty.';
    }
    if (problem != null) return setState(() => _error = problem);

    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await ApiClient.instance.post('/emi', {
        'accountId': _accountId,
        'label': _label.text.trim(),
        'months': months,
        'monthlyAmountMinor': monthly,
        'paidCount': _paid,
        // Midday in India is the same calendar day in UTC, so the day the
        // schedule is laid out on is the day picked.
        'nextDueDate': DateTime.utc(_nextDue.year, _nextDue.month, _nextDue.day, 6, 30).toIso8601String(),
        if (principal != null) 'principalMinor': principal,
        if (rate != null) 'interestRatePctAnnual': rate,
        if (force) 'force': true,
      });
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (error) {
      if (!mounted) return;
      setState(() => _saving = false);
      final body = error.body;
      if (error.statusCode == 409 && body is Map && body['code'] == 'duplicate') {
        final again = await showDialog<bool>(
          context: context,
          builder: (context) => AlertDialog(
            title: const Text('Already added?'),
            content: Text(error.message),
            actions: [
              TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
              FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Add anyway')),
            ],
          ),
        );
        if (again == true) await _save(force: true);
        return;
      }
      setState(() => _error = error.message);
    } catch (_) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = "Couldn't save it. Try again in a moment.";
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final months = _monthsValue;
    final maxPaid = months == null ? 0 : months - 1;
    if (_paid > maxPaid) _paid = maxPaid;
    final summary = _summary;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Add an EMI you already have',
            style: TextStyle(fontSize: 18, height: 24 / 18, fontWeight: FontWeight.w600, color: c.tx),
          ),
          const SizedBox(height: 4),
          Text(
            'For one that began before SpendLog, so its purchase was never seen. The months already paid are '
            'marked paid; payments from here on are matched as they arrive.',
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
          ),
          const SizedBox(height: 16),
          if (_accounts == null && !_loadFailed)
            const Padding(padding: EdgeInsets.all(8), child: Center(child: DsSpinner()))
          else if (_loadFailed)
            Text("Couldn't load your cards and accounts.", style: TextStyle(fontSize: 13, color: c.crit))
          else if (_accounts!.isEmpty)
            Text('Add the card or bank account first, from Accounts.', style: TextStyle(fontSize: 13, color: c.tx2))
          else
            DropdownButtonFormField<String>(
              key: const ValueKey('emi-account'),
              initialValue: _accounts!.any((a) => a.id == _accountId) ? _accountId : null,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'Billed to'),
              items: [
                for (final account in _accounts!)
                  DropdownMenuItem(
                    value: account.id,
                    child: Text(
                      '${account.label}${account.accountType == 'CARD' ? ' · credit card' : ' · bank account'}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: (value) => setState(() => _accountId = value),
            ),
          const SizedBox(height: 12),
          TextField(
            key: const ValueKey('emi-label'),
            controller: _label,
            textCapitalization: TextCapitalization.sentences,
            maxLength: 80,
            decoration: const InputDecoration(labelText: "What it's for", hintText: 'iPhone 16', counterText: ''),
          ),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                flex: 3,
                child: TextField(
                  key: const ValueKey('emi-monthly'),
                  controller: _monthly,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: [_amount],
                  style: kNum.copyWith(fontSize: 16, fontWeight: FontWeight.w600),
                  decoration: const InputDecoration(labelText: 'Each month', prefixText: '₹ ', hintText: '0.00'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                flex: 2,
                child: TextField(
                  key: const ValueKey('emi-months'),
                  controller: _months,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  style: kNum.copyWith(fontSize: 16, fontWeight: FontWeight.w600),
                  decoration: const InputDecoration(labelText: 'Months in all'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Already paid', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: c.tx)),
                    Text(
                      months == null ? 'Set the months first' : '$_paid of $months',
                      style: kNum.copyWith(fontSize: 12, color: c.tx3),
                    ),
                  ],
                ),
              ),
              IconButton.outlined(
                key: const ValueKey('emi-paid-less'),
                tooltip: 'One fewer paid',
                onPressed: _paid > 0 ? () => setState(() => _paid -= 1) : null,
                icon: const Icon(Icons.remove, size: 18),
              ),
              SizedBox(
                width: 44,
                child: Text(
                  '$_paid',
                  key: const ValueKey('emi-paid-count'),
                  textAlign: TextAlign.center,
                  style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              IconButton.outlined(
                key: const ValueKey('emi-paid-more'),
                tooltip: 'One more paid',
                onPressed: _paid < maxPaid ? () => setState(() => _paid += 1) : null,
                icon: const Icon(Icons.add, size: 18),
              ),
            ],
          ),
          const SizedBox(height: 8),
          ListTile(
            key: const ValueKey('emi-next-due'),
            contentPadding: EdgeInsets.zero,
            title: Text('Next instalment due', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: c.tx)),
            subtitle: Text(DateFormat('EEE, d MMM y').format(_nextDue), style: kNum.copyWith(fontSize: 13, color: c.tx2)),
            trailing: TextButton(onPressed: _pickNextDue, child: const Text('Change')),
            onTap: _pickNextDue,
          ),
          Theme(
            data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
            child: ExpansionTile(
              tilePadding: EdgeInsets.zero,
              childrenPadding: EdgeInsets.zero,
              title: Text('More details', style: TextStyle(fontSize: 14, color: c.tx2)),
              subtitle: Text('Optional: amount borrowed, interest rate', style: TextStyle(fontSize: 12, color: c.tx3)),
              children: [
                TextField(
                  key: const ValueKey('emi-principal'),
                  controller: _principal,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: [_amount],
                  decoration: const InputDecoration(labelText: 'Amount borrowed', prefixText: '₹ '),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('emi-rate'),
                  controller: _rate,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  decoration: const InputDecoration(labelText: 'Interest rate', suffixText: '% a year'),
                ),
                const SizedBox(height: 8),
              ],
            ),
          ),
          if (summary != null) ...[
            const SizedBox(height: 4),
            Container(
              key: const ValueKey('emi-summary'),
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(color: c.sunk, borderRadius: BorderRadius.circular(Ds.rMd)),
              child: Text(summary, style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx)),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.crit)),
          ],
          const SizedBox(height: 16),
          FilledButton(
            key: const ValueKey('emi-save'),
            onPressed: _saving || (_accounts?.isEmpty ?? true) ? null : () => _save(),
            child: Text(_saving ? 'Adding…' : 'Add EMI'),
          ),
        ],
      ),
    );
  }
}
