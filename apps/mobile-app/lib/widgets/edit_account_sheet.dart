import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';

// CARD is a credit card and DEBIT a debit card. They differ everywhere it
// matters: a credit card has a cycle, a limit, a due date and a statement
// of its own; a debit card has none of those, because it is a way of
// reaching a bank account rather than a line of credit.
const _types = [
  ('BANK', 'Bank account'),
  ('CARD', 'Credit card'),
  ('DEBIT', 'Debit card'),
  ('UPI', 'UPI'),
  ('CASH', 'Cash'),
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

  /// Never pre-filled: the stored value is not readable, by design.
  final _statementPassword = TextEditingController();
  late final TextEditingController _dueDay;

  late String _type;
  String? _linkedAccountId;
  String? _sharesLimitWith;
  late bool _isActive;
  late bool _noCreditAlerts;

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
    _linkedAccountId = a?.linkedAccountId;
    _sharesLimitWith = a?.sharesLimitWith;
    _isActive = a?.isActive ?? true;
    _noCreditAlerts = a?.noCreditAlerts ?? false;
  }

  @override
  void dispose() {
    for (final c in [
      _nickname,
      _bankName,
      _last4,
      _cardNetwork,
      _creditLimit,
      _statementDay,
      _statementPassword,
      _dueDay,
    ]) {
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
    final bankName = _type == 'CASH' && _bankName.text.trim().isEmpty
        ? 'Cash'
        : _bankName.text.trim();
    if (bankName.isEmpty) {
      setState(() => _error = 'The bank or card issuer needs a name.');
      return;
    }
    final last4 = _last4.text.trim();
    if (last4.isNotEmpty && !RegExp(r'^\d{2,6}$').hasMatch(last4)) {
      setState(() => _error = 'Last digits should be 2 to 6 numbers, or left blank.');
      return;
    }
    if (_type == 'CARD') {
      for (final (label, field) in [('Statement day', _statementDay), ('Due day', _dueDay)]) {
        final text = field.text.trim();
        final day = int.tryParse(text);
        if (text.isNotEmpty && (day == null || day < 1 || day > 31)) {
          setState(() => _error = '$label should be a day of the month, 1 to 31.');
          return;
        }
      }
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
      // Only ever sent for a debit card, so switching a card away from
      // debit clears the link rather than leaving it dangling.
      'linkedAccountId': _type == 'DEBIT' ? _linkedAccountId : null,
      // Likewise only ever sent for a credit card.
      'sharesLimitWith': _type == 'CARD' ? _sharesLimitWith : null,
      'cardNetwork': _cardNetwork.text.trim().isEmpty ? null : _cardNetwork.text.trim(),
      'creditLimitMinor': limit == null ? null : limit * 100,
      'statementDay': _intOrNull(_statementDay),
      'dueDay': _intOrNull(_dueDay),
      'isActive': _isActive,
      // Only a bank account has messages about money coming in or not.
      'noCreditAlerts': _type == 'BANK' && _noCreditAlerts,
    };

    try {
      final saved = _isNew
          ? await ApiClient.instance.post('/accounts', body) as Map<String, dynamic>
          : await ApiClient.instance.patch('/accounts/${widget.account!.id}', body)
              as Map<String, dynamic>;

      // Sent separately because it is encrypted before it is stored and
      // never comes back out, so it cannot travel with the rest of the
      // account the way an ordinary field would.
      final password = _statementPassword.text.trim();
      if (password.isNotEmpty) {
        await ApiClient.instance
            .put('/statements/password/${saved['id']}', {'password': password});
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
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsDragHandle(),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: DsSheetHeader(
              title: _isNew ? 'Add an account' : 'Edit account',
              subtitle: _isNew
                  ? "For anything your bank doesn't text you about."
                  : 'The name is yours to choose; the bank name is what incoming messages are matched against.',
            ),
          ),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _Field(label: 'Name it', controller: _nickname, hint: 'Salary account'),
                  const SizedBox(height: 16),

                  const DsLabel('Type'),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final (value, label) in _types)
                        DsChip(
                          label: label,
                          selected: _type == value,
                          onTap: () => setState(() => _type = value),
                        ),
                    ],
                  ),
                  const SizedBox(height: 16),

                  if (_type != 'CASH') ...[
                    _Field(label: 'Bank name', controller: _bankName, hint: 'HDFC Bank'),
                    const SizedBox(height: 16),
                    _Field(label: 'Last digits', controller: _last4, hint: '1377', numeric: true),
                  ],

                  // What a debit card draws on. Its spending is that account's
                  // money, so it is counted there and shows on that account's
                  // statement - and a debit card whose account SpendLog has
                  // never seen stands on its own, the way cash does.
                  if (_type == 'DEBIT') ...[
                    const SizedBox(height: 16),
                    const DsLabel('Draws on'),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String?>(
                      initialValue: _linkedAccountId,
                      isExpanded: true,
                      icon: DsIcon(DsIcons.chevronDown, color: c.tx2),
                      items: [
                        const DropdownMenuItem(value: null, child: Text('Nothing — it stands on its own')),
                        for (final bank in widget.accounts.where((a) => a.accountType == 'BANK'))
                          DropdownMenuItem(value: bank.id, child: Text(bank.label)),
                      ],
                      onChanged: (value) => setState(() => _linkedAccountId = value),
                    ),
                  ],

                  // Two cards from one bank often draw on a single limit: spend on
                  // either and the other has less. The card named holds the
                  // limit; this one's own is then ignored. Only cards not
                  // themselves drawing on a third are offered - the server
                  // flattens a chain, but offering its head is clearer.
                  if (_type == 'CARD' &&
                      widget.accounts.any((a) =>
                          a.accountType == 'CARD' && a.id != widget.account?.id && a.sharesLimitWith == null)) ...[
                    const SizedBox(height: 16),
                    const DsLabel('Shares its limit with'),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String?>(
                      initialValue: _sharesLimitWith,
                      isExpanded: true,
                      icon: DsIcon(DsIcons.chevronDown, color: c.tx2),
                      items: [
                        const DropdownMenuItem(value: null, child: Text('Nothing — a limit of its own')),
                        for (final holder in widget.accounts.where((a) =>
                            a.accountType == 'CARD' && a.id != widget.account?.id && a.sharesLimitWith == null))
                          DropdownMenuItem(value: holder.id, child: Text(holder.label)),
                      ],
                      onChanged: (value) => setState(() => _sharesLimitWith = value),
                    ),
                  ],

                  // The network is a card thing rather than a credit-card thing:
                  // a debit card gets suggested at a till on the same grounds.
                  if (_type == 'CARD' || _type == 'DEBIT') ...[
                    const SizedBox(height: 16),
                    _Field(label: 'Network', controller: _cardNetwork, hint: 'Visa, Mastercard, RuPay'),
                  ],

                  if (_type == 'CARD') ...[
                    const SizedBox(height: 16),
                    _Field(label: 'Credit limit (₹)', controller: _creditLimit, hint: '200000', numeric: true),
                    const SizedBox(height: 16),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
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
                    const SizedBox(height: 6),
                    // The one thing every figure on the card hangs off. Each card
                    // bills on its own day, so nothing here borrows the salary
                    // month - without it the card simply has no cycle yet.
                    Text(
                      "Statement day is when the bill is drawn. This card's cycle, what it owes and what is left "
                      'of its limit all count from it. A statement read for this card fills both in.',
                      style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                    const SizedBox(height: 16),

                    // The one field the statement reader cannot work without.
                    // Every card's password is tried against every statement, so
                    // one is often enough for all of them.
                    const DsLabel('Statement password'),
                    const SizedBox(height: 6),
                    DsPasswordField(
                      controller: _statementPassword,
                      decoration: InputDecoration(
                        hintText: widget.account?.hasStatementPassword == true
                            ? 'Already set - type a new one to replace it'
                            : 'Opens the PDF this card emails',
                        helperText: 'Stored encrypted and never sent back to this screen. Issuers build it '
                            'from a date of birth, so it usually opens more than this one card.',
                        helperMaxLines: 4,
                      ),
                    ),
                  ],

                  // Some banks text every payment out and none in. Said once
                  // here, a gap on the account is read as money in first, and
                  // its statement is asked for every month to catch the rest.
                  if (_type == 'BANK') ...[
                    const SizedBox(height: 12),
                    SwitchListTile(
                      key: const ValueKey('no-credit-alerts'),
                      value: _noCreditAlerts,
                      onChanged: (value) => setState(() => _noCreditAlerts = value),
                      contentPadding: EdgeInsets.zero,
                      title: Text(
                        "This bank doesn't text me about money coming in",
                        style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                      ),
                      subtitle: Text(
                        'SpendLog then reads a gap as a credit it missed, and asks for the statement monthly.',
                        style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                      ),
                    ),
                    if (!_noCreditAlerts && widget.account?.suggestNoCreditAlerts == true)
                      DsCallout(tone: DsTone.warn, title: _suggestionText(widget.account!)),
                  ],

                  const SizedBox(height: 8),
                  CheckboxListTile(
                    value: !_isActive,
                    onChanged: (v) => setState(() => _isActive = !(v ?? false)),
                    controlAffinity: ListTileControlAffinity.leading,
                    contentPadding: EdgeInsets.zero,
                    title: Text(
                      'Closed — keep its history, but hide it when picking an account',
                      style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx2),
                    ),
                  ),

                  if (!_isNew && widget.account!.aliases.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      'Also recognised as ${widget.account!.aliases.map((a) => a.bankName).join(', ')}',
                      style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                  ],

                  if (!_isNew && others.isNotEmpty) ...[
                    const SizedBox(height: 16),
                    const DsLabel('Same account as'),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Expanded(
                          child: DropdownButtonFormField<String>(
                            initialValue: _mergeInto,
                            isExpanded: true,
                            icon: DsIcon(DsIcons.chevronDown, color: c.tx2),
                            hint: Text('Merge this into…', style: TextStyle(fontSize: 15, color: c.tx3)),
                            items: [
                              for (final a in others)
                                DropdownMenuItem(
                                  value: a.id,
                                  child: Text(a.label, style: TextStyle(fontSize: 15, color: c.tx)),
                                ),
                            ],
                            onChanged: (v) => setState(() => _mergeInto = v),
                          ),
                        ),
                        const SizedBox(width: 8),
                        OutlinedButton(
                          onPressed: _mergeInto == null || _saving ? null : _merge,
                          style: OutlinedButton.styleFrom(minimumSize: const Size(0, 52)),
                          child: const Text('Merge'),
                        ),
                      ],
                    ),
                  ],

                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    DsCallout(tone: DsTone.crit, title: _error!),
                  ],
                ],
              ),
            ),
          ),

          // The footer, pinned: destructive on the left, then Cancel and Save.
          Container(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
            decoration: BoxDecoration(color: c.sf2, border: Border(top: BorderSide(color: c.ln))),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (!_isNew && _confirmDelete) ...[
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _saving ? null : () => _delete(unassign: true),
                          style: OutlinedButton.styleFrom(
                            foregroundColor: c.crit,
                            backgroundColor: Colors.transparent,
                            side: BorderSide(color: c.critSoft),
                          ),
                          icon: const DsIcon(DsIcons.trash, size: 18),
                          label: const Text('Delete anyway'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      TextButton(
                        onPressed: () => setState(() => _confirmDelete = false),
                        child: const Text('Keep it'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                ],
                Row(
                  children: [
                    if (!_isNew && !_confirmDelete)
                      OutlinedButton.icon(
                        onPressed: _saving ? null : () => setState(() => _confirmDelete = true),
                        style: OutlinedButton.styleFrom(
                          foregroundColor: c.crit,
                          backgroundColor: Colors.transparent,
                          side: BorderSide(color: c.critSoft),
                          minimumSize: const Size(0, 48),
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                        ),
                        icon: const DsIcon(DsIcons.trash, size: 18),
                        label: const Text('Delete'),
                      ),
                    const Spacer(),
                    TextButton(
                      onPressed: _saving ? null : () => Navigator.of(context).pop(false),
                      style: TextButton.styleFrom(minimumSize: const Size(0, 48)),
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
        ],
      ),
    );
  }
}

/// "We've seen 28 debits and 1 credit by text in 90 days — turn this on?"
String _suggestionText(Account account) {
  final debits = account.textDebits ?? 0;
  final credits = account.textCredits ?? 0;
  String count(int n, String one) => '$n $one${n == 1 ? '' : 's'}';
  return "We've seen ${count(debits, 'debit')} and ${count(credits, 'credit')} by text in "
      '${account.textDays} days — turn this on?';
}

/// A labelled text field: `12/16 600` label, 6 px gap, the themed 52 px input.
class _Field extends StatelessWidget {
  final String label;
  final TextEditingController controller;
  final String? hint;
  final bool numeric;

  const _Field({required this.label, required this.controller, this.hint, this.numeric = false});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsField(
      label: label,
      child: TextField(
        controller: controller,
        keyboardType: numeric ? TextInputType.number : TextInputType.text,
        style: (numeric ? kNum : const TextStyle()).copyWith(fontSize: 15, color: c.tx),
        decoration: InputDecoration(hintText: hint),
      ),
    );
  }
}