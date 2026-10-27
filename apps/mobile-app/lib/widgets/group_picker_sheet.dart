import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import 'ds/ds.dart';
import '../utils/format.dart';

/// Who a group payment is shared between. [custom] types each one's part.
enum GroupShare { everyone, justMine, chosen, custom }

/// The parts typed, by member id - a blank or unreadable box is nothing.
Map<String, int> readGroupParts(Map<String, TextEditingController> boxes) => {
      for (final entry in boxes.entries) entry.key: parseRupees(entry.value.text) ?? 0,
    };

/// The parts as the server takes them: every member with a part, and only
/// those.
List<Map<String, dynamic>> groupPartsBody(Map<String, int> parts) => [
      for (final entry in parts.entries)
        if (entry.value > 0) {'memberId': entry.key, 'amountMinor': entry.value},
    ];

/// What is wrong with the parts against the payment, or null when they add
/// up to it.
String? groupPartsProblem(Map<String, int> parts, int totalMinor) {
  final sum = parts.values.fold<int>(0, (total, part) => total + part);
  if (sum == 0) return 'Type at least one person\'s part.';
  if (sum == totalMinor) return null;
  return sum > totalMinor
      ? 'The parts add up to ${formatMoney(sum)}, ${formatMoney(sum - totalMinor)} more than the payment.'
      : 'The parts add up to ${formatMoney(sum)}, ${formatMoney(totalMinor - sum)} short of the payment.';
}

/// Each member of a group with a box for their part, and a line saying
/// whether the parts add up to the payment. The boxes are the caller's, by
/// member id, so they keep what was typed across rebuilds.
class GroupPartsEditor extends StatelessWidget {
  const GroupPartsEditor({
    super.key,
    required this.members,
    required this.boxes,
    required this.totalMinor,
    required this.onChanged,
  });

  final List<GroupMember> members;
  final Map<String, TextEditingController> boxes;
  final int totalMinor;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final problem = groupPartsProblem(readGroupParts(boxes), totalMinor);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final member in members)
          if (boxes[member.id] != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      member.isMe ? 'Me' : member.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w500, color: c.tx),
                    ),
                  ),
                  const SizedBox(width: 12),
                  SizedBox(
                    width: 132,
                    child: TextField(
                      key: ValueKey('group-part-${member.id}'),
                      controller: boxes[member.id],
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      textAlign: TextAlign.right,
                      onChanged: (_) => onChanged(),
                      style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.tx),
                      decoration: InputDecoration(
                        isDense: true,
                        hintText: '0.00',
                        prefixText: '₹ ',
                        prefixStyle: TextStyle(fontSize: 14, color: c.tx3, fontWeight: FontWeight.w500),
                        contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
                      ),
                    ),
                  ),
                ],
              ),
            ),
        Text(
          problem ?? 'Adds up to ${formatMoney(totalMinor)}.',
          style: TextStyle(
            fontSize: 12,
            height: 16 / 12,
            fontWeight: problem == null ? FontWeight.w400 : FontWeight.w600,
            color: problem == null ? c.tx3 : c.crit,
          ),
        ),
      ],
    );
  }
}

/// Each person's part of [amountMinor], the way the server works it out:
/// whole paise, the remainder going to the earliest ids, so the parts add
/// back up to the whole and agree with who-owes-whom to the paisa.
Map<String, int> groupShareOut(int amountMinor, List<String> ids) {
  final ordered = [...ids]..sort();
  if (ordered.isEmpty) return const {};
  final base = amountMinor ~/ ordered.length;
  var remainder = amountMinor - base * ordered.length;
  final shares = <String, int>{};
  for (final id in ordered) {
    shares[id] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return shares;
}

/// Picks one of the user's active groups for a payment - Goa, the flat,
/// the office lunch. Nothing goes into a group by itself any more, so this
/// is how a payment gets there, whatever its date. [currentId] is the group
/// it is in already, marked so moving it is a deliberate choice. Null when
/// dismissed.
Future<Group?> showGroupPickerSheet(BuildContext context, {String? currentId}) {
  return showModalBottomSheet<Group>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.c.sf,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(Ds.r3xl)),
    ),
    builder: (_) => _GroupPicker(currentId: currentId),
  );
}

