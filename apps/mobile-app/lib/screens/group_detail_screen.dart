import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/state_block.dart';
import 'group_add_payments_screen.dart';
import 'group_members_screen.dart';
import 'group_other_payment_screen.dart';
import 'group_payments_screen.dart';
import 'groups_screen.dart';

/// How many payments the detail lists before "See all".
const groupDetailPaymentLimit = 5;

/// One group: what it cost, who is in it, who owes whom, and the payments.
///
/// Pops with true when anything changed, so the list's totals are redone.
class GroupDetailScreen extends StatefulWidget {
  final Group group;

  const GroupDetailScreen({super.key, required this.group});

  @override
  State<GroupDetailScreen> createState() => _GroupDetailScreenState();
}

class _GroupDetailScreenState extends State<GroupDetailScreen> {
  GroupDetail? _detail;
  GroupSummary? _summary;
  GroupSettlement? _settlement;
  List<GroupPaymentRow>? _payments;
  bool _error = false;
  bool _busy = false;
  bool _changed = false;

  String get _id => widget.group.id;
  Group get _group => _detail?.group ?? widget.group;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/groups/$_id'),
        ApiClient.instance.get('/groups/$_id/summary'),
        ApiClient.instance.get('/groups/$_id/settlement'),
        ApiClient.instance.get('/groups/$_id/transactions'),
      ]);
      if (!mounted) return;
      setState(() {
        _detail = GroupDetail.fromJson(results[0] as Map<String, dynamic>);
        _summary = GroupSummary.fromJson(results[1] as Map<String, dynamic>);
        _settlement = GroupSettlement.fromJson(results[2] as Map<String, dynamic>);
        _payments = (results[3] as List<dynamic>)
            .map((r) => GroupPaymentRow.fromJson(r as Map<String, dynamic>))
            .toList();
        _error = false;
      });
    } catch (_) {
      if (mounted) setState(() => _error = true);
    }
  }

  /// Runs an action that changes the group, then reloads it.
  Future<void> _run(Future<void> Function() action, {String? done, bool pop = false}) async {
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    try {
      await action();
      _changed = true;
      if (done != null) messenger.showSnackBar(SnackBar(content: Text(done)));
      if (pop) {
        navigator.pop(true);
        return;
      }
      await _load();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(e is ApiException ? e.message : "That didn't work.")));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _push(Widget screen) async {
    final result = await Navigator.of(context).push<Object?>(MaterialPageRoute(builder: (_) => screen));
    if (!mounted) return;
    if (result is int && result > 0) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(addedToGroupMessage(result, _group.name))));
    }
    _changed = true;
    await _load();
  }

  Future<void> _addOtherPayment() async {
    final detail = _detail;
    if (detail == null) return;
    await _push(GroupOtherPaymentScreen(detail: detail));
  }

  Future<void> _edit(GroupPaymentRow row) async {
    final saved = await showEditTransactionById(context, row.transaction.id);
    if (saved == true) {
      _changed = true;
      await _load();
    }
  }

  Future<void> _rescan() => _run(() async {
        final result = await ApiClient.instance.post('/groups/$_id/rescan') as Map<String, dynamic>;
        final claimed = result['claimedCount'] as int? ?? 0;
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text(claimed == 0 ? 'Nothing else from those dates to add.' : 'Added $claimed more.'),
          ));
        }
      });

  Future<void> _delete() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete ${_group.name}?'),
        content: const Text('Every payment in it is kept - only the group goes.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: FilledButton.styleFrom(backgroundColor: context.c.critFill, foregroundColor: Colors.white),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    await _run(
      () => ApiClient.instance.delete('/groups/$_id'),
      done: 'Group deleted. Every payment kept.',
      pop: true,
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final detail = _detail;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        backgroundColor: c.bg,
        appBar: AppBar(
          title: Text(_group.name, maxLines: 1, overflow: TextOverflow.ellipsis),
          actions: [
            IconButton(
              tooltip: 'People',
              onPressed: detail == null
                  ? null
                  : () => _push(GroupMembersScreen(groupId: _id, groupName: _group.name)),
              icon: const DsIcon(DsIcons.users),
            ),
            const SizedBox(width: 4),
          ],
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
                ? const Padding(
                    padding: EdgeInsets.fromLTRB(16, 16, 16, 0),
                    child: DsSkeletonRows(count: 5),
                  )
                : RefreshIndicator(
                    onRefresh: _load,
                    child: ListView(
                      padding: kPagePad,
                      children: [
                        _Headline(detail: detail, summary: _summary, settlement: _settlement),
                        const SizedBox(height: kCardGap),
                        if (detail.group.isActive) ...[
                          FilledButton.icon(
                            onPressed: _busy ? null : _addOtherPayment,
                            icon: const DsIcon(DsIcons.plus, size: 18),
                            label: const Text(
                              'Add a payment someone else made',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(height: 8),
                          OutlinedButton.icon(
                            onPressed: _busy ? null : () => _push(GroupAddPaymentsScreen(group: detail.group)),
                            icon: const DsIcon(DsIcons.listChecks, size: 18),
                            label: const Text('Add earlier payments', maxLines: 1, overflow: TextOverflow.ellipsis),
                          ),
                          const SizedBox(height: kCardGap),
                        ],
                        _WhoOwes(settlement: _settlement),
                        const SizedBox(height: kCardGap),
                        _PeopleCard(
                          detail: detail,
                          settlement: _settlement,
                          onManage: () => _push(GroupMembersScreen(groupId: _id, groupName: _group.name)),
                        ),
                        const SizedBox(height: kCardGap),
                        _PaymentsCard(
                          rows: _payments ?? const [],
                          onEdit: _edit,
                          onSeeAll: () => _push(GroupPaymentsScreen(group: detail.group)),
                        ),
                        const SizedBox(height: 16),
                        _Actions(
                          detail: detail,
                          busy: _busy,
                          onRescan: _rescan,
                          onArchive: () => _run(
                            () => ApiClient.instance.post('/groups/$_id/archive'),
                            done: 'Archived. It stays under Archived, with everything in it.',
                          ),
                          onUnarchive: () => _run(
                            () => ApiClient.instance.post('/groups/$_id/unarchive'),
                            done: 'Active again.',
                          ),
                          onDelete: _delete,
                          onLeave: () => _run(
                            () => ApiClient.instance.post('/groups/$_id/leave'),
                            done: 'You left ${detail.group.name}.',
                            pop: true,
                          ),
                        ),
                      ],
                    ),
                  ),
      ),
    );
  }
}

