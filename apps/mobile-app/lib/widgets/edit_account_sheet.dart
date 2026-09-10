import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';

const _types = [
  ('BANK', 'Bank'),
  ('CARD', 'Card'),
  ('UPI', 'UPI'),
];

/// Add or edit one account, and merge away the duplicates a bank creates by
/// spelling its own name two different ways.
Future<bool?> showEditAccountSheet(
  BuildContext context, {
  /// null means "add a new one".
  Account? account,
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
      child: _EditAccountSheet(account: account, accounts: accounts),
    ),
  );
}

class _EditAccountSheet extends StatefulWidget {
  final Account? account;
  final List<Account> accounts;

  const _EditAccountSheet({required this.account, required this.accounts});

  @override
  State<_EditAccountSheet> createState() => _EditAccountSheetState();
}

class _EditAccountSheetState extends State<_EditAccountSheet> {
  late final TextEditingController _nickname;
  late final TextEditingController _bankName;
  late final TextEditingController _last4;
  late final TextEditingController _cardNetwork;
  late final TextEditingController _creditLimit;
  late final TextEditingController _statementDay;
  late final TextEditingController _dueDay;

  late String _type;
  late bool _isActive;
  String? _mergeInto;

  bool _saving = false;
  bool _confirmDelete = false;
  String? _error;

  bool get _isNew => widget.account == null;

  @override
  void initState() {
    super.initState();
    final a = widget.account;
    _nickname = TextEditingController(text: a?.nickname ?? '');
    _bankName = TextEditingController(text: a?.bankName ?? '');
    _last4 = TextEditingController(text: a?.last4 ?? '');
    _cardNetwork = TextEditingController(text: a?.cardNetwork ?? '');
    _creditLimit = TextEditingController(
      text: a?.creditLimitMinor != null ? (a!.creditLimitMinor! ~/ 100).toString() : '',
    );
    _statementDay = TextEditingController(text: a?.statementDay?.toString() ?? '');
    _dueDay = TextEditingController(text: a?.dueDay?.toString() ?? '');
    _type = a?.accountType ?? 'BANK';
    _isActive = a?.isActive ?? true;
  }

  @override
  void dispose() {
    for (final c in [_nickname, _bankName, _last4, _cardNetwork, _creditLimit, _statementDay, _dueDay]) {
      c.dispose();
    }
    super.dispose();
  }

  int? _intOrNull(TextEditingController controller) {
    final text = controller.text.trim();
    if (text.isEmpty) return null;
    return int.tryParse(text);
  }

