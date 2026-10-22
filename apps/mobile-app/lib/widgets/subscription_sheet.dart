import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../models/subscription_models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import 'ds/ds.dart';
import 'person_picker_sheet.dart';

/// Adding a subscription, or changing one. Returns true once it is saved.
///
/// Opened blank, from a detected one (the name, amount, frequency, dates and
/// account already filled in), or on an existing one to edit.
Future<bool?> showSubscriptionSheet(
  BuildContext context, {
  Subscription? existing,
  SubscriptionSuggestion? from,
  List<Account>? accounts,
  List<Category>? categories,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.sf,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl))),
    builder: (_) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SubscriptionSheet(existing: existing, from: from, accounts: accounts, categories: categories),
    ),
  );
}

/// YYYY-MM-DD for a local calendar day.
String dayKey(DateTime day) => DateFormat('yyyy-MM-dd').format(day);

/// "25 Oct 2026" from YYYY-MM-DD.
String dayWords(String key, {bool year = true}) {
  final parsed = DateTime.tryParse(key);
  if (parsed == null) return key;
  return DateFormat(year ? 'd MMM yyyy' : 'd MMM').format(parsed);
}

class _Share {
  _Share({required this.contact, int? amountMinor})
      : amount = TextEditingController(text: amountMinor == null ? '' : _rupees(amountMinor));
  final Contact contact;
  final TextEditingController amount;
}

String _rupees(int minor) => minor % 100 == 0 ? '${minor ~/ 100}' : (minor / 100).toStringAsFixed(2);

class SubscriptionSheet extends StatefulWidget {
  const SubscriptionSheet({super.key, this.existing, this.from, this.accounts, this.categories});

  final Subscription? existing;
  final SubscriptionSuggestion? from;
  final List<Account>? accounts;
  final List<Category>? categories;

  @override
  State<SubscriptionSheet> createState() => _SubscriptionSheetState();
}

class _SubscriptionSheetState extends State<SubscriptionSheet> {
  late final _name = TextEditingController(text: widget.existing?.name ?? widget.from?.suggestedName ?? '');
  late final _amount = TextEditingController(
    text: () {
      final minor = widget.existing?.amountMinor ?? widget.from?.amountMinor;
      return minor == null ? '' : _rupees(minor);
    }(),
  );
  late final _every = TextEditingController(text: '${widget.existing?.every ?? widget.from?.every ?? 1}');
  late final _notes = TextEditingController(text: widget.existing?.notes ?? '');

  late String _preset = widget.existing?.frequencyPreset ?? _presetFor(widget.from?.every ?? 1, widget.from?.unit ?? 'month');
  late String _unit = widget.existing?.unit ?? widget.from?.unit ?? 'month';
  late String _nextRenewalOn = widget.existing?.nextRenewalOn ?? widget.from?.nextOn ?? dayKey(DateTime.now());
  late String? _startedOn = widget.existing?.startedOn.isNotEmpty == true
      ? widget.existing!.startedOn
      : (widget.from?.firstOn.isNotEmpty == true ? widget.from!.firstOn : null);
  late bool _trial = widget.existing?.trialEndsOn != null;
  late String? _trialEndsOn = widget.existing?.trialEndsOn;
  late String? _payMethod = widget.existing?.payMethod;
  late String? _accountId = widget.existing?.accountId ?? widget.from?.accountId;
  late String? _categoryId = widget.existing?.categoryId ?? widget.from?.categoryId;
  late int _remind = widget.existing?.remindDaysBefore ?? 2;
  final List<_Share> _shares = [];

  List<Account> _accounts = const [];
  List<Category> _categories = const [];
  bool _loadingLists = false;
  bool _saving = false;
  String? _error;

  bool get _isEdit => widget.existing != null;

  @override
  void initState() {
    super.initState();
    _accounts = widget.accounts ?? const [];
    _categories = widget.categories ?? const [];
    if (widget.accounts == null || widget.categories == null) _loadLists();
    if (widget.existing != null && widget.existing!.sharedWith.isNotEmpty) _loadShares();
  }

  @override
  void dispose() {
    _name.dispose();
    _amount.dispose();
    _every.dispose();
    _notes.dispose();
    for (final share in _shares) {
      share.amount.dispose();
    }
    super.dispose();
  }

  static String _presetFor(int every, String unit) {
    for (final (preset, e, u, _) in frequencyPresets) {
      if (e == every && u == unit) return preset;
    }
    if (unit == 'month' && every == 12) return 'yearly';
    return 'custom';
  }

