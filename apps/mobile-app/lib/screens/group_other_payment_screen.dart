import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/ds/ds.dart';
import '../widgets/group_picker_sheet.dart';

/// "Rahul paid ₹2,000 for dinner": a payment one of the user's contacts
/// made for the group. No account of the user's moves. Their own share
/// counts as their spending, and the contact is owed it - the People page
/// says so until it is paid back.
///
/// Pops with true once saved.
class GroupOtherPaymentScreen extends StatefulWidget {
  final GroupDetail detail;

  /// Told once the payment is saved, before the screen closes.
  final VoidCallback? onSaved;

  const GroupOtherPaymentScreen({super.key, required this.detail, this.onSaved});

  @override
  State<GroupOtherPaymentScreen> createState() => _GroupOtherPaymentScreenState();
}

class _GroupOtherPaymentScreenState extends State<GroupOtherPaymentScreen> {
  final _amount = TextEditingController();
  final _merchant = TextEditingController();
  String? _payerId;
  GroupShare _share = GroupShare.everyone;
  final Set<String> _chosen = {};

  /// On [GroupShare.custom]: each member's part as typed, by member id.
  final Map<String, TextEditingController> _parts = {};
  late DateTime _occurredAt;
  bool _saving = false;
  String? _error;

  GroupDetail get _detail => widget.detail;

  @override
  void initState() {
    super.initState();
    _occurredAt = istWallClock(DateTime.now());
    final mine = _detail.myContacts;
    if (mine.length == 1) _payerId = mine.single.id;
    _chosen.addAll(_detail.everyone.map((m) => m.id));
    for (final member in _detail.everyone) {
      _parts[member.id] = TextEditingController();
    }
  }

  @override
  void dispose() {
    _amount.dispose();
    _merchant.dispose();
    for (final box in _parts.values) {
      box.dispose();
    }
    super.dispose();
  }

  int get _totalMinor => parseRupees(_amount.text) ?? 0;

  String? get _myId => _detail.me?.id;

  GroupMember? get _payer => _detail.myContacts.where((m) => m.id == _payerId).firstOrNull;

  /// Who it is shared between, as ids, or null for everyone.
  List<String>? get _shareWith => switch (_share) {
        GroupShare.everyone => null,
        GroupShare.justMine => _myId == null ? const [] : [_myId!],
        GroupShare.chosen => _detail.everyone.map((m) => m.id).where(_chosen.contains).toList(),
        GroupShare.custom => null,
      };

