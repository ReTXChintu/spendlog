import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/perk_reader.dart';
import '../services/api_client.dart';
import '../theme.dart';

/// Add or edit one perk.
///
/// The kind comes first because it changes what the rest means. A card
/// offer is attached to a card and stands until the bank changes it; a
/// coupon has a code, an expiry, and is gone once used.
class PerkSheet extends StatefulWidget {
  /// null means "add a new one".
  final Perk? perk;

  /// What a model made of a picture, to start from. Every field is still
  /// editable and nothing is saved until you save it — the model proposes
  /// and you decide, because one that reads "20% up to ₹150" as "₹150
  /// off" is wrong in a way you would only notice at a till.
  final PerkDraft? draft;

  final List<Account> accounts;
  final List<Category> categories;

  const PerkSheet({
    super.key,
    this.perk,
    this.draft,
    required this.accounts,
    required this.categories,
  });

  @override
  State<PerkSheet> createState() => _PerkSheetState();
}

/// What a missing field is called in the sentence that names it.
const _missingLabel = {
  'title': 'a name',
  'discount': 'what it takes off',
  'expiresOn': 'when it runs out',
  'code': 'the code',
};

/// Minor units as whole rupees, for a field somebody types into.
String _rupees(int? minor) => minor == null ? '' : (minor ~/ 100).toString();

class _PerkSheetState extends State<PerkSheet> {
  late final TextEditingController _title;
  late final TextEditingController _merchants;
  late final TextEditingController _percent;
  late final TextEditingController _flat;
  late final TextEditingController _maxDiscount;
  late final TextEditingController _minSpend;
  late final TextEditingController _code;

  late String _kind;
  late bool _asPercent;
  String? _accountId;
  String? _categoryId;
  DateTime? _expiresOn;

  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final perk = widget.perk;
    final draft = widget.draft;

    _kind = perk?.kind ?? draft?.kind ?? 'COUPON';
    _asPercent = (perk?.flatMinor ?? draft?.flatMinor) == null;
    _accountId = perk?.accountId ?? draft?.accountId;
    _expiresOn = perk?.expiresOn ?? draft?.expiresOn;

