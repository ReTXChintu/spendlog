import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/phone_contacts.dart';
import '../theme.dart';
import '../utils/format.dart';

/// Choosing who a transaction was with: someone already in SpendLog, found
/// by typing, or someone new from the phone's contacts or by name.
///
/// [exclude] is whoever is already on the transaction - the same person
/// twice on one bill is never what was meant.
Future<Contact?> showPersonPicker(BuildContext context, {Set<String> exclude = const {}}) {
  return showModalBottomSheet<Contact>(
    context: context,
    isScrollControlled: true,
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
      child: _PersonPicker(exclude: exclude),
    ),
  );
}

/// Choosing several people at once for a split or settling up - only
/// people already in SpendLog, or picked from the phone's contacts. No
/// typed-in names here: a balance kept against "Rahul" and another against
/// "rahul " is two people who are one.
///
/// Returns everyone ticked (new ones included), or null if cancelled.
Future<List<Contact>?> showPeoplePicker(
  BuildContext context, {
  Set<String> exclude = const {},
  String title = 'Who was it with?',
}) {
  return showModalBottomSheet<List<Contact>>(
    context: context,
    isScrollControlled: true,
    backgroundColor: context.c.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(T.rLg)),
    ),
    builder: (sheetContext) => Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
      child: _PeoplePicker(exclude: exclude, title: title),
    ),
  );
}

class _PeoplePicker extends StatefulWidget {
  const _PeoplePicker({required this.exclude, required this.title});

  final Set<String> exclude;
  final String title;

  @override
  State<_PeoplePicker> createState() => _PeoplePickerState();
}

