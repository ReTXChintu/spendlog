import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/ds/ds.dart';

/// One person in the starting-balances editor, and what stood between
/// the two of you when the group began here.
class OpeningDraft {
  final String memberId;
  final String name;
  final bool isContact;
  final TextEditingController amount;
  OpeningDirection direction;

  /// Set when the other person already said what's owed between you: theirs
  /// stands, shown instead of a field.
  final GroupOpening? setByThem;

  OpeningDraft({
    required this.memberId,
    required this.name,
    required this.isContact,
    int amountMinor = 0,
    this.direction = OpeningDirection.owesMe,
    this.setByThem,
  }) : amount = TextEditingController(text: amountMinor > 0 ? _rupees(amountMinor) : '');

  /// Whole rupees without the ".00", so editing ₹1,200 shows "1200".
  static String _rupees(int paise) => paise % 100 == 0 ? '${paise ~/ 100}' : (paise / 100).toStringAsFixed(2);

  /// What was typed, in paise; 0 for nothing usable.
  int get amountMinor => setByThem != null ? 0 : (parseRupees(amount.text) ?? 0);

  void dispose() => amount.dispose();
}

/// What the editor sends: one entry per person with an amount, none for
/// the rest - leaving someone at nothing takes theirs away.
List<Map<String, dynamic>> openingsBodyOf(List<OpeningDraft> drafts) => [
      for (final draft in drafts)
        if (draft.amountMinor > 0)
          openingBody(
            isContact: draft.isContact,
            memberId: draft.memberId,
            direction: draft.direction,
            amountMinor: draft.amountMinor,
          ),
    ];

/// Every person with an amount field and "Owes me / I owe" - what was
/// already owed when a running group comes into SpendLog. Used by "New
/// group" and by the group's own Starting balances.
class GroupOpeningsEditor extends StatelessWidget {
  final List<OpeningDraft> drafts;
  final VoidCallback onChanged;
  final bool enabled;

  const GroupOpeningsEditor({super.key, required this.drafts, required this.onChanged, this.enabled = true});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < drafts.length; i++) ...[
          if (i > 0) Divider(color: c.ln, height: 24),
          _OpeningRow(draft: drafts[i], onChanged: onChanged, enabled: enabled),
        ],
      ],
    );
  }
}

class _OpeningRow extends StatelessWidget {
  final OpeningDraft draft;
  final VoidCallback onChanged;
  final bool enabled;

  const _OpeningRow({required this.draft, required this.onChanged, required this.enabled});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final theirs = draft.setByThem;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            DsAvatar(draft.name, size: 32, tone: draft.isContact ? DsTone.neutral : DsTone.ac),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    draft.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  Text(
                    draft.isContact ? 'Your contact · in People' : 'On SpendLog · settles in the group',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        if (theirs != null)
          Text(
            '${draft.name} already set this: ${openingSentence(theirs)}. Only they can change it.',
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
          )
        else
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: TextField(
                  key: ValueKey('opening-amount-${draft.memberId}'),
                  controller: draft.amount,
                  enabled: enabled,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  onChanged: (_) => onChanged(),
                  style: kNum.copyWith(fontSize: 15, color: c.tx),
                  decoration: InputDecoration(
                    prefixText: '₹ ',
                    hintText: '0',
                    isDense: true,
                    labelText: 'Amount for ${draft.name}',
                    floatingLabelBehavior: FloatingLabelBehavior.never,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: DsSegmented<OpeningDirection>(
                  key: ValueKey('opening-direction-${draft.memberId}'),
                  segments: const [
                    (OpeningDirection.owesMe, 'Owes me'),
                    (OpeningDirection.iOwe, 'I owe'),
                  ],
                  selected: draft.direction,
                  onChanged: enabled
                      ? (direction) {
                          draft.direction = direction;
                          onChanged();
                        }
                      : null,
                ),
              ),
            ],
          ),
      ],
    );
  }
}

