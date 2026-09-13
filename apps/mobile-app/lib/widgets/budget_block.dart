import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';

/// What is left to spend before the next salary, and how fast it is going.
///
/// Two figures rather than one: "slow down" only means something against
/// what has actually been going out. A pace, not a judgement about whether
/// a bill can be paid.
class BudgetBlock extends StatefulWidget {
  const BudgetBlock({super.key});

  @override
  State<BudgetBlock> createState() => _BudgetBlockState();
}

class _BudgetBlockState extends State<BudgetBlock> {
  BudgetPace? _pace;
  bool _editing = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final result = await ApiClient.instance.get('/budget/pace') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() => _pace = BudgetPace.fromJson(result));
    } catch (_) {
      // Analytics still works without it.
    }
  }

  Future<void> _editSalary() async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => const _SalaryDialog(),
    );
    if (saved == true) {
      setState(() => _editing = false);
      await _load();
    }
  }

  Future<void> _addCommitment() async {
    final saved = await showDialog<bool>(
      context: context,
      builder: (_) => const _CommitmentDialog(),
    );
    if (saved == true) await _load();
  }

  Future<void> _togglePaid(FixedCommitment commitment, bool paid) async {
    await ApiClient.instance
        .post('/budget/commitments/${commitment.id}/paid', {'paid': paid})
        .catchError((_) => null);
    await _load();
  }

  Future<void> _remove(FixedCommitment commitment) async {
    await ApiClient.instance
        .delete('/budget/commitments/${commitment.id}')
        .catchError((_) => null);
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final pace = _pace;
    if (pace == null) return const SizedBox.shrink();

    if (!pace.configured || _editing) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _SectionHeading(
            title: 'Spending pace',
            sub: 'Tell it what lands each month and when, and it can say how much a day is left '
                'before the next one.',
          ),
          const SizedBox(height: 12),
          FilledButton(onPressed: _editSalary, child: const Text('Set your salary')),
        ],
      );
    }

    final (background, foreground) = switch (pace.state) {
      'over' => (c.debit50, c.debit),
      'watch' => (c.warnBg, c.warn),
      _ => (c.brand50, c.brandDark),
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _SectionHeading(
          title: 'Spending pace',
          sub: '${pace.daysLeft} ${pace.daysLeft == 1 ? 'day' : 'days'} until the next salary.',
        ),
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(T.rMd)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  _Figure(label: 'Left', value: formatMoneyShort(pace.remainingMinor)),
                  _Figure(label: 'A day from here', value: formatMoneyShort(pace.perDayMinor)),
                  _Figure(label: 'Lately', value: formatMoneyShort(pace.recentPerDayMinor)),
                ],
              ),
              if (pace.state != 'ok') ...[
                const SizedBox(height: 10),
                Text(
                  pace.state == 'over'
                      ? 'Past the salary for this period. Anything more comes out of something '
                          'else.'
                      : "Carrying on at the last week's pace would run this period dry before "
                          'payday.',
                  style: TextStyle(fontSize: 12, height: 1.45, color: foreground),
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 14),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'FIXED EACH MONTH',
              style: TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.5,
                color: c.muted,
              ),
            ),
            TextButton(onPressed: _editSalary, child: const Text('Salary')),
          ],
        ),
        for (final commitment in pace.commitments)
          Dismissible(
            key: ValueKey(commitment.id),
            direction: DismissDirection.endToStart,
            onDismissed: (_) => _remove(commitment),
            background: Container(
              alignment: Alignment.centerRight,
              padding: const EdgeInsets.only(right: 16),
              color: c.debit50,
              child: Icon(Icons.delete_outline, size: 18, color: c.debit),
            ),
            child: CheckboxListTile(
              value: commitment.isPaid,
              onChanged: (value) => _togglePaid(commitment, value ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              dense: true,
              title: Text(
                commitment.name,
                style: TextStyle(
                  fontSize: 12.8,
                  color: commitment.isPaid ? c.mutedLight : c.ink70,
                  decoration: commitment.isPaid ? TextDecoration.lineThrough : null,
                ),
              ),
              secondary: Text(
                formatMoney(commitment.amountMinor),
                style: kNum.copyWith(fontSize: 12.8, color: c.ink70),
              ),
            ),
          ),
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            onPressed: _addCommitment,
            icon: const Icon(Icons.add, size: 16),
            label: const Text('Add rent, a SIP, insurance…'),
          ),
        ),
        Text(
          'Tick one when it has gone out. Until then it is held back from what is left to spend — '
          'so an unticked one that has already been paid is counted twice.',
          style: TextStyle(fontSize: 11.5, height: 1.45, color: c.mutedLight),
        ),
      ],
    );
  }
}

