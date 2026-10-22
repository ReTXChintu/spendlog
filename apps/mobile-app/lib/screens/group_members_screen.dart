import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../services/phone_contacts.dart';
import '../widgets/ds/ds.dart';
import '../widgets/person_picker_sheet.dart';
import '../widgets/state_block.dart';

/// Who is in a group, and how to get someone else into it.
///
/// Two kinds of people. Someone with SpendLog joins with the code - shown
/// large enough to read across a table, and as a QR for the other phone to
/// scan. Someone without it is added from the user's contacts: their share
/// of what the user pays is owed to the user, on the People page.
///
/// The QR carries the code and nothing else: no link, no deep link
/// handling, and nothing that works outside the app.
class GroupMembersScreen extends StatefulWidget {
  final String groupId;
  final String groupName;

  const GroupMembersScreen({super.key, required this.groupId, required this.groupName});

  @override
  State<GroupMembersScreen> createState() => _GroupMembersScreenState();
}

class _GroupMembersScreenState extends State<GroupMembersScreen> {
  GroupDetail? _detail;
  bool _error = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/groups/${widget.groupId}') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _detail = GroupDetail.fromJson(result);
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  Future<void> _run(Future<void> Function() action, String done) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await action();
      await _load();
      messenger.showSnackBar(SnackBar(content: Text(done)));
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "That didn't work.")),
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Contacts already in, from anyone, so nobody is offered twice.
  Set<String> get _contactIds => {for (final m in _detail?.contacts ?? const <GroupMember>[]) m.id};

  Future<void> _addFromContacts() async {
    final picked = await showPeoplePicker(context, exclude: _contactIds, title: 'Who else is in it?');
    if (picked == null || picked.isEmpty || !mounted) return;
    await _addContacts(picked);
  }

  Future<void> _addByName() async {
    final contact = await addContactByName(context);
    if (contact == null || !mounted) return;
    await _addContacts([contact]);
  }

  Future<void> _addContacts(List<Contact> contacts) => _run(
        () async {
          for (final contact in contacts) {
            await ApiClient.instance.post('/groups/${widget.groupId}/contacts', {'contactId': contact.id});
          }
        },
        contacts.length == 1 ? 'Added ${contacts.single.name}.' : 'Added ${contacts.length} people.',
      );

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final detail = _detail;

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Text(widget.groupName, maxLines: 1, overflow: TextOverflow.ellipsis),
      ),
      body: _error
          ? StateBlock(
              icon: Icons.wifi_off,
              warn: true,
              title: "Couldn't load the group",
              body: 'The connection failed. Check your internet and try again.',
              actionLabel: 'Retry',
              onAction: _load,
            )
          : detail == null
              ? const Center(child: DsSpinner())
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    padding: kPagePad,
                    children: [
                      _MembersCard(
                        detail: detail,
                        busy: _busy,
                        onRemoveUser: (member) => _run(
                          () => ApiClient.instance.delete('/groups/${widget.groupId}/members/${member.id}'),
                          'Removed. What they spent stays in the group.',
                        ),
                        onRemoveContact: (member) => _run(
                          () => ApiClient.instance.delete('/groups/${widget.groupId}/contacts/${member.id}'),
                          'Removed ${member.name}.',
                        ),
                      ),
                      const SizedBox(height: kCardGap),
                      DsCard(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            const DsSectionHeader('Someone without SpendLog'),
                            const SizedBox(height: 4),
                            Text(
                              'Add them from your contacts. Their share of what you pay is owed to you, and '
                              'shows on the People page with everything else between you.',
                              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                            ),
                            const SizedBox(height: 12),
                            FilledButton.icon(
                              onPressed: _busy ? null : _addFromContacts,
                              icon: const DsIcon(DsIcons.users, size: 18),
                              label: const Text('Add from contacts'),
                            ),
                            const SizedBox(height: 4),
                            TextButton(
                              onPressed: _busy ? null : _addByName,
                              child: const Text('Add someone by name'),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: kCardGap),
                      _JoinCodeCard(
                        joinCode: detail.group.joinCode,
                        busy: _busy,
                        canRotate: detail.iOwn,
                        onRotate: () => _run(
                          () => ApiClient.instance.post('/groups/${widget.groupId}/rotate-code').then((_) {}),
                          'New code. The old one no longer works.',
                        ),
                      ),
                      const SizedBox(height: 12),
                      Text(
                        'Everyone with SpendLog here sees what was spent in this group, and nothing else of '
                        'yours. Nothing goes into it by itself - each person picks which payments to add.',
                        style: TextStyle(fontSize: 12, height: 17 / 12, color: c.tx3),
                      ),
                    ],
                  ),
                ),
    );
  }
}

/// Everyone in the group, SpendLog users first, then contacts.
class _MembersCard extends StatelessWidget {
  final GroupDetail detail;
  final bool busy;
  final ValueChanged<GroupMember> onRemoveUser;
  final ValueChanged<GroupMember> onRemoveContact;

