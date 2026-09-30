import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/phone_contacts.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../widgets/person_picker_sheet.dart';
import '../widgets/state_block.dart';

/// Who owes what.
///
/// Built from the transactions that name people - a split bill, money
/// lent, a friend paying back - so a balance here is always the sum of
/// rows you can open and check, never a figure typed in on its own.
class PeopleScreen extends StatefulWidget {
  const PeopleScreen({super.key});

  @override
  State<PeopleScreen> createState() => _PeopleScreenState();
}

class _PeopleScreenState extends State<PeopleScreen> {
  ContactBalance? _data;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/contacts') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _data = ContactBalance.fromJson(json);
        _failed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _add() async {
    final how = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.contacts_outlined),
              title: const Text('Pick from phone contacts'),
              onTap: () => Navigator.of(context).pop('phone'),
            ),
            ListTile(
              leading: const Icon(Icons.person_add_alt),
              title: const Text('Type a name'),
              onTap: () => Navigator.of(context).pop('name'),
            ),
          ],
        ),
      ),
    );
    if (how == null || !mounted) return;

    final added = how == 'phone' ? await addContactFromPhone(context) : await addContactByName(context);
    if (added != null) await _load();
  }

  Future<void> _open(Contact contact) async {
    await Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => PersonScreen(contact: contact)),
    );
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text('People', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
        shape: Border(bottom: BorderSide(color: c.line)),
        actions: [
          IconButton(tooltip: 'Add a person', onPressed: _add, icon: const Icon(Icons.person_add_alt)),
        ],
      ),
      body: _body(),
    );
  }

  Widget _body() {
    final c = context.c;

    if (_failed) {
      return StateBlock(
        icon: Icons.wifi_off,
        warn: true,
        title: "Couldn't load people",
        body: 'The connection failed. Check your internet and try again.',
        actionLabel: 'Retry',
        onAction: _load,
      );
    }

    final data = _data;
    if (data == null) return const Center(child: CircularProgressIndicator());

    if (data.contacts.isEmpty) {
      return StateBlock(
        icon: Icons.people_outline,
        title: 'Nobody yet',
        body: 'Add someone here, or on a transaction: tick Split or Settling up and say who it was '
            'with. Their balance is worked out from those.',
        actionLabel: 'Add a person',
        onAction: _add,
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
        children: [
          Row(
            children: [
              Expanded(child: _Total(label: 'Owed to you', amountMinor: data.owedToYouMinor, colour: c.credit)),
              const SizedBox(width: 10),
              Expanded(child: _Total(label: 'You owe', amountMinor: data.youOweMinor, colour: c.debit)),
            ],
          ),
          const SizedBox(height: 16),
          Container(
            decoration: BoxDecoration(
              color: c.surface,
              border: Border.all(color: c.line),
              borderRadius: BorderRadius.circular(T.rMd),
            ),
            child: Column(
              children: [
                for (final (i, contact) in data.contacts.indexed) ...[
                  if (i > 0) Divider(height: 1, color: c.line),
                  ListTile(
                    onTap: () => _open(contact),
                    leading: PersonAvatar(name: contact.name, radius: 18),
                    title: Text(
                      contact.name,
                      style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: c.ink),
                    ),
                    subtitle: Text(
                      contact.transactionCount == 0
                          ? (contact.phone ?? 'Not on anything yet')
                          : '${contact.transactionCount} '
                              '${contact.transactionCount == 1 ? 'transaction' : 'transactions'}'
                              '${contact.lastAt != null ? ' · last ${formatShortDate(contact.lastAt!)}' : ''}',
                      style: TextStyle(fontSize: 11.5, color: c.muted),
                    ),
                    trailing: BalanceText(balanceMinor: contact.balanceMinor),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Total extends StatelessWidget {
  const _Total({required this.label, required this.amountMinor, required this.colour});

  final String label;
  final int amountMinor;
  final Color colour;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label.toUpperCase(),
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.5, color: c.muted),
          ),
          const SizedBox(height: 5),
          Text(
            formatMoney(amountMinor),
            style: kNum.copyWith(
              fontSize: 19,
              fontWeight: FontWeight.w800,
              color: amountMinor == 0 ? c.ink : colour,
            ),
          ),
        ],
      ),
    );
  }
}

/// One person: where you stand, and every transaction that got you there.
class PersonScreen extends StatefulWidget {
  const PersonScreen({super.key, required this.contact});

  /// What the list already knew, drawn while the full history loads.
  final Contact contact;

  @override
  State<PersonScreen> createState() => _PersonScreenState();
}

class _PersonScreenState extends State<PersonScreen> {
  late Contact _contact = widget.contact;
  List<ContactHistoryEntry>? _history;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/contacts/${widget.contact.id}') as Map<String, dynamic>;
      if (!mounted) return;
      final detail = ContactDetail.fromJson(json);
      setState(() {
        _contact = detail.contact;
        _history = detail.history;
        _failed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _edit() async {
    final entered = await showDialog<({String name, String phone})>(
      context: context,
      builder: (_) => ContactDialog(
        title: 'Edit ${_contact.name}',
        initialName: _contact.name,
        initialPhone: _contact.phone ?? '',
        action: 'Save',
      ),
    );
    if (entered == null || !mounted) return;

    final messenger = ScaffoldMessenger.of(context);
    try {
      final json = await ApiClient.instance.patch('/contacts/${_contact.id}', {
        'name': entered.name,
        'phone': entered.phone.isEmpty ? null : entered.phone,
      }) as Map<String, dynamic>;
      if (mounted) setState(() => _contact = Contact.fromJson(json));
    } catch (error) {
      messenger.showSnackBar(SnackBar(
        content: Text(error is ApiException ? error.message : "Couldn't save that."),
      ));
    }
  }

  Future<void> _delete() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove ${_contact.name}?'),
        content: const Text(
          'They come off every transaction they are on. The transactions themselves stay exactly '
          'as they are - a split is still a split, just not with anyone in particular.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Keep')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Remove')),
        ],
      ),
    );
    if (sure != true || !mounted) return;

    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.delete('/contacts/${_contact.id}');
      navigator.pop();
    } catch (error) {
      messenger.showSnackBar(SnackBar(
        content: Text(error is ApiException ? error.message : "Couldn't remove them."),
      ));
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final contact = _contact;

    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text(contact.name, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
        shape: Border(bottom: BorderSide(color: c.line)),
        actions: [
          IconButton(tooltip: 'Edit name or number', onPressed: _edit, icon: const Icon(Icons.edit_outlined)),
          IconButton(
            tooltip: 'Remove this person',
            onPressed: _delete,
            icon: Icon(Icons.delete_outline, color: c.debit),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 14, 16, 28),
          children: [
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: c.surface,
                border: Border.all(color: c.line),
                borderRadius: BorderRadius.circular(T.rLg),
              ),
              child: Row(
                children: [
                  PersonAvatar(name: contact.name, radius: 22),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        BalanceText(balanceMinor: contact.balanceMinor, fontSize: 18),
                        const SizedBox(height: 4),
                        Text(
                          [
                            'Lent ${formatMoney(contact.givenMinor)}',
                            'paid back ${formatMoney(contact.returnedMinor)}',
                            if (contact.phone != null) contact.phone!,
                          ].join(' · '),
                          style: TextStyle(fontSize: 12, color: c.muted),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 18),
            Text(
              'HISTORY',
              style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 1.1, color: c.muted),
            ),
            const SizedBox(height: 8),
            if (_failed)
              Text("Couldn't load their history. Pull down to try again.",
                  style: TextStyle(fontSize: 12.5, color: c.warn))
            else if (_history == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (_history!.isEmpty)
              Text(
                'Nothing yet. On a transaction, tick Split or Settling up and add '
                '${contact.name} under who it was with.',
                style: TextStyle(fontSize: 12.5, height: 1.45, color: c.muted),
              )
            else
              Container(
                decoration: BoxDecoration(
                  color: c.surface,
                  border: Border.all(color: c.line),
                  borderRadius: BorderRadius.circular(T.rMd),
                ),
                child: Column(
                  children: [
                    for (final (i, entry) in _history!.indexed) ...[
                      if (i > 0) Divider(height: 1, color: c.line),
                      _HistoryRow(entry: entry),
                    ],
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _HistoryRow extends StatelessWidget {
  const _HistoryRow({required this.entry});

  final ContactHistoryEntry entry;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final t = entry.transaction;
    final added = entry.amountMinor >= 0;

    // Positive adds to what they owe: their part of a bill, money lent, or
    // - when settling up in the other direction - money you paid them back.
    final what = added ? (t.isSettlement ? 'you paid' : 'lent') : 'paid back';

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  t.merchant ?? t.note ?? (t.type == 'DEBIT' ? 'A payment' : 'Money in'),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 13.4, fontWeight: FontWeight.w700, color: c.ink),
                ),
                const SizedBox(height: 2),
                Text(
                  [
                    formatShortDate(t.occurredAt),
                    if (t.split?.groupLabel != null) t.split!.groupLabel!,
                    'of ${formatMoney(t.amountMinor)}',
                  ].join(' · '),
                  style: TextStyle(fontSize: 11.5, color: c.muted),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '${added ? '+' : '−'}${formatMoney(entry.amountMinor.abs())}',
                style: kNum.copyWith(
                  fontSize: 13.4,
                  fontWeight: FontWeight.w700,
                  // Money coming back is the good news, so it gets the colour.
                  color: added ? c.ink : c.credit,
                ),
              ),
              Text(what, style: TextStyle(fontSize: 11, color: c.muted)),
            ],
          ),
        ],
      ),
    );
  }
}