class _PeoplePickerState extends State<_PeoplePicker> {
  List<Contact>? _contacts;
  final List<Contact> _ticked = [];
  String _query = '';
  bool _adding = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/contacts') as Map<String, dynamic>;
      if (!mounted) return;
      final everyone = ContactBalance.fromJson(json).contacts
        ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      setState(() => _contacts = everyone);
    } catch (_) {
      if (mounted) setState(() => _contacts = []);
    }
  }

  bool _isTicked(Contact contact) => _ticked.any((t) => t.id == contact.id);

  void _toggle(Contact contact) => setState(() {
        if (_isTicked(contact)) {
          _ticked.removeWhere((t) => t.id == contact.id);
        } else {
          _ticked.add(contact);
        }
      });

  Future<void> _fromPhone() async {
    setState(() => _adding = true);
    final contact = await addContactFromPhone(context);
    if (!mounted) return;
    setState(() {
      _adding = false;
      if (contact == null || widget.exclude.contains(contact.id)) return;
      // The phone may hand back someone already listed - tick them rather
      // than listing them twice.
      final list = _contacts ?? <Contact>[];
      if (!list.any((c) => c.id == contact.id)) {
        list.insert(0, contact);
        _contacts = list;
      }
      if (!_isTicked(contact)) _ticked.add(contact);
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final wanted = _query.trim().toLowerCase();
    final visible = (_contacts ?? const <Contact>[])
        .where((contact) => !widget.exclude.contains(contact.id))
        .where((contact) =>
            wanted.isEmpty ||
            contact.name.toLowerCase().contains(wanted) ||
            (contact.phone ?? '').contains(wanted))
        .toList();

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
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
            Row(
              children: [
                Expanded(
                  child: Text(
                    widget.title,
                    style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink),
                  ),
                ),
                TextButton.icon(
                  onPressed: _adding ? null : _fromPhone,
                  icon: const Icon(Icons.contacts_outlined, size: 17),
                  label: const Text('Pick from phone contacts'),
                ),
              ],
            ),
            if (_contacts != null && _contacts!.length > 6) ...[
              const SizedBox(height: 8),
              TextField(
                onChanged: (value) => setState(() => _query = value),
                style: TextStyle(fontSize: 13.5, color: c.ink),
                decoration: InputDecoration(
                  hintText: 'Search your SpendLog contacts',
                  hintStyle: TextStyle(color: c.mutedLight),
                  prefixIcon: Icon(Icons.search, size: 18, color: c.muted),
                  isDense: true,
                  filled: true,
                  fillColor: c.surface,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(T.rSm),
                    borderSide: BorderSide(color: c.lineStrong),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(T.rSm),
                    borderSide: BorderSide(color: c.brand),
                  ),
                ),
              ),
            ],
            const SizedBox(height: 8),
            if (_contacts == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (visible.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  _contacts!.isEmpty
                      ? 'No contacts in SpendLog yet. Pick someone from your phone to start.'
                      : wanted.isEmpty
                          ? 'Everyone here is already on it.'
                          : 'Nobody called "${_query.trim()}" - pick them from your phone contacts.',
                  style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
                ),
              )
            else
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 340),
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: visible.length,
                  itemBuilder: (context, i) {
                    final contact = visible[i];
                    return CheckboxListTile(
                      value: _isTicked(contact),
                      onChanged: (_) => _toggle(contact),
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      secondary: PersonAvatar(name: contact.name),
                      title: Text(contact.name,
                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                      subtitle: contact.balanceMinor != 0
                          ? BalanceText(balanceMinor: contact.balanceMinor, fontSize: 11.5)
                          : (contact.phone != null ? Text(contact.phone!) : null),
                    );
                  },
                ),
              ),
            const SizedBox(height: 10),
            Row(
              children: [
                const Spacer(),
                TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _ticked.isEmpty ? null : () => Navigator.of(context).pop(List.of(_ticked)),
                  child: Text(_ticked.length <= 1 ? 'Add' : 'Add ${_ticked.length}'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _PersonPicker extends StatefulWidget {
  const _PersonPicker({required this.exclude});

  final Set<String> exclude;

  @override
  State<_PersonPicker> createState() => _PersonPickerState();
}

class _PersonPickerState extends State<_PersonPicker> {
  List<Contact>? _contacts;
  String _query = '';
  bool _adding = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/contacts') as Map<String, dynamic>;
      if (!mounted) return;
      final everyone = ContactBalance.fromJson(json).contacts;
      // By name here, rather than by who owes most: this is a lookup.
      everyone.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      setState(() => _contacts = everyone);
    } catch (_) {
      if (mounted) setState(() => _contacts = []);
    }
  }

  List<Contact> get _visible {
    final wanted = _query.trim().toLowerCase();
    return (_contacts ?? const [])
        .where((contact) => !widget.exclude.contains(contact.id))
        .where((contact) =>
            wanted.isEmpty ||
            contact.name.toLowerCase().contains(wanted) ||
            (contact.phone ?? '').contains(wanted))
        .toList();
  }

  Future<void> _add(Future<Contact?> Function() how) async {
    setState(() => _adding = true);
    final contact = await how();
    if (!mounted) return;
    setState(() => _adding = false);
    if (contact != null) Navigator.of(context).pop(contact);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final visible = _visible;

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
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
            Text('Who was it with?', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16, color: c.ink)),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _adding ? null : () => _add(() => addContactFromPhone(context)),
                    icon: const Icon(Icons.contacts_outlined, size: 17),
                    label: const Text('Pick from phone contacts'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _adding
                        ? null
                        : () => _add(() => addContactByName(context, initialName: _query.trim())),
                    icon: const Icon(Icons.person_add_alt, size: 17),
                    label: const Text('Add by name'),
                  ),
                ),
              ],
            ),
            if (_contacts != null && _contacts!.isNotEmpty) ...[
              const SizedBox(height: 14),
              TextField(
                onChanged: (value) => setState(() => _query = value),
                style: TextStyle(fontSize: 13.5, color: c.ink),
                decoration: InputDecoration(
                  hintText: 'Search people in SpendLog',
                  hintStyle: TextStyle(color: c.mutedLight),
                  prefixIcon: Icon(Icons.search, size: 18, color: c.muted),
                  isDense: true,
                  filled: true,
                  fillColor: c.surface,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(T.rSm),
                    borderSide: BorderSide(color: c.lineStrong),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(T.rSm),
                    borderSide: BorderSide(color: c.brand),
                  ),
                ),
              ),
            ],
            const SizedBox(height: 8),
            if (_contacts == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_contacts!.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  'Nobody here yet. Pick someone from your phone, or add them by name.',
                  style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
                ),
              )
            else if (visible.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text(
                  _query.trim().isEmpty
                      ? 'Everyone here is already on it.'
                      : 'Nobody called "${_query.trim()}" yet - add them by name.',
                  style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
                ),
              )
            else
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 320),
                child: ListView.builder(
                  shrinkWrap: true,
                  itemCount: visible.length,
                  itemBuilder: (context, i) {
                    final contact = visible[i];
                    return ListTile(
                      contentPadding: EdgeInsets.zero,
                      dense: true,
                      leading: PersonAvatar(name: contact.name),
                      title: Text(contact.name, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                      subtitle: contact.phone != null ? Text(contact.phone!) : null,
                      trailing: contact.balanceMinor == 0 ? null : BalanceText(balanceMinor: contact.balanceMinor),
                      onTap: () => Navigator.of(context).pop(contact),
                    );
                  },
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// A person's initial in a circle.
class PersonAvatar extends StatelessWidget {
  const PersonAvatar({super.key, required this.name, this.radius = 16});

  final String name;
  final double radius;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final initial = name.trim().isEmpty ? '?' : name.trim().characters.first.toUpperCase();
    return CircleAvatar(
      radius: radius,
      backgroundColor: c.brand50,
      child: Text(
        initial,
        style: TextStyle(fontSize: radius * 0.85, fontWeight: FontWeight.w700, color: c.brandDark),
      ),
    );
  }
}

/// "owes you ₹X", "you owe ₹X" or "settled up", in the colour that goes
/// with it.
class BalanceText extends StatelessWidget {
  const BalanceText({super.key, required this.balanceMinor, this.fontSize = 12.5});

  final int balanceMinor;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (text, colour) = balanceMinor > 0
        ? ('owes you ${formatMoney(balanceMinor)}', c.credit)
        : balanceMinor < 0
            ? ('you owe ${formatMoney(-balanceMinor)}', c.debit)
            : ('settled up', c.muted);
    return Text(
      text,
      style: TextStyle(fontSize: fontSize, fontWeight: FontWeight.w700, color: colour),
    );
  }
}