  const _MembersCard({
    required this.detail,
    required this.busy,
    required this.onRemoveUser,
    required this.onRemoveContact,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final everyone = detail.everyone;

    return DsCard(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DsSectionHeader(
            'In this group',
            meta: '${everyone.length}',
            trailing: GroupAvatarStack(names: [for (final m in everyone) m.name]),
          ),
          const SizedBox(height: 4),
          for (var i = 0; i < everyone.length; i++)
            GroupMemberRow(
              member: everyone[i],
              last: i == everyone.length - 1,
              trailing: _trailing(context, everyone[i], c),
            ),
        ],
      ),
    );
  }

  Widget? _trailing(BuildContext context, GroupMember member, DsColors c) {
    if (!member.isContact) {
      if (member.isOwner) return const DsBadge('Started it');
      if (!detail.iOwn || member.isMe) return null;
      return TextButton(
        onPressed: busy ? null : () => onRemoveUser(member),
        style: TextButton.styleFrom(foregroundColor: c.crit),
        child: const Text('Remove'),
      );
    }
    if (!member.isMine && !detail.iOwn) return null;
    return TextButton(
      onPressed: busy ? null : () => onRemoveContact(member),
      style: TextButton.styleFrom(foregroundColor: c.crit),
      child: const Text('Remove'),
    );
  }
}

/// One person in a group. A SpendLog user is a round avatar in the accent;
/// a contact is a neutral avatar with a "Contact" tag and whose they are.
class GroupMemberRow extends StatelessWidget {
  final GroupMember member;
  final bool last;
  final Widget? trailing;

  /// What they come to in the group, shown on the right instead of
  /// [trailing] in the detail screen.
  final String? value;

  const GroupMemberRow({super.key, required this.member, this.last = false, this.trailing, this.value});

  /// "You", "SpendLog", "Your contact" or "Asha's contact".
  static String describe(GroupMember member) {
    if (!member.isContact) return member.isMe ? 'You · on SpendLog' : 'On SpendLog';
    if (member.isMine) return 'Your contact · in People';
    return member.addedByName != null ? "${member.addedByName}'s contact" : 'Someone’s contact';
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      constraints: const BoxConstraints(minHeight: 56),
      padding: const EdgeInsets.symmetric(vertical: 8),
      decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
      child: Row(
        children: [
          DsAvatar(member.name, tone: member.isContact ? DsTone.neutral : DsTone.ac),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        member.isMe ? '${member.name} (you)' : member.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                      ),
                    ),
                    if (member.isContact) ...[
                      const SizedBox(width: 6),
                      const Flexible(child: DsBadge('Contact', outline: true)),
                    ],
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  describe(member),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                ),
              ],
            ),
          ),
          if (value != null) ...[
            const SizedBox(width: 8),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 120),
              child: Text(
                value!,
                maxLines: 2,
                textAlign: TextAlign.end,
                style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w600, color: c.tx2),
              ),
            ),
          ],
          if (trailing != null) ...[const SizedBox(width: 8), trailing!],
        ],
      ),
    );
  }
}

/// The code, large and as a QR, for someone with SpendLog to join.
class _JoinCodeCard extends StatelessWidget {
  final String joinCode;
  final bool busy;
  final bool canRotate;
  final VoidCallback onRotate;

  const _JoinCodeCard({required this.joinCode, required this.busy, required this.canRotate, required this.onRotate});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsSectionHeader('Someone with SpendLog'),
          const SizedBox(height: 4),
          Text(
            'Show them this. They scan it, or type the code in themselves.',
            style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
          ),
          const SizedBox(height: 16),
          Center(
            // White behind it whatever the theme: a QR has to stay readable
            // to another phone's camera.
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                border: Border.all(color: c.ln),
                borderRadius: BorderRadius.circular(Ds.rLg),
              ),
              child: QrImageView(
                data: joinCode,
                size: 180,
                backgroundColor: Colors.white,
                // No point drawing something unscannable.
                errorStateBuilder: (context, _) => const SizedBox(
                  width: 180,
                  height: 180,
                  child: Center(child: Text('Could not draw the code')),
                ),
              ),
            ),
          ),
          const SizedBox(height: 16),
          const DsLabel('Join code', padding: EdgeInsets.only(bottom: 6)),
          // The code reads as a machine string: Plex Mono on a read-only
          // field.
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: c.sf2,
              border: Border.all(color: c.ln2),
              borderRadius: BorderRadius.circular(Ds.rMd),
            ),
            child: Center(
              child: SelectableText(
                joinCode,
                style: kMono.copyWith(
                  fontSize: 26,
                  height: 32 / 26,
                  fontWeight: FontWeight.w500,
                  letterSpacing: 26 * 0.12,
                  color: c.tx,
                ),
              ),
            ),
          ),
          if (canRotate) ...[
            const SizedBox(height: 4),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                style: TextButton.styleFrom(padding: EdgeInsets.zero),
                onPressed: busy ? null : onRotate,
                icon: const DsIcon(DsIcons.refresh, size: 18),
                label: const Text('New code'),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

DsTone _toneFor(int i) => const [DsTone.ac, DsTone.good, DsTone.warn, DsTone.neutral][i % 4];

/// Overlapping avatars, each ringed in the page colour.
class GroupAvatarStack extends StatelessWidget {
  final List<String> names;

  const GroupAvatarStack({super.key, required this.names});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final shown = names.take(4).toList();
    if (shown.isEmpty) return const SizedBox.shrink();
    const size = 28.0;
    return SizedBox(
      height: size + 4,
      width: (size + 4) + (shown.length - 1) * (size + 4 - 8),
      child: Stack(
        children: [
          for (var i = 0; i < shown.length; i++)
            Positioned(
              left: i * (size + 4 - 8),
              child: Container(
                padding: const EdgeInsets.all(2),
                decoration: BoxDecoration(color: c.sf, shape: BoxShape.circle),
                child: DsAvatar(shown[i], size: size, tone: _toneFor(i)),
              ),
            ),
        ],
      ),
    );
  }
}
