import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/api_client.dart';
import '../theme.dart';

/// The full card details, behind a PIN.
///
/// Locked is the resting state and the only one that survives leaving the
/// screen — there is no unlock that lasts, because the server checks the
/// PIN on the request that reveals and on no other. Shown details put
/// themselves away after a minute, so a card number is not left on a phone
/// somebody sets down.
///
/// There is no CVV here and no field for one. It is the single value that
/// turns a stolen number into someone else's purchase, and its owner knows
/// it by heart.
class CardVaultPanel extends StatefulWidget {
  const CardVaultPanel({
    super.key,
    required this.accountId,
    required this.last4,
    required this.hasDetails,
    required this.onChanged,
  });

  final String accountId;
  final String? last4;
  final bool hasDetails;
  final VoidCallback onChanged;

  @override
  State<CardVaultPanel> createState() => _CardVaultPanelState();
}

/// How long a revealed card stays on screen.
const _hideAfter = Duration(minutes: 1);

class _CardVaultPanelState extends State<CardVaultPanel> {
  bool _hasPin = false;
  bool _available = true;
  DateTime? _lockedUntil;

  Map<String, dynamic>? _revealed;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _status();
  }

  @override
  void didUpdateWidget(covariant CardVaultPanel old) {
    super.didUpdateWidget(old);
    // Back to locked when the card changes underneath, so switching tabs
    // never carries one card's details onto another's panel.
    if (old.accountId != widget.accountId) setState(() => _revealed = null);
  }

  Future<void> _status() async {
    try {
      final json = await ApiClient.instance.get('/vault') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _hasPin = json['hasPin'] as bool? ?? false;
        _available = json['available'] as bool? ?? true;
        _lockedUntil = DateTime.tryParse((json['lockedUntil'] as String?) ?? '');
      });
    } catch (_) {
      // The panel simply offers nothing.
    }
  }

  Future<void> _reveal(String pin) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final json = await ApiClient.instance
          .post('/vault/cards/${widget.accountId}/reveal', {'pin': pin}) as Map<String, dynamic>;
      if (!mounted) return;
      setState(() => _revealed = json);

      Future.delayed(_hideAfter, () {
        if (mounted) setState(() => _revealed = null);
      });
    } catch (error) {
      if (mounted) {
        setState(() => _error = error is ApiException ? error.message : "That didn't work.");
      }
      await _status();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final lockedOut = _lockedUntil != null && _lockedUntil!.isAfter(DateTime.now());

    return Container(
      margin: const EdgeInsets.only(top: 14),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.paper,
        border: Border.all(color: _revealed != null ? c.brand : c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.lock_outline, size: 16, color: c.muted),
              const SizedBox(width: 8),
              const Text('Card details',
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
              const Spacer(),
              Text(
                '•••• ${widget.last4 ?? '••••'}',
                style: kNum.copyWith(fontSize: 13, color: c.muted, letterSpacing: 1.2),
              ),
            ],
          ),
          const SizedBox(height: 10),
          if (!_available)
            Text(
              'The server has no encryption key set, so card details cannot be stored yet.',
              style: TextStyle(fontSize: 11.5, height: 1.45, color: c.muted),
            )
          else if (!_hasPin)
            _hint(
              'Card details are kept encrypted and shown only after a PIN.',
              action: OutlinedButton(onPressed: _setPin, child: const Text('Set a PIN')),
            )
          else if (_revealed != null)
            _shown(_revealed!)
          else if (!widget.hasDetails)
            _hint(
              'Nothing stored for this card yet. The number, expiry and name are encrypted; '
              'the CVV is never kept.',
              action: OutlinedButton(onPressed: _edit, child: const Text('Add card details')),
            )
          else if (lockedOut)
            Text(
              'Too many wrong PINs. Try again after '
              '${TimeOfDay.fromDateTime(_lockedUntil!).format(context)}.',
              style: TextStyle(fontSize: 12, color: c.warn),
            )
          else
            OutlinedButton.icon(
              onPressed: _busy ? null : _askPin,
              icon: const Icon(Icons.visibility_outlined, size: 17),
              label: Text(_busy ? 'Checking…' : 'Show details'),
            ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(fontSize: 11.5, color: c.debit)),
          ],
        ],
      ),
    );
  }

  Widget _hint(String text, {required Widget action}) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text, style: TextStyle(fontSize: 11.5, height: 1.45, color: context.c.muted)),
          const SizedBox(height: 10),
          action,
        ],
      );

  Widget _shown(Map<String, dynamic> card) {
    final c = context.c;
    final number = (card['number'] as String?) ?? '';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _field('Card number', _spaced(number), mono: true, copyable: number),
        _field('Expires', (card['expiry'] as String?) ?? '—'),
        _field('Name on card', (card['nameOnCard'] as String?) ?? '—'),
        if ((card['note'] as String?)?.isNotEmpty ?? false) _field('Note', card['note'] as String),
        const SizedBox(height: 6),
        Row(
          children: [
            TextButton.icon(
              onPressed: () => setState(() => _revealed = null),
              icon: const Icon(Icons.lock_outline, size: 16),
              label: const Text('Hide'),
            ),
            TextButton(onPressed: _edit, child: const Text('Replace')),
          ],
        ),
        Text(
          'Hides itself in a minute. No CVV is stored.',
          style: TextStyle(fontSize: 11, color: c.mutedLight),
        ),
      ],
    );
  }

  Widget _field(String label, String value, {bool mono = false, String? copyable}) {
    final c = context.c;

    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label.toUpperCase(),
            style: TextStyle(
              fontSize: 9.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.5,
              color: c.muted,
            ),
          ),
          const SizedBox(height: 3),
          Row(
            children: [
              Expanded(
                child: Text(
                  value,
                  style: mono
                      ? kNum.copyWith(fontSize: 16, letterSpacing: 1.4)
                      : const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                ),
              ),
              if (copyable != null)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.copy_outlined, size: 16),
                  tooltip: 'Copy',
                  onPressed: () {
                    Clipboard.setData(ClipboardData(text: copyable));
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Copied. Your clipboard now has it too.')),
                    );
                  },
                ),
            ],
          ),
        ],
      ),
    );
  }

  /// Groups of four, which is how a card number is read aloud.
  String _spaced(String number) =>
      number.replaceAllMapped(RegExp(r'.{4}'), (match) => '${match.group(0)} ').trim();

  Future<void> _askPin() async {
    final pin = await showDialog<String>(context: context, builder: (_) => const _PinDialog());
    if (pin != null) await _reveal(pin);
  }

  Future<void> _setPin() async {
    final set = await showDialog<bool>(context: context, builder: (_) => const _SetPinDialog());
    if (set == true) await _status();
  }

  Future<void> _edit() async {
    final saved = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _EditCardSheet(accountId: widget.accountId),
    );
    if (saved == true) {
      if (mounted) setState(() => _revealed = null);
      widget.onChanged();
    }
  }
}

