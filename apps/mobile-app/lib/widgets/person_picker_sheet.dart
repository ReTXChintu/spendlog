import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/phone_contacts.dart';
import 'ds/ds.dart';
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
    backgroundColor: context.c.sf,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
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
    backgroundColor: context.c.sf,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
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
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsDragHandle(),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  DsSheetHeader(title: widget.title, icon: DsIcons.users),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: _adding ? null : _fromPhone,
                      style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 4)),
                      icon: const Icon(Icons.contacts_outlined, size: 18),
                      label: const Text('Pick from phone contacts'),
                    ),
                  ),
                  if (_contacts != null && _contacts!.length > 6) ...[
                    const SizedBox(height: 8),
                    _PeopleSearch(
                      hint: 'Search your SpendLog contacts',
                      onChanged: (value) => setState(() => _query = value),
                    ),
                  ],
                  const SizedBox(height: 8),
                  if (_contacts == null)
                    const DsSkeletonRows(count: 3)
                  else if (visible.isEmpty)
                    DsEmpty(
                      icon: DsIcons.users,
                      message: _contacts!.isEmpty
                          ? 'No contacts in SpendLog yet. Pick someone from your phone to start.'
                          : wanted.isEmpty
                              ? 'Everyone here is already on it.'
                              : 'Nobody called "${_query.trim()}" - pick them from your phone contacts.',
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
                            secondary: PersonAvatar(name: contact.name, radius: 18),
                            title: Text(
                              contact.name,
                              style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                            ),
                            subtitle: contact.balanceMinor != 0
                                ? BalanceText(balanceMinor: contact.balanceMinor, fontSize: 13)
                                : (contact.phone != null
                                    ? Text(contact.phone!, style: TextStyle(fontSize: 13, color: c.tx3))
                                    : null),
                          );
                        },
                      ),
                    ),
                ],
              ),
            ),
          ),
          _SheetFooter(
            children: [
              OutlinedButton(
                onPressed: () => Navigator.of(context).pop(),
                style: OutlinedButton.styleFrom(minimumSize: const Size(64, 48)),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: _ticked.isEmpty ? null : () => Navigator.of(context).pop(List.of(_ticked)),
                child: Text(_ticked.length <= 1 ? 'Add' : 'Add ${_ticked.length}'),
              ),
            ],
          ),
        ],
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
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsDragHandle(),
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  DsSheetHeader(
                    title: 'Who was it with?',
                    icon: DsIcons.users,
                    onClose: () => Navigator.of(context).pop(),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _adding ? null : () => _add(() => addContactFromPhone(context)),
                          style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 12)),
                          icon: const Icon(Icons.contacts_outlined, size: 18),
                          label: const Text('Pick from phone contacts'),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _adding
                              ? null
                              : () => _add(() => addContactByName(context, initialName: _query.trim())),
                          style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 12)),
                          icon: const DsIcon(DsIcons.plus, size: 18),
                          label: const Text('Add by name'),
                        ),
                      ),
                    ],
                  ),
                  if (_contacts != null && _contacts!.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    _PeopleSearch(
                      hint: 'Search people in SpendLog',
                      onChanged: (value) => setState(() => _query = value),
                    ),
                  ],
                  const SizedBox(height: 8),
                  if (_contacts == null)
                    const DsSkeletonRows(count: 3)
                  else if (_contacts!.isEmpty)
                    const DsEmpty(
                      icon: DsIcons.users,
                      message: 'Nobody here yet. Pick someone from your phone, or add them by name.',
                    )
                  else if (visible.isEmpty)
                    DsEmpty(
                      icon: DsIcons.search,
                      message: _query.trim().isEmpty
                          ? 'Everyone here is already on it.'
                          : 'Nobody called "${_query.trim()}" yet - add them by name.',
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
                            leading: PersonAvatar(name: contact.name, radius: 18),
                            title: Text(
                              contact.name,
                              style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                            ),
                            subtitle: contact.phone != null
                                ? Text(contact.phone!, style: TextStyle(fontSize: 13, color: c.tx3))
                                : null,
                            trailing:
                                contact.balanceMinor == 0 ? null : BalanceText(balanceMinor: contact.balanceMinor),
                            onTap: () => Navigator.of(context).pop(contact),
                          );
                        },
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The in-sheet search: 44 h, a leading search icon in tx3.
class _PeopleSearch extends StatelessWidget {
  const _PeopleSearch({required this.hint, required this.onChanged});

  final String hint;
  final ValueChanged<String> onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return TextField(
      onChanged: onChanged,
      style: TextStyle(fontSize: 14, color: c.tx),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: TextStyle(fontSize: 14, color: c.tx3),
        prefixIcon: Padding(
          padding: const EdgeInsets.only(left: 12, right: 8),
          child: DsIcon(DsIcons.search, size: 20, color: c.tx3),
        ),
        prefixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 44),
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      ),
    );
  }
}

/// A pinned sheet footer on `sf2`, actions right-aligned.
class _SheetFooter extends StatelessWidget {
  const _SheetFooter({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: BoxDecoration(color: c.sf2, border: Border(top: BorderSide(color: c.ln))),
      child: OverflowBar(
        alignment: MainAxisAlignment.end,
        overflowAlignment: OverflowBarAlignment.end,
        spacing: 8,
        overflowSpacing: 8,
        children: children,
      ),
    );
  }
}

/// A person: two-letter initials in a soft-tinted circle (§7.5). The tint
/// is picked from the name, so the same person always looks the same.
class PersonAvatar extends StatelessWidget {
  const PersonAvatar({super.key, required this.name, this.radius = 18});

  final String name;
  final double radius;

  static const _tones = [DsTone.ac, DsTone.warn, DsTone.good, DsTone.neutral];

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final trimmed = name.trim();
    final tone = trimmed.isEmpty ? DsTone.neutral : _tones[trimmed.codeUnits.fold<int>(0, (a, b) => a + b) % _tones.length];
    return Container(
      width: radius * 2,
      height: radius * 2,
      alignment: Alignment.center,
      decoration: BoxDecoration(color: c.soft(tone), shape: BoxShape.circle),
      child: Text(
        trimmed.isEmpty ? '?' : initialsOf(trimmed),
        style: TextStyle(
          fontSize: radius >= 18 ? 13 : 11,
          height: 1,
          fontWeight: FontWeight.w600,
          color: c.strong(tone),
        ),
      ),
    );
  }
}

/// "owes you ₹X", "you owe ₹X" or "settled up", in the colour that goes
/// with it: money coming to you is green, money you owe is ink.
class BalanceText extends StatelessWidget {
  const BalanceText({super.key, required this.balanceMinor, this.fontSize = 13});

  final int balanceMinor;
  final double fontSize;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (text, colour) = balanceMinor > 0
        ? ('owes you ${formatMoney(balanceMinor)}', c.good)
        : balanceMinor < 0
            ? ('you owe ${formatMoney(-balanceMinor)}', c.tx)
            : ('settled up', c.tx3);
    return Text(
      text,
      style: TextStyle(fontSize: fontSize, fontWeight: FontWeight.w600, color: colour, fontFeatures: Ds.tabular),
    );
  }
}
