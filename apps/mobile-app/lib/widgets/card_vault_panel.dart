import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../services/api_client.dart';
import '../services/vault_session.dart';
import 'ds/ds.dart';

/// The full card or bank account details, behind a PIN.
///
/// One PIN entry opens every account at once, through [VaultSession]: the
/// details stay readable for a few minutes, across every card and account
/// on the screen, and then lock themselves - sooner if the app goes to the
/// background. While it is open, changing or removing details does not ask
/// for the PIN again; while it is locked, anything that reads or changes
/// details asks first.
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
    this.isBank = false,
  });

  final String accountId;
  final String? last4;
  final bool hasDetails;
  final VoidCallback onChanged;

  /// A bank account: an account number, IFSC and holder rather than a
  /// card number, expiry and name on card.
  final bool isBank;

  @override
  State<CardVaultPanel> createState() => _CardVaultPanelState();
}

class _CardVaultPanelState extends State<CardVaultPanel> {
  final VaultSession _session = VaultSession.instance;

  bool _hasPin = false;
  bool _available = true;
  DateTime? _lockedUntil;

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
    // An error about one account should not follow onto the next.
    if (old.accountId != widget.accountId) setState(() => _error = null);
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

  String _failure(Object error) => error is ApiException ? error.message : "That didn't work.";

  /// Unlocks every account at once, not only this one.
  Future<void> _unlock() async {
    final pin = await _askPin(action: 'Show');
    if (pin == null) return;

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await _session.unlock(pin);
    } catch (error) {
      if (mounted) setState(() => _error = _failure(error));
      await _status();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _askPin({required String action}) => askVaultPin(context, action: action);

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(listenable: _session, builder: (context, _) => _panel());
  }

