import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/person_picker_sheet.dart';
import '../widgets/state_block.dart';
import 'group_detail_screen.dart';
import 'group_openings_screen.dart';
import 'join_group_screen.dart';

/// Groups: spending shared with people - a holiday, the flat, an office
/// lunch - totalled on its own, with who owes whom.
///
/// Nothing goes into a group by itself: a payment is put in one from the
/// editor, which offers every active group. A group stays active until
/// someone archives it; archived ones fold away at the bottom.
class GroupsScreen extends StatefulWidget {
  const GroupsScreen({super.key});

  @override
  State<GroupsScreen> createState() => _GroupsScreenState();
}

class _GroupsScreenState extends State<GroupsScreen> {
  List<Group>? _groups;
  bool _error = false;
  bool _showArchived = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/groups') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        _groups = result.map((g) => Group.fromJson(g as Map<String, dynamic>)).toList();
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _open(Group group) async {
    await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => GroupDetailScreen(group: group)),
    );
    if (mounted) await _load();
  }

  Future<void> _join() async {
    final joined = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const JoinGroupScreen()),
    );
    if (joined == null || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Joined $joined.')));
    await _load();
  }

  Future<void> _create() async {
    final created = await showModalBottomSheet<Group>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.c.sf,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
      ),
      builder: (sheetContext) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
        child: const NewGroupSheet(),
      ),
    );
    if (created == null || !mounted) return;
    await _load();
    if (mounted) await _open(created);
  }

  @override
  Widget build(BuildContext context) {
    final groups = _groups;
    final active = groups?.where((g) => g.isActive).toList() ?? const <Group>[];
    final archived = groups?.where((g) => !g.isActive).toList() ?? const <Group>[];

    return Scaffold(
      backgroundColor: context.c.bg,
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: kPagePad,
          children: [
            _IntroCard(onCreate: _create, onJoin: _join),
            const SizedBox(height: 20),
            if (_error)
              StateBlock(
                icon: Icons.wifi_off,
                warn: true,
                title: "Couldn't load your groups",
                body: 'The connection failed. Check your internet and try again.',
                actionLabel: 'Retry',
                onAction: _load,
              )
            else if (groups == null)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 40),
                child: Center(child: DsSpinner()),
              )
            else if (groups.isEmpty)
              const StateBlock(
                icon: Icons.group_outlined,
                title: 'No groups yet',
                body: 'Make one for a trip, the flat or a regular lunch. Add the people in it - from SpendLog '
                    'or your contacts - and pick it when you add a payment.',
              )
            else ...[
              if (active.isNotEmpty) ...[
                const DsLabel('Active', padding: EdgeInsets.only(left: 2, bottom: 8)),
                for (final group in active) GroupCard(group: group, onTap: () => _open(group)),
              ] else
                const Padding(
                  padding: EdgeInsets.only(bottom: 12),
                  child: DsEmpty(icon: DsIcons.users, message: 'No active groups. Archived ones are below.'),
                ),
              if (archived.isNotEmpty) ...[
                const SizedBox(height: 8),
                _ArchivedToggle(
                  count: archived.length,
                  open: _showArchived,
                  onTap: () => setState(() => _showArchived = !_showArchived),
                ),
                if (_showArchived)
                  for (final group in archived) GroupCard(group: group, onTap: () => _open(group)),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

/// What groups are for, and the two ways to get one.
class _IntroCard extends StatelessWidget {
  final VoidCallback onCreate;
  final VoidCallback onJoin;

  const _IntroCard({required this.onCreate, required this.onJoin});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const DsIconTile(DsIcons.users, tone: DsTone.ac),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Spending shared with people',
                      style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      'A trip, the flat, an office lunch. Pick a group when you add or edit a payment - '
                      "it's split equally with everyone in it unless you say otherwise.",
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: onCreate,
                  icon: const DsIcon(DsIcons.plus, size: 18),
                  label: const Text('New group', maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: onJoin,
                style: OutlinedButton.styleFrom(minimumSize: const Size(64, 48)),
                child: const Text('Join one'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// "Archived (3)", folding the archived groups away.
class _ArchivedToggle extends StatelessWidget {
  final int count;
  final bool open;
  final VoidCallback onTap;

  const _ArchivedToggle({required this.count, required this.open, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Semantics(
      button: true,
      expanded: open,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(Ds.rMd),
        child: Container(
          constraints: const BoxConstraints(minHeight: 48),
          padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 8),
          child: Row(
            children: [
              Text(
                'Archived ($count)',
                style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, letterSpacing: 0.24, color: c.tx2),
              ),
              const SizedBox(width: 4),
              DsIcon(open ? DsIcons.chevronUp : DsIcons.chevronDown, size: 16, color: c.tx2),
              const SizedBox(width: 8),
              Expanded(child: Divider(color: c.ln)),
            ],
          ),
        ),
      ),
    );
  }
}

/// "1 Aug – 6 Aug", "From 1 Aug", "Until 6 Aug", or null with no dates.
String? groupDates(Group group) {
  final from = group.startedAt;
  final to = group.endedAt;
  if (from != null && to != null) return '${formatShortDate(from)} – ${formatShortDate(to)}';
  if (from != null) return 'From ${formatShortDate(from)}';
  if (to != null) return 'Until ${formatShortDate(to)}';
  return null;
}

/// One group in the list: what it is, who is in it, what it cost.
class GroupCard extends StatelessWidget {
  final Group group;
  final VoidCallback onTap;

  const GroupCard({super.key, required this.group, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final dates = groupDates(group);
    final meta = [
      if (dates != null) dates,
      '${group.memberCount} ${group.memberCount == 1 ? 'person' : 'people'}',
      '${group.transactionCount} ${group.transactionCount == 1 ? 'payment' : 'payments'}',
    ].join(' · ');

    return Container(
      margin: const EdgeInsets.only(bottom: kCardGap),
      decoration: BoxDecoration(
        color: c.sf,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    DsMonogram(group.name, tone: group.isActive ? DsTone.ac : DsTone.neutral),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            group.name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontWeight: FontWeight.w600, fontSize: 15, height: 20 / 15, color: c.tx),
                          ),
                          const SizedBox(height: 2),
                          Text(meta, style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3)),
                          if (group.isArchived) ...[
                            const SizedBox(height: 6),
                            const DsBadge('Archived'),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      formatMoney(group.totalMinor),
                      style: kNum.copyWith(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                    ),
                    const SizedBox(width: 4),
                    DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
                  ],
                ),
              ),
            ),
          ),
          if (group.source != null) GroupSourceRow(source: group.source!),
        ],
      ),
    );
  }
}

