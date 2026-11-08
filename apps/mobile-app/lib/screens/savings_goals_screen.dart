import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/ds/ds.dart';
import '../widgets/funds/fund_form.dart';
import '../widgets/funds/fund_text.dart';
import '../widgets/state_block.dart';

/// Small things being saved up for: a PS5 by next October. Each has what is
/// put aside so far, what it needs a month to get there on time, and the
/// savings account the money sits in. Money goes in by marking a transfer
/// into savings "For a goal", or by typing it here.
class SavingsGoalsScreen extends StatefulWidget {
  const SavingsGoalsScreen({super.key});

  @override
  State<SavingsGoalsScreen> createState() => _SavingsGoalsScreenState();
}

class _SavingsGoalsScreenState extends State<SavingsGoalsScreen> {
  SavingsGoalList? _list;
  List<Account> _accounts = const [];
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        ApiClient.instance.get('/savings-goals'),
        ApiClient.instance.get('/accounts').catchError((_) => const <dynamic>[]),
      ]);
      if (!mounted) return;
      setState(() {
        _list = SavingsGoalList.fromJson(results[0] as Map<String, dynamic>);
        _accounts = (results[1] as List<dynamic>)
            .whereType<Map<String, dynamic>>()
            .map(Account.fromJson)
            .where((account) => account.isActive && (account.accountType == 'BANK' || account.accountType == 'CASH'))
            .toList()
          ..sort((a, b) => (b.isSavings ? 1 : 0) - (a.isSavings ? 1 : 0));
        _failed = false;
      });
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _edit([SavingsGoal? goal]) async {
    final changed = await SavingsGoalEditorScreen.open(context, goal: goal, accounts: _accounts);
    if (changed) await _load();
  }

  Future<void> _open(SavingsGoal goal) async {
    final changed = await showSavingsGoalSheet(context, goal: goal, onEdit: () => _edit(goal));
    if (changed) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final list = _list;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: const Text('Savings goals'),
        actions: [
          if (list != null && !list.isEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: TextButton.icon(
                onPressed: () => _edit(),
                icon: DsIcon(DsIcons.plus, size: 18, color: c.ac),
                label: Text('Add', style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: c.ac)),
              ),
            ),
        ],
      ),
      body: switch ((list, _failed)) {
        (null, true) => StateBlock(
            icon: DsIcons.alertTriangle,
            title: "Couldn't load your goals",
            body: 'Check your connection and try again.',
            actionLabel: 'Retry',
            onAction: () {
              setState(() => _failed = false);
              _load();
            },
            warn: true,
          ),
        (null, _) => const Center(child: CircularProgressIndicator()),
        (final SavingsGoalList list, _) when list.isEmpty => StateBlock(
            icon: DsIcons.target,
            title: 'Saving up for something?',
            body: 'Add what it is, what it costs and when you want it. SpendLog works out what to put aside each '
                'month, and keeps that money marked in your savings account.',
            actionLabel: 'Add a goal',
            onAction: () => _edit(),
          ),
        (final SavingsGoalList list, _) => RefreshIndicator(
            onRefresh: _load,
            child: _GoalList(list: list, onOpen: _open),
          ),
      },
    );
  }
}

class _GoalList extends StatelessWidget {
  const _GoalList({required this.list, required this.onOpen});