  Future<void> _loadLists() async {
    setState(() => _loadingLists = true);
    try {
      final results = await Future.wait([
        widget.accounts == null ? ApiClient.instance.get('/accounts') : Future.value(null),
        widget.categories == null ? ApiClient.instance.get('/categories') : Future.value(null),
      ]);
      if (!mounted) return;
      setState(() {
        if (results[0] != null) {
          _accounts = (results[0] as List<dynamic>).map((a) => Account.fromJson(a as Map<String, dynamic>)).toList();
        }
        if (results[1] != null) {
          _categories = (results[1] as List<dynamic>).map((c) => Category.fromJson(c as Map<String, dynamic>)).toList();
        }
      });
    } catch (_) {
      // The pickers stay empty; the rest of the form still saves.
    } finally {
      if (mounted) setState(() => _loadingLists = false);
    }
  }

  /// The people it is shared with, by name: the subscription only knows their ids.
  Future<void> _loadShares() async {
    try {
      final json = await ApiClient.instance.get('/contacts') as Map<String, dynamic>;
      final contacts = (json['contacts'] as List<dynamic>).map((c) => Contact.fromJson(c as Map<String, dynamic>)).toList();
      if (!mounted) return;
      setState(() {
        for (final share in widget.existing!.sharedWith) {
          final contact = contacts.where((c) => c.id == share.contactId).firstOrNull;
          if (contact != null) _shares.add(_Share(contact: contact, amountMinor: share.amountMinor));
        }
      });
    } catch (_) {}
  }

