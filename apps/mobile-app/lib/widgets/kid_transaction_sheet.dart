import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/kid_models.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/kid_service.dart';
import '../utils/format.dart';
import 'ds/ds.dart';

/// What stops a kid's transaction being saved, or null when it can be.
/// Kept apart from the sheet so the rules can be tested on their own.
String? kidTransactionProblem({required String amountText, required String? accountId}) {
  final amount = parseRupees(amountText);
  if (amount == null || amount <= 0) return 'Enter how much it was.';
  if (accountId == null) return 'Pick which pocket money this was from.';
  return null;
}

/// Add a transaction to a kid's pocket money, or change one. Returns true
/// when something was saved. Deliberately not the owner's edit sheet: a
/// kid gets the plain fields and nothing about how the parent counts it.
Future<bool?> showKidTransactionSheet(
  BuildContext context, {
  Transaction? transaction,
  required List<KidAccount> accounts,
  required List<Category> categories,
  required List<MerchantPreset> presets,
  String? accountId,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
      child: KidTransactionSheet(
        transaction: transaction,
        accounts: accounts,
        categories: categories,
        presets: presets,
        accountId: accountId,
      ),
    ),
  );
}

class KidTransactionSheet extends StatefulWidget {
  const KidTransactionSheet({
    super.key,
    this.transaction,
    required this.accounts,
    required this.categories,
    required this.presets,
    this.accountId,
  });

  /// null means "add a new one".
  final Transaction? transaction;
  final List<KidAccount> accounts;
  final List<Category> categories;
  final List<MerchantPreset> presets;

  /// The account to start on when adding, e.g. the one chosen on screen.
  final String? accountId;

  @override
  State<KidTransactionSheet> createState() => _KidTransactionSheetState();
}

class _KidTransactionSheetState extends State<KidTransactionSheet> {
  late final TextEditingController _amount;
  late final TextEditingController _merchant;
  late final TextEditingController _note;
  late bool _isDebit;
  String? _categoryId;
  String? _accountId;

  /// IST wall-clock, so the pickers show the time it happened in India.
  late DateTime _occurredAt;
  late List<MerchantPreset> _presets;
  bool _saving = false;
  String? _error;

  bool get _editing => widget.transaction != null;

  @override
  void initState() {
    super.initState();
    final t = widget.transaction;
    _amount = TextEditingController(text: t == null ? '' : _rupeesText(t.amountMinor));
    _merchant = TextEditingController(text: t?.merchant ?? '');
    _note = TextEditingController(text: t?.note ?? '');
    _isDebit = t == null || t.type == 'DEBIT';
    _categoryId = t?.category?.id;
    _occurredAt = istWallClock(t?.occurredAt ?? DateTime.now());
    _presets = List.of(widget.presets);

    final ids = widget.accounts.map((a) => a.id).toSet();
    final wanted = t?.account?.id ?? widget.accountId;
    _accountId = wanted != null && ids.contains(wanted)
        ? wanted
        : (widget.accounts.length == 1 ? widget.accounts.first.id : null);
  }

  @override
  void dispose() {
    _amount.dispose();
    _merchant.dispose();
    _note.dispose();
    super.dispose();
  }

  /// "250" for a round amount, "249.50" otherwise - what the kid would type.
  static String _rupeesText(int minor) =>
      minor % 100 == 0 ? '${minor ~/ 100}' : (minor / 100).toStringAsFixed(2);

  /// Only the categories that make sense for the way the money moved.
  List<Category> get _categories => widget.categories
      .where((c) => c.direction == 'BOTH' || c.direction == (_isDebit ? 'OUT' : 'IN') || c.id == _categoryId)
      .toList();

  // ---- Shortcuts -----------------------------------------------------

  void _applyPreset(MerchantPreset preset) {
    setState(() {
      _merchant.text = preset.merchant;
      if (preset.categoryId != null) _categoryId = preset.categoryId;
    });
    // Only orders the chips; nothing to tell the kid if it fails.
    KidService.instance.presetUsed(preset.id).catchError((_) {});
  }

  Future<void> _savePreset() async {
    final name = _merchant.text.trim();
    if (name.isEmpty) return;
    try {
      final saved = await KidService.instance.addPreset(name, _categoryId);
      if (!mounted) return;
      setState(() => _presets = [..._presets.where((p) => p.id != saved.id), saved]);
    } catch (e) {
      if (mounted) setState(() => _error = "Couldn't save the shortcut: ${_message(e)}");
    }
  }

  void _removePreset(MerchantPreset preset) {
    setState(() => _presets = _presets.where((p) => p.id != preset.id).toList());
    KidService.instance.deletePreset(preset.id).catchError((_) {});
  }

