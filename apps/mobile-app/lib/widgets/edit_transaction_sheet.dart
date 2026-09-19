import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import 'emi_sheet.dart';
import 'refund_sheet.dart';

/// Full manual edit, and the same form used to add a transaction by hand.
///
/// Parsing gets most of a message right but not all of it, and a wrong
/// amount or direction is worse than none — so every field is editable,
/// including creating a row no message ever produced (cash).
Future<bool?> showEditTransactionSheet(
  BuildContext context, {
  /// null means "create a new one".
  Transaction? transaction,
  required List<Category> categories,
  required List<Account> accounts,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: _EditSheet(
        transaction: transaction,
        categories: categories,
        accounts: accounts,
      ),
    ),
  );
}

class _EditSheet extends StatefulWidget {
  final Transaction? transaction;
  final List<Category> categories;
  final List<Account> accounts;

  const _EditSheet({
    required this.transaction,
    required this.categories,
    required this.accounts,
  });

  @override
  State<_EditSheet> createState() => _EditSheetState();
}

class _EditSheetState extends State<_EditSheet> {
  late final TextEditingController _amount;
  late final TextEditingController _merchant;
  late final TextEditingController _note;

  late String _type;
  String? _categoryId;
  String? _accountId;
  late DateTime _occurredAt;
  late bool _isTransfer;
  late bool _isSpecial;
  late bool _isSalary;
  String? _cardPaymentFor;
  String? _commitmentId;
  String? _loanId;

  /// Fetched here rather than threaded through as a prop, because this
  /// sheet opens from several places and only one of them would have
  /// had them to hand.
  List<FixedCommitment> _commitments = [];
  List<Loan> _loans = [];
  late bool _isSplit;
  late bool _isSettlement;
  /// On a trip, an expense is everyone's unless it says otherwise. The only
  /// narrowing worth a control is "this one was just mine".
  late bool _tripJustMine;
  late final TextEditingController _myShare;
  late final TextEditingController _groupLabel;

  List<MerchantPreset> _presets = [];
  List<CardStatus> _cards = [];

  bool _saving = false;
  bool _confirmDelete = false;
  String? _error;

  bool get _isNew => widget.transaction == null;

  /// The card this is going on, when it is near or past its own limit.
  CardStatus? get _cardWarning {
    if (_accountId == null) return null;
    for (final card in _cards) {
      if (card.accountId == _accountId && (card.state == 'over' || card.state == 'close')) {
        return card;
      }
    }
    return null;
  }

  /// Says what the split will do, in the same terms the balance uses - but
  /// the terms flip with the direction: on a payment the rest is owed back
  /// to the user, on a credit the rest was already theirs and is not new
  /// income.
  String get _owedHint {
    final total = ((double.tryParse(_amount.text.trim()) ?? 0) * 100).round();
    final share = ((double.tryParse(_myShare.text.trim()) ?? 0) * 100).round();
    final notMine = total - share;

    if (_type == 'DEBIT') {
      if (notMine <= 0) return 'All of it counts as your own spending.';
      return '${formatMoney(notMine)} counts as owed back to you, not as spending.';
    }
    if (notMine <= 0) return 'All of it counts as income.';
    return "${formatMoney(notMine)} doesn't count as income - it's money coming back to you.";
  }

  @override
  void initState() {
    super.initState();
    final t = widget.transaction;
    _amount = TextEditingController(
      text: t == null ? '' : (t.amountMinor / 100).toStringAsFixed(2),
    );
    _merchant = TextEditingController(text: t?.merchant ?? '');
    _note = TextEditingController(text: t?.note ?? '');
    _type = t?.type ?? 'DEBIT';
    _categoryId = t?.category?.id;
    _accountId = t?.account?.id;
    // Held as IST wall-clock while the pickers are open: choosing
    // "11 Sep, 7:21pm" must mean that in India whatever the phone's clock
    // is set to. Converted back to a real instant on save.
    _occurredAt = istWallClock(t?.occurredAt ?? DateTime.now());
    _isTransfer = t?.isTransfer ?? false;
    _isSpecial = t?.isSpecial ?? false;
    _isSalary = t?.isSalary ?? false;
    _cardPaymentFor = t?.cardPaymentFor;
    _commitmentId = t?.commitmentId;
    _loanId = t?.loanId;

    _loadCommitments();
    _loadLoans();
    _isSplit = t?.split != null;
    _isSettlement = t?.isSettlement ?? false;
    _tripJustMine = (t?.tripShareWith?.isNotEmpty ?? false);
    _loadPresets();
    _loadCards();
    _myShare = TextEditingController(
      text: t?.split != null ? (t!.split!.myShareMinor / 100).toStringAsFixed(2) : '',
    );
    _groupLabel = TextEditingController(text: t?.split?.groupLabel ?? '');
  }

