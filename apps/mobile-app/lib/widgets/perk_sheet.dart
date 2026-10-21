import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/perk_reader.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';

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

/// The usual places a coupon or offer comes from in India. Suggestions
/// only - anything can be typed.
const _sourceSuggestions = [
  'Google Pay',
  'PhonePe',
  'Paytm',
  'CRED',
  'Amazon Pay',
  'HDFC Bank',
  'ICICI Bank',
  'SBI Card',
  'Axis Bank',
];

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
  late final TextEditingController _source;
  late final TextEditingController _terms;

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
    _source = TextEditingController(text: perk?.source ?? draft?.source ?? '');
    _terms = TextEditingController(text: perk?.terms ?? draft?.terms ?? '');
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
    _source.dispose();
    _terms.dispose();
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
      'source': _source.text.trim().isEmpty ? null : _source.text.trim(),
      'terms': _terms.text.trim().isEmpty ? null : _terms.text.trim(),
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
          color: c.sf,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
        ),
        clipBehavior: Clip.antiAlias,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const DsDragHandle(),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 8, 8),
              child: DsSheetHeader(
                title: widget.perk == null ? 'Add a perk' : 'Edit perk',
                subtitle: 'Anything that makes a purchase cheaper, so the app can answer before you pay.',
                icon: DsIcons.tag,
                onClose: () => Navigator.of(context).pop(),
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    // Read, not saved. The model fills the form and you decide,
                    // because one that reads "20% up to ₹150" as "₹150 off" is
                    // wrong in a way nobody notices until they are at a till.
                    if (widget.draft != null) ...[
                      DsCallout(
                        tone: DsTone.ac,
                        icon: DsIcons.sparkles,
                        title: _readNote(widget.draft!),
                      ),
                      const SizedBox(height: 16),
                    ],

                    DsField(
                      label: 'Kind',
                      child: DsSegmented<String>(
                        segments: const [('COUPON', 'Coupon'), ('CARD_OFFER', 'Card offer')],
                        selected: _kind,
                        onChanged: (kind) => setState(() => _kind = kind),
                      ),
                    ),
                    const SizedBox(height: 16),

                    _field(c, 'What it is', _title, hint: _kind == 'COUPON' ? '20% off' : '5% NeuCoins'),
                    const SizedBox(height: 16),
                    _field(
                      c,
                      'Where it works',
                      _merchants,
                      hint: 'Gucci, Croma — or leave empty for anywhere',
                      help: 'Separate several with commas. Matching is forgiving, so "amazon" finds '
                          '"AMAZON PAY IN UTILITY".',
                    ),
                    const SizedBox(height: 16),

                    DsField(
                      label: _kind == 'CARD_OFFER' ? 'On which card' : 'Card (optional)',
                      child: DropdownButtonFormField<String?>(
                        initialValue: _accountId,
                        isExpanded: true,
                        icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
                        borderRadius: BorderRadius.circular(Ds.rLg),
                        dropdownColor: c.sf,
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
                    ),
                    const SizedBox(height: 16),

                    DsField(
                      label: 'Category (optional)',
                      help: 'For "5% on all dining" instead of naming shops',
                      child: DropdownButtonFormField<String?>(
                        initialValue: _categoryId,
                        isExpanded: true,
                        icon: DsIcon(DsIcons.chevronDown, size: 20, color: c.tx2),
                        borderRadius: BorderRadius.circular(Ds.rLg),
                        dropdownColor: c.sf,
                        items: [
                          const DropdownMenuItem<String?>(value: null, child: Text('Any')),
                          for (final category in widget.categories)
                            DropdownMenuItem<String?>(value: category.id, child: Text(category.name)),
                        ],
                        onChanged: (value) => setState(() => _categoryId = value),
                      ),
                    ),
                    const SizedBox(height: 16),

                    DsField(
                      label: 'How much it takes off',
                      child: DsSegmented<bool>(
                        segments: const [(true, 'Percentage'), (false, 'Flat ₹')],
                        selected: _asPercent,
                        onChanged: (asPercent) => setState(() => _asPercent = asPercent),
                      ),
                    ),
                    const SizedBox(height: 16),

                    if (_asPercent) ...[
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(child: _field(c, 'Percent off', _percent, hint: '5', numeric: true)),
                          const SizedBox(width: 12),
                          Expanded(
                            child: _field(c, 'Capped at (₹)', _maxDiscount, hint: '500', numeric: true),
                          ),
                        ],
                      ),
                    ] else
                      _field(c, 'Amount off (₹)', _flat, hint: '500', numeric: true),

                    const SizedBox(height: 16),
                    _field(c, 'Minimum spend (₹)', _minSpend, hint: '5000', numeric: true),

                    if (_kind == 'COUPON') ...[
                      const SizedBox(height: 16),
                      _field(c, 'Code', _code, hint: 'GUCCI20', mono: true),
                      const SizedBox(height: 16),
                      DsField(
                        label: 'Expires',
                        child: InkWell(
                          borderRadius: BorderRadius.circular(Ds.rMd),
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
                            decoration: InputDecoration(
                              suffixIcon: Padding(
                                padding: const EdgeInsets.only(right: 12),
                                child: DsIcon(DsIcons.calendar, size: 20, color: c.tx2),
                              ),
                              suffixIconConstraints: const BoxConstraints(minWidth: 32, minHeight: 20),
                            ),
                            child: Text(
                              _expiresOn == null
                                  ? 'No expiry'
                                  : '${_expiresOn!.day}/${_expiresOn!.month}/${_expiresOn!.year}',
                              style: TextStyle(
                                fontSize: 15,
                                color: _expiresOn == null ? c.tx3 : c.tx,
                                fontFeatures: Ds.tabular,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],

                    const SizedBox(height: 16),
                    _field(c, 'From (app or bank)', _source, hint: 'Google Pay, CRED, HDFC Bank…'),
                    const SizedBox(height: 8),
                    // Tap to fill rather than a dropdown: the list is a shortcut,
                    // and a bank not on it still has to be typeable.
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final suggestion in _sourceSuggestions)
                          if (suggestion.toLowerCase() != _source.text.trim().toLowerCase())
                            DsChip(
                              label: suggestion,
                              height: 32,
                              onTap: () => setState(() => _source.text = suggestion),
                            ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    DsField(
                      label: 'Terms & conditions',
                      child: TextField(
                        controller: _terms,
                        minLines: 2,
                        maxLines: 6,
                        style: TextStyle(color: c.tx, fontSize: 15),
                        decoration: const InputDecoration(
                          hintText: 'Valid once per user. Not on sale items.',
                        ),
                      ),
                    ),

                    // What was read off the screenshot, for checking the fields
                    // above against. Not editable: it is a record of the picture.
                    if ((widget.perk?.extractedText?.trim() ?? '').isNotEmpty) ...[
                      const SizedBox(height: 16),
                      const DsLabel('Text read from the screenshot'),
                      const SizedBox(height: 6),
                      Container(
                        width: double.infinity,
                        constraints: const BoxConstraints(maxHeight: 220),
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: c.sf2,
                          border: Border.all(color: c.ln),
                          borderRadius: BorderRadius.circular(Ds.rMd),
                        ),
                        child: SingleChildScrollView(
                          child: SelectableText(
                            widget.perk!.extractedText!.trim(),
                            style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx2),
                          ),
                        ),
                      ),
                    ],

                    if (_error != null) ...[
                      const SizedBox(height: 16),
                      DsCallout(title: _error!, tone: DsTone.crit),
                    ],
                  ],
                ),
              ),
            ),
            // The footer stays put while the form scrolls.
            Container(
              decoration: BoxDecoration(color: c.sf2, border: Border(top: BorderSide(color: c.ln))),
              padding: EdgeInsets.fromLTRB(16, 12, 16, 12 + MediaQuery.of(context).padding.bottom),
              child: Row(
                children: [
                  const Spacer(),
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    style: TextButton.styleFrom(minimumSize: const Size(64, 48)),
                    child: const Text('Cancel'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _saving || _title.text.trim().isEmpty ? null : _save,
                    child: Text(_saving ? 'Saving…' : 'Save'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _field(
    DsColors c,
    String label,
    TextEditingController controller, {
    String? hint,
    String? help,
    bool numeric = false,
    bool mono = false,
  }) {
    return DsField(
      label: label,
      help: help,
      child: TextField(
        controller: controller,
        keyboardType: numeric ? const TextInputType.numberWithOptions(decimal: true) : null,
        style: mono
            ? kMono.copyWith(color: c.tx, fontSize: 15)
            : TextStyle(color: c.tx, fontSize: 15, fontFeatures: numeric ? Ds.tabular : null),
        // Rebuilt on every keystroke so the save button can turn on the
        // moment there is a title to save.
        onChanged: (_) => setState(() {}),
        decoration: InputDecoration(hintText: hint),
      ),
    );
  }
}
