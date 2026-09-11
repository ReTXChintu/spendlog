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
  late bool _isSplit;
  late bool _isSettlement;
  /// On a trip, an expense is everyone's unless it says otherwise. The only
  /// narrowing worth a control is "this one was just mine".
  late bool _tripJustMine;
  late final TextEditingController _myShare;
  late final TextEditingController _groupLabel;

  bool _saving = false;
  bool _confirmDelete = false;
  String? _error;

  bool get _isNew => widget.transaction == null;

  /// Says what the split will do, in the same terms the balance uses.
  String get _owedHint {
    final total = ((double.tryParse(_amount.text.trim()) ?? 0) * 100).round();
    final share = ((double.tryParse(_myShare.text.trim()) ?? 0) * 100).round();
    final owed = total - share;
    if (owed <= 0) return 'All of it counts as your own spending.';
    return '${formatMoney(owed)} counts as owed back to you, not as spending.';
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
    _isSplit = t?.split != null;
    _isSettlement = t?.isSettlement ?? false;
    _tripJustMine = (t?.tripShareWith?.isNotEmpty ?? false);
    _myShare = TextEditingController(
      text: t?.split != null ? (t!.split!.myShareMinor / 100).toStringAsFixed(2) : '',
    );
    _groupLabel = TextEditingController(text: t?.split?.groupLabel ?? '');
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
                    onTap: () => setState(() => _type = 'DEBIT'),
                  ),
                  const SizedBox(width: 8),
                  _Segment(
                    label: 'Money in',
                    on: _type == 'CREDIT',
                    onTap: () => setState(() => _type = 'CREDIT'),
                  ),
                ],
              ),
            ),

            _Field(
              label: 'Merchant',
              child: TextField(
                controller: _merchant,
                style: TextStyle(color: c.ink),
                decoration: _inputDecoration(context, hint: 'Who was paid'),
              ),
            ),

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
                  ...widget.categories.map(
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

            CheckboxListTile(
              value: _isSplit,
              onChanged: (value) => setState(() {
                _isSplit = value ?? false;
                // Anchored to the full bill, since the point of a split is
                // usually that the share is some way below it.
                if (_isSplit && _myShare.text.trim().isEmpty) _myShare.text = _amount.text;
              }),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              title: Text(
                'Split — only part of this was mine',
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
                        decoration: _inputDecoration(context, hint: 'Goa trip'),
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