  Widget _panel() {
    final c = context.c;
    final lockedOut = _lockedUntil != null && _lockedUntil!.isAfter(DateTime.now());
    final unlocked = _session.isUnlocked;
    final details = _session.detailsFor(widget.accountId);
    final what = widget.isBank ? 'account' : 'card';

    return Container(
      margin: const EdgeInsets.only(top: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        // Open details read as a selected item: the accent tint and ring.
        color: details != null ? c.acSoft : c.sf,
        border: Border.all(color: details != null ? c.acLine : c.ln),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              DsIconTile(
                unlocked ? Icons.lock_open_outlined : DsIcons.lock,
                tone: unlocked ? DsTone.ac : DsTone.neutral,
                size: 36,
                onTinted: details != null,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  widget.isBank ? 'Account details' : 'Card details',
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              Text(
                '•••• ${widget.last4 ?? '••••'}',
                style: kMono.copyWith(fontSize: 13, color: c.tx3, letterSpacing: 13 * .12),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (!_available)
            Text(
              'The server has no encryption key set, so $what details cannot be stored yet.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
            )
          else if (!_hasPin)
            _hint(
              widget.isBank
                  ? 'Account details are kept encrypted and shown only after a PIN.'
                  : 'Card details are kept encrypted and shown only after a PIN.',
              action: OutlinedButton(onPressed: _setPin, child: const Text('Set a PIN')),
            )
          else if (details != null)
            _shown(details)
          else if (unlocked || !widget.hasDetails)
            _hint(
              widget.isBank
                  ? 'Nothing stored for this account yet. The account number, IFSC and holder are '
                      'encrypted.'
                  : 'Nothing stored for this card yet. The number, expiry and name are encrypted; '
                      'the CVV is never kept.',
              action: OutlinedButton(
                onPressed: () => _edit(null),
                child: Text(widget.isBank ? 'Add account details' : 'Add card details'),
              ),
            )
          else if (lockedOut)
            DsCallout(
              tone: DsTone.warn,
              icon: DsIcons.lock,
              title: 'Too many wrong PINs. Try again after '
                  '${TimeOfDay.fromDateTime(_lockedUntil!).format(context)}.',
            )
          else ...[
            OutlinedButton.icon(
              onPressed: _busy ? null : _unlock,
              icon: const DsIcon(DsIcons.eye, size: 18),
              label: Text(_busy ? 'Checking…' : 'Show details'),
            ),
            const SizedBox(height: 8),
            Text(
              'One PIN shows every card and account for five minutes.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ],
          if (unlocked && details == null && _hasPin && _available) _unlockedNote(),
          if (_error != null) ...[
            const SizedBox(height: 8),
            Text(_error!, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.crit)),
          ],
        ],
      ),
    );
  }

  Widget _hint(String text, {required Widget action}) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text, style: TextStyle(fontSize: 13, height: 18 / 13, color: context.c.tx2)),
          const SizedBox(height: 12),
          action,
        ],
      );

  /// How long the vault stays open, and the way to shut it now.
  Widget _unlockedNote() {
    final c = context.c;
    final minutes = _session.minutesLeft;

    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Unlocked for $minutes more ${minutes == 1 ? 'minute' : 'minutes'}'
              '${widget.isBank ? '.' : '. No CVV is stored.'}',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
          ),
          TextButton.icon(
            onPressed: _session.lock,
            icon: const DsIcon(DsIcons.lock, size: 16),
            label: const Text('Lock'),
          ),
        ],
      ),
    );
  }

  Widget _shown(VaultDetails details) {
    final isBank = widget.isBank;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (isBank) ...[
          _field('Account number', details.number, mono: true, copyable: details.number),
          _field('IFSC', details.ifsc ?? '—', mono: details.ifsc != null, copyable: details.ifsc),
          _field('Account holder', details.nameOnCard ?? '—'),
        ] else ...[
          _field('Card number', _spaced(details.number), mono: true, copyable: details.number),
          _field('Expires', details.expiry ?? '—'),
          _field('Name on card', details.nameOnCard ?? '—'),
        ],
        if (details.note?.isNotEmpty ?? false) _field('Note', details.note!),
        Wrap(
          spacing: 4,
          children: [
            TextButton(onPressed: () => _edit(details), child: const Text('Change')),
            TextButton(
              onPressed: _busy ? null : _remove,
              style: TextButton.styleFrom(foregroundColor: context.c.crit),
              child: const Text('Remove'),
            ),
          ],
        ),
        _unlockedNote(),
      ],
    );
  }

  Widget _field(String label, String value, {bool mono = false, String? copyable}) {
    final c = context.c;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsLabel(label),
          const SizedBox(height: 4),
          Row(
            children: [
              Expanded(
                child: Text(
                  value,
                  style: mono
                      ? kMono.copyWith(fontSize: 16, letterSpacing: 16 * .1, color: c.tx)
                      : TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                ),
              ),
              if (copyable != null && copyable.isNotEmpty)
                IconButton(
                  visualDensity: VisualDensity.compact,
                  icon: Icon(Icons.copy_outlined, size: 18, color: c.tx2),
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

  Future<void> _setPin() async {
    final set = await showDialog<bool>(context: context, builder: (_) => const _SetPinDialog());
    if (set == true) await _status();
  }

  Future<void> _edit(VaultDetails? existing) async {
    final pin = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _EditDetailsSheet(
        accountId: widget.accountId,
        isBank: widget.isBank,
        existing: existing,
        sessionPin: _session.pin,
      ),
    );
    if (pin == null) return;

    // Saved. Show what the server now holds - and if the PIN had to be
    // typed for this, that was the one entry: open the vault with it.
    try {
      if (_session.isUnlocked) {
        await _session.refresh(widget.accountId);
      } else {
        await _session.unlock(pin);
      }
    } catch (_) {
      // Saved either way; the details are one tap on Show away.
    }
    widget.onChanged();
  }

  Future<void> _remove() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(widget.isBank ? 'Remove these account details?' : 'Remove these card details?'),
        content: const Text(
          'The stored number and everything with it is deleted. The account itself and its '
          'transactions stay.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (sure != true || !mounted) return;

    final pin = _session.pin ?? await _askPin(action: 'Remove');
    if (pin == null) return;

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ApiClient.instance.delete('/vault/cards/${widget.accountId}', {'pin': pin});
      _session.forget(widget.accountId);
      widget.onChanged();
    } catch (error) {
      if (mounted) setState(() => _error = _failure(error));
      await _status();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

/// Asks for the vault PIN. Null when the dialog is cancelled.
///
/// The one prompt for it everywhere - the details here, and the eye on a
/// card's face on Home - so the PIN is always asked for the same way.
Future<String?> askVaultPin(BuildContext context, {String action = 'Show'}) =>
    showDialog<String>(context: context, builder: (_) => VaultPinDialog(action: action));

class VaultPinDialog extends StatefulWidget {
  const VaultPinDialog({super.key, required this.action});

  /// The confirm button's label: Show, Remove.
  final String action;

  @override
  State<VaultPinDialog> createState() => _VaultPinDialogState();
}

class _VaultPinDialogState extends State<VaultPinDialog> {
  final _pin = TextEditingController();

  @override
  void dispose() {
    _pin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const _DialogTitle('Your PIN'),
        content: DsPasswordField(
          controller: _pin,
          noun: 'PIN',
          pin: true,
          autofocus: true,
          maxLength: 6,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(counterText: ''),
          onSubmitted: (value) => Navigator.of(context).pop(value),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(_pin.text),
            child: Text(widget.action),
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
      // Whatever was open was opened with the old PIN.
      VaultSession.instance.lock();
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
        title: const _DialogTitle('Choose a PIN'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final (controller, label) in [(_pin, 'New PIN'), (_again, 'Again')]) ...[
              DsField(
                label: label,
                child: DsPasswordField(
                  controller: controller,
                  noun: 'PIN',
                  pin: true,
                  maxLength: 6,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(counterText: ''),
                ),
              ),
              const SizedBox(height: 12),
            ],
            Text(
              'Four to six digits, and the same PIN unlocks every card and account. Five wrong '
              'tries locks it for fifteen minutes.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: context.c.tx3),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: TextStyle(fontSize: 12, height: 16 / 12, color: context.c.crit)),
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

/// Adding or replacing one account's details. Pops with the PIN that was
/// used when it saved, and with nothing when it did not.
class _EditDetailsSheet extends StatefulWidget {
  const _EditDetailsSheet({
    required this.accountId,
    required this.isBank,
    this.existing,
    this.sessionPin,
  });

  final String accountId;
  final bool isBank;
  final VaultDetails? existing;

  /// The unlocked vault's PIN. When there is one, the sheet does not ask.
  final String? sessionPin;

  @override
  State<_EditDetailsSheet> createState() => _EditDetailsSheetState();
}

class _EditDetailsSheetState extends State<_EditDetailsSheet> {
  late final _number = TextEditingController(text: widget.existing?.number ?? '');
  late final _expiry = TextEditingController(text: widget.existing?.expiry ?? '');
  late final _ifsc = TextEditingController(text: widget.existing?.ifsc ?? '');
  late final _name = TextEditingController(text: widget.existing?.nameOnCard ?? '');
  late final _note = TextEditingController(text: widget.existing?.note ?? '');
  final _pin = TextEditingController();
  late String? _sessionPin = widget.sessionPin;
  String? _error;
  bool _busy = false;

  @override
  void dispose() {
    for (final controller in [_number, _expiry, _ifsc, _name, _note, _pin]) {
      controller.dispose();
    }
    super.dispose();
  }

  String? _orNull(TextEditingController controller) {
    final text = controller.text.trim();
    return text.isEmpty ? null : text;
  }

  Future<void> _save() async {
    final pin = _sessionPin ?? _pin.text;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ApiClient.instance.put('/vault/cards/${widget.accountId}', {
        'pin': pin,
        'number': _number.text.trim(),
        if (!widget.isBank) 'expiry': _orNull(_expiry),
        if (widget.isBank) 'ifsc': _orNull(_ifsc),
        'nameOnCard': _orNull(_name),
        'note': _orNull(_note),
      });
      if (mounted) Navigator.of(context).pop(pin);
    } catch (error) {
      // The PIN the vault was opened with has stopped working - changed
      // on another device, say. Lock it and ask for the PIN here instead.
      if (error is ApiException && error.statusCode == 403 && _sessionPin != null) {
        VaultSession.instance.lock();
        _sessionPin = null;
      }
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
    final isBank = widget.isBank;

    final mono = kMono.copyWith(fontSize: 15, color: c.tx, letterSpacing: 15 * .06);

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const DsDragHandle(),
              DsSheetHeader(
                title: isBank ? 'Account details' : 'Card details',
                icon: DsIcons.lock,
                onClose: () => Navigator.of(context).pop(),
              ),
              const SizedBox(height: 16),
              DsField(
                label: isBank ? 'Account number' : 'Card number',
                child: TextField(
                  controller: _number,
                  keyboardType: TextInputType.number,
                  style: mono,
                  decoration: InputDecoration(hintText: isBank ? '50100123456789' : '5252 2525 2525 6623'),
                ),
              ),
              const SizedBox(height: 16),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: isBank
                        ? DsField(
                            label: 'IFSC',
                            child: TextField(
                              controller: _ifsc,
                              textCapitalization: TextCapitalization.characters,
                              maxLength: 11,
                              style: mono,
                              decoration: const InputDecoration(hintText: 'HDFC0001234', counterText: ''),
                            ),
                          )
                        : DsField(
                            label: 'Expires',
                            child: TextField(
                              controller: _expiry,
                              style: mono,
                              decoration: const InputDecoration(hintText: '08/29'),
                            ),
                          ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: DsField(
                      label: isBank ? 'Account holder' : 'Name on card',
                      child: TextField(
                        controller: _name,
                        textCapitalization: isBank ? TextCapitalization.words : TextCapitalization.characters,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              DsField(label: 'Note', child: TextField(controller: _note)),
              if (_sessionPin == null) ...[
                const SizedBox(height: 16),
                DsField(
                  label: 'Your PIN',
                  child: DsPasswordField(
                    controller: _pin,
                    noun: 'PIN',
                    pin: true,
                    maxLength: 6,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(counterText: ''),
                  ),
                ),
              ],
              const SizedBox(height: 8),
              Text(
                isBank
                    ? 'Stored encrypted, and shown only after your PIN.'
                    : 'There is no CVV field, on purpose — it is the one thing that makes a stolen '
                        'number spendable, and you already know yours.',
                style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                DsCallout(tone: DsTone.crit, title: _error!),
              ],
              const SizedBox(height: 20),
              Row(
                children: [
                  const Spacer(),
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('Cancel'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _busy ? null : _save,
                    child: Text(_busy ? 'Saving…' : 'Save'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// A dialog's header (§7.7): a 40 accent icon tile and the 19/24 title.
class _DialogTitle extends StatelessWidget {
  const _DialogTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Row(
        children: [
          const DsIconTile(DsIcons.lock, tone: DsTone.ac),
          const SizedBox(width: 12),
          Expanded(child: Text(text)),
        ],
      );
}