/// "Goa · 4 people · ₹12,400" - who is in it, and what it has cost so far.
String groupPickerMeta(Group group) {
  final people = '${group.memberCount} ${group.memberCount == 1 ? 'person' : 'people'}';
  return '$people · ${formatMoneyShort(group.totalMinor)}';
}

class _GroupPicker extends StatefulWidget {
  const _GroupPicker({this.currentId});

  final String? currentId;

  @override
  State<_GroupPicker> createState() => _GroupPickerState();
}

class _GroupPickerState extends State<_GroupPicker> {
  List<Group>? _groups;
  bool _error = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = false);
    try {
      final result = await ApiClient.instance.get('/groups/active') as List<dynamic>;
      if (!mounted) return;
      setState(() {
        // Archived ones are never offered, whatever the server sends.
        _groups = result
            .map((g) => Group.fromJson(g as Map<String, dynamic>))
            .where((group) => group.isActive)
            .toList();
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final groups = _groups;

    return ConstrainedBox(
      constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.7),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const DsDragHandle(),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: DsSheetHeader(
              icon: DsIcons.users,
              title: 'Add to a group',
              subtitle: 'Shared equally with everyone in it unless you say otherwise.',
            ),
          ),
          Divider(height: 1, color: c.ln),
          if (_error)
            Padding(
              padding: const EdgeInsets.all(16),
              child: Container(
                padding: const EdgeInsets.fromLTRB(14, 6, 6, 6),
                decoration: BoxDecoration(color: c.sunk, borderRadius: BorderRadius.circular(Ds.rLg)),
                child: Row(
                  children: [
                    DsIcon(DsIcons.alertTriangle, size: 20, color: c.tx2),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        "Couldn't load your groups.",
                        style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                      ),
                    ),
                    OutlinedButton(
                      onPressed: _load,
                      style: OutlinedButton.styleFrom(
                        minimumSize: const Size(0, 36),
                        padding: const EdgeInsets.symmetric(horizontal: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(Ds.rMd)),
                        textStyle: const TextStyle(fontFamily: Ds.sans, fontSize: 13, fontWeight: FontWeight.w600),
                      ),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            )
          else if (groups == null)
            const Padding(
              padding: EdgeInsets.all(16),
              child: DsSkeletonRows(count: 3),
            )
          else if (groups.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 24),
              child: DsEmpty(
                icon: DsIcons.users,
                message: 'No active groups. Start one from Groups, then add this to it.',
              ),
            )
          else
            Flexible(
              child: ListView(
                shrinkWrap: true,
                padding: const EdgeInsets.only(bottom: 16),
                children: [
                  for (final group in groups)
                    Material(
                      color: group.id == widget.currentId ? c.acSoft : Colors.transparent,
                      child: InkWell(
                        onTap: () => Navigator.of(context).pop(group),
                        child: Container(
                          constraints: const BoxConstraints(minHeight: 64),
                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                          decoration: BoxDecoration(border: Border(bottom: BorderSide(color: c.ln))),
                          child: Row(
                            children: [
                              DsMonogram(group.name, tone: DsTone.ac, onTinted: group.id == widget.currentId),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        Flexible(
                                          child: Text(
                                            group.name,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              fontSize: 15,
                                              height: 20 / 15,
                                              fontWeight: FontWeight.w600,
                                              color: c.tx,
                                            ),
                                          ),
                                        ),
                                        if (group.id == widget.currentId) ...[
                                          const SizedBox(width: 8),
                                          const DsBadge('In it now', tone: DsTone.ac, onTinted: true),
                                        ],
                                      ],
                                    ),
                                    const SizedBox(height: 2),
                                    Text(
                                      groupPickerMeta(group),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 13,
                                        height: 18 / 13,
                                        color: c.tx3,
                                        fontFeatures: Ds.tabular,
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 8),
                              DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