  Future<void> _save() async {
    final bankName = _bankName.text.trim();
    if (bankName.isEmpty) {
      setState(() => _error = 'The bank or card issuer needs a name.');
      return;
    }
    final last4 = _last4.text.trim();
    if (last4.isNotEmpty && !RegExp(r'^\d{2,6}$').hasMatch(last4)) {
      setState(() => _error = 'Last digits should be 2 to 6 numbers, or left blank.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    final limit = _intOrNull(_creditLimit);
    final body = <String, dynamic>{
      'bankName': bankName,
      'nickname': _nickname.text.trim().isEmpty ? null : _nickname.text.trim(),
      'last4': last4.isEmpty ? null : last4,
      'accountType': _type,
      'cardNetwork': _cardNetwork.text.trim().isEmpty ? null : _cardNetwork.text.trim(),
      'creditLimitMinor': limit == null ? null : limit * 100,
      'statementDay': _intOrNull(_statementDay),
      'dueDay': _intOrNull(_dueDay),
      'isActive': _isActive,
    };

    try {
      if (_isNew) {
        await ApiClient.instance.post('/accounts', body);
      } else {
        await ApiClient.instance.patch('/accounts/${widget.account!.id}', body);
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't save that account.";
        _saving = false;
      });
    }
  }

  Future<void> _delete({required bool unassign}) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final suffix = unassign ? '?unassign=true' : '';
      await ApiClient.instance.delete('/accounts/${widget.account!.id}$suffix');
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't delete that account.";
        _saving = false;
        _confirmDelete = false;
      });
    }
  }

  Future<void> _merge() async {
    if (_mergeInto == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      // The account picked survives; this one is absorbed into it.
      await ApiClient.instance.post('/accounts/$_mergeInto/merge', {'fromId': widget.account!.id});
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      setState(() {
        _error = e is ApiException ? e.message : "Couldn't merge those accounts.";
        _saving = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final others = widget.accounts.where((a) => a.id != widget.account?.id).toList();

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
              _isNew ? 'Add an account' : 'Edit account',
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink),
            ),
            const SizedBox(height: 4),
            Text(
              _isNew
                  ? "For anything your bank doesn't text you about."
                  : 'The name is yours to choose; the bank name is what incoming messages are matched against.',
              style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
            ),
            const SizedBox(height: 18),

            _Field(label: 'Name it', controller: _nickname, hint: 'Salary account'),
            const SizedBox(height: 14),

            Text('Type', style: _labelStyle(c)),
            const SizedBox(height: 6),
            Row(
              children: [
                for (final (value, label) in _types)
                  Expanded(
                    child: GestureDetector(
                      onTap: () => setState(() => _type = value),
                      child: Container(
                        margin: const EdgeInsets.only(right: 8),
                        padding: const EdgeInsets.symmetric(vertical: 10),
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: _type == value ? c.brand50 : c.surface,
                          border: Border.all(color: _type == value ? c.brand : c.lineStrong),
                          borderRadius: BorderRadius.circular(T.rSm),
                        ),
                        child: Text(
                          label,
                          style: TextStyle(
                            fontSize: 12.5,
                            fontWeight: FontWeight.w700,
                            color: _type == value ? c.brandDark : c.ink70,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 14),

            _Field(label: 'Bank name', controller: _bankName, hint: 'HDFC Bank'),
            const SizedBox(height: 14),
            _Field(label: 'Last digits', controller: _last4, hint: '1377', numeric: true),

            if (_type == 'CARD') ...[
              const SizedBox(height: 14),
              _Field(label: 'Network', controller: _cardNetwork, hint: 'Visa, Mastercard, RuPay'),
              const SizedBox(height: 14),
              _Field(label: 'Credit limit (₹)', controller: _creditLimit, hint: '200000', numeric: true),
              const SizedBox(height: 14),
              Row(
                children: [
                  Expanded(
                    child: _Field(label: 'Statement day', controller: _statementDay, hint: '18', numeric: true),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _Field(label: 'Due day', controller: _dueDay, hint: '7', numeric: true),
                  ),
                ],
              ),
            ],

            const SizedBox(height: 6),
            CheckboxListTile(
              value: !_isActive,
              onChanged: (v) => setState(() => _isActive = !(v ?? false)),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              title: Text(
                'Closed — keep its history, but hide it when picking an account',
                style: TextStyle(fontSize: 12.8, color: c.ink70),
              ),
            ),

            if (!_isNew && widget.account!.aliases.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                'Also recognised as ${widget.account!.aliases.map((a) => a.bankName).join(', ')}',
                style: TextStyle(fontSize: 12, color: c.muted),
              ),
            ],

            if (!_isNew && others.isNotEmpty) ...[
              const SizedBox(height: 16),
              Text('Same account as', style: _labelStyle(c)),
              const SizedBox(height: 6),
              Row(
                children: [
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      initialValue: _mergeInto,
                      isExpanded: true,
                      decoration: _inputDecoration(c),
                      hint: Text('Merge this into…', style: TextStyle(fontSize: 13, color: c.mutedLight)),
                      items: [
                        for (final a in others)
                          DropdownMenuItem(
                            value: a.id,
                            child: Text(a.label, style: TextStyle(fontSize: 13, color: c.ink)),
                          ),
                      ],
                      onChanged: (v) => setState(() => _mergeInto = v),
                    ),
                  ),
                  const SizedBox(width: 8),
                  OutlinedButton(
                    onPressed: _mergeInto == null || _saving ? null : _merge,
                    child: const Text('Merge'),
                  ),
                ],
              ),
            ],

            if (_error != null) ...[
              const SizedBox(height: 14),
              Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
            ],

            const SizedBox(height: 20),
            Row(
              children: [
                if (!_isNew)
                  if (_confirmDelete) ...[
                    TextButton(
                      onPressed: _saving ? null : () => _delete(unassign: true),
                      style: TextButton.styleFrom(foregroundColor: c.debit),
                      child: const Text('Delete anyway'),
                    ),
                    TextButton(
                      onPressed: () => setState(() => _confirmDelete = false),
                      child: const Text('Keep it'),
                    ),
                  ] else
                    TextButton(
                      onPressed: _saving ? null : () => setState(() => _confirmDelete = true),
                      style: TextButton.styleFrom(foregroundColor: c.debit),
                      child: const Text('Delete'),
                    ),
                const Spacer(),
                TextButton(
                  onPressed: _saving ? null : () => Navigator.of(context).pop(false),
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

TextStyle _labelStyle(SpendColors c) =>
    TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.muted);

InputDecoration _inputDecoration(SpendColors c, {String? hint}) => InputDecoration(
      hintText: hint,
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

class _Field extends StatelessWidget {
  final String label;
  final TextEditingController controller;
  final String? hint;
  final bool numeric;

  const _Field({required this.label, required this.controller, this.hint, this.numeric = false});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: _labelStyle(c)),
        const SizedBox(height: 6),
        TextField(
          controller: controller,
          keyboardType: numeric ? TextInputType.number : TextInputType.text,
          style: TextStyle(fontSize: 13.5, color: c.ink),
          decoration: _inputDecoration(c, hint: hint),
        ),
      ],
    );
  }
}