  final SavingsGoalList list;
  final ValueChanged<SavingsGoal> onOpen;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final open = list.open;
    final closed = list.closed;
    return LayoutBuilder(
      builder: (context, constraints) {
        final wide = constraints.maxWidth >= 720;
        final side = wide ? 24.0 : 16.0;
        Widget grid(List<SavingsGoal> goals) {
          if (!wide) {
            return Column(
              children: [
                for (final goal in goals)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: SavingsGoalCard(goal: goal, onTap: () => onOpen(goal)),
                  ),
              ],
            );
          }
          final columns = constraints.maxWidth >= 1100 ? 3 : 2;
          final width = (constraints.maxWidth - side * 2 - 12 * (columns - 1)) / columns;
          return Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              for (final goal in goals)
                SizedBox(width: width, child: SavingsGoalCard(goal: goal, onTap: () => onOpen(goal))),
            ],
          );
        }

        return ListView(
          padding: EdgeInsets.fromLTRB(side, 16, side, 32),
          physics: const AlwaysScrollableScrollPhysics(),
          children: [
            if (open.isNotEmpty) ...[
              Wrap(
                spacing: 24,
                runSpacing: 8,
                children: [
                  DsInlineStat(label: 'Put aside', value: formatMoney(list.savedMinor)),
                  if (list.perMonthMinor > 0)
                    DsInlineStat(label: 'A month to stay on track', value: formatMoney(list.perMonthMinor)),
                ],
              ),
              const SizedBox(height: 16),
              grid(open),
            ],
            if (closed.isNotEmpty) ...[
              const SizedBox(height: 12),
              Text(
                'Bought or closed',
                style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx2),
              ),
              const SizedBox(height: 10),
              grid(closed),
            ],
          ],
        );
      },
    );
  }
}

/// "₹15,000 of ₹55,000", the bar, and what to put aside a month.
class SavingsGoalCard extends StatelessWidget {
  const SavingsGoalCard({super.key, required this.goal, this.onTap});

  final SavingsGoal goal;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final overdue = !goal.isDone && goal.targetOn.isNotEmpty && goal.targetOn.compareTo(istToday()) < 0;
    return DsCard(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  goal.name,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                ),
              ),
              if (!goal.isActive)
                const DsBadge('Closed')
              else if (goal.isDone)
                const DsBadge('Ready', tone: DsTone.good)
              else if (overdue)
                const DsBadge('Date passed', tone: DsTone.warn),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            [
              'by ${goal.targetOn.isEmpty ? '—' : formatIsoLongDate(goal.targetOn)}',
              if (goal.accountLabel != null) 'in ${goal.accountLabel}',
            ].join(' · '),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: DsMeter(
                  value: (goal.percent / 100).clamp(0.0, 1.0),
                  color: goal.isDone ? c.good : c.ac,
                ),
              ),
              const SizedBox(width: 10),
              Text(
                '${goal.percent.round()}%',
                style: kNum.copyWith(fontSize: 13, fontWeight: FontWeight.w600, color: c.tx),
              ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            '${formatMoney(goal.savedMinor)} of ${formatMoney(goal.targetMinor)}',
            style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
          ),
          if (goal.isActive) ...[
            const SizedBox(height: 10),
            Text(
              goal.isDone
                  ? "It's all there."
                  : overdue
                      ? '${formatMoney(goal.leftMinor)} still to go'
                      : '${formatMoney(goal.perMonthMinor)} a month · '
                          '${goal.monthsLeft} ${goal.monthsLeft == 1 ? 'month' : 'months'} left',
              style: kNum.copyWith(
                fontSize: 15,
                height: 20 / 15,
                fontWeight: FontWeight.w600,
                color: goal.isDone ? c.good : c.tx,
              ),
            ),
            if (!goal.isDone)
              Text(
                goal.addedThisMonthMinor > 0
                    ? '${formatMoney(goal.addedThisMonthMinor)} put aside this month'
                    : 'Nothing put aside this month yet',
                style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
              ),
          ],
        ],
      ),
    );
  }
}

/// A goal up close: what went in, and the ways to add, take out, edit or
/// close it. Pops true when something changed.
Future<bool> showSavingsGoalSheet(BuildContext context, {required SavingsGoal goal, required VoidCallback onEdit}) async {
  final changed = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    builder: (context) => _GoalSheet(goal: goal, onEdit: onEdit),
  );
  return changed == true;
}

class _GoalSheet extends StatefulWidget {
  const _GoalSheet({required this.goal, required this.onEdit});

  final SavingsGoal goal;
  final VoidCallback onEdit;

  @override
  State<_GoalSheet> createState() => _GoalSheetState();
}