  // ---- Date ----------------------------------------------------------

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _occurredAt,
      firstDate: DateTime(2000),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked == null) return;
    setState(() => _occurredAt =
        DateTime(picked.year, picked.month, picked.day, _occurredAt.hour, _occurredAt.minute));
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(context: context, initialTime: TimeOfDay.fromDateTime(_occurredAt));
    if (picked == null) return;
    setState(() => _occurredAt =
        DateTime(_occurredAt.year, _occurredAt.month, _occurredAt.day, picked.hour, picked.minute));
  }

  // ---- Save ----------------------------------------------------------

  static String _message(Object e) => e is ApiException ? e.message : 'Check your internet and try again.';

  Future<void> _save() async {
    final problem = kidTransactionProblem(amountText: _amount.text, accountId: _accountId);
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }

    final merchant = _merchant.text.trim();
    final note = _note.text.trim();
    final body = <String, dynamic>{
      'accountId': _accountId,
      'amountMinor': parseRupees(_amount.text),
      'merchant': merchant.isEmpty ? null : merchant,
      'note': note.isEmpty ? null : note,
      'categoryId': _categoryId,
      'occurredAt': fromIstWallClock(_occurredAt).toIso8601String(),
    };

    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      if (_editing) {
        // The server keeps the way money moved as it was; it isn't sent.
        await KidService.instance.updateTransaction(widget.transaction!.id, body);
      } else {
        await KidService.instance.addTransaction({...body, 'type': _isDebit ? 'DEBIT' : 'CREDIT'});
      }
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (mounted) setState(() => _error = "Couldn't save: ${_message(e)}");
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ---- Layout --------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          const DsDragHandle(),
          Text(
            _editing ? 'Change this' : 'Add to your money',
            style: TextStyle(fontSize: 19, height: 24 / 19, fontWeight: FontWeight.w600, color: c.tx),
          ),
          const SizedBox(height: 16),
          DsSegmented<bool>(
            segments: const [(true, 'Spent'), (false, 'Got money')],
            selected: _isDebit,
            // Fixed once saved: the server doesn't let a kid flip it.
            onChanged: _editing ? null : (value) => setState(() => _isDebit = value),
          ),
          const SizedBox(height: 16),
          _label('How much'),
          const SizedBox(height: 6),
          TextField(
            key: const Key('kid-amount'),
            controller: _amount,
            autofocus: !_editing,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            style: kNum.copyWith(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
            decoration: const InputDecoration(prefixText: '₹ '),
          ),
          const SizedBox(height: 16),
          _label(_isDebit ? 'Where or what' : 'From whom'),
          const SizedBox(height: 6),
          TextField(
            controller: _merchant,
            textCapitalization: TextCapitalization.words,
            onChanged: (_) => setState(() {}),
          ),
          _presetRow(),
          const SizedBox(height: 16),
          _label('Category'),
          const SizedBox(height: 6),
          _categoryPicker(),
          const SizedBox(height: 16),
          _label('When'),
          const SizedBox(height: 6),
          Row(
            children: [
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _pickDate,
                  style: _fieldButton(c),
                  icon: DsIcon(DsIcons.calendar, size: 18, color: c.tx2),
                  label: Text(DateFormat('EEE, d MMM yyyy').format(_occurredAt)),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: _pickTime,
                style: _fieldButton(c),
                child: Text(DateFormat('h:mm a').format(_occurredAt).replaceAll('AM', 'am').replaceAll('PM', 'pm')),
              ),
            ],
          ),
          if (widget.accounts.length > 1) ...[
            const SizedBox(height: 16),
            _label('Which money'),
            const SizedBox(height: 6),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final account in widget.accounts)
                  ChoiceChip(
                    label: Text(account.label),
                    selected: _accountId == account.id,
                    onSelected: (_) => setState(() => _accountId = account.id),
                  ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          _label('Note (optional)'),
          const SizedBox(height: 6),
          TextField(
            controller: _note,
            maxLines: 2,
            minLines: 1,
            textCapitalization: TextCapitalization.sentences,
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            DsCallout(tone: DsTone.crit, title: _error!),
          ],
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving ? const DsSpinner(size: 18) : Text(_editing ? 'Save changes' : 'Add'),
          ),
        ],
      ),
    );
  }

  Widget _label(String text) => DsLabel(text);

  /// An outlined button drawn as a 52 px field (a date or time "select").
  ButtonStyle _fieldButton(DsColors c) => OutlinedButton.styleFrom(
        minimumSize: const Size(0, 52),
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
        textStyle: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w400),
        foregroundColor: c.tx,
      );

  Widget _presetRow() {
    final c = context.c;
    final typed = _merchant.text.trim();
    final canSave = typed.isNotEmpty && !_presets.any((p) => p.merchant.toLowerCase() == typed.toLowerCase());
    if (_presets.isEmpty && !canSave) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final preset in _presets)
              Padding(
                padding: const EdgeInsets.only(right: 6),
                child: InputChip(
                  label: Text(preset.merchant),
                  selected: preset.merchant.toLowerCase() == typed.toLowerCase(),
                  showCheckmark: false,
                  onPressed: () => _applyPreset(preset),
                  deleteIcon: DsIcon(
                    DsIcons.x,
                    size: 14,
                    color: preset.merchant.toLowerCase() == typed.toLowerCase() ? c.bg : c.tx3,
                  ),
                  deleteButtonTooltipMessage: 'Remove shortcut',
                  onDeleted: () => _removePreset(preset),
                ),
              ),
            if (canSave)
              ActionChip(
                avatar: DsIcon(DsIcons.plus, size: 16, color: c.ac),
                label: const Text('Save as a shortcut'),
                labelStyle: TextStyle(fontSize: 13, color: c.ac, fontWeight: FontWeight.w600),
                side: BorderSide(color: c.acLine),
                backgroundColor: c.sf,
                onPressed: _savePreset,
              ),
          ],
        ),
      ),
    );
  }

  Widget _categoryPicker() {
    final c = context.c;
    final categories = _categories;
    if (categories.isEmpty) {
      return Text('No categories to choose from yet.', style: TextStyle(fontSize: 13, color: c.tx3));
    }

    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final category in categories)
          ChoiceChip(
            avatar: Icon(
              categoryIcon(category.icon),
              size: 16,
              color: _categoryId == category.id ? c.bg : parseHexColor(category.color),
            ),
            label: Text(category.name),
            selected: _categoryId == category.id,
            showCheckmark: false,
            // Tapping the chosen one again clears it.
            onSelected: (_) => setState(() => _categoryId = _categoryId == category.id ? null : category.id),
          ),
      ],
    );
  }
}