class _SectionHeading extends StatelessWidget {
  final String title;
  final String sub;

  const _SectionHeading({required this.title, required this.sub});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: TextStyle(fontWeight: FontWeight.w800, fontSize: 15, color: c.ink)),
        const SizedBox(height: 3),
        Text(sub, style: TextStyle(fontSize: 12, height: 1.45, color: c.muted)),
      ],
    );
  }
}

class _Figure extends StatelessWidget {
  final String label;
  final String value;

  const _Figure({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w600, color: c.muted)),
        const SizedBox(height: 2),
        Text(value, style: kNum.copyWith(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink)),
      ],
    );
  }
}

class _SalaryDialog extends StatefulWidget {
  const _SalaryDialog();

  @override
  State<_SalaryDialog> createState() => _SalaryDialogState();
}

class _SalaryDialogState extends State<_SalaryDialog> {
  final _amount = TextEditingController();
  final _day = TextEditingController();
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    ApiClient.instance.get('/budget/profile').then((result) {
      final profile = result as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        final amount = profile['salaryAmountMinor'] as int?;
        if (amount != null) _amount.text = (amount ~/ 100).toString();
        final day = profile['salaryDay'] as int?;
        if (day != null) _day.text = day.toString();
      });
    }).catchError((_) => null);
  }

  @override
  void dispose() {
    _amount.dispose();
    _day.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final navigator = Navigator.of(context);
    final rupees = double.tryParse(_amount.text.trim());
    try {
      await ApiClient.instance.patch('/budget/profile', {
        'salaryAmountMinor': rupees == null ? null : (rupees * 100).round(),
        'salaryDay': int.tryParse(_day.text.trim()),
      });
      navigator.pop(true);
    } catch (_) {
      setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Your salary'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Amount', prefixText: '₹ '),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _day,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Day of the month', hintText: '15'),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _saving ? null : _save, child: const Text('Save')),
      ],
    );
  }
}

class _CommitmentDialog extends StatefulWidget {
  const _CommitmentDialog();

  @override
  State<_CommitmentDialog> createState() => _CommitmentDialogState();
}

class _CommitmentDialogState extends State<_CommitmentDialog> {
  final _name = TextEditingController();
  final _amount = TextEditingController();
  final _day = TextEditingController();
  bool _saving = false;

  @override
  void dispose() {
    _name.dispose();
    _amount.dispose();
    _day.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final rupees = double.tryParse(_amount.text.trim());
    if (_name.text.trim().isEmpty || rupees == null) return;

    setState(() => _saving = true);
    final navigator = Navigator.of(context);
    try {
      await ApiClient.instance.post('/budget/commitments', {
        'name': _name.text.trim(),
        'amountMinor': (rupees * 100).round(),
        'dayOfMonth': int.tryParse(_day.text.trim()) ?? 1,
      });
      navigator.pop(true);
    } catch (_) {
      setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Fixed each month'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _name,
            autofocus: true,
            decoration: const InputDecoration(labelText: 'What it is', hintText: 'Rent'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _amount,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: const InputDecoration(labelText: 'Amount', prefixText: '₹ '),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _day,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Day of the month', hintText: '5'),
          ),
        ],
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: _saving ? null : _save, child: const Text('Add')),
      ],
    );
  }
}
