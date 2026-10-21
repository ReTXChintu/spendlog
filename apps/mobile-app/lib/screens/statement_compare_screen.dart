import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
import '../utils/format.dart';
import '../widgets/edit_transaction_sheet.dart';
import '../widgets/state_block.dart';

/// A statement set beside the ledger, both ways: what the bank lists that
/// SpendLog does not have, and what SpendLog has that the bank does not
/// list. For a bank statement, also whether the app's running balance
/// meets the statement's closing balance.
///
/// Reads only. The statement's own page is where lines are added; this is
/// where you look when the two disagree and want to know which rows.
class StatementCompareScreen extends StatefulWidget {
  const StatementCompareScreen({super.key, required this.statementId, required this.title});

  final String statementId;
  final String title;

  @override
  State<StatementCompareScreen> createState() => _StatementCompareScreenState();
}

class _StatementCompareScreenState extends State<StatementCompareScreen> {
  StatementComparison? _comparison;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final json = await ApiClient.instance.get('/statements/${widget.statementId}/compare') as Map<String, dynamic>;
      if (mounted) setState(() => _comparison = StatementComparison.fromJson(json));
    } catch (e) {
      if (mounted) setState(() => _error = e is ApiException ? e.message : "Couldn't compare just now.");
    }
  }

  Future<void> _openRow(CompareRow row) async {
    final changed = await showEditTransactionById(context, row.transactionId);
    if (changed == true && mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Scaffold(
      backgroundColor: c.bg,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Compare with app'),
            Text(
              widget.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w400, color: c.tx3),
            ),
          ],
        ),
      ),
      body: _body(),
    );
  }

  Widget _body() {
    final comparison = _comparison;
    if (comparison == null) {
      if (_error != null) {
        return StateBlock(
          icon: Icons.wifi_off,
          warn: true,
          title: "Couldn't compare the statement",
          body: _error!,
          actionLabel: 'Try again',
          onAction: _load,
        );
      }
      return const Padding(
        padding: kPagePad,
        child: DsSkeletonRows(count: 5, caption: 'Checking the statement against SpendLog…'),
      );
    }

    final missing = comparison.onStatementNotInApp;
    final extra = comparison.inAppNotOnStatement;
    final clean = missing.isEmpty && extra.isEmpty;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: kPagePad,
        children: [
          if (comparison.isBank) _Closing(comparison: comparison),
          _Summary(comparison: comparison),
          const SizedBox(height: 16),
          if (clean)
            const DsCallout(
              tone: DsTone.good,
              title: 'Every line on the statement has a row in SpendLog, and nothing in SpendLog is missing from it.',
            ),
          if (missing.isNotEmpty) ...[
            _Section(
              title: 'On the statement, not in SpendLog',
              count: missing.length,
              hint: 'Add these from the statement\'s own page.',
              children: [
                for (var i = 0; i < missing.length; i++)
                  _LineTile(
                    date: missing[i].date,
                    title: missing[i].description,
                    // What the bank printed is a machine string.
                    mono: true,
                    amountMinor: missing[i].amountMinor,
                    isDebit: missing[i].isDebit,
                    note: missing[i].addedTransactionId != null ? 'added by this statement' : null,
                    last: i == missing.length - 1,
                  ),
              ],
            ),
            const SizedBox(height: 16),
          ],
          if (extra.isNotEmpty)
            _Section(
              title: 'In SpendLog, not on the statement',
              count: extra.length,
              hint: 'Tap one to open it. A row the bank does not show may be a duplicate, or on another account.',
              children: [
                for (var i = 0; i < extra.length; i++)
                  _LineTile(
                    date: extra[i].occurredAt,
                    title: extra[i].merchant ?? 'Unknown',
                    amountMinor: extra[i].amountMinor,
                    isDebit: extra[i].isDebit,
                    last: i == extra.length - 1,
                    onTap: () => _openRow(extra[i]),
                  ),
              ],
            ),
        ],
      ),
    );
  }
}

/// The statement's closing balance against the app's running balance at
/// that moment. Only a bank statement has one to offer.
class _Closing extends StatelessWidget {
  const _Closing({required this.comparison});

