import 'package:flutter/material.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
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
      backgroundColor: c.paper,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Compare with app', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 18, color: c.ink)),
            Text(
              widget.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: c.muted),
            ),
          ],
        ),
        shape: Border(bottom: BorderSide(color: c.line)),
      ),
      body: _body(),
    );
  }

  Widget _body() {
    final c = context.c;
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
      return const Center(child: CircularProgressIndicator());
    }

    final missing = comparison.onStatementNotInApp;
    final extra = comparison.inAppNotOnStatement;
    final clean = missing.isEmpty && extra.isEmpty;

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 32),
        children: [
          if (comparison.isBank) _Closing(comparison: comparison),
          _Summary(comparison: comparison),
          const SizedBox(height: 18),
          if (clean)
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(color: c.credit50, borderRadius: BorderRadius.circular(T.rMd)),
              child: Row(
                children: [
                  Icon(Icons.check_circle, color: c.credit, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'Every line on the statement has a row in SpendLog, and nothing in SpendLog is missing from it.',
                      style: TextStyle(fontSize: 13, height: 1.45, color: c.ink70),
                    ),
                  ),
                ],
              ),
            ),
          if (missing.isNotEmpty) ...[
            _SectionTitle(
              'On the statement, not in SpendLog',
              count: missing.length,
              hint: 'Add these from the statement\'s own page.',
            ),
            Container(
              decoration: _panel(c),
              child: Column(
                children: [
                  for (var i = 0; i < missing.length; i++)
                    _LineTile(
                      date: missing[i].date,
                      title: missing[i].description,
                      amountMinor: missing[i].amountMinor,
                      isDebit: missing[i].isDebit,
                      note: missing[i].addedTransactionId != null ? 'added by this statement' : null,
                      last: i == missing.length - 1,
                    ),
                ],
              ),
            ),
            const SizedBox(height: 18),
          ],
          if (extra.isNotEmpty) ...[
            _SectionTitle(
              'In SpendLog, not on the statement',
              count: extra.length,
              hint: 'Tap one to open it. A row the bank does not show may be a duplicate, or on another account.',
            ),
            Container(
              decoration: _panel(c),
              child: Column(
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
            ),
          ],
        ],
      ),
    );
  }

  BoxDecoration _panel(SpendColors c) => BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      );
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

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: c.surface,
        border: Border.all(color: c.line),
        borderRadius: BorderRadius.circular(T.rMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            on == null ? 'AT THE CLOSE' : 'AT THE CLOSE · ${formatShortDate(on).toUpperCase()}',
            style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w800, letterSpacing: 0.6, color: c.muted),
          ),
          const SizedBox(height: 8),
          Row(
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
          const SizedBox(height: 10),
          if (!comparison.hasClosingComparison || difference == null)
            Text(
              expected == null
                  ? 'Set a starting balance on the account and SpendLog can check its figure against the close.'
                  : 'The statement did not give a closing balance to check against.',
              style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
            )
          else if (!driftIsOff(difference))
            Row(
              children: [
                Icon(Icons.check_circle_outline, size: 16, color: c.credit),
                const SizedBox(width: 6),
                Text('Within a rupee of the statement', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.credit)),
              ],
            )
          else
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
                  decoration: BoxDecoration(color: c.debit50, borderRadius: BorderRadius.circular(100)),
                  child: Text(
                    '${formatMoney(difference.abs())} off',
                    style: kNum.copyWith(fontSize: 12.5, fontWeight: FontWeight.w800, color: c.debit),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    difference < 0
                        ? 'SpendLog shows more than the statement at the close.'
                        : 'The statement shows more than SpendLog at the close.',
                    style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}

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
        Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: c.muted)),
        const SizedBox(height: 3),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(value, style: kNum.copyWith(fontSize: 18, fontWeight: FontWeight.w800, color: c.ink)),
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
    return Text(parts.join(' · '), style: TextStyle(fontSize: 12, height: 1.45, color: c.muted));
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.title, {required this.count, required this.hint});

  final String title;
  final int count;
  final String hint;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(title, style: TextStyle(fontSize: 14.5, fontWeight: FontWeight.w800, color: c.ink))),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: c.chipNeutral, borderRadius: BorderRadius.circular(100)),
                child: Text('$count', style: kNum.copyWith(fontSize: 11.5, fontWeight: FontWeight.w800, color: c.ink70)),
              ),
            ],
          ),
          const SizedBox(height: 3),
          Text(hint, style: TextStyle(fontSize: 11.5, height: 1.4, color: c.muted)),
        ],
      ),
    );
  }
}

class _LineTile extends StatelessWidget {
  const _LineTile({
    required this.date,
    required this.title,
    required this.amountMinor,
    required this.isDebit,
    this.note,
    this.last = false,
    this.onTap,
  });

  final DateTime date;
  final String title;
  final int amountMinor;
  final bool isDebit;
  final String? note;
  final bool last;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    return InkWell(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
        decoration: BoxDecoration(border: last ? null : Border(bottom: BorderSide(color: c.line))),
        child: Row(
          children: [
            SizedBox(
              width: 48,
              child: Text(formatShortDate(date), style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.muted)),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 13.3, fontWeight: FontWeight.w600, color: c.ink)),
                  if (note != null) Text(note!, style: TextStyle(fontSize: 11, color: c.mutedLight)),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Text(
              '${isDebit ? '−' : '+'}${formatMoney(amountMinor)}',
              style: kNum.copyWith(fontSize: 13.5, fontWeight: FontWeight.w700, color: isDebit ? c.debit : c.credit),
            ),
            if (onTap != null) ...[
              const SizedBox(width: 4),
              Icon(Icons.chevron_right, size: 18, color: c.mutedLight),
            ],
          ],
        ),
      ),
    );
  }
}