class _GoalSheetState extends State<_GoalSheet> {
  List<GoalEntry>? _entries;
  int _opening = 0;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadEntries();
  }

  Future<void> _loadEntries() async {
    try {
      final json = await ApiClient.instance.get('/savings-goals/${widget.goal.id}/entries') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _entries = (json['entries'] as List<dynamic>? ?? const [])
            .whereType<Map<String, dynamic>>()
            .map(GoalEntry.fromJson)
            .toList();
        _opening = json['openingMinor'] is int ? json['openingMinor'] as int : 0;
      });
    } catch (_) {
      if (mounted) setState(() => _entries = const []);
    }
  }

  Future<void> _adjust({required bool add}) async {
    final result = await showGoalAmountSheet(context, goal: widget.goal, add: add);
    if (result == null || !mounted) return;
    await _run(() => ApiClient.instance.post('/savings-goals/${widget.goal.id}/adjustments', {
          'amountMinor': add ? result.amountMinor : -result.amountMinor,
          'note': result.note,
        }));
  }

  Future<void> _setActive(bool active) =>
      _run(() => ApiClient.instance.patch('/savings-goals/${widget.goal.id}', {'isActive': active}));

  Future<void> _delete() async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete "${widget.goal.name}"?'),
        content: const Text('The money stays in your account. Transfers marked for it just stop being marked.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: context.c.critFill, foregroundColor: Colors.white),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    await _run(() => ApiClient.instance.delete('/savings-goals/${widget.goal.id}'));
  }

  Future<void> _run(Future<dynamic> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      await action();
      navigator.pop(true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = error is ApiException ? error.message : "Couldn't save that.";
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final goal = widget.goal;
    final entries = _entries;
    return SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.85),
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            const DsDragHandle(),
            SavingsGoalCard(goal: goal),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (goal.isActive) ...[
                  FilledButton.icon(
                    onPressed: _busy ? null : () => _adjust(add: true),
                    icon: const DsIcon(DsIcons.plus, size: 18),
                    label: const Text('Add money'),
                  ),
                  if (goal.savedMinor > 0)
                    OutlinedButton(onPressed: _busy ? null : () => _adjust(add: false), child: const Text('Take out')),
                ],
                OutlinedButton(
                  onPressed: _busy
                      ? null
                      : () {
                          Navigator.of(context).pop(false);
                          widget.onEdit();
                        },
                  child: const Text('Edit'),
                ),
                OutlinedButton(
                  onPressed: _busy ? null : () => _setActive(!goal.isActive),
                  child: Text(goal.isActive ? 'Mark as bought' : 'Open again'),
                ),
                TextButton(
                  style: TextButton.styleFrom(foregroundColor: c.crit),
                  onPressed: _busy ? null : _delete,
                  child: const Text('Delete'),
                ),
              ],
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              DsCallout(tone: DsTone.crit, title: _error!),
            ],
            const SizedBox(height: 20),
            Text('What went in', style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx)),
            const SizedBox(height: 4),
            Text(
              'Mark a transfer into savings "For a goal" when you edit it, or add money here.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            ),
            const SizedBox(height: 8),
            if (entries == null)
              const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()))
            else ...[
              for (final entry in entries) _EntryRow(entry: entry),
              if (_opening > 0)
                _EntryRow(entry: GoalEntry(kind: 'OPENING', label: 'Already put aside at the start', amountMinor: _opening)),
              if (entries.isEmpty && _opening == 0)
                Text('Nothing yet.', style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3)),
            ],
          ],
        ),
      ),
    );
  }
}

class _EntryRow extends StatelessWidget {
  const _EntryRow({required this.entry});

  final GoalEntry entry;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final out = entry.amountMinor < 0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          DsIcon(entry.isTransfer ? DsIcons.transfer : (out ? DsIcons.arrowUpRight : DsIcons.piggyBank), size: 18, color: c.tx3),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(entry.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 14, height: 20 / 14, color: c.tx)),
                if (entry.on != null)
                  Text(
                    [formatShortDate(entry.on!), if (entry.isTransfer) 'transfer'].join(' · '),
                    style: kNum.copyWith(fontSize: 12, height: 16 / 12, color: c.tx3),
                  ),
              ],
            ),
          ),
          Text(
            '${out ? '−' : '+'}${formatMoney(entry.amountMinor.abs())}',
            style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w600, color: out ? c.tx2 : c.good),
          ),
        ],
      ),
    );
  }
}

/// An amount typed for a goal, and what it was.
typedef GoalAmount = ({int amountMinor, String? note});