  final StatementComparison comparison;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final closing = comparison.closingBalanceMinor;
    final expected = comparison.expectedAtClosingMinor;
    final difference = comparison.differenceMinor;
    final on = comparison.closingOn;

    return DsCard(
      margin: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DsLabel(on == null ? 'At the close' : 'At the close · ${formatShortDate(on)}'),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: _Figure(label: 'Statement closes at', value: closing == null ? '—' : formatMoney(closing)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _Figure(label: 'SpendLog expected', value: expected == null ? '—' : formatMoney(expected)),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (!comparison.hasClosingComparison || difference == null)
            Text(
              expected == null
                  ? 'Set a starting balance on the account and SpendLog can check its figure against the close.'
                  : 'The statement did not give a closing balance to check against.',
              style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3),
            )
          else if (!driftIsOff(difference))
            const DsBadge('Within a rupee of the statement', tone: DsTone.good, icon: DsIcons.check)
          else
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DsBadge('${formatMoney(difference.abs())} off', tone: DsTone.crit),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    difference < 0
                        ? 'SpendLog shows more than the statement at the close.'
                        : 'The statement shows more than SpendLog at the close.',
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx2),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

/// Label over a bank-balance figure (2 decimals, tabular).
class _Figure extends StatelessWidget {
  const _Figure({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(fontSize: 12, height: 16 / 12, fontWeight: FontWeight.w600, color: c.tx2),
        ),
        const SizedBox(height: 2),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            value,
            style: kNum.copyWith(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
          ),
        ),
      ],
    );
  }
}

class _Summary extends StatelessWidget {
  const _Summary({required this.comparison});

  final StatementComparison comparison;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final parts = <String>[
      '${comparison.matched} ${comparison.matched == 1 ? 'line matches' : 'lines match'} a row',
      '${comparison.onStatementNotInApp.length} only on the statement',
      '${comparison.inAppNotOnStatement.length} only in SpendLog',
    ];
    return Text(parts.join(' · '), style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2));
  }
}

/// One of the two lists: a section card with a header, a count that says
/// these disagree (crit), a hint, and the rows.
class _Section extends StatelessWidget {
  const _Section({required this.title, required this.count, required this.hint, required this.children});

  final String title;
  final int count;
  final String hint;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return DsCard(
      padding: EdgeInsets.zero,
      clip: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        style: TextStyle(fontSize: 17, height: 24 / 17, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                    ),
                    const SizedBox(width: 8),
                    DsBadge('$count', tone: DsTone.crit),
                  ],
                ),
                const SizedBox(height: 2),
                Text(hint, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
              ],
            ),
          ),
          Divider(height: 1, color: c.ln),
          ...children,
        ],
      ),
    );
  }
}

/// A phone transaction row: date, the name, and the amount signed and
/// coloured by direction.
class _LineTile extends StatelessWidget {
  const _LineTile({
    required this.date,
    required this.title,
    required this.amountMinor,
    required this.isDebit,
    this.note,
    this.last = false,
    this.mono = false,
    this.onTap,
  });

  final DateTime date;
  final String title;
  final int amountMinor;
  final bool isDebit;
  final String? note;
  final bool last;
  final bool mono;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 56),
        padding: EdgeInsets.fromLTRB(16, 12, onTap != null ? 10 : 16, 12),
        decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.ln))),
        child: Row(
          children: [
            SizedBox(
              width: 52,
              child: Text(
                formatShortDate(date),
                style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: mono
                        ? kMono.copyWith(fontSize: 13, height: 18 / 13, color: c.tx)
                        : TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w500, color: c.tx),
                  ),
                  if (note != null)
                    Text(note!, style: TextStyle(fontSize: 12, height: 16 / 12, color: c.tx3)),
                ],
              ),
            ),
            const SizedBox(width: 10),
            DsMoney(
              amountMinor,
              kind: isDebit ? MoneyKind.out : MoneyKind.inflow,
              short: false,
              style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            ),
            if (onTap != null) ...[
              const SizedBox(width: 4),
              DsIcon(DsIcons.chevronRight, size: 18, color: c.tx3),
            ],
          ],
        ),
      ),
    );
  }
}