    _title = TextEditingController(text: perk?.title ?? draft?.title ?? '');
    _merchants = TextEditingController(
      text: perk?.merchants.join(', ') ?? draft?.merchants.join(', ') ?? '',
    );
    _percent = TextEditingController(
      text: (perk?.percent ?? draft?.percent)?.toString() ?? '',
    );
    _flat = TextEditingController(text: _rupees(perk?.flatMinor ?? draft?.flatMinor));
    _maxDiscount = TextEditingController(
      text: _rupees(perk?.maxDiscountMinor ?? draft?.maxDiscountMinor),
    );
    _minSpend = TextEditingController(
      text: _rupees(perk?.minSpendMinor ?? draft?.minSpendMinor),
    );
    _code = TextEditingController(text: perk?.code ?? draft?.code ?? '');
  }

  @override
  void dispose() {
    _title.dispose();
    _merchants.dispose();
    _percent.dispose();
    _flat.dispose();
    _maxDiscount.dispose();
    _minSpend.dispose();
    _code.dispose();
    super.dispose();
  }

  int? _minorOrNull(TextEditingController controller) {
    final value = double.tryParse(controller.text.trim());
    return value == null ? null : (value * 100).round();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });

    final navigator = Navigator.of(context);
    final body = {
      'kind': _kind,
      'title': _title.text.trim(),
      'merchants':
          _merchants.text.split(',').map((m) => m.trim()).where((m) => m.isNotEmpty).toList(),
      'accountId': _accountId,
      'categoryId': _categoryId,
      'percent': _asPercent ? double.tryParse(_percent.text.trim()) : null,
      'flatMinor': _asPercent ? null : _minorOrNull(_flat),
      'maxDiscountMinor': _asPercent ? _minorOrNull(_maxDiscount) : null,
      'minSpendMinor': _minorOrNull(_minSpend),
      'expiresOn': _expiresOn?.toIso8601String(),
      'code': _code.text.trim().isEmpty ? null : _code.text.trim(),
    };

    try {
      if (widget.perk == null) {
        await ApiClient.instance.post('/perks', body);
      } else {
        await ApiClient.instance.patch('/perks/${widget.perk!.id}', body);
      }
      navigator.pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error is ApiException ? error.message : "Couldn't save that.";
        _saving = false;
      });
    }
  }

  /// What the banner says: where it came from, what it could not find,
  /// and the card it named that is not one of yours.
  String _readNote(PerkDraft draft) {
    final parts = <String>['Read from your picture.'];

    if (draft.missing.isEmpty) {
      parts.add('Check it over before saving.');
    } else {
      final named = draft.missing.map((field) => _missingLabel[field] ?? field).join(', ');
      parts.add('Check it over — it could not find $named.');
    }

    if (draft.cardNamed != null && draft.accountId == null) {
      parts.add(
        'It says this is for ${draft.cardNamed}, which is not one of your cards — pick the right '
        'one below, or leave it blank.',
      );
    }

    return parts.join(' ');
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final cards = widget.accounts
        .where((account) => account.accountType == 'CARD' || account.accountType == 'DEBIT')
        .toList();

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        decoration: BoxDecoration(
          color: c.surface,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(T.rLg)),
        ),
        padding: const EdgeInsets.fromLTRB(20, 18, 20, 24),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                widget.perk == null ? 'Add a perk' : 'Edit perk',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: c.ink),
              ),
              const SizedBox(height: 3),
              Text(
                'Anything that makes a purchase cheaper, so the app can answer before you pay.',
                style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
              ),
              const SizedBox(height: 16),

              // Read, not saved. The model fills the form and you decide,
              // because one that reads "20% up to ₹150" as "₹150 off" is
              // wrong in a way nobody notices until they are at a till.
              if (widget.draft != null) ...[
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: c.brand50,
                    border: Border.all(color: c.brand),
                    borderRadius: BorderRadius.circular(T.rMd),
                  ),
                  child: Text(
                    _readNote(widget.draft!),
                    style: TextStyle(fontSize: 12, height: 1.5, color: c.ink70),
                  ),
                ),
                const SizedBox(height: 16),
              ],

              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'COUPON', label: Text('Coupon')),
                  ButtonSegment(value: 'CARD_OFFER', label: Text('Card offer')),
                ],
                selected: {_kind},
                onSelectionChanged: (selection) => setState(() => _kind = selection.first),
              ),
              const SizedBox(height: 16),

              _field(c, 'What it is', _title, hint: _kind == 'COUPON' ? '20% off' : '5% NeuCoins'),
              const SizedBox(height: 12),
              _field(
                c,
                'Where it works',
                _merchants,
                hint: 'Gucci, Croma — or leave empty for anywhere',
              ),
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: Text(
                  'Separate several with commas. Matching is forgiving, so "amazon" finds '
                  '"AMAZON PAY IN UTILITY".',
                  style: TextStyle(fontSize: 11, height: 1.4, color: c.mutedLight),
                ),
              ),
              const SizedBox(height: 12),

              DropdownButtonFormField<String?>(
                initialValue: _accountId,
                decoration: InputDecoration(
                  labelText: _kind == 'CARD_OFFER' ? 'On which card' : 'Card (optional)',
                  isDense: true,
                ),
                items: [
                  DropdownMenuItem<String?>(
                    value: null,
                    child: Text(_kind == 'CARD_OFFER' ? 'Pick one…' : 'Any card'),
                  ),
                  for (final card in cards)
                    DropdownMenuItem<String?>(value: card.id, child: Text(card.label)),
                ],
                onChanged: (value) => setState(() => _accountId = value),
              ),
              const SizedBox(height: 12),

              DropdownButtonFormField<String?>(
                initialValue: _categoryId,
                decoration: const InputDecoration(
                  labelText: 'Category (optional)',
                  helperText: 'For "5% on all dining" instead of naming shops',
                  isDense: true,
                ),
                items: [
                  const DropdownMenuItem<String?>(value: null, child: Text('Any')),
                  for (final category in widget.categories)
                    DropdownMenuItem<String?>(value: category.id, child: Text(category.name)),
                ],
                onChanged: (value) => setState(() => _categoryId = value),
              ),
              const SizedBox(height: 16),

              SegmentedButton<bool>(
                segments: const [
                  ButtonSegment(value: true, label: Text('Percentage')),
                  ButtonSegment(value: false, label: Text('Flat ₹')),
                ],
                selected: {_asPercent},
                onSelectionChanged: (selection) => setState(() => _asPercent = selection.first),
              ),
              const SizedBox(height: 12),

              if (_asPercent) ...[
                Row(
                  children: [
                    Expanded(child: _field(c, 'Percent off', _percent, hint: '5', numeric: true)),
                    const SizedBox(width: 10),
                    Expanded(
                      child: _field(c, 'Capped at (₹)', _maxDiscount, hint: '500', numeric: true),
                    ),
                  ],
                ),
              ] else
                _field(c, 'Amount off (₹)', _flat, hint: '500', numeric: true),

              const SizedBox(height: 12),
              _field(c, 'Minimum spend (₹)', _minSpend, hint: '5000', numeric: true),

              if (_kind == 'COUPON') ...[
                const SizedBox(height: 12),
                _field(c, 'Code', _code, hint: 'GUCCI20'),
                const SizedBox(height: 12),
                InkWell(
                  onTap: () async {
                    final picked = await showDatePicker(
                      context: context,
                      initialDate: _expiresOn ?? DateTime.now().add(const Duration(days: 30)),
                      firstDate: DateTime.now().subtract(const Duration(days: 365)),
                      lastDate: DateTime.now().add(const Duration(days: 365 * 3)),
                    );
                    if (picked != null) setState(() => _expiresOn = picked);
                  },
                  child: InputDecorator(
                    decoration: const InputDecoration(labelText: 'Expires', isDense: true),
                    child: Text(
                      _expiresOn == null
                          ? 'No expiry'
                          : '${_expiresOn!.day}/${_expiresOn!.month}/${_expiresOn!.year}',
                      style: TextStyle(color: _expiresOn == null ? c.mutedLight : c.ink),
                    ),
                  ),
                ),
              ],

              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: TextStyle(fontSize: 12.5, color: c.debit)),
              ],

              const SizedBox(height: 20),
              Row(
                children: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                  const Spacer(),
                  FilledButton(
                    onPressed: _saving || _title.text.trim().isEmpty ? null : _save,
                    child: Text(_saving ? 'Saving…' : 'Save'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _field(
    SpendColors c,
    String label,
    TextEditingController controller, {
    String? hint,
    bool numeric = false,
  }) {
    return TextField(
      controller: controller,
      keyboardType: numeric ? const TextInputType.numberWithOptions(decimal: true) : null,
      style: TextStyle(color: c.ink),
      // Rebuilt on every keystroke so the save button can turn on the
      // moment there is a title to save.
      onChanged: (_) => setState(() {}),
      decoration: InputDecoration(labelText: label, hintText: hint, isDense: true),
    );
  }
}