/// The name, dates and the three figures that matter.
class _Headline extends StatelessWidget {
  final GroupDetail detail;
  final GroupSummary? summary;
  final GroupSettlement? settlement;

  const _Headline({required this.detail, required this.summary, required this.settlement});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final group = detail.group;
    final dates = groupDates(group);
    final people = detail.everyone.length;
    final meta = [
      if (dates != null) dates,
      '$people ${people == 1 ? 'person' : 'people'}',
    ].join(' · ');

    return Container(
      decoration: BoxDecoration(
        color: c.sf,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rXl),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    DsMonogram(group.name, tone: group.isActive ? DsTone.ac : DsTone.neutral),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            group.name,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
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
                  ],
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(child: _Figure(label: 'Total', value: formatMoneyShort(summary?.totalMinor ?? group.totalMinor))),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _Figure(
                        label: 'Payments',
                        value: '${summary?.transactionCount ?? group.transactionCount}',
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: _Figure(label: 'Your share', value: formatMoneyShort(settlement?.mine?.shareMinor ?? 0)),
                    ),
                  ],
                ),
              ],
            ),
          ),
          if (group.source != null) GroupSourceRow(source: group.source!),
        ],
      ),
    );
  }
}

/// Who owes whom: the payments that square everyone off.
class _WhoOwes extends StatelessWidget {
  final GroupSettlement? settlement;

  const _WhoOwes({required this.settlement});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final transfers = settlement?.transfers ?? const <GroupTransfer>[];

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(color: c.goodSoft, borderRadius: BorderRadius.circular(Ds.rLg)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Who owes whom',
            style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
          ),
          const SizedBox(height: 8),
          if (settlement == null)
            Text('Working it out…', style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2))
          else if (transfers.isEmpty)
            Text(
              'Everyone is square - nobody owes anybody anything.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
            )
          else
            for (final transfer in transfers)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    DsAvatar(transfer.fromName, size: 28, tone: DsTone.good),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '${transfer.fromName} → ${transfer.toName}',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      formatMoney(transfer.amountMinor),
                      style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: c.good),
                    ),
                  ],
                ),
              ),
          const SizedBox(height: 6),
          Text(
            "What your contacts owe you, or you owe them, is also on the People page - one balance per person, "
            'across every group.',
            style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
        ],
      ),
    );
  }
}

/// Everyone in the group, with where each stands.
class _PeopleCard extends StatelessWidget {
  final GroupDetail detail;
  final GroupSettlement? settlement;
  final VoidCallback onManage;

  const _PeopleCard({required this.detail, required this.settlement, required this.onManage});