Future<GoalAmount?> showGoalAmountSheet(BuildContext context, {required SavingsGoal goal, required bool add}) {
  return showModalBottomSheet<GoalAmount>(
    context: context,
    isScrollControlled: true,
    builder: (context) => _AmountSheet(goal: goal, add: add),
  );
}

class _AmountSheet extends StatefulWidget {
  const _AmountSheet({required this.goal, required this.add});

  final SavingsGoal goal;
  final bool add;

  @override
  State<_AmountSheet> createState() => _AmountSheetState();
}

class _AmountSheetState extends State<_AmountSheet> {
  late final _amount = TextEditingController(
    text: widget.add && widget.goal.perMonthMinor > 0 && !widget.goal.isDone ? _rupees(widget.goal.perMonthMinor) : '',
  );
  final _note = TextEditingController();
  String? _error;

  static String _rupees(int minor) => minor % 100 == 0 ? (minor ~/ 100).toString() : (minor / 100).toStringAsFixed(2);

  @override
  void dispose() {
    _amount.dispose();
    _note.dispose();
    super.dispose();
  }

  void _done() {
    final minor = parseRupees(_amount.text);
    if (minor == null || minor <= 0) return setState(() => _error = 'Type an amount.');
    if (!widget.add && minor > widget.goal.savedMinor) {
      return setState(() => _error = 'It only has ${formatMoney(widget.goal.savedMinor)}.');
    }
    Navigator.of(context).pop<GoalAmount>((amountMinor: minor, note: _note.text.trim().isEmpty ? null : _note.text.trim()));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            const DsDragHandle(),
            Text(
              widget.add ? 'Add money to ${widget.goal.name}' : 'Take money out of ${widget.goal.name}',
              style: TextStyle(fontSize: 19, height: 24 / 19, fontWeight: FontWeight.w600, color: c.tx),
            ),
            const SizedBox(height: 6),
            Text(
              widget.add
                  ? 'Money already in your savings, now marked for this. A transfer you can mark instead, from the '
                      'transaction itself.'
                  : 'Spent, or no longer for this goal. It stays in your account, just not marked.',
              style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
            ),
            const SizedBox(height: 16),
            DsField(
              label: 'Amount',
              child: TextField(
                key: const ValueKey('goal-amount'),
                controller: _amount,
                autofocus: true,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                style: kNum.copyWith(fontSize: 15, color: c.tx),
                decoration: const InputDecoration(prefixText: '₹ '),
              ),
            ),
            const SizedBox(height: 12),
            DsField(
              label: 'Note (optional)',
              child: TextField(
                controller: _note,
                textCapitalization: TextCapitalization.sentences,
                decoration: InputDecoration(hintText: widget.add ? 'Birthday money' : 'Bought the controller'),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              DsCallout(tone: DsTone.crit, title: _error!),
            ],
            const SizedBox(height: 16),
            FilledButton(onPressed: _done, child: Text(widget.add ? 'Add' : 'Take out')),
          ],
        ),
      ),
    );
  }
}

/// Add a savings goal, or change one. Pops `true` when something changed.
class SavingsGoalEditorScreen extends StatefulWidget {
  const SavingsGoalEditorScreen({super.key, this.goal, this.accounts = const []});

  final SavingsGoal? goal;

  /// Where the money can be kept: bank accounts and cash, savings first.
  final List<Account> accounts;

  static Future<bool> open(BuildContext context, {SavingsGoal? goal, List<Account> accounts = const []}) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => SavingsGoalEditorScreen(goal: goal, accounts: accounts)),
    );
    return changed == true;
  }

  @override
  State<SavingsGoalEditorScreen> createState() => _SavingsGoalEditorScreenState();
}

class _SavingsGoalEditorScreenState extends State<SavingsGoalEditorScreen> {
  late final SavingsGoal? _goal = widget.goal;
  late final _name = TextEditingController(text: _goal?.name ?? '');
  late final _target = TextEditingController(text: _goal == null ? '' : _rupees(_goal.targetMinor));
  final _opening = TextEditingController();
  late String? _targetOn = _goal?.targetOn;
  late String? _accountId = _goal?.accountId ??
      widget.accounts.where((account) => account.isSavings).map((account) => account.id).firstOrNull;
  bool _saving = false;
  String? _error;

