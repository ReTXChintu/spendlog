import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../utils/format.dart';
import '../widgets/ds/ds.dart';

/// One EMI and every month of it: what was paid and how SpendLog knows,
/// what is still to come. Rename, put the monthly figure right (for one
/// typed in), close it early, or delete it.
class EmiPlanScreen extends StatefulWidget {
  const EmiPlanScreen({super.key, required this.plan, this.today});

  final EmiPlan plan;

  /// The day it is, in IST, as yyyy-mm-dd. Tests pin it.
  final String? today;

  /// Opens it and says whether anything about the plan changed.
  static Future<bool> open(BuildContext context, EmiPlan plan) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => EmiPlanScreen(plan: plan)),
    );
    return changed == true;
  }

  @override
  State<EmiPlanScreen> createState() => _EmiPlanScreenState();
}

enum _Action { rename, amount, close, delete }

class _EmiPlanScreenState extends State<EmiPlanScreen> {
  late EmiPlan _plan = widget.plan;
  bool _changed = false;
  bool _busy = false;

  String get _today => widget.today ?? istToday();

  Future<void> _reload() async {
    try {
      final rows = await ApiClient.instance.get('/emi') as List<dynamic>;
      final found = rows
          .map((row) => EmiPlan.fromJson(row as Map<String, dynamic>))
          .where((plan) => plan.id == _plan.id)
          .toList();
      if (mounted && found.isNotEmpty) setState(() => _plan = found.first);
    } catch (_) {
      // What is on screen stays; the next visit loads it again.
    }
  }

  Future<void> _run(Future<void> Function() call) async {
    setState(() => _busy = true);
    try {
      await call();
      _changed = true;
      await _reload();
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(error is ApiException ? error.message : "Couldn't save that."),
        ));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _markPaid(EmiInstalment instalment) async {
    if (instalment.id == null) return;
    await _run(() => ApiClient.instance.post('/emi/instalments/${instalment.id}/pay', {}));
  }

