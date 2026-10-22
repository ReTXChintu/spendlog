import 'dart:async';
import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/state_block.dart';

/// How far back the list reaches - from the group's start, or from today
/// for a group with no dates - one step per "go back further". Tickets are
/// booked weeks out, sometimes months.
const groupLookbackSteps = [60, 180, 365];

/// "Added 3 payments to Goa".
String addedToGroupMessage(int added, String groupName) =>
    'Added $added ${added == 1 ? 'payment' : 'payments'} to $groupName';

/// Picks payments made before - tickets, a hotel's advance, last week's
/// groceries - and puts them in a group. Nothing goes into a group by
/// itself, so this is how the earlier ones get there.
///
/// Pops with how many were added, or null when nothing was.
class GroupAddPaymentsScreen extends StatefulWidget {
  final Group group;

  const GroupAddPaymentsScreen({super.key, required this.group});

  @override
  State<GroupAddPaymentsScreen> createState() => _GroupAddPaymentsScreenState();
}

class _GroupAddPaymentsScreenState extends State<GroupAddPaymentsScreen> {
  final _search = TextEditingController();
  Timer? _debounce;

  int _step = 0;
  List<GroupCandidate>? _rows;
  bool _error = false;
  bool _saving = false;

  /// Picked rows, kept by id across searches and a longer look back, so
  /// the total on the button never forgets one that scrolled out of view.
  final Map<String, GroupCandidate> _picked = {};

  /// Which load is the latest, so a slow answer to an older search cannot
  /// replace a newer one.
  int _loadToken = 0;

  int get _days => groupLookbackSteps[_step];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final token = ++_loadToken;
    setState(() {
      _rows = null;
      _error = false;
    });
    final q = _search.text.trim();
    try {
      final result = await ApiClient.instance.get(
        '/groups/${widget.group.id}/candidates?days=$_days'
        '${q.isEmpty ? '' : '&q=${Uri.encodeQueryComponent(q)}'}',
      ) as List<dynamic>;
      if (!mounted || token != _loadToken) return;
      setState(() => _rows = result.map((r) => GroupCandidate.fromJson(r as Map<String, dynamic>)).toList());
    } catch (_) {
      if (mounted && token == _loadToken) setState(() => _error = true);
    }
  }

  void _onSearch(String _) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), _load);
  }

  void _goBackFurther() {
    if (_step >= groupLookbackSteps.length - 1) return;
    setState(() => _step += 1);
    _load();
  }

  void _toggle(GroupCandidate row) {
    setState(() {
      if (_picked.remove(row.id) == null) _picked[row.id] = row;
    });
  }

  Future<void> _add() async {
    if (_picked.isEmpty) return;
    setState(() => _saving = true);
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      final result = await ApiClient.instance.post(
        '/groups/${widget.group.id}/add',
        {'transactionIds': _picked.keys.toList()},
      ) as Map<String, dynamic>;
      navigator.pop(result['added'] as int? ?? _picked.length);
    } catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      messenger.showSnackBar(
        SnackBar(content: Text(e is ApiException ? e.message : "Couldn't add those. Try again.")),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final rows = _rows;
    final travel = rows?.where((r) => r.likelyTravel).toList() ?? const <GroupCandidate>[];
    final rest = rows?.where((r) => !r.likelyTravel).toList() ?? const <GroupCandidate>[];
    final from = (widget.group.startedAt ?? DateTime.now()).subtract(Duration(days: _days));
    final count = _picked.length;
    final totalMinor = _picked.values.fold<int>(0, (sum, row) => sum + row.amountMinor);

    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Add earlier payments'),
            Text(
              widget.group.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w400, color: c.tx3),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: TextField(
              controller: _search,
              onChanged: _onSearch,
              textInputAction: TextInputAction.search,
              style: TextStyle(fontSize: 14, color: c.tx),
              decoration: InputDecoration(
                hintText: 'Search merchant or note',
                hintStyle: TextStyle(fontSize: 14, color: c.tx3),
                prefixIcon: Padding(
                  padding: const EdgeInsets.only(left: 12, right: 8),
                  child: DsIcon(DsIcons.search, size: 20, color: c.tx3),
                ),
                prefixIconConstraints: const BoxConstraints(minWidth: 40, minHeight: 44),
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 8, 0),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    'Your payments since ${formatShortDate(from)}, in no group yet',
                    maxLines: 2,
                    style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                  ),
                ),
                if (_step < groupLookbackSteps.length - 1)
                  TextButton.icon(
                    onPressed: _goBackFurther,
                    icon: const DsIcon(DsIcons.calendar, size: 16),
                    label: const Text('Go back further'),
                  ),
              ],
            ),
          ),
          Expanded(
            child: _error
                ? StateBlock(
                    icon: Icons.wifi_off,
                    warn: true,
                    title: "Couldn't load your payments",
                    body: 'The connection failed. Check your internet and try again.',
                    actionLabel: 'Retry',
                    onAction: _load,
                  )
                : rows == null
                    ? const Padding(
                        padding: EdgeInsets.fromLTRB(16, 16, 16, 0),
                        child: DsSkeletonRows(count: 5, caption: 'Loading your payments…'),
                      )
                    : rows.isEmpty
                        ? StateBlock(
                            icon: Icons.receipt_long_outlined,
                            title: 'Nothing to add',
                            body: _search.text.trim().isNotEmpty
                                ? 'No payment matches that search.'
                                : 'Every payment since ${formatShortDate(from)} is already in a group, '
                                    'or there were none.',
                            actionLabel: _step < groupLookbackSteps.length - 1 ? 'Go back further' : null,
                            onAction: _step < groupLookbackSteps.length - 1 ? _goBackFurther : null,
                          )
                        : ListView(
                            padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
                            children: [
                              if (travel.isNotEmpty) ...[
                                const _SectionLabel('Looks like travel'),
                                _RowCard(
                                  rows: travel,
                                  picked: _picked,
                                  onToggle: _toggle,
                                ),
                              ],
                              if (rest.isNotEmpty) ...[
                                _SectionLabel(travel.isEmpty ? 'Your payments' : 'Everything else'),
                                _RowCard(
                                  rows: rest,
                                  picked: _picked,
                                  onToggle: _toggle,
                                ),
                              ],
                            ],
                          ),
          ),
        ],
      ),
      // The footer stays pinned, so the total is always in view.
      bottomNavigationBar: Container(
        decoration: BoxDecoration(
          color: c.sf2,
          border: Border(top: BorderSide(color: c.ln)),
        ),
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: count == 0 || _saving ? null : _add,
                child: Text(
                  count == 0
                      ? 'Pick the payments to add'
                      : 'Add $count ${count == 1 ? 'payment' : 'payments'} (${formatMoney(totalMinor)})',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontFeatures: Ds.tabular),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) =>
      DsLabel(text, padding: const EdgeInsets.fromLTRB(2, 16, 2, 8));
}