  static String _rupees(int minor) => minor % 100 == 0 ? (minor ~/ 100).toString() : (minor / 100).toStringAsFixed(2);

  @override
  void dispose() {
    _name.dispose();
    _target.dispose();
    _opening.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final name = _name.text.trim();
    final target = parseRupees(_target.text);
    final opening = _opening.text.trim().isEmpty ? 0 : parseRupees(_opening.text);
    final error = name.isEmpty
        ? 'Say what it is for, like "PS5".'
        : target == null || target < 100
            ? 'Type what it will cost.'
            : _targetOn == null
                ? 'Pick when you want it by.'
                : _goal == null && _targetOn!.compareTo(istToday()) <= 0
                    ? 'Pick a day still to come.'
                    : opening == null
                        ? '"Already put aside" is not an amount.'
                        : null;
    if (error != null) return setState(() => _error = error);

    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    final body = <String, dynamic>{
      'name': name,
      'targetMinor': target,
      'targetOn': _targetOn,
      'accountId': _accountId,
      if (_goal == null) 'openingMinor': opening,
    };
    try {
      final goal = _goal;
      if (goal == null) {
        await ApiClient.instance.post('/savings-goals', body);
      } else {
        await ApiClient.instance.patch('/savings-goals/${goal.id}', body);
      }
      navigator.pop(true);
    } catch (error) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = error is ApiException ? error.message : "Couldn't save the goal.";
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final today = DateTime.parse(istToday());
    final known = widget.accounts.any((account) => account.id == _accountId);
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(title: Text(_goal == null ? 'New savings goal' : 'Edit savings goal')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          DsCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DsField(
                  label: 'What for',
                  child: TextField(
                    key: const ValueKey('savings-goal-name'),
                    controller: _name,
                    autofocus: _goal == null,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(hintText: 'PS5'),
                  ),
                ),
                const SizedBox(height: 14),
                DsField(
                  label: 'It will cost',
                  child: TextField(
                    key: const ValueKey('savings-goal-target'),
                    controller: _target,
                    keyboardType: const TextInputType.numberWithOptions(decimal: true),
                    style: kNum.copyWith(fontSize: 15, color: c.tx),
                    decoration: const InputDecoration(prefixText: '₹ ', hintText: '55000'),
                  ),
                ),
                const SizedBox(height: 14),
                DateField(
                  label: 'Want it by',
                  value: _targetOn,
                  onPick: () async {
                    final picked = await pickIsoDate(
                      context,
                      initial: _targetOn ?? isoDay(DateTime(today.year + 1, today.month, 1)),
                      first: _goal == null ? today.add(const Duration(days: 1)) : DateTime(2000),
                      last: DateTime(today.year + 20),
                    );
                    if (picked != null) setState(() => _targetOn = picked);
                  },
                ),
                if (widget.accounts.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  DsField(
                    label: 'Kept in',
                    help: 'The account shows this much of its balance as spoken for.',
                    child: DropdownButtonFormField<String?>(
                      key: const ValueKey('savings-goal-account'),
                      initialValue: known ? _accountId : null,
                      isExpanded: true,
                      items: [
                        const DropdownMenuItem<String?>(value: null, child: Text('Not said')),
                        for (final account in widget.accounts)
                          DropdownMenuItem<String?>(
                            value: account.id,
                            child: Text(
                              account.isSavings ? '${account.label} · savings' : account.label,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                      ],
                      onChanged: (value) => setState(() => _accountId = value),
                    ),
                  ),
                ],
                if (_goal == null) ...[
                  const SizedBox(height: 14),
                  DsField(
                    label: 'Already put aside (optional)',
                    child: TextField(
                      key: const ValueKey('savings-goal-opening'),
                      controller: _opening,
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      style: kNum.copyWith(fontSize: 15, color: c.tx),
                      decoration: const InputDecoration(prefixText: '₹ '),
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            DsCallout(tone: DsTone.crit, title: _error!),
          ],
          const SizedBox(height: 20),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(_goal == null ? 'Add goal' : 'Save'),
          ),
        ],
      ),
    );
  }
}
