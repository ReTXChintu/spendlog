import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/phone_contacts.dart';
import '../utils/format.dart';
import '../widgets/ds/ds.dart';
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
        child: Padding(
          padding: const EdgeInsets.fromLTRB(0, 0, 0, 12),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const DsDragHandle(),
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 4, 16, 8),
                child: DsSheetHeader(title: 'Add a person'),
              ),
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                leading: const DsIconTile(Icons.contacts_outlined, tone: DsTone.ac),
                title: const Text('Pick from phone contacts'),
                onTap: () => Navigator.of(context).pop('phone'),
              ),
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                leading: const DsIconTile(DsIcons.users, tone: DsTone.neutral),
                title: const Text('Type a name'),
                onTap: () => Navigator.of(context).pop('name'),
              ),
            ],
          ),
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
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('People'),
        actions: [
          IconButton(tooltip: 'Add a person', onPressed: _add, icon: const DsIcon(DsIcons.plus)),
          const SizedBox(width: 4),
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
    if (data == null) return const Center(child: DsSpinner());

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
        padding: kPagePad,
        children: [
          Row(
            children: [
              Expanded(
                child: _Total(
                  label: 'Owed to you',
                  amountMinor: data.owedToYouMinor,
                  colour: c.good,
                  tint: c.goodSoft,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _Total(label: 'You owe', amountMinor: data.youOweMinor, colour: c.tx, tint: c.sunk),
              ),
            ],
          ),
          const SizedBox(height: kCardGap),
          DsCard(
            padding: EdgeInsets.zero,
            clip: true,
            child: Column(
              children: [
                const DsSectionHeader('Everyone', padding: EdgeInsets.fromLTRB(16, 14, 16, 6)),
                for (final (i, contact) in data.contacts.indexed) ...[
                  if (i > 0) const Divider(indent: 64),
                  ListTile(
                    onTap: () => _open(contact),
                    minVerticalPadding: 12,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                    leading: DsAvatar(contact.name, size: 40),
                    title: Text(
                      contact.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                    ),
                    subtitle: Text(
                      contact.transactionCount == 0
                          ? (contact.phone ?? 'Not on anything yet')
                          : '${contact.transactionCount} '
                              '${contact.transactionCount == 1 ? 'transaction' : 'transactions'}'
                              '${contact.lastAt != null ? ' · last ${formatShortDate(contact.lastAt!)}' : ''}',
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                    ),
                    trailing: _BalanceStack(balanceMinor: contact.balanceMinor),
                  ),
                ],
                const SizedBox(height: 4),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A summary tile on the person's tint: green for what comes back to you,
/// neutral for what you owe (spending is ink, never red).
class _Total extends StatelessWidget {
  const _Total({required this.label, required this.amountMinor, required this.colour, required this.tint});

  final String label;
  final int amountMinor;
  final Color colour;
  final Color tint;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: tint, borderRadius: BorderRadius.circular(Ds.rLg)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsLabel(label),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              formatMoney(amountMinor),
              style: kNum.copyWith(
                fontSize: 22,
                height: 28 / 22,
                fontWeight: FontWeight.w600,
                color: amountMinor == 0 ? c.tx : colour,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// "owes you" over a green amount, "you owe" over an ink one, or "settled
/// up" — the trailing figure of a person's row.
class _BalanceStack extends StatelessWidget {
  const _BalanceStack({required this.balanceMinor});

  final int balanceMinor;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    if (balanceMinor == 0) {
      return Text('settled up', style: TextStyle(fontSize: 13, color: c.tx3));
    }
    final theyOwe = balanceMinor > 0;
    return Column(
      mainAxisSize: MainAxisSize.min,
      mainAxisAlignment: MainAxisAlignment.center,
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(theyOwe ? 'owes you' : 'you owe', style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
        Text(
          formatMoney(balanceMinor.abs()),
          style: kNum.copyWith(
            fontSize: 15,
            height: 20 / 15,
            fontWeight: FontWeight.w600,
            color: theyOwe ? c.good : c.tx,
          ),
        ),
      ],
    );
  }
}

/// The big figure on a person's page: "Owes you ₹1,000" in green, "You
/// owe ₹1,840" in ink, or "Settled up".
class _BalanceHero extends StatelessWidget {
  const _BalanceHero({required this.balanceMinor});

  final int balanceMinor;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final (label, colour) = balanceMinor > 0
        ? ('Owes you', c.good)
        : balanceMinor < 0
            ? ('You owe', c.tx)
            : ('Settled up', c.tx3);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        DsLabel(label),
        if (balanceMinor != 0) ...[
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              formatMoney(balanceMinor.abs()),
              style: kNum.copyWith(
                fontSize: 34,
                height: 40 / 34,
                fontWeight: FontWeight.w600,
                letterSpacing: -0.68,
                color: colour,
              ),
            ),
          ),
        ],
      ],
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
  List<ContactClearance> _clearances = const [];
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
        _clearances = detail.clearances;
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

  /// Part or all of what is owed, settled without money moving - they
  /// owed ₹1,000 and bought you a ₹999 watch.
  Future<void> _clear() async {
    final cleared = await showModalBottomSheet<bool>(
      context: context,
      isScrollControlled: true,
      backgroundColor: context.c.sf,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
      ),
      builder: (_) => _ClearSheet(contact: _contact),
    );
    if (cleared == true) await _load();
  }

  /// Takes a clearance back: what it cleared is owed again.
  Future<void> _undoClearance(ContactClearance clearance) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.delete('/contacts/${_contact.id}/clear/${clearance.id}');
      await _load();
      messenger.showSnackBar(SnackBar(
        content: Text('Undone - ${_plainMoney(clearance.amountMinor)} is owed again.'),
      ));
    } catch (error) {
      messenger.showSnackBar(SnackBar(
        content: Text(error is ApiException ? error.message : "Couldn't undo that."),
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

  /// Transactions and clearances as one history, newest first: a
  /// clearance happened on a day like anything else did.
  List<Widget> _rows() {
    final rows = <(DateTime, Widget)>[
      for (final entry in _history ?? const <ContactHistoryEntry>[])
        (entry.transaction.occurredAt, _HistoryRow(entry: entry)),
      for (final clearance in _clearances)
        (clearance.on, _ClearanceRow(clearance: clearance, onUndo: () => _undoClearance(clearance))),
    ]..sort((a, b) => b.$1.compareTo(a.$1));
    return [for (final (_, row) in rows) row];
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final contact = _contact;
    final opening = contact.openingBalanceMinor;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(contact.name, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(tooltip: 'Edit name or number', onPressed: _edit, icon: const DsIcon(DsIcons.pencil)),
          IconButton(
            tooltip: 'Remove this person',
            onPressed: _delete,
            icon: DsIcon(DsIcons.trash, color: c.crit),
          ),
          const SizedBox(width: 4),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: kPagePad,
          children: [
            DsCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      DsAvatar(contact.name, size: 48),
                      const SizedBox(width: 12),
                      Expanded(child: _BalanceHero(balanceMinor: contact.balanceMinor)),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Text(
                    [
                      'Lent ${formatMoney(contact.givenMinor)}',
                      'paid back ${formatMoney(contact.returnedMinor)}',
                      if (contact.clearedMinor != 0) 'cleared ${formatMoney(contact.clearedMinor.abs())}',
                      if (contact.phone != null) contact.phone!,
                    ].join(' · '),
                    style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
                  if (opening != 0) ...[
                    const SizedBox(height: 2),
                    Text(
                      opening > 0
                          ? 'Owed you ${formatMoney(opening)} before SpendLog'
                          : 'You owed them ${formatMoney(-opening)} before SpendLog',
                      style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
                    ),
                  ],
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      // Settled some other way: a gift, a favour.
                      if (contact.balanceMinor != 0)
                        FilledButton.icon(
                          onPressed: _clear,
                          style: FilledButton.styleFrom(minimumSize: const Size(0, 44)),
                          icon: const DsIcon(DsIcons.check, size: 18),
                          label: const Text('Clear'),
                        ),
                      OutlinedButton(
                        onPressed: _setOpening,
                        child: Text(opening == 0 ? 'Set starting balance' : 'Change starting balance'),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: kCardGap),
            if (_failed)
              const DsCallout(
                tone: DsTone.warn,
                title: "Couldn't load their history. Pull down to try again.",
              )
            else if (_history == null)
              const DsCard(child: DsSkeletonRows(count: 3))
            else if (_history!.isEmpty && _clearances.isEmpty && opening == 0)
              DsCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    DsSectionHeader('History with ${contact.name}'),
                    const SizedBox(height: 12),
                    DsEmpty(
                      icon: DsIcons.users,
                      message: 'Nothing yet. On a transaction, tick Split or Settling up and add '
                          '${contact.name} under who it was with.',
                    ),
                  ],
                ),
              )
            else
              DsCard(
                padding: EdgeInsets.zero,
                clip: true,
                child: Column(
                  children: [
                    DsSectionHeader(
                      'History with ${contact.name}',
                      padding: const EdgeInsets.fromLTRB(16, 14, 16, 10),
                    ),
                    const Divider(),
                    for (final (i, row) in _rows().indexed) ...[
                      if (i > 0) const Divider(),
                      row,
                    ],
                    // Newest first, so what came before SpendLog goes last.
                    if (opening != 0) ...[
                      if (_history!.isNotEmpty || _clearances.isNotEmpty) const Divider(),
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

/// The rupees without ".00" when there are no paise: ₹1,000, ₹999.50.
String _plainMoney(int paise) => paise % 100 == 0 ? formatMoneyShort(paise) : formatMoney(paise);

/// The starting balance, drawn as the oldest line of the history so the
/// rows still add up to the balance at the top.
class _StartingRow extends StatelessWidget {
  const _StartingRow({required this.amountMinor});

  final int amountMinor;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final theyOwed = amountMinor > 0;

    return _HistoryLine(
      leading: const DsIconTile(DsIcons.calendar),
      title: 'Starting balance',
      meta: 'Before SpendLog',
      amount: '${theyOwed ? '+' : '−'}${formatMoney(amountMinor.abs())}',
      amountColour: c.tx,
      caption: theyOwed ? 'they owed' : 'you owed',
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
              style: TextStyle(fontSize: 13, height: 1.45, color: context.c.tx2),
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

    final title = t.merchant ?? t.note ?? (t.type == 'DEBIT' ? 'A payment' : 'Money in');
    return _HistoryLine(
      leading: DsMonogram(title, tone: added ? DsTone.neutral : DsTone.good),
      title: title,
      meta: [
        formatShortDate(t.occurredAt),
        if (t.split?.groupLabel != null) t.split!.groupLabel!,
        'of ${formatMoney(t.amountMinor)}',
      ].join(' · '),
      amount: '${added ? '+' : '−'}${formatMoney(entry.amountMinor.abs())}',
      // Money coming back is the good news, so it gets the colour.
      amountColour: added ? c.tx : c.good,
      caption: what,
    );
  }
}

/// One line of a person's history: a 40 leading tile, a 15/20 title over a
/// 13/18 meta line, and the amount with what it was underneath.
class _HistoryLine extends StatelessWidget {
  const _HistoryLine({
    required this.leading,
    required this.title,
    required this.meta,
    required this.amount,
    required this.amountColour,
    required this.caption,
    this.titleMaxLines = 1,
    this.trailing,
  });

  final Widget leading;
  final String title;
  final String meta;
  final String amount;
  final Color amountColour;
  final String caption;
  final int titleMaxLines;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 12, trailing == null ? 16 : 4, 12),
      child: Row(
        children: [
          leading,
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: titleMaxLines,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                ),
                const SizedBox(height: 2),
                Text(meta, style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3)),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                amount,
                style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: amountColour),
              ),
              Text(caption, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
            ],
          ),
          if (trailing != null) trailing!,
        ],
      ),
    );
  }
}

/// Something settled without money moving, as a line of the history. Kept
/// in neutral ink: it was neither spending nor money coming back.
class _ClearanceRow extends StatelessWidget {
  const _ClearanceRow({required this.clearance, required this.onUndo});

  final ContactClearance clearance;
  final VoidCallback onUndo;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final effect = clearance.effectMinor;

    return _HistoryLine(
      leading: const DsIconTile(DsIcons.check, tone: DsTone.neutral),
      title: [
        'Cleared ${_plainMoney(clearance.amountMinor)}',
        if (clearance.note != null && clearance.note!.trim().isNotEmpty) clearance.note!,
      ].join(' · '),
      titleMaxLines: 2,
      meta: '${formatShortDate(clearance.on)} · no money moved',
      amount: '${effect > 0 ? '+' : '−'}${formatMoney(effect.abs())}',
      amountColour: c.tx3,
      caption: clearance.clearedTheirs ? 'they owed' : 'you owed',
      trailing: IconButton(
        tooltip: 'Undo - it is owed again',
        onPressed: onUndo,
        icon: DsIcon(DsIcons.undo, size: 18, color: c.tx3),
      ),
    );
  }
}

/// Clears part or all of what is owed, either way, with no money moving.
/// Starts at the whole amount - clearing everything is the usual case -
/// and can be brought down for a part. Pops true once saved.
class _ClearSheet extends StatefulWidget {
  const _ClearSheet({required this.contact});

  final Contact contact;

  @override
  State<_ClearSheet> createState() => _ClearSheetState();
}

class _ClearSheetState extends State<_ClearSheet> {
  late final int _outstanding = widget.contact.balanceMinor.abs();
  late final _amount = TextEditingController(
    text: _outstanding % 100 == 0 ? '${_outstanding ~/ 100}' : (_outstanding / 100).toStringAsFixed(2),
  );
  final _note = TextEditingController();

  /// The day it was settled, as IST wall-clock; today unless changed.
  DateTime _on = istWallClock(DateTime.now());
  bool _saving = false;
  String? _error;

  int get _minor => parseRupees(_amount.text) ?? 0;

  String? get _problem {
    if (_minor <= 0) return 'Enter an amount greater than zero.';
    if (_minor > _outstanding) {
      return "Only ${_plainMoney(_outstanding)} is owed - you can't clear more than that.";
    }
    return null;
  }

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final today = istWallClock(DateTime.now());
    final picked = await showDatePicker(
      context: context,
      initialDate: _on,
      firstDate: DateTime(2000),
      lastDate: DateTime(today.year, today.month, today.day),
    );
    if (picked != null) setState(() => _on = picked);
  }

  Future<void> _save() async {
    final problem = _problem;
    if (problem != null) {
      setState(() => _error = problem);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final note = _note.text.trim();
      await ApiClient.instance.post('/contacts/${widget.contact.id}/clear', {
        'amountMinor': _minor,
        'note': note.isEmpty ? null : note,
        // Midday in India, so the day reads the same wherever it is shown.
        'on': fromIstWallClock(DateTime(_on.year, _on.month, _on.day, 12)).toIso8601String(),
      });
      if (mounted) Navigator.of(context).pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = error is ApiException ? error.message : "Couldn't clear that.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final contact = widget.contact;
    final problem = _problem;
    final owing = contact.balanceMinor > 0
        ? '${contact.name} owes you ${_plainMoney(_outstanding)}'
        : 'You owe ${contact.name} ${_plainMoney(_outstanding)}';
    final left = _outstanding - _minor;
    final after = problem ?? (left == 0 ? 'settled up after this' : '${_plainMoney(left)} left after this');

    final progress = _outstanding == 0 ? 0.0 : (_minor / _outstanding).clamp(0.0, 1.0);

    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const DsDragHandle(),
              DsSheetHeader(
                title: 'Clear with ${contact.name}',
                onClose: _saving ? null : () => Navigator.of(context).pop(),
              ),
              const SizedBox(height: 4),
              Text(
                'Settled some other way - a gift, a favour. No money moves, and nothing counts as '
                'spending or income.',
                style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
              ),
              const SizedBox(height: 16),
              const DsLabel('Amount to clear', padding: EdgeInsets.only(bottom: 6)),
              TextField(
                controller: _amount,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                onChanged: (_) => setState(() => _error = null),
                style: kNum.copyWith(fontSize: 17, fontWeight: FontWeight.w600, color: c.tx),
                decoration: InputDecoration(
                  prefixText: '₹ ',
                  errorText: problem == null ? null : '',
                  errorStyle: const TextStyle(height: 0, fontSize: 0),
                ),
              ),
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: c.sf2,
                  border: Border.all(color: c.ln),
                  borderRadius: BorderRadius.circular(Ds.rLg),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      '$owing → $after',
                      style: kNum.copyWith(
                        fontSize: 14,
                        height: 20 / 14,
                        fontWeight: FontWeight.w600,
                        color: problem == null ? c.tx : c.crit,
                      ),
                    ),
                    const SizedBox(height: 10),
                    DsMeter(value: progress, height: 10, color: problem == null ? c.tx : c.critFill),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              const DsLabel('Note (optional)', padding: EdgeInsets.only(bottom: 6)),
              TextField(
                controller: _note,
                maxLength: 200,
                textCapitalization: TextCapitalization.sentences,
                decoration: const InputDecoration(
                  hintText: 'Bought me a watch',
                  counterText: '',
                ),
              ),
              const SizedBox(height: 16),
              const DsLabel('Date', padding: EdgeInsets.only(bottom: 6)),
              OutlinedButton.icon(
                onPressed: _pickDate,
                style: OutlinedButton.styleFrom(
                  alignment: Alignment.centerLeft,
                  minimumSize: const Size.fromHeight(52),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
                  textStyle: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w400),
                ),
                icon: DsIcon(DsIcons.calendar, size: 18, color: c.tx2),
                label: Text(DateFormat('EEE, d MMM yyyy').format(_on)),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                DsCallout(tone: DsTone.crit, title: _error!),
              ],
              const SizedBox(height: 16),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  TextButton(
                    onPressed: _saving ? null : () => Navigator.of(context).pop(),
                    style: TextButton.styleFrom(minimumSize: const Size(0, 48)),
                    child: const Text('Cancel'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton(
                    onPressed: _saving || problem != null ? null : _save,
                    child: Text(_saving
                        ? 'Clearing…'
                        : problem == null
                            ? 'Clear ${_plainMoney(_minor)}'
                            : 'Clear'),
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