  Future<void> _act(_Action action) async {
    switch (action) {
      case _Action.rename:
        final name = await showDialog<String>(context: context, builder: (_) => _RenameDialog(initial: _plan.label ?? ''));
        if (name != null) await _run(() => ApiClient.instance.patch('/emi/${_plan.id}', {'label': name}));
      case _Action.amount:
        final minor = await showDialog<int>(
          context: context,
          builder: (_) => _AmountDialog(initialMinor: _plan.monthlyAmountMinor),
        );
        if (minor != null) {
          await _run(() => ApiClient.instance.patch('/emi/${_plan.id}', {'monthlyAmountMinor': minor}));
        }
      case _Action.close:
        final left = _plan.instalments.where((row) => row.isDue).length;
        final sure = await _confirm(
          title: 'Close this EMI early?',
          body: 'What is still due - ${formatMoney(_plan.remainingMinor)} over $left '
              '${left == 1 ? 'month' : 'months'} - stops being expected. Months already paid stay as they are.',
          action: 'Close early',
        );
        if (sure) await _run(() => ApiClient.instance.patch('/emi/${_plan.id}', {'status': 'CLOSED'}));
      case _Action.delete:
        final sure = await _confirm(
          title: 'Delete this EMI?',
          body: _plan.isExisting
              ? 'The schedule goes. Payments already matched to it stay in your transactions as ordinary payments.'
              : 'The schedule goes and the purchase counts in full again. Payments already matched to it stay in '
                  'your transactions as ordinary payments.',
          action: 'Delete',
          destructive: true,
        );
        if (!sure) return;
        setState(() => _busy = true);
        try {
          await ApiClient.instance.delete('/emi/${_plan.id}');
          if (mounted) Navigator.of(context).pop(true);
        } catch (error) {
          if (mounted) {
            setState(() => _busy = false);
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(error is ApiException ? error.message : "Couldn't delete it."),
            ));
          }
        }
    }
  }

  Future<bool> _confirm({required String title, required String body, required String action, bool destructive = false}) async {
    final sure = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: destructive ? FilledButton.styleFrom(backgroundColor: context.c.crit) : null,
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(action),
          ),
        ],
      ),
    );
    return sure == true;
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final plan = _plan;
    final ends = plan.endsOn;

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        backgroundColor: c.bg,
        appBar: AppBar(
          title: Text(plan.name),
          actions: [
            PopupMenuButton<_Action>(
              key: const ValueKey('emi-menu'),
              enabled: !_busy,
              onSelected: _act,
              itemBuilder: (_) => [
                const PopupMenuItem(value: _Action.rename, child: Text('Rename')),
                if (plan.isExisting && plan.isActive)
                  const PopupMenuItem(value: _Action.amount, child: Text('Change the monthly amount')),
                if (plan.isActive) const PopupMenuItem(value: _Action.close, child: Text('Close early')),
                const PopupMenuItem(value: _Action.delete, child: Text('Delete')),
              ],
            ),
          ],
        ),
        body: ListView(
          padding: kPagePad,
          children: [
            DsCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (plan.accountLabel != null) ...[
                    Text(plan.accountLabel!, style: TextStyle(fontSize: 13, color: c.tx3)),
                    const SizedBox(height: 4),
                  ],
                  Text.rich(
                    TextSpan(children: [
                      TextSpan(
                        text: formatMoney(plan.monthlyAmountMinor),
                        style: TextStyle(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                      TextSpan(text: ' a month', style: TextStyle(fontSize: 13, color: c.tx3)),
                    ]),
                    style: kNum,
                  ),
                  const SizedBox(height: 10),
                  DsMeter(value: plan.months == 0 ? 0 : (plan.paidCount / plan.months).clamp(0.0, 1.0), height: 8),
                  const SizedBox(height: 8),
                  Text(
                    [
                      '${plan.paidCount} of ${plan.months} paid',
                      if (plan.isActive) '${formatMoney(plan.remainingMinor)} to go' else 'Closed',
                      if (ends != null) 'ends ${DateFormat('MMM y').format(istWallClock(ends))}',
                    ].join(' · '),
                    style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2),
                  ),
                  if (plan.isExisting) ...[
                    const SizedBox(height: 8),
                    Text(
                      'Added for an EMI that began before SpendLog. Months paid before then are marked paid; '
                      'payments since are matched as they arrive.',
                      style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: kCardGap),
            const DsLabel('Every month', padding: EdgeInsets.fromLTRB(2, 4, 2, 8)),
            DsCard(
              padding: EdgeInsets.zero,
              clip: true,
              child: Column(
                children: [
                  for (final (i, row) in plan.instalments.indexed) ...[
                    if (i > 0) Divider(height: 1, color: c.ln),
                    _InstalmentRow(
                      row: row,
                      note: _noteFor(row),
                      overdue: row.isDue && istDayOf(row.dueDate).compareTo(_today) < 0,
                      onMarkPaid: plan.isActive && row.isDue && !_busy ? () => _markPaid(row) : null,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// How SpendLog knows a month was paid, or that it is still to come.
  String _noteFor(EmiInstalment row) {
    if (row.status == 'SKIPPED') return 'Not due - closed early';
    if (row.isDue) return istDayOf(row.dueDate).compareTo(_today) < 0 ? 'Overdue' : 'Due';
    if (row.paidBeforeTracking) {
      final since = _plan.trackingSince;
      return since == null || row.dueDate.isBefore(since) ? 'Paid before SpendLog' : 'Marked paid';
    }
    if (row.transactionId != null) return 'Paid · matched to a payment';
    return row.paidAt == null ? 'Paid' : 'Marked paid ${formatShortDate(row.paidAt!)}';
  }
}

class _InstalmentRow extends StatelessWidget {
  const _InstalmentRow({required this.row, required this.note, required this.overdue, this.onMarkPaid});

  final EmiInstalment row;
  final String note;
  final bool overdue;
  final VoidCallback? onMarkPaid;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final paid = row.isPaid;
    return Padding(
      key: ValueKey('emi-row-${row.seq}'),
      padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
      child: Row(
        children: [
          SizedBox(
            width: 28,
            child: Text('${row.seq}', style: kNum.copyWith(fontSize: 13, color: c.tx3)),
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  DateFormat('d MMM y').format(istWallClock(row.dueDate)),
                  style: kNum.copyWith(fontSize: 14, fontWeight: FontWeight.w500, color: paid ? c.tx2 : c.tx),
                ),
                Text(
                  note,
                  style: TextStyle(
                    fontSize: 12,
                    height: 16 / 12,
                    color: overdue ? c.warn : (paid ? c.good : c.tx3),
                    fontWeight: overdue ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ],
            ),
          ),
          Text(
            formatMoney(row.amountMinor),
            style: kNum.copyWith(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: paid ? c.tx3 : c.tx,
              decoration: row.status == 'SKIPPED' ? TextDecoration.lineThrough : null,
            ),
          ),
          if (onMarkPaid != null)
            TextButton(onPressed: onMarkPaid, child: const Text('Mark paid'))
          else
            const SizedBox(width: 8),
        ],
      ),
    );
  }
}

class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initial});
  final String initial;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final _name = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Rename'),
        content: TextField(
          controller: _name,
          autofocus: true,
          maxLength: 80,
          decoration: const InputDecoration(labelText: "What it's for", counterText: ''),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final name = _name.text.trim();
              if (name.isNotEmpty) Navigator.of(context).pop(name);
            },
            child: const Text('Save'),
          ),
        ],
      );
}

class _AmountDialog extends StatefulWidget {
  const _AmountDialog({required this.initialMinor});
  final int initialMinor;

  @override
  State<_AmountDialog> createState() => _AmountDialogState();
}

class _AmountDialogState extends State<_AmountDialog> {
  late final _amount = TextEditingController(text: (widget.initialMinor / 100).toStringAsFixed(2));
  String? _error;

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Monthly amount'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              key: const ValueKey('emi-new-amount'),
              controller: _amount,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'^[\d,]*\.?\d{0,2}'))],
              decoration: InputDecoration(labelText: 'Each month', prefixText: '₹ ', errorText: _error),
            ),
            const SizedBox(height: 8),
            Text(
              'Every month still due takes the new amount. Months already paid keep theirs.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: context.c.tx3),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final minor = parseRupees(_amount.text);
              if (minor == null || minor <= 0) return setState(() => _error = 'Type the amount as a number.');
              Navigator.of(context).pop(minor);
            },
            child: const Text('Save'),
          ),
        ],
      );
}