  Future<void> _pickDay({required String? current, required ValueChanged<String> onPicked, String? help}) async {
    final initial = DateTime.tryParse(current ?? '') ?? DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(2015),
      lastDate: DateTime(2040),
      helpText: help,
    );
    if (picked != null) onPicked(dayKey(picked));
  }

  Future<void> _addPeople() async {
    final picked = await showPeoplePicker(
      context,
      exclude: _shares.map((s) => s.contact.id).toSet(),
      title: 'Who shares it?',
    );
    if (picked == null || picked.isEmpty || !mounted) return;
    setState(() {
      for (final contact in picked) {
        _shares.add(_Share(contact: contact));
      }
      _suggestEqualShares();
    });
  }

  /// Equal parts of the amount, filled where nothing has been typed.
  void _suggestEqualShares() {
    final total = parseRupees(_amount.text) ?? 0;
    if (total <= 0 || _shares.isEmpty) return;
    final each = total ~/ (_shares.length + 1);
    for (final share in _shares) {
      if (share.amount.text.trim().isEmpty) share.amount.text = _rupees(each);
    }
  }

  Map<String, dynamic>? _body() {
    final name = _name.text.trim();
    final amount = parseRupees(_amount.text);
    if (name.isEmpty) return _fail('Give it a name.');
    if (amount == null || amount < 0) return _fail('What does it cost each time?');
    var every = 1;
    var unit = 'month';
    if (_preset == 'custom') {
      every = int.tryParse(_every.text.trim()) ?? 0;
      unit = _unit;
      if (every < 1) return _fail('Every how many ${_unit}s?');
    } else {
      final preset = frequencyPresets.firstWhere((p) => p.$1 == _preset);
      every = preset.$2;
      unit = preset.$3;
    }
    final shares = <Map<String, dynamic>>[];
    var theirs = 0;
    for (final share in _shares) {
      final part = parseRupees(share.amount.text) ?? 0;
      if (part <= 0) return _fail("Say how much of it is ${share.contact.name}'s.");
      theirs += part;
      shares.add({'contactId': share.contact.id, 'amountMinor': part});
    }
    if (theirs >= amount && amount > 0) return _fail('Their parts come to the whole amount, leaving nothing of yours.');
    return {
      'name': name,
      'amountMinor': amount,
      'every': every,
      'unit': unit,
      'nextRenewalOn': _nextRenewalOn,
      'startedOn': _startedOn,
      'trialEndsOn': _trial ? _trialEndsOn : null,
      'payMethod': _payMethod,
      'accountId': _accountId,
      'categoryId': _categoryId,
      'notes': _notes.text.trim().isEmpty ? null : _notes.text.trim(),
      'sharedWith': shares,
      'remindDaysBefore': _remind,
      if (!_isEdit && widget.from != null) 'merchantKeys': [widget.from!.key],
    };
  }

  Map<String, dynamic>? _fail(String message) {
    setState(() => _error = message);
    return null;
  }

  Future<void> _save() async {
    final body = _body();
    if (body == null) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (_isEdit) {
        await ApiClient.instance.patch('/subscriptions/${widget.existing!.id}', body);
      } else {
        await ApiClient.instance.post('/subscriptions', body);
      }
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't save. Check your connection and try again.");
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final debitCategories = categoriesFor(_categories, 'DEBIT');

    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Center(child: DsDragHandle()),
            const SizedBox(height: 8),
            DsSheetHeader(
              title: _isEdit ? 'Edit subscription' : (widget.from != null ? 'Track ${widget.from!.suggestedName}' : 'Add a subscription'),
              subtitle: widget.from != null && !_isEdit
                  ? '${widget.from!.count} charges seen, last on ${dayWords(widget.from!.lastOn, year: false)}'
                  : 'Anything that renews: streaming, gym, broadband, iCloud.',
              icon: DsIcons.repeat,
              onClose: () => Navigator.of(context).pop(),
            ),
            const SizedBox(height: 16),
            DsField(
              label: 'Name',
              child: TextField(
                key: const ValueKey('sub-name'),
                controller: _name,
                textCapitalization: TextCapitalization.words,
                autofocus: !_isEdit && widget.from == null,
                decoration: const InputDecoration(hintText: 'Netflix'),
              ),
            ),
            const SizedBox(height: 16),
            DsField(
              label: 'Amount each time',
              child: TextField(
                key: const ValueKey('sub-amount'),
                controller: _amount,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                style: kNum.copyWith(fontSize: 15),
                decoration: const InputDecoration(prefixText: '₹'),
                onChanged: (_) => setState(() {}),
              ),
            ),
            const SizedBox(height: 16),
            const DsLabel('How often'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final (preset, _, _, label) in frequencyPresets)
                  DsChip(
                    key: ValueKey('sub-freq-$preset'),
                    label: label,
                    selected: _preset == preset,
                    onTap: () => setState(() => _preset = preset),
                  ),
                DsChip(label: 'Custom', selected: _preset == 'custom', onTap: () => setState(() => _preset = 'custom')),
              ],
            ),
            if (_preset == 'custom') ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  Text('Every', style: TextStyle(fontSize: 14, color: c.tx2)),
                  const SizedBox(width: 10),
                  SizedBox(
                    width: 72,
                    child: TextField(
                      key: const ValueKey('sub-every'),
                      controller: _every,
                      keyboardType: TextInputType.number,
                      style: kNum.copyWith(fontSize: 15),
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: DropdownButtonFormField<String>(
                      initialValue: _unit,
                      items: [
                        for (final unit in subscriptionUnits) DropdownMenuItem(value: unit, child: Text('${unit}s')),
                      ],
                      onChanged: (value) => setState(() => _unit = value ?? 'month'),
                      icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
                      dropdownColor: c.sf,
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: 16),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: _DayField(
                    label: 'Next renewal',
                    value: _nextRenewalOn,
                    keyName: 'sub-next',
                    onTap: () => _pickDay(current: _nextRenewalOn, onPicked: (d) => setState(() => _nextRenewalOn = d), help: 'Next renewal'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: _DayField(
                    label: 'Started',
                    value: _startedOn,
                    placeholder: 'Not sure',
                    onTap: () => _pickDay(current: _startedOn, onPicked: (d) => setState(() => _startedOn = d), help: 'Started on'),
                    onClear: _startedOn == null ? null : () => setState(() => _startedOn = null),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            SwitchListTile(
              key: const ValueKey('sub-trial'),
              contentPadding: EdgeInsets.zero,
              title: Text('On a free trial', style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx)),
              subtitle: Text(
                _trial && _trialEndsOn != null ? 'Ends ${dayWords(_trialEndsOn!)}; the first charge comes at the next renewal.' : 'Say when it ends, and you are told before it turns into a charge.',
                style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
              ),
              value: _trial,
              onChanged: (on) async {
                setState(() => _trial = on);
                if (on && _trialEndsOn == null) {
                  await _pickDay(current: null, onPicked: (d) => setState(() => _trialEndsOn = d), help: 'Trial ends');
                  if (_trialEndsOn == null && mounted) setState(() => _trial = false);
                }
              },
            ),
            if (_trial && _trialEndsOn != null)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: () => _pickDay(current: _trialEndsOn, onPicked: (d) => setState(() => _trialEndsOn = d), help: 'Trial ends'),
                  child: Text('Trial ends ${dayWords(_trialEndsOn!)} · change'),
                ),
              ),
            const SizedBox(height: 8),
            const DsLabel('Paid with'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final (method, label) in const [
                  ('card', 'Card'),
                  ('upi', 'UPI autopay'),
                  ('bank', 'Bank'),
                  ('wallet', 'Wallet'),
                  ('cash', 'Cash'),
                ])
                  DsChip(
                    label: label,
                    selected: _payMethod == method,
                    onTap: () => setState(() => _payMethod = _payMethod == method ? null : method),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            DsField(
              label: 'Account or card',
              help: _accounts.isEmpty && !_loadingLists ? 'Pick one so an exact charge on it is recognised even when the bank names no merchant.' : null,
              child: DropdownButtonFormField<String?>(
                key: const ValueKey('sub-account'),
                initialValue: _accounts.any((a) => a.id == _accountId) ? _accountId : null,
                isExpanded: true,
                icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
                dropdownColor: c.sf,
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('Not picked')),
                  for (final account in _accounts) DropdownMenuItem<String?>(value: account.id, child: Text(account.label, overflow: TextOverflow.ellipsis)),
                ],
                onChanged: (value) => setState(() => _accountId = value),
              ),
            ),
            const SizedBox(height: 16),
            DsField(
              label: 'Category',
              child: DropdownButtonFormField<String?>(
                key: const ValueKey('sub-category'),
                initialValue: debitCategories.any((c) => c.id == _categoryId) ? _categoryId : null,
                isExpanded: true,
                icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
                dropdownColor: c.sf,
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('None')),
                  for (final category in debitCategories) DropdownMenuItem<String?>(value: category.id, child: Text(category.name)),
                ],
                onChanged: (value) => setState(() => _categoryId = value),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                const Expanded(child: DsLabel('Shared with')),
                TextButton.icon(
                  key: const ValueKey('sub-add-people'),
                  onPressed: _addPeople,
                  icon: const DsIcon(DsIcons.plus, size: 16),
                  label: Text(_shares.isEmpty ? 'Add people' : 'Add more'),
                ),
              ],
            ),
            if (_shares.isEmpty)
              Text(
                'Nobody - all yours. Add the people who chip in, and their parts go on each charge so People knows what they owe.',
                style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
              )
            else
              for (final share in _shares)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    children: [
                      PersonAvatar(name: share.contact.name, radius: 16),
                      const SizedBox(width: 10),
                      Expanded(child: Text(share.contact.name, style: TextStyle(fontSize: 14, color: c.tx))),
                      SizedBox(
                        width: 110,
                        child: TextField(
                          controller: share.amount,
                          keyboardType: const TextInputType.numberWithOptions(decimal: true),
                          style: kNum.copyWith(fontSize: 15),
                          decoration: const InputDecoration(prefixText: '₹', isDense: true),
                        ),
                      ),
                      IconButton(
                        tooltip: 'Remove',
                        icon: DsIcon(DsIcons.x, size: 18, color: c.tx3),
                        onPressed: () => setState(() => _shares.remove(share)),
                      ),
                    ],
                  ),
                ),
            const SizedBox(height: 12),
            const DsLabel('Remind me'),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final (days, label) in const [(0, 'Never'), (1, 'A day before'), (2, '2 days before'), (3, '3 days before'), (7, 'A week before')])
                  DsChip(label: label, selected: _remind == days, onTap: () => setState(() => _remind = days)),
              ],
            ),
            const SizedBox(height: 16),
            DsField(
              label: 'Notes',
              child: TextField(
                controller: _notes,
                maxLines: 2,
                decoration: const InputDecoration(hintText: 'Family plan, renews on the card ending 1234'),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              DsCallout(tone: DsTone.crit, title: _error!),
            ],
            const SizedBox(height: 20),
            Row(
              children: [
                const Spacer(),
                TextButton(onPressed: _saving ? null : () => Navigator.of(context).pop(), child: const Text('Cancel')),
                const SizedBox(width: 8),
                FilledButton(
                  key: const ValueKey('sub-save'),
                  onPressed: _saving ? null : _save,
                  child: Text(_saving ? 'Saving…' : (_isEdit ? 'Save' : (widget.from != null ? 'Track it' : 'Add'))),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// A date shown as a button: tap to pick, with an optional clear.
class _DayField extends StatelessWidget {
  const _DayField({required this.label, required this.value, required this.onTap, this.onClear, this.placeholder, this.keyName});

  final String label;
  final String? value;
  final VoidCallback onTap;
  final VoidCallback? onClear;
  final String? placeholder;
  final String? keyName;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsField(
      label: label,
      child: Material(
        color: c.sf,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rLg), side: BorderSide(color: c.ln2)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: keyName == null ? null : ValueKey(keyName),
          onTap: onTap,
          child: Container(
            height: 44,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(
              children: [
                DsIcon(DsIcons.calendar, size: 18, color: c.tx2),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    value == null ? (placeholder ?? 'Pick a day') : dayWords(value!),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 14, color: value == null ? c.tx3 : c.tx),
                  ),
                ),
                if (onClear != null)
                  GestureDetector(onTap: onClear, child: DsIcon(DsIcons.x, size: 16, color: c.tx3)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