/// Where a group planned in Trippin says so: a chip back to it while
/// linked, and a note of where it came from once tracking was switched off
/// there.
class GroupSourceRow extends StatelessWidget {
  final GroupSource source;
  final bool tinted;

  const GroupSourceRow({super.key, required this.source, this.tinted = false});

  Future<void> _open() async {
    final url = source.url;
    if (url == null || url.isEmpty) return;
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final linked = source.linked;
    final hasUrl = source.url != null && source.url!.isNotEmpty;
    final fg = linked ? c.ac : c.tx2;

    return Container(
      width: double.infinity,
      color: tinted ? c.acSoft : null,
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // An accent badge while linked (neutral once it isn't), which
          // opens the trip in Trippin.
          Material(
            color: linked ? (tinted ? c.sf : c.acSoft) : c.sunk,
            borderRadius: BorderRadius.circular(Ds.rSm),
            child: InkWell(
              borderRadius: BorderRadius.circular(Ds.rSm),
              onTap: hasUrl ? _open : null,
              child: Container(
                constraints: const BoxConstraints(minHeight: 28),
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    DsIcon(DsIcons.link, size: 14, color: fg),
                    const SizedBox(width: 6),
                    Text(
                      linked ? 'Planned in Trippin' : 'Was linked to Trippin',
                      style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: fg),
                    ),
                    if (hasUrl) ...[
                      const SizedBox(width: 4),
                      DsIcon(DsIcons.arrowUpRight, size: 14, color: fg),
                    ],
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            linked
                ? "Its name, dates and people follow Trippin, and payments between its dates go in by "
                    "themselves. You can change it here, but Trippin's next change overwrites yours."
                : "Tracking was switched off in Trippin. Everything in it stayed, and it's an "
                    'ordinary group now.',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}

/// A new group: a name, optional dates, and optionally the contacts in it -
/// then, with anyone in it, an optional "Anything already owed?" for a
/// group that was running before SpendLog. Pops with the group once made.
class NewGroupSheet extends StatefulWidget {
  const NewGroupSheet({super.key});

  @override
  State<NewGroupSheet> createState() => _NewGroupSheetState();
}

class _NewGroupSheetState extends State<NewGroupSheet> {
  final _name = TextEditingController();
  DateTime? _startsOn;
  DateTime? _endsOn;
  final List<Contact> _contacts = [];
  bool _saving = false;
  String? _error;

  /// On the second step: what was already owed with each of them.
  bool _askingOwed = false;
  final Map<String, OpeningDraft> _drafts = {};

  @override
  void dispose() {
    _name.dispose();
    for (final draft in _drafts.values) {
      draft.dispose();
    }
    super.dispose();
  }

  /// The checks the first step can make, as a sentence, or null.
  String? _firstStepError() {
    if (_name.text.trim().isEmpty) return 'Give it a name.';
    if (_startsOn != null && _endsOn != null && _endsOn!.isBefore(_startsOn!)) {
      return "It can't end before it starts.";
    }
    return null;
  }

  /// On to "Anything already owed?", one row per contact, keeping whatever
  /// was typed for someone before going back.
  void _next() {
    final problem = _firstStepError();
    if (problem != null) return setState(() => _error = problem);
    setState(() {
      for (final contact in _contacts) {
        _drafts.putIfAbsent(contact.id, () => OpeningDraft(memberId: contact.id, name: contact.name, isContact: true));
      }
      _error = null;
      _askingOwed = true;
    });
  }

  List<OpeningDraft> get _shownDrafts => [
        for (final contact in _contacts)
          if (_drafts[contact.id] != null) _drafts[contact.id]!,
      ];

  Future<void> _pickDate({required bool start}) async {
    final current = start ? _startsOn : _endsOn;
    final picked = await showDatePicker(
      context: context,
      initialDate: current ?? (start ? null : _startsOn) ?? DateTime.now(),
      firstDate: DateTime(2000),
      lastDate: DateTime(2100),
    );
    if (picked == null) return;
    setState(() {
      if (start) {
        _startsOn = picked;
      } else {
        _endsOn = picked;
      }
      _error = null;
    });
  }

  Future<void> _pickContacts() async {
    final picked = await showPeoplePicker(
      context,
      exclude: {for (final c in _contacts) c.id},
      title: "Who's in it?",
    );
    if (picked == null || !mounted) return;
    setState(() => _contacts.addAll(picked));
  }

  /// A calendar day as the start of that day in IST, as the server keeps it.
  String _dayStart(DateTime day) => fromIstWallClock(DateTime(day.year, day.month, day.day)).toIso8601String();

  /// The last moment of that day in IST.
  String _dayEnd(DateTime day) =>
      fromIstWallClock(DateTime(day.year, day.month, day.day, 23, 59, 59)).toIso8601String();

  Future<void> _save({bool withOpenings = true}) async {
    final name = _name.text.trim();
    final problem = _firstStepError();
    if (problem != null) return setState(() => _error = problem);
    final openings = withOpenings && _askingOwed ? openingsBodyOf(_shownDrafts) : const <Map<String, dynamic>>[];
    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      final json = await ApiClient.instance.post('/groups', {
        'name': name,
        'startedAt': _startsOn == null ? null : _dayStart(_startsOn!),
        'endedAt': _endsOn == null ? null : _dayEnd(_endsOn!),
        if (_contacts.isNotEmpty) 'contactIds': [for (final c in _contacts) c.id],
        if (openings.isNotEmpty) 'openingBalances': openings,
      }) as Map<String, dynamic>;
      navigator.pop(Group.fromJson(json));
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _error = e is ApiException && !e.message.startsWith('{') ? e.message : "Couldn't make that group.";
      });
    }
  }

  Widget _dateButton({required String label, required DateTime? value, required bool start}) {
    final c = context.c;
    return DsField(
      label: label,
      child: Row(
        children: [
          Expanded(
            child: OutlinedButton(
              onPressed: () => _pickDate(start: start),
              style: OutlinedButton.styleFrom(
                minimumSize: const Size.fromHeight(48),
                alignment: Alignment.centerLeft,
                padding: const EdgeInsets.symmetric(horizontal: 12),
                foregroundColor: value == null ? c.tx3 : c.tx,
              ),
              child: Text(
                value == null ? 'Optional' : DateFormat('d MMM yyyy').format(value),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          if (value != null)
            IconButton(
              tooltip: 'Clear the ${label.toLowerCase()} date',
              onPressed: () => setState(() {
                if (start) {
                  _startsOn = null;
                } else {
                  _endsOn = null;
                }
              }),
              icon: DsIcon(DsIcons.x, size: 18, color: c.tx3),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const DsDragHandle(),
            DsSheetHeader(
              icon: DsIcons.users,
              title: _askingOwed ? 'Anything already owed?' : 'New group',
              onClose: _saving ? null : () => Navigator.of(context).pop(),
            ),
            const SizedBox(height: 16),
            if (_askingOwed) ..._owedStep(c) else ..._detailsStep(c),
          ],
        ),
      ),
    );
  }

  /// "Anything already owed?": optional, for a group that was running
  /// before it came into SpendLog.
  List<Widget> _owedStep(DsColors c) => [
        Text(
          'If ${_name.text.trim()} was already running, say what was owed when it began here - '
          '"Rahul owes me ₹1,200". Leave anyone at nothing. It isn\'t spending: only who owes whom moves.',
          style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
        ),
        const SizedBox(height: 16),
        GroupOpeningsEditor(
          drafts: _shownDrafts,
          enabled: !_saving,
          onChanged: () => setState(() => _error = null),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          DsCallout(tone: DsTone.crit, title: _error!),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _saving ? null : _save,
          child: Text(_saving ? 'Making it…' : 'Make the group'),
        ),
        const SizedBox(height: 8),
        // Wraps rather than overflowing on a narrow phone with large text.
        Wrap(
          alignment: WrapAlignment.spaceBetween,
          spacing: 8,
          children: [
            TextButton(
              onPressed: _saving ? null : () => setState(() => _askingOwed = false),
              child: const Text('Back'),
            ),
            TextButton(
              onPressed: _saving ? null : () => _save(withOpenings: false),
              child: const Text('Skip - nothing owed'),
            ),
          ],
        ),
      ];

  /// The name, dates and contacts.
  List<Widget> _detailsStep(DsColors c) => [
            DsField(
              label: 'Name',
              child: TextField(
                controller: _name,
                autofocus: true,
                textCapitalization: TextCapitalization.sentences,
                style: TextStyle(fontSize: 15, color: c.tx),
                decoration: const InputDecoration(hintText: 'Goa trip, Flatmates, Office lunch'),
              ),
            ),
            const SizedBox(height: 16),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: _dateButton(label: 'Starts', value: _startsOn, start: true)),
                const SizedBox(width: 12),
                Expanded(child: _dateButton(label: 'Ends', value: _endsOn, start: false)),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              "Dates are only labels - nothing goes in by itself. It stays active until you archive it.",
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
            const SizedBox(height: 16),
            const DsLabel('People without SpendLog'),
            const SizedBox(height: 6),
            if (_contacts.isNotEmpty) ...[
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final contact in _contacts)
                    InputChip(
                      label: Text(contact.name),
                      onDeleted: () => setState(() => _contacts.removeWhere((c) => c.id == contact.id)),
                      deleteButtonTooltipMessage: 'Take ${contact.name} off',
                    ),
                ],
              ),
              const SizedBox(height: 8),
            ],
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: _saving ? null : _pickContacts,
                style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 4)),
                icon: const DsIcon(DsIcons.plus, size: 18),
                label: const Text('Add from contacts'),
              ),
            ),
            Text(
              'People with SpendLog join with the code, from the group once it is made.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              DsCallout(tone: DsTone.crit, title: _error!),
            ],
            const SizedBox(height: 16),
            // With people in it, on to what was already owed with them.
            if (_contacts.isNotEmpty)
              FilledButton(
                onPressed: _saving ? null : _next,
                child: const Text('Next'),
              )
            else
              FilledButton(
                onPressed: _saving ? null : _save,
                child: Text(_saving ? 'Making it…' : 'Make the group'),
              ),
          ];
}