  Future<void> _loadCards() async {
    try {
      final result = await ApiClient.instance.get('/cards') as List<dynamic>;
      if (!mounted) return;
      setState(() =>
          _cards = result.map((c) => CardStatus.fromJson(c as Map<String, dynamic>)).toList());
    } catch (_) {
      // Advisory only.
    }
  }

  Future<void> _loadPresets() async {
    try {
      final result = await ApiClient.instance.get('/merchant-presets') as List<dynamic>;
      if (!mounted) return;
      setState(() => _presets =
          result.map((p) => MerchantPreset.fromJson(p as Map<String, dynamic>)).toList());
    } catch (_) {
      // The form works without shortcuts.
    }
  }

  /// Fills the name and its usual category in one go.
  void _applyPreset(MerchantPreset preset) {
    setState(() {
      _merchant.text = preset.merchant;
      if (preset.categoryId != null) _categoryId = preset.categoryId;
    });
    // Ordering only: a shortcut must not wait on a round trip.
    ApiClient.instance.post('/merchant-presets/${preset.id}/used').catchError((_) => null);
  }

  Future<void> _savePreset() async {
    final name = _merchant.text.trim();
    if (name.isEmpty) return;
    try {
      await ApiClient.instance
          .post('/merchant-presets', {'merchant': name, 'categoryId': _categoryId});
      await _loadPresets();
    } catch (_) {
      // A shortcut that failed to save is not worth interrupting the edit.
    }
  }

  void _removePreset(MerchantPreset preset) {
    setState(() => _presets = _presets.where((p) => p.id != preset.id).toList());
    ApiClient.instance.delete('/merchant-presets/${preset.id}').catchError((_) => null);
  }