  /// The user's own part of it: what counts as their spending, and what
  /// they will owe whoever paid.
  int get _myShareMinor {
    final me = _myId;
    if (_share == GroupShare.custom) return me == null ? 0 : readGroupParts(_parts)[me] ?? 0;
    final ids = _shareWith ?? _detail.everyone.map((m) => m.id).toList();
    if (me == null || !ids.contains(me)) return 0;
    return groupShareOut(_totalMinor, ids)[me] ?? 0;
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _occurredAt,
      firstDate: DateTime(2000),
      lastDate: DateTime.now().add(const Duration(days: 1)),
    );
    if (picked == null) return;
    setState(() => _occurredAt = DateTime(picked.year, picked.month, picked.day, _occurredAt.hour, _occurredAt.minute));
  }

  Future<void> _save() async {
    final total = _totalMinor;
    if (_payer == null) return setState(() => _error = 'Pick who paid.');
    if (total <= 0) return setState(() => _error = 'Enter an amount greater than zero.');
    final shareWith = _shareWith;
    if (shareWith != null && shareWith.isEmpty) {
      return setState(() => _error = _share == GroupShare.justMine
          ? "Couldn't tell which member is you. Go back and open the group again."
          : 'Pick at least one person it was for.');
    }
    final parts = _share == GroupShare.custom ? readGroupParts(_parts) : null;
    final partsProblem = parts == null ? null : groupPartsProblem(parts, total);
    if (partsProblem != null) return setState(() => _error = partsProblem);

    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.post('/groups/${_detail.group.id}/payments', {
        'paidBy': {'contactId': _payer!.id},
        'amountMinor': total,
        'occurredAt': fromIstWallClock(_occurredAt).toIso8601String(),
        'merchant': _merchant.text.trim().isEmpty ? null : _merchant.text.trim(),
        'shareWith': shareWith,
        if (parts != null) 'shareAmounts': groupPartsBody(parts),
      });
      widget.onSaved?.call();
      navigator.pop(true);
      messenger.showSnackBar(SnackBar(content: Text('Saved. You owe ${_payer!.name} your share.')));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e is ApiException && !e.message.startsWith('{') ? e.message : "Couldn't save that payment.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final contacts = _detail.myContacts;
    final payer = _payer;
    final myShare = _myShareMinor;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('A payment someone else made', maxLines: 1, overflow: TextOverflow.ellipsis),
            Text(
              _detail.group.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w400, color: c.tx3),
            ),
          ],
        ),
      ),
      body: contacts.isEmpty
          ? ListView(
              padding: kPagePad,
              children: const [
                DsEmpty(
                  icon: DsIcons.users,
                  message: 'Add someone from your contacts to this group first. Only a contact of yours can be '
                      'said to have paid.',
                ),
              ],
            )
          : ListView(
              padding: kPagePad,
              children: [
                const DsLabel('Who paid?', padding: EdgeInsets.only(bottom: 8)),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    for (final contact in contacts)
                      DsChip(
                        label: contact.name,
                        icon: DsIcons.users,
                        selected: contact.id == _payerId,
                        onTap: () => setState(() {
                          _payerId = contact.id;
                          _error = null;
                        }),
                      ),
                  ],
                ),
                const SizedBox(height: 18),
                DsField(
                  label: 'How much',
                  child: TextField(
                    controller: _amount,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    onChanged: (_) => setState(() => _error = null),
                    style: kNum.copyWith(fontSize: 17, color: c.tx),
                    decoration: const InputDecoration(prefixText: '₹ ', hintText: '0.00'),
                  ),
                ),
                const SizedBox(height: 18),
                DsField(
                  label: 'What for',
                  child: TextField(
                    controller: _merchant,
                    textCapitalization: TextCapitalization.sentences,
                    style: TextStyle(fontSize: 15, color: c.tx),
                    decoration: const InputDecoration(hintText: 'Dinner at the beach shack'),
                  ),
                ),
                const SizedBox(height: 18),
                DsField(
                  label: 'When',
                  child: OutlinedButton.icon(
                    onPressed: _pickDate,
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(52),
                      alignment: Alignment.centerLeft,
                      foregroundColor: c.tx,
                    ),
                    icon: DsIcon(DsIcons.calendar, size: 18, color: c.tx3),
                    label: Text(DateFormat('EEE, d MMM yyyy').format(_occurredAt)),
                  ),
                ),
                const SizedBox(height: 18),
                const DsLabel('Who was it for?', padding: EdgeInsets.only(bottom: 8)),
                DsSegmented<GroupShare>(
                  segments: const [
                    (GroupShare.everyone, 'Everyone'),
                    (GroupShare.justMine, 'Just me'),
                    (GroupShare.chosen, 'Choose'),
                    (GroupShare.custom, 'Custom'),
                  ],
                  selected: _share,
                  onChanged: (share) => setState(() {
                    // Typing parts starts from an equal split of what is entered.
                    if (share == GroupShare.custom && readGroupParts(_parts).values.every((p) => p == 0)) {
                      final equal = groupShareOut(_totalMinor, _detail.everyone.map((m) => m.id).toList());
                      for (final entry in _parts.entries) {
                        final part = equal[entry.key] ?? 0;
                        entry.value.text = part > 0 ? (part / 100).toStringAsFixed(2) : '';
                      }
                    }
                    _share = share;
                    _error = null;
                  }),
                ),
                if (_share == GroupShare.custom) ...[
                  const SizedBox(height: 10),
                  GroupPartsEditor(
                    members: _detail.everyone,
                    boxes: _parts,
                    totalMinor: _totalMinor,
                    onChanged: () => setState(() => _error = null),
                  ),
                ],
                if (_share == GroupShare.chosen) ...[
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final member in _detail.everyone)
                        DsChip(
                          label: member.isMe ? 'Me' : member.name,
                          height: 32,
                          selected: _chosen.contains(member.id),
                          onTap: () => setState(() {
                            if (!_chosen.remove(member.id)) _chosen.add(member.id);
                          }),
                        ),
                    ],
                  ),
                ],
                const SizedBox(height: 16),
                if (payer != null && _totalMinor > 0)
                  DsCallout(
                    tone: DsTone.ac,
                    icon: DsIcons.info,
                    title: myShare > 0
                        ? 'Your share is ${formatMoney(myShare)}. It counts as your spending, and you owe '
                            '${payer.name} that much.'
                        : "None of it is yours, so you don't owe ${payer.name} anything for it.",
                    detail: 'Nothing moves on any of your accounts. Paying ${payer.name} back later is '
                        'settling up, which counts as nothing.',
                  ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  DsCallout(tone: DsTone.crit, title: _error!),
                ],
              ],
            ),
      bottomNavigationBar: contacts.isEmpty
          ? null
          : Container(
              decoration: BoxDecoration(color: c.sf2, border: Border(top: BorderSide(color: c.ln))),
              child: SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                  child: SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: _saving ? null : _save,
                      child: Text(_saving ? 'Saving…' : 'Save payment'),
                    ),
                  ),
                ),
              ),
            ),
    );
  }
}
