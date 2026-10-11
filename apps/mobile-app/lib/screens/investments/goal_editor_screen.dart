import 'package:flutter/material.dart';
import '../../models/fund_models.dart';
import '../../services/api_client.dart';
import '../../theme.dart';
import '../../utils/format.dart';
import '../../widgets/funds/fund_form.dart';
import '../../widgets/funds/fund_text.dart';

/// A goal's fields as typed, and the checks the server would make.
class GoalFormData {
  final String name;
  final String target;
  final String? targetOn;
  final String saved;
  final List<String> holdingIds;

  const GoalFormData({
    this.name = '',
    this.target = '',
    this.targetOn,
    this.saved = '',
    this.holdingIds = const [],
  });

  /// The body, or the first thing wrong. A new goal's date has to be ahead;
  /// an old one's may have passed, so it can still be edited.
  ({String? error, Map<String, dynamic>? body}) check(String today, {required bool isNew}) {
    final trimmed = name.trim();
    if (trimmed.isEmpty) return (error: 'Give the goal a name, like "Laptop".', body: null);
    if (trimmed.length > 80) return (error: 'Keep the name under 80 characters.', body: null);
    final targetMinor = parseRupees(target);
    if (targetMinor == null || targetMinor < 100) return (error: 'Enter how much it will cost.', body: null);
    final day = targetOn;
    if (day == null) return (error: 'Pick when you need the money.', body: null);
    if (isNew && day.compareTo(today) <= 0) return (error: 'Pick a date in the future.', body: null);
    final savedMinor = saved.trim().isEmpty ? 0 : parseRupees(saved);
    if (savedMinor == null) return (error: '"Already saved" is not an amount.', body: null);
    return (
      error: null,
      body: {
        'name': trimmed,
        'targetMinor': targetMinor,
        'targetOn': day,
        'savedMinor': savedMinor,
        'holdingIds': holdingIds,
      },
    );
  }
}

/// Add a goal, or change or delete one. Pops `true` when something changed.
class GoalEditorScreen extends StatefulWidget {
  const GoalEditorScreen({super.key, this.goal, this.holdings = const []});

  final FundGoal? goal;
  final List<FundHolding> holdings;

  static Future<bool> open(BuildContext context, {FundGoal? goal, List<FundHolding> holdings = const []}) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => GoalEditorScreen(goal: goal, holdings: holdings)),
    );
    return changed == true;
  }

  @override
  State<GoalEditorScreen> createState() => _GoalEditorScreenState();
}

class _GoalEditorScreenState extends State<GoalEditorScreen> {
  late final FundGoal? _goal = widget.goal;
  late final _name = TextEditingController(text: _goal?.name ?? '');
  late final _target = TextEditingController(text: _goal == null ? '' : _rupees(_goal.targetMinor));
  late final _saved = TextEditingController(text: _goal == null || _goal.savedMinor == 0 ? '' : _rupees(_goal.savedMinor));
  late String? _targetOn = _goal?.targetOn;
  late final Set<String> _holdingIds = {...?_goal?.holdingIds};
  bool _saving = false;
  String? _error;

  static String _rupees(int minor) => minor % 100 == 0 ? (minor ~/ 100).toString() : (minor / 100).toStringAsFixed(2);

  @override
  void dispose() {
    _name.dispose();
    _target.dispose();
    _saved.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final check = GoalFormData(
      name: _name.text,
      target: _target.text,
      targetOn: _targetOn,
      saved: _saved.text,
      holdingIds: _holdingIds.toList(),
    ).check(istToday(), isNew: _goal == null);
    if (check.error != null) {
      setState(() => _error = check.error);
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    try {
      final goal = _goal;
      if (goal == null) {
        await ApiClient.instance.post('/goals', check.body);
      } else {
        await ApiClient.instance.patch('/goals/${goal.id}', check.body);
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

  Future<void> _delete() async {
    final goal = _goal;
    if (goal == null) return;
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete "${goal.name}"?'),
        content: const Text('The funds counted towards it stay in your portfolio.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: context.c.debit),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (sure != true || !mounted) return;
    final navigator = Navigator.of(context);
    try {
      await ApiClient.instance.delete('/goals/${goal.id}');
      navigator.pop(true);
    } catch (error) {
      if (mounted) setState(() => _error = error is ApiException ? error.message : "Couldn't delete the goal.");
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final today = DateTime.parse(istToday());
    return Scaffold(
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Text(
          _goal == null ? 'New goal' : 'Edit goal',
          style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink),
        ),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 32),
        children: [
          TextField(
            key: const ValueKey('goal-name'),
            controller: _name,
            autofocus: _goal == null,
            textCapitalization: TextCapitalization.sentences,
            decoration: const InputDecoration(labelText: 'What for', hintText: 'Laptop'),
          ),
          const SizedBox(height: 10),
          TextField(
            key: const ValueKey('goal-target'),
            controller: _target,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'It will cost about', prefixText: '₹ ', hintText: '200000'),
          ),
          const SizedBox(height: 10),
          DateField(
            label: 'Needed by',
            value: _targetOn,
            onPick: () async {
              final picked = await pickIsoDate(
                context,
                initial: _targetOn ?? isoDay(DateTime(today.year + 1, today.month, today.day)),
                first: _goal == null ? today.add(const Duration(days: 1)) : DateTime(2000),
                last: DateTime(today.year + 40),
              );
              if (picked != null) setState(() => _targetOn = picked);
            },
          ),
          const SizedBox(height: 10),
          TextField(
            key: const ValueKey('goal-saved'),
            controller: _saved,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(
              labelText: 'Already saved elsewhere (optional)',
              prefixText: '₹ ',
              helperText: 'Money put aside outside these funds - a deposit, a savings account.',
              helperMaxLines: 2,
            ),
          ),
          const SizedBox(height: 18),
          Text(
            'FUNDS COUNTED TOWARDS IT',
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 1.1, color: c.muted),
          ),
          const SizedBox(height: 4),
          if (widget.holdings.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Text(
                'No funds yet. The plan still says how much to put in each month, and where.',
                style: TextStyle(fontSize: 12.5, height: 1.4, color: c.muted),
              ),
            )
          else
            for (final holding in widget.holdings)
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _holdingIds.contains(holding.id),
                onChanged: (on) => setState(() => on == true ? _holdingIds.add(holding.id) : _holdingIds.remove(holding.id)),
                title: Text(shortSchemeName(holding.schemeName), style: TextStyle(fontSize: 14, color: c.ink)),
                subtitle: Text(
                  '${formatMoneyShort(holding.valueMinor)} · ${holding.categoryLabel}',
                  style: TextStyle(fontSize: 12, color: c.muted),
                ),
              ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(fontSize: 12.5, height: 1.4, color: c.debit)),
          ],
          const SizedBox(height: 18),
          FilledButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : Text(_goal == null ? 'Add goal' : 'Save'),
          ),
          if (_goal != null) ...[
            const SizedBox(height: 8),
            TextButton(
              style: TextButton.styleFrom(foregroundColor: c.debit),
              onPressed: _saving ? null : _delete,
              child: const Text('Delete goal'),
            ),
          ],
        ],
      ),
    );
  }
}