  @override
  void dispose() {
    _amount.dispose();
    _merchant.dispose();
    _note.dispose();
    _myShare.dispose();
    _groupLabel.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _occurredAt,
      firstDate: DateTime(2000),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked == null) return;
    setState(() => _occurredAt = DateTime(
          picked.year,
          picked.month,
          picked.day,
          _occurredAt.hour,
          _occurredAt.minute,
        ));
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_occurredAt),
    );
    if (picked == null) return;
    setState(() => _occurredAt = DateTime(
          _occurredAt.year,
          _occurredAt.month,
          _occurredAt.day,
          picked.hour,
          picked.minute,
        ));
  }

  Future<void> _save() async {
    final rupees = double.tryParse(_amount.text.trim());
    if (rupees == null || rupees <= 0) {
      setState(() => _error = 'Enter an amount greater than zero.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    final body = <String, dynamic>{
      'amountMinor': (rupees * 100).round(),
      'type': _type,
      'merchant': _merchant.text.trim().isEmpty ? null : _merchant.text.trim(),
      'note': _note.text.trim().isEmpty ? null : _note.text.trim(),
      'categoryId': _categoryId,
      'accountId': _accountId,
      'occurredAt': fromIstWallClock(_occurredAt).toIso8601String(),
      'isTransfer': _isTransfer,
      'isSpecial': _type == 'DEBIT' && _isSpecial,
      'isSalary': _type == 'CREDIT' && _isSalary,
      'cardPaymentFor': _type == 'DEBIT' ? _cardPaymentFor : null,
      'commitmentId': _type == 'DEBIT' ? _commitmentId : null,
      'loanId': _type == 'DEBIT' ? _loanId : null,
      'isSettlement': _isSettlement,
      // Narrowed to the payer alone, or widened back to everyone on the trip.
      if (widget.transaction?.tripId != null)
        'tripShareWith': _tripJustMine ? [widget.transaction!.userId] : null,
      'split': _isSplit
          ? {
              'myShareMinor': ((double.tryParse(_myShare.text.trim()) ?? 0) * 100).round(),
              'groupLabel': _groupLabel.text.trim().isEmpty ? null : _groupLabel.text.trim(),
            }
          : null,
    };

    try {
      if (_isNew) {
        await ApiClient.instance.post('/transactions', {...body, 'currency': 'INR'});
      } else {
        await ApiClient.instance.patch('/transactions/${widget.transaction!.id}', body);
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _error = "Couldn't save that change.";
        _saving = false;
      });
    }
  }

  /// More than one message means the row was merged, automatically or by
  /// hand — and either can be wrong, so both can be taken apart.
  Future<void> _unmerge() async {
    setState(() => _saving = true);
    try {
      await ApiClient.instance.post('/transactions/${widget.transaction!.id}/unmerge');
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't split it apart.";
        _saving = false;
      });
    }
  }

  Future<void> _delete() async {
    setState(() => _saving = true);
    try {
      await ApiClient.instance.delete('/transactions/${widget.transaction!.id}');
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _error = "Couldn't delete it.";
        _saving = false;
      });
    }
  }

  /// Changing direction has to drop anything the new one cannot mean, or
  /// a category picked as spending stays attached to something that is now
  /// income and quietly lands in the wrong total.
  void _setType(String type) {
    setState(() {
      _type = type;

      final stillValid = categoriesFor(widget.categories, type)
          .any((category) => category.id == _categoryId);
      if (!stillValid) _categoryId = null;

      if (type == 'CREDIT') {
        _isSplit = false;
        _tripJustMine = false;
        _cardPaymentFor = null;
        _commitmentId = null;
        _loanId = null;
      } else {
        _isSalary = false;
      }
    });
  }

  /// Picking a fixed cost fills in what it is always paid to and always
  /// counts as. A fixed cost is the same merchant and the same category
  /// every month, so typing them again is typing them again.
  ///
  /// Only fills what is empty: a merchant read off a bank message is
  /// better evidence than a default recorded weeks ago.
  void _pickCommitment(String? id) {
    setState(() {
      _commitmentId = id;
      if (id == null) return;

      final picked = _commitments.where((commitment) => commitment.id == id).firstOrNull;
      if (picked == null) return;

      if (_merchant.text.trim().isEmpty && picked.merchant != null) {
        _merchant.text = picked.merchant!;
      }
      _categoryId ??= picked.categoryId;
    });
  }

  Future<void> _loadCommitments() async {
    try {
      final result = await ApiClient.instance.get('/budget/commitments') as List<dynamic>;
      if (!mounted) return;
      setState(() => _commitments =
          result.map((c) => FixedCommitment.fromJson(c as Map<String, dynamic>)).toList());
    } catch (_) {
      // The picker simply does not appear.
    }
  }

  /// A loan has no purchase to keep out of the totals the way an EMI's
  /// does, so picking one here never changes what the payment counts as -
  /// only which schedule it closes an instalment off on.
  ///
  /// Active loans, plus whichever this payment already claims - a closed
  /// loan should not vanish from its own dropdown.
  Future<void> _loadLoans() async {
    try {
      final result = await ApiClient.instance.get('/loans') as List<dynamic>;
      if (!mounted) return;
      final all = result.map((l) => Loan.fromJson(l as Map<String, dynamic>)).toList();
      setState(
        () => _loans = all.where((loan) => loan.status == 'ACTIVE' || loan.id == _loanId).toList(),
      );
    } catch (_) {
      // The picker simply does not appear.
    }
  }

  List<Account> get _cardAccounts =>
      widget.accounts.where((account) => account.accountType == 'CARD').toList();

  @override
  Widget build(BuildContext context) {
    final c = context.c;

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
                decoration: BoxDecoration(
                  color: c.lineStrong,
                  borderRadius: BorderRadius.circular(100),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Text(
              _isNew ? 'Add a transaction' : 'Edit transaction',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink),
            ),
            const SizedBox(height: 4),
            Text(
              _isNew
                  ? 'For cash, or anything no message covered.'
                  : 'Change anything the automatic import got wrong.',
              style: TextStyle(fontSize: 12.5, color: c.muted),
            ),
            const SizedBox(height: 18),

            _Field(
              label: 'Amount',
              child: TextField(
                controller: _amount,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                style: kNum.copyWith(fontWeight: FontWeight.w700, color: c.ink),
                decoration: _inputDecoration(context, prefix: '₹ ', hint: '0.00'),
              ),
            ),

            _Field(
              label: 'Direction',
              child: Row(
                children: [
                  _Segment(
                    label: 'Money out',
                    on: _type == 'DEBIT',
                    onTap: () => _setType('DEBIT'),
                  ),
                  const SizedBox(width: 8),
                  _Segment(
                    label: 'Money in',
                    on: _type == 'CREDIT',
                    onTap: () => _setType('CREDIT'),
                  ),
                ],
              ),
            ),

            _Field(
              label: 'Merchant',
              child: TextField(
                controller: _merchant,
                onChanged: (_) => setState(() {}),
                style: TextStyle(color: c.ink),
                decoration: _inputDecoration(context, hint: 'Who was paid'),
              ),
            ),

            // Shortcuts, small and quiet: a convenience rather than the
            // main way to fill the form in.
            if (_presets.isNotEmpty || _merchant.text.trim().isNotEmpty) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  for (final preset in _presets)
                    _PresetChip(
                      preset: preset,
                      isCurrent:
                          preset.merchant.toLowerCase() == _merchant.text.trim().toLowerCase(),
                      onTap: () => _applyPreset(preset),
                      onRemove: () => _removePreset(preset),
                    ),
                  if (_merchant.text.trim().isNotEmpty &&
                      !_presets.any((p) =>
                          p.merchant.toLowerCase() == _merchant.text.trim().toLowerCase()))
                    GestureDetector(
                      onTap: _savePreset,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
                        child: Text(
                          'Save as a shortcut',
                          style: TextStyle(
                            fontSize: 11.5,
                            color: c.brand,
                            decoration: TextDecoration.underline,
                            decorationColor: c.brand,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ],

            _Field(
              label: 'When',
              child: Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _pickDate,
                      child: Text(
                        '${_occurredAt.day.toString().padLeft(2, '0')}/'
                        '${_occurredAt.month.toString().padLeft(2, '0')}/${_occurredAt.year}',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: OutlinedButton(
                      onPressed: _pickTime,
                      child: Text(TimeOfDay.fromDateTime(_occurredAt).format(context)),
                    ),
                  ),
                ],
              ),
            ),

            _Field(
              label: 'Category',
              child: DropdownButtonFormField<String?>(
                initialValue: _categoryId,
                isExpanded: true,
                decoration: _inputDecoration(context),
                dropdownColor: c.surface,
                style: TextStyle(fontSize: 14, color: c.ink),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('Uncategorized')),
                  ...categoriesFor(widget.categories, _type).map(
                    (category) => DropdownMenuItem<String?>(
                      value: category.id,
                      child: Text(category.name),
                    ),
                  ),
                ],
                onChanged: (value) => setState(() => _categoryId = value),
              ),
            ),

            _Field(
              label: 'Account',
              child: DropdownButtonFormField<String?>(
                initialValue: _accountId,
                isExpanded: true,
                decoration: _inputDecoration(context),
                dropdownColor: c.surface,
                style: TextStyle(fontSize: 14, color: c.ink),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('Not set')),
                  ...widget.accounts.map(
                    (account) => DropdownMenuItem<String?>(
                      value: account.id,
                      child: Text(
                        account.label,
                      ),
                    ),
                  ),
                ],
                onChanged: (value) => setState(() => _accountId = value),
              ),
            ),

            _Field(
              label: 'Note',
              child: TextField(
                controller: _note,
                style: TextStyle(color: c.ink),
                decoration: _inputDecoration(context, hint: 'Optional'),
              ),
            ),

            if (_cardWarning != null) ...[
              const SizedBox(height: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                decoration: BoxDecoration(
                  color: _cardWarning!.state == 'over' ? c.debit50 : c.warnBg,
                  borderRadius: BorderRadius.circular(T.rMd),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      Icons.error_outline,
                      size: 15,
                      color: _cardWarning!.state == 'over' ? c.debit : c.warn,
                    ),
                    const SizedBox(width: 9),
                    Expanded(
                      child: Text(
                        _cardWarning!.state == 'over'
                            ? '${_cardWarning!.name} is already past its limit for this billing '
                                'cycle.'
                            : '${_cardWarning!.name} has '
                                '${formatMoney(_cardWarning!.remainingMinor ?? 0)} left of its '
                                'limit this cycle.',
                        style: TextStyle(
                          fontSize: 12.5,
                          height: 1.45,
                          color: _cardWarning!.state == 'over' ? c.debit : c.warn,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
            ],

            CheckboxListTile(
              value: _isTransfer,
              onChanged: (value) => setState(() => _isTransfer = value ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              title: Text(
                'Between my own accounts — keep it out of totals',
                style: TextStyle(fontSize: 12.8, color: c.ink70),
              ),
            ),

            // Real spending, counted everywhere - but a day is not a bad
            // day for having had a laptop in it.
            if (_type == 'DEBIT')
              CheckboxListTile(
                value: _isSpecial,
                onChanged: (value) => setState(() => _isSpecial = value ?? false),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                dense: true,
                title: Text(
                  'A one-off — keep it out of the daily budget only',
                  style: TextStyle(fontSize: 12.8, color: c.ink70),
                ),
              ),

            // A bill payment usually produces one message, from the bank
            // being debited, with nothing on the card side to pair it with
            // - so the automatic transfer detection can never find it.
            if (_type == 'DEBIT' && _cardAccounts.isNotEmpty) ...[
              const SizedBox(height: 4),
              DropdownButtonFormField<String?>(
                initialValue: _cardPaymentFor,
                isExpanded: true,
                decoration: const InputDecoration(
                  labelText: 'Paid a credit card bill?',
                  helperText: 'Counts as nothing - the purchases on that card were already counted.',
                  helperMaxLines: 3,
                  isDense: true,
                ),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('No - ordinary spending')),
                  for (final card in _cardAccounts)
                    DropdownMenuItem<String?>(
                      value: card.id,
                      child: Text('Yes, the bill for ${card.label}', overflow: TextOverflow.ellipsis),
                    ),
                ],
                onChanged: (value) => setState(() => _cardPaymentFor = value),
              ),
              const SizedBox(height: 8),
            ],

            // Marking the payment rather than ticking a due date is what
            // lets a bill be paid early - an early salary can be spent on
            // early - and what makes a part payment tellable from none.
            if (_type == 'DEBIT' && _commitments.isNotEmpty) ...[
              const SizedBox(height: 4),
              DropdownButtonFormField<String?>(
                initialValue: _commitmentId,
                isExpanded: true,
                decoration: const InputDecoration(
                  labelText: 'Towards a fixed monthly cost?',
                  helperText: 'Still counts as spending. Sending less than usual is fine - the '
                      'dashboard says what went short rather than calling it unpaid.',
                  helperMaxLines: 3,
                  isDense: true,
                ),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('No - ordinary spending')),
                  for (final commitment in _commitments)
                    DropdownMenuItem<String?>(
                      value: commitment.id,
                      child: Text(
                        '${commitment.name} - ${formatMoney(commitment.amountMinor)} a month',
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: _pickCommitment,
              ),
              const SizedBox(height: 8),
            ],

            // A loan has no purchase to keep out of the totals the way an
            // EMI's does, so this always counts in full - the picker only
            // ever says which schedule the payment closes off next.
            if (_type == 'DEBIT' && _loans.isNotEmpty) ...[
              const SizedBox(height: 4),
              DropdownButtonFormField<String?>(
                initialValue: _loanId,
                isExpanded: true,
                decoration: const InputDecoration(
                  labelText: 'Repaying a loan?',
                  helperText: 'Claims whichever instalment on it is next due, regardless of the '
                      'exact amount here.',
                  helperMaxLines: 3,
                  isDense: true,
                ),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('No - ordinary spending')),
                  for (final loan in _loans)
                    DropdownMenuItem<String?>(
                      value: loan.id,
                      child: Text(
                        '${loan.label} - ${loan.paidCount} of ${loan.months} paid',
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
                onChanged: (value) => setState(() => _loanId = value),
              ),
              const SizedBox(height: 8),
            ],

            // Only a person can say which credit is the month's pay: it
            // lands a day either side of the day it is meant to, and a
            // month with leave in it is smaller than the profile says.
            if (_type == 'CREDIT')
              CheckboxListTile(
                value: _isSalary,
                onChanged: (value) => setState(() => _isSalary = value ?? false),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                dense: true,
                title: Text(
                  'This is my salary',
                  style: TextStyle(fontSize: 12.8, color: c.ink70),
                ),
                subtitle: Text(
                  'Starts the spending period here, and uses this amount rather than the one in Settings.',
                  style: TextStyle(fontSize: 11.5, height: 1.4, color: c.mutedLight),
                ),
              ),

            // The same control either way round: some of the money that
            // moved was never really the user's. On a payment, the rest is
            // owed back - a table's bill paid on one card. On a credit, the
            // rest is money that was always theirs coming back rather than
            // new income - a roommate settling rent and something else in
            // one transfer. Hidden once Settling up is ticked: that one is
            // whole-transaction and would win outright, quietly ignoring
            // the share entered here.
            if (!_isSettlement)
              CheckboxListTile(
                value: _isSplit,
                onChanged: (value) => setState(() {
                  _isSplit = value ?? false;
                  // Anchored to the full amount, since the point of a
                  // split is usually that the share is some way below it.
                  if (_isSplit && _myShare.text.trim().isEmpty) _myShare.text = _amount.text;
                }),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                dense: true,
                title: Text(
                  _type == 'DEBIT'
                      ? 'Split — only part of this was mine'
                      : 'Split — only part of this is really mine',
                  style: TextStyle(fontSize: 12.8, color: c.ink70),
                ),
              ),

            if (_isSplit) ...[
              const SizedBox(height: 6),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: _Field(
                      label: 'My share',
                      child: TextField(
                        controller: _myShare,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        onChanged: (_) => setState(() {}),
                        style: kNum.copyWith(fontWeight: FontWeight.w700, color: c.ink),
                        decoration: _inputDecoration(context, hint: '0.00', prefix: '₹ '),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _Field(
                      label: 'What for',
                      child: TextField(
                        controller: _groupLabel,
                        style: TextStyle(color: c.ink),
                        decoration: _inputDecoration(
                          context,
                          hint: _type == 'DEBIT' ? 'Goa trip' : 'Roommate reimbursement',
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(_owedHint, style: TextStyle(fontSize: 12, color: c.muted, height: 1.45)),
              const SizedBox(height: 6),
            ],

            if (widget.transaction?.tripName != null)
              CheckboxListTile(
                value: _tripJustMine,
                onChanged: (value) => setState(() => _tripJustMine = value ?? false),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                dense: true,
                title: Text(
                  'On ${widget.transaction!.tripName}, this one was just mine — leave it out of '
                  'who owes whom',
                  style: TextStyle(fontSize: 12.8, color: c.ink70),
                ),
              ),

            // Whole-transaction and all-or-nothing, so it is hidden once
            // Split is ticked rather than shown beside it - see the note
            // above Split for why.
            if (!_isSplit)
              CheckboxListTile(
                value: _isSettlement,
                onChanged: (value) => setState(() => _isSettlement = value ?? false),
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                dense: true,
                title: Text(
                  'Settling up — paying back, or being paid back, for bills already recorded',
                  style: TextStyle(fontSize: 12.8, color: c.ink70),
                ),
              ),

            if (_error != null) ...[
              const SizedBox(height: 6),
              Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
            ],

            const SizedBox(height: 16),
            Row(
              children: [
                if (!_isNew)
                  TextButton(
                    onPressed: _saving
                        ? null
                        : () => _confirmDelete ? _delete() : setState(() => _confirmDelete = true),
                    style: TextButton.styleFrom(foregroundColor: c.debit),
                    child: Text(_confirmDelete ? 'Really delete?' : 'Delete'),
                  ),
                if (!_isNew && widget.transaction!.type == 'CREDIT')
                  TextButton(
                    onPressed: _saving
                        ? null
                        : () async {
                            final navigator = Navigator.of(context);
                            final linked = await showRefundSheet(context, refund: widget.transaction!);
                            if (linked == true) navigator.pop(true);
                          },
                    child: Text(widget.transaction!.refundOf.isNotEmpty ? 'Refund of…' : "It's a refund"),
                  ),
                if (!_isNew &&
                    widget.transaction!.type == 'DEBIT' &&
                    widget.transaction!.emiPlanId == null)
                  TextButton(
                    onPressed: _saving
                        ? null
                        : () async {
                            // Captured before the await: after it, this
                            // sheet's own context may be gone.
                            final navigator = Navigator.of(context);
                            final created = await showEmiSheet(context, transaction: widget.transaction!);
                            if (created == true) navigator.pop(true);
                          },
                    child: const Text('EMI'),
                  ),
                if (!_isNew && widget.transaction!.wasReportedTwice)
                  TextButton(
                    onPressed: _saving ? null : _unmerge,
                    child: Text('Split into ${widget.transaction!.sources.length}'),
                  ),
                const Spacer(),
                TextButton(
                  onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                  style: TextButton.styleFrom(foregroundColor: c.muted),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: Text(_saving ? 'Saving…' : (_isNew ? 'Add' : 'Save')),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

InputDecoration _inputDecoration(BuildContext context, {String? hint, String? prefix}) {
  final c = context.c;
  return InputDecoration(
    hintText: hint,
    prefixText: prefix,
    hintStyle: TextStyle(color: c.mutedLight),
    prefixStyle: TextStyle(color: c.muted, fontWeight: FontWeight.w600),
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
}

class _Field extends StatelessWidget {
  final String label;
  final Widget child;
  const _Field({required this.label, required this.child});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: context.c.muted),
          ),
          const SizedBox(height: 6),
          child,
        ],
      ),
    );
  }
}

class _Segment extends StatelessWidget {
  final String label;
  final bool on;
  final VoidCallback onTap;

  const _Segment({required this.label, required this.on, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Expanded(
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 11),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: on ? c.brand50 : c.surface,
            border: Border.all(color: on ? c.brand : c.lineStrong),
            borderRadius: BorderRadius.circular(T.rSm),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
              color: on ? c.brandDark : c.ink70,
            ),
          ),
        ),
      ),
    );
  }
}

class _PresetChip extends StatelessWidget {
  final MerchantPreset preset;
  final bool isCurrent;
  final VoidCallback onTap;
  final VoidCallback onRemove;

  const _PresetChip({
    required this.preset,
    required this.isCurrent,
    required this.onTap,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return GestureDetector(
      onTap: onTap,
      // Removing is deliberately the long press: the tap has to stay the
      // thing you do fifty times, not the one you undo.
      onLongPress: onRemove,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: isCurrent ? c.brand50 : c.surface,
          border: Border.all(color: isCurrent ? c.brand : c.lineStrong),
          borderRadius: BorderRadius.circular(100),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (preset.category?.color != null) ...[
              Container(
                width: 7,
                height: 7,
                decoration: BoxDecoration(
                  color: parseHexColor(preset.category!.color),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 6),
            ],
            Text(
              preset.merchant,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: isCurrent ? c.brandDark : c.ink70,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