class _PinDialog extends StatefulWidget {
  const _PinDialog();

  @override
  State<_PinDialog> createState() => _PinDialogState();
}

class _PinDialogState extends State<_PinDialog> {
  final _pin = TextEditingController();

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Your PIN'),
        content: TextField(
          controller: _pin,
          autofocus: true,
          obscureText: true,
          keyboardType: TextInputType.number,
          maxLength: 6,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(counterText: ''),
          onSubmitted: (value) => Navigator.of(context).pop(value),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(_pin.text),
            child: const Text('Show'),
          ),
        ],
      );
}

class _SetPinDialog extends StatefulWidget {
  const _SetPinDialog();

  @override
  State<_SetPinDialog> createState() => _SetPinDialogState();
}

class _SetPinDialogState extends State<_SetPinDialog> {
  final _pin = TextEditingController();
  final _again = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    _pin.dispose();
    _again.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_pin.text != _again.text) return setState(() => _error = "Those two don't match.");

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ApiClient.instance.put('/vault/pin', {'pin': _pin.text});
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      if (mounted) {
        setState(() => _error = error is ApiException ? error.message : "That didn't work.");
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Choose a PIN'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final (controller, label) in [(_pin, 'New PIN'), (_again, 'Again')])
              TextField(
                controller: controller,
                obscureText: true,
                keyboardType: TextInputType.number,
                maxLength: 6,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: InputDecoration(labelText: label, counterText: ''),
              ),
            const SizedBox(height: 8),
            Text(
              'Four to six digits, and the same PIN unlocks every card. Five wrong tries locks it '
              'for fifteen minutes.',
              style: TextStyle(fontSize: 11.5, height: 1.4, color: context.c.muted),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(fontSize: 12, color: context.c.debit)),
            ],
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: _busy || _pin.text.length < 4 ? null : _save,
            child: Text(_busy ? 'Saving…' : 'Set PIN'),
          ),
        ],
      );
}

class _EditCardSheet extends StatefulWidget {
  const _EditCardSheet({required this.accountId});

  final String accountId;

  @override
  State<_EditCardSheet> createState() => _EditCardSheetState();
}

class _EditCardSheetState extends State<_EditCardSheet> {
  final _number = TextEditingController();
  final _expiry = TextEditingController();
  final _name = TextEditingController();
  final _note = TextEditingController();
  final _pin = TextEditingController();
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    for (final controller in [_number, _expiry, _name, _note, _pin]) {
      controller.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ApiClient.instance.put('/vault/cards/${widget.accountId}', {
        'pin': _pin.text,
        'number': _number.text,
        'expiry': _expiry.text.isEmpty ? null : _expiry.text,
        'nameOnCard': _name.text.isEmpty ? null : _name.text,
        'note': _note.text.isEmpty ? null : _note.text,
      });
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      if (mounted) {
        setState(() => _error = error is ApiException ? error.message : "That didn't work.");
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Padding(
      padding: EdgeInsets.fromLTRB(16, 18, 16, MediaQuery.of(context).viewInsets.bottom + 20),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Card details', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
            const SizedBox(height: 14),
            TextField(
              controller: _number,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(
                labelText: 'Card number',
                hintText: '5252 2525 2525 6623',
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _expiry,
                    decoration: const InputDecoration(labelText: 'Expires', hintText: '08/29'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _name,
                    textCapitalization: TextCapitalization.characters,
                    decoration: const InputDecoration(labelText: 'Name on card'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _note,
              decoration: const InputDecoration(labelText: 'Note'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _pin,
              obscureText: true,
              keyboardType: TextInputType.number,
              maxLength: 6,
              inputFormatters: [FilteringTextInputFormatter.digitsOnly],
              decoration: const InputDecoration(labelText: 'Your PIN', counterText: ''),
            ),
            const SizedBox(height: 6),
            Text(
              'There is no CVV field, on purpose — it is the one thing that makes a stolen number '
              'spendable, and you already know yours.',
              style: TextStyle(fontSize: 11.5, height: 1.45, color: c.muted),
            ),
            if (_error != null) ...[
              const SizedBox(height: 10),
              Text(_error!, style: TextStyle(fontSize: 12, color: c.debit)),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: FilledButton(
                    onPressed: _busy ? null : _save,
                    child: Text(_busy ? 'Saving…' : 'Save'),
                  ),
                ),
                const SizedBox(width: 10),
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Cancel'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