/// One section's rows in a single flat card, divided by hairlines.
class _RowCard extends StatelessWidget {
  final List<GroupCandidate> rows;
  final Map<String, GroupCandidate> picked;
  final ValueChanged<GroupCandidate> onToggle;

  const _RowCard({required this.rows, required this.picked, required this.onToggle});

  @override
  Widget build(BuildContext context) {
    return DsCard(
      padding: EdgeInsets.zero,
      clip: true,
      child: Column(
        children: [
          for (var i = 0; i < rows.length; i++)
            _CandidateRow(
              row: rows[i],
              picked: picked.containsKey(rows[i].id),
              last: i == rows.length - 1,
              onTap: () => onToggle(rows[i]),
            ),
        ],
      ),
    );
  }
}

class _CandidateRow extends StatelessWidget {
  final GroupCandidate row;
  final bool picked;
  final bool last;
  final VoidCallback onTap;

  const _CandidateRow({required this.row, required this.picked, required this.onTap, this.last = false});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final meta = [
      formatShortDate(row.occurredAt),
      if (row.accountLabel != null) row.accountLabel!,
      if (row.categoryName != null) row.categoryName!,
    ].join(' · ');

    return Material(
      // A picked row is a selected list item: accent tint.
      color: picked ? c.acSoft : Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 64),
          decoration: BoxDecoration(
            border: last ? null : Border(bottom: BorderSide(color: c.ln)),
          ),
          padding: const EdgeInsets.fromLTRB(4, 8, 16, 8),
          child: Row(
            children: [
              // A 24 px box in a 48 px hit area.
              SizedBox(
                width: 48,
                height: 48,
                child: Center(child: Checkbox(value: picked, onChanged: (_) => onTap())),
              ),
              const SizedBox(width: 4),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      row.merchant ?? 'Payment',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Text(
                formatMoney(row.amountMinor),
                style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: c.tx),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