  /// "gets back ₹400", "owes ₹250" or "square".
  static String standing(GroupBalance? balance) {
    final net = balance?.netMinor ?? 0;
    if (net > 0) return 'gets back ${formatMoneyShort(net)}';
    if (net < 0) return 'owes ${formatMoneyShort(-net)}';
    return 'square';
  }

  @override
  Widget build(BuildContext context) {
    final everyone = detail.everyone;
    final balances = settlement?.balances ?? const <GroupBalance>[];

    return DsCard(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DsSectionHeader(
            'People',
            trailing: TextButton(onPressed: onManage, child: const Text('Add or remove')),
          ),
          const SizedBox(height: 4),
          for (var i = 0; i < everyone.length; i++)
            GroupMemberRow(
              member: everyone[i],
              last: i == everyone.length - 1,
              value: standing(balances.where((b) => b.userId == everyone[i].id).firstOrNull),
            ),
        ],
      ),
    );
  }
}

/// The latest payments, everyone's, with the rest a tap away.
class _PaymentsCard extends StatelessWidget {
  final List<GroupPaymentRow> rows;
  final ValueChanged<GroupPaymentRow> onEdit;
  final VoidCallback onSeeAll;

  const _PaymentsCard({required this.rows, required this.onEdit, required this.onSeeAll});

  @override
  Widget build(BuildContext context) {
    final shown = rows.take(groupDetailPaymentLimit).toList();
    return DsCard(
      padding: EdgeInsets.zero,
      clip: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: DsSectionHeader('Payments', meta: '${rows.length}'),
          ),
          if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: DsEmpty(
                icon: DsIcons.list,
                message: 'Nothing in it yet. Pick this group when you add or edit a payment.',
              ),
            )
          else ...[
            for (var i = 0; i < shown.length; i++)
              GroupPaymentTile(
                row: shown[i],
                last: i == shown.length - 1 && rows.length <= groupDetailPaymentLimit,
                onTap: shown[i].isMine ? () => onEdit(shown[i]) : null,
              ),
            if (rows.length > groupDetailPaymentLimit)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: DsLinkRow(label: 'See all ${rows.length} payments', onTap: onSeeAll, divider: false),
              ),
          ],
        ],
      ),
    );
  }
}

/// Re-scan, archive or unarchive, delete - or leave, for someone who did
/// not start it.
class _Actions extends StatelessWidget {
  final GroupDetail detail;
  final bool busy;
  final VoidCallback onRescan;
  final VoidCallback onArchive;
  final VoidCallback onUnarchive;
  final VoidCallback onDelete;
  final VoidCallback onLeave;

  const _Actions({
    required this.detail,
    required this.busy,
    required this.onRescan,
    required this.onArchive,
    required this.onUnarchive,
    required this.onDelete,
    required this.onLeave,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final group = detail.group;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 4,
          runSpacing: 4,
          children: [
            // Only a group from Trippin takes in payments by date.
            if (group.autoAdds)
              TextButton.icon(
                onPressed: busy ? null : onRescan,
                icon: const DsIcon(DsIcons.refresh, size: 18),
                label: const Text('Re-scan its dates'),
              ),
            if (detail.iOwn)
              TextButton.icon(
                onPressed: busy ? null : (group.isActive ? onArchive : onUnarchive),
                icon: DsIcon(group.isActive ? DsIcons.lock : DsIcons.undo, size: 18),
                label: Text(group.isActive ? 'Archive' : 'Unarchive'),
              ),
            if (detail.iOwn)
              TextButton.icon(
                onPressed: busy ? null : onDelete,
                style: TextButton.styleFrom(foregroundColor: c.crit),
                icon: const DsIcon(DsIcons.trash, size: 18),
                label: const Text('Delete'),
              )
            else
              TextButton.icon(
                onPressed: busy ? null : onLeave,
                style: TextButton.styleFrom(foregroundColor: c.crit),
                icon: const DsIcon(DsIcons.x, size: 18),
                label: const Text('Leave'),
              ),
          ],
        ),
        Text(
          group.isActive
              ? 'Archiving tucks it away once it is done with; it stops being offered for new payments. '
                  'Deleting keeps every payment - only the group goes.'
              : 'Archived: not offered for new payments. Unarchive it to use it again.',
          style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
        ),
      ],
    );
  }
}

/// A stat tile in miniature: label over a tabular figure, on `sf2`.
class _Figure extends StatelessWidget {
  final String label;
  final String value;

  const _Figure({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: c.sf2,
        border: Border.all(color: c.ln),
        borderRadius: BorderRadius.circular(Ds.rLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsLabel(label),
          const SizedBox(height: 2),
          // A lakh-sized group on a narrow phone shrinks a little rather
          // than losing digits.
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
            ),
          ),
        ],
      ),
    );
  }
}