/// "Rahul owes you ₹1,200", "You owe Priya ₹450", or - between two other
/// people - "Meera owes Asha ₹300": an opening from the signed-in user's side.
String openingSentence(GroupOpening opening) {
  final money = formatMoneyShort(opening.amountMinor);
  return switch (opening.viewerDirection) {
    OpeningDirection.owesMe => '${opening.isMine ? opening.memberName : opening.setByName} owes you $money',
    OpeningDirection.iOwe => 'You owe ${opening.isMine ? opening.memberName : opening.setByName} $money',
    null => '${opening.fromName} owes ${opening.toName} $money',
  };
}

/// A group's Starting balances: what the signed-in user says was owed
/// between them and each of the others when the group began here, and -
/// read only - what the others set.
///
/// Pops with true once saved.
class GroupOpeningsScreen extends StatefulWidget {
  final GroupDetail detail;

  const GroupOpeningsScreen({super.key, required this.detail});

  @override
  State<GroupOpeningsScreen> createState() => _GroupOpeningsScreenState();
}

class _GroupOpeningsScreenState extends State<GroupOpeningsScreen> {
  late final List<OpeningDraft> _drafts;
  bool _saving = false;
  String? _error;

  GroupDetail get _detail => widget.detail;

  @override
  void initState() {
    super.initState();
    final mine = _detail.myOpenings;
    _drafts = [
      for (final member in _detail.openingMembers)
        () {
          final existing = mine.where((o) => o.memberId == member.id).firstOrNull;
          return OpeningDraft(
            memberId: member.id,
            name: member.name,
            isContact: member.isContact,
            amountMinor: existing?.amountMinor ?? 0,
            direction: existing?.direction ?? OpeningDirection.owesMe,
            setByThem: member.isContact ? null : _detail.openingSetWithMeBy(member.id),
          );
        }(),
    ];
  }

  @override
  void dispose() {
    for (final draft in _drafts) {
      draft.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ApiClient.instance.put('/groups/${_detail.group.id}/openings', {
        'openingBalances': openingsBodyOf(_drafts),
      });
      navigator.pop(true);
      messenger.showSnackBar(const SnackBar(content: Text('Starting balances saved.')));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e is ApiException && !e.message.startsWith('{') ? e.message : "Couldn't save those.";
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    // Between two other people: theirs to set, shown so the group's
    // arithmetic has no surprises in it.
    final others = _detail.openings.where((o) => !o.isMine && o.viewerDirection == null).toList();

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Starting balances', maxLines: 1, overflow: TextOverflow.ellipsis),
            Text(
              _detail.group.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w400, color: c.tx3),
            ),
          ],
        ),
      ),
      body: ListView(
        padding: kPagePad,
        children: [
          Text(
            'Anything already owed when the group began here. It starts the group\'s who-owes-whom, and with '
            'a contact it moves their balance on People too. It isn\'t spending - nothing counts in your '
            'budget and no account moves.',
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
          ),
          const SizedBox(height: 16),
          if (_drafts.isEmpty)
            const DsEmpty(
              icon: DsIcons.users,
              message: 'Nobody to set one with yet. Add your contacts to the group, or have friends join with '
                  'the code.',
            )
          else
            DsCard(
              child: GroupOpeningsEditor(
                drafts: _drafts,
                enabled: !_saving,
                onChanged: () => setState(() => _error = null),
              ),
            ),
          if (others.isNotEmpty) ...[
            const SizedBox(height: kCardGap),
            const DsLabel('Set by others', padding: EdgeInsets.only(left: 2, bottom: 8)),
            DsCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final opening in others)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 4),
                      child: Text(
                        '${openingSentence(opening)} · set by ${opening.setByName}',
                        style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                      ),
                    ),
                ],
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            DsCallout(tone: DsTone.crit, title: _error!),
          ],
        ],
      ),
      bottomNavigationBar: _drafts.isEmpty
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
                      child: Text(_saving ? 'Saving…' : 'Save starting balances'),
                    ),
                  ),
                ),
              ),
            ),
    );
  }
}
