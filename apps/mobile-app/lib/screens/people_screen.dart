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
/// rows you can open and check. The one figure typed in on its own is a
/// starting balance, for money between you from before SpendLog, and it
/// shows as the oldest row of their history.
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
    final entered = await showDialog<ContactEntry>(
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

  /// Money that stood between you before SpendLog. Saved on its own so the
  /// balance and the history both pick it up from the server.
  Future<void> _setOpening() async {
    final value = await showDialog<int>(
      context: context,
      builder: (_) => _OpeningDialog(name: _contact.name, initialMinor: _contact.openingBalanceMinor),
    );
    if (value == null || value == _contact.openingBalanceMinor || !mounted) return;

    final messenger = ScaffoldMessenger.of(context);
    try {
      final json = await ApiClient.instance.patch('/contacts/${_contact.id}', {
        'openingBalanceMinor': value,
      }) as Map<String, dynamic>;
      if (mounted) setState(() => _contact = Contact.fromJson(json));
      await _load();
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
    final opening = contact.openingBalanceMinor;

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
                        if (opening != 0) ...[
                          const SizedBox(height: 2),
                          Text(
                            opening > 0
                                ? 'Owed you ${formatMoney(opening)} before SpendLog'
                                : 'You owed them ${formatMoney(-opening)} before SpendLog',
                            style: TextStyle(fontSize: 12, color: c.muted),
                          ),
                        ],
                        Align(
                          alignment: Alignment.centerLeft,
                          child: TextButton(
                            onPressed: _setOpening,
                            style: TextButton.styleFrom(
                              padding: EdgeInsets.zero,
                              minimumSize: const Size(0, 32),
                              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                            ),
                            child: Text(opening == 0 ? 'Set starting balance' : 'Change starting balance'),
                          ),
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
            else if (_history!.isEmpty && opening == 0)
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
                    // Newest first, so what came before SpendLog goes last.
                    if (opening != 0) ...[
                      if (_history!.isNotEmpty) Divider(height: 1, color: c.line),
                      _StartingRow(amountMinor: opening),
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

/// The starting balance, drawn as the oldest line of the history so the
/// rows still add up to the balance at the top.
class _StartingRow extends StatelessWidget {
  const _StartingRow({required this.amountMinor});

  final int amountMinor;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final theyOwed = amountMinor > 0;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Starting balance',
                  style: TextStyle(fontSize: 13.4, fontWeight: FontWeight.w700, color: c.ink),
                ),
                const SizedBox(height: 2),
                Text('Before SpendLog', style: TextStyle(fontSize: 11.5, color: c.muted)),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                '${theyOwed ? '+' : '−'}${formatMoney(amountMinor.abs())}',
                style: kNum.copyWith(fontSize: 13.4, fontWeight: FontWeight.w700, color: c.ink),
              ),
              Text(theyOwed ? 'they owed' : 'you owed', style: TextStyle(fontSize: 11, color: c.muted)),
            ],
          ),
        ],
      ),
    );
  }
}

/// Sets what stood between you before SpendLog. Pops the new signed
/// amount in paise - 0 when cleared - or nothing when cancelled.
class _OpeningDialog extends StatefulWidget {
  const _OpeningDialog({required this.name, required this.initialMinor});

  final String name;
  final int initialMinor;

  @override
  State<_OpeningDialog> createState() => _OpeningDialogState();
}

class _OpeningDialogState extends State<_OpeningDialog> {
  late final _amount = TextEditingController(
    text: widget.initialMinor == 0 ? '' : _rupees(widget.initialMinor.abs()),
  );
  late bool _theyOwe = widget.initialMinor >= 0;

  /// Whole rupees without the ".00", so editing ₹10,000 shows "10000".
  static String _rupees(int paise) =>
      paise % 100 == 0 ? '${paise ~/ 100}' : (paise / 100).toStringAsFixed(2);

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Starting balance'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Money between you and ${widget.name} from before SpendLog - lent last year, say. '
              'Their balance starts from here.',
              style: TextStyle(fontSize: 13, height: 1.45, color: context.c.ink70),
            ),
            const SizedBox(height: 14),
            OwedField(
              amount: _amount,
              theyOwe: _theyOwe,
              onDirection: (owe) => setState(() => _theyOwe = owe),
              autofocus: true,
            ),
          ],
        ),
      ),
      actions: [
        if (widget.initialMinor != 0)
          TextButton(onPressed: () => Navigator.of(context).pop(0), child: const Text('Clear')),
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        ListenableBuilder(
          listenable: _amount,
          builder: (context, _) {
            final typed = signedPaise(_amount.text, theyOwe: _theyOwe);
            return FilledButton(
              onPressed: typed == 0 ? null : () => Navigator.of(context).pop(typed),
              child: const Text('Save'),
            );
          },
        ),
      ],
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
