import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../theme.dart';
import '../utils/format.dart';
import '../utils/loan_tab.dart';
import '../widgets/loan_dialog.dart';
import '../widgets/state_block.dart';

/// Every loan and where it stands: ahead or behind on its schedule, each
/// instalment paid, part paid or still due, and every payment towards it
/// with its share - one payment that repaid several loans shows in each,
/// as the part of it that went there.
///
/// Ahead is money already in hand for instalments still to come, not a
/// prepayment: the lender's schedule stays exactly as it was.
class LoansScreen extends StatefulWidget {
  /// The loan tapped to get here, opened out; the rest start folded.
  final String? focusLoanId;

  const LoansScreen({super.key, this.focusLoanId});

  /// Opens it and says whether anything about a loan was changed from it.
  static Future<bool> open(BuildContext context, {String? loanId}) async {
    final changed = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => LoansScreen(focusLoanId: loanId)),
    );
    return changed == true;
  }

  @override
  State<LoansScreen> createState() => _LoansScreenState();
}

class _LoansScreenState extends State<LoansScreen> {
  List<Loan> _loans = [];
  LoanTotals _totals = const LoanTotals();
  bool _loading = true;
  bool _failed = false;
  bool _changed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final json = await ApiClient.instance.get('/loans?totals=1') as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        _loans = (json['loans'] as List<dynamic>? ?? [])
            .map((loan) => Loan.fromJson(loan as Map<String, dynamic>))
            .toList();
        _totals = LoanTotals.fromJson(json['totals'] as Map<String, dynamic>?);
        _loading = false;
        _failed = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _loading = false;
          _failed = true;
        });
      }
    }
  }

  Future<void> _edit(Loan loan) async {
    if (await LoanDialog.show(context, loan: loan)) {
      _changed = true;
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final running = _loans.where((loan) => loan.status == 'ACTIVE').toList();
    final finished = _loans.where((loan) => loan.status != 'ACTIVE').toList();

    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_changed);
      },
      child: Scaffold(
        backgroundColor: c.paper,
        appBar: AppBar(
          title: const Text('Loans'),
          shape: Border(bottom: BorderSide(color: c.line)),
        ),
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : _failed
                ? StateBlock(
                    icon: Icons.wifi_off,
                    title: "Couldn't load your loans",
                    body: 'Nothing is lost — try again in a moment.',
                    actionLabel: 'Try again',
                    onAction: _load,
                  )
                : RefreshIndicator(
                    onRefresh: _load,
                    child: ListView(
                      padding: const EdgeInsets.fromLTRB(16, 14, 16, 32),
                      children: [
                        if (running.isNotEmpty) ...[
                          _TotalLine(balanceMinor: _totals.balanceMinor),
                          const SizedBox(height: 12),
                        ],
                        for (final loan in running) ...[
                          _LoanCard(
                            loan: loan,
                            expanded: loan.id == widget.focusLoanId || running.length == 1,
                            onEdit: () => _edit(loan),
                          ),
                          const SizedBox(height: 12),
                        ],
                        if (finished.isNotEmpty) ...[
                          Padding(
                            padding: const EdgeInsets.fromLTRB(2, 8, 2, 8),
                            child: Text(
                              'Closed',
                              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: c.muted),
                            ),
                          ),
                          for (final loan in finished) ...[
                            _LoanCard(loan: loan, expanded: loan.id == widget.focusLoanId, onEdit: () => _edit(loan)),
                            const SizedBox(height: 12),
                          ],
                        ],
                        if (_loans.isEmpty)
                          Text(
                            'No loans yet. Add one from Settings.',
                            style: TextStyle(fontSize: 13, color: c.muted),
                          ),
                      ],
                    ),
                  ),
      ),
    );
  }
}

/// "₹1,200 ahead overall", across every running loan.
class _TotalLine extends StatelessWidget {
  final int balanceMinor;

  const _TotalLine({required this.balanceMinor});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final behind = balanceMinor < 0;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: behind ? c.warnBg : c.surface,
        borderRadius: BorderRadius.circular(T.rMd),
        border: Border.all(color: behind ? c.warn : c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            loanTotalLine(balanceMinor),
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: behind ? c.warn : c.ink),
          ),
          const SizedBox(height: 3),
          Text(
            'Everything paid towards your loans, against everything that has fallen due so far. '
            'Extra counts towards the next instalments; it does not shorten the loan.',
            style: TextStyle(fontSize: 12, height: 1.45, color: c.muted),
          ),
        ],
      ),
    );
  }
}

/// One loan: its tab, then its schedule and its payments, folded away
/// until asked for.
class _LoanCard extends StatelessWidget {
  final Loan loan;
  final bool expanded;
  final VoidCallback onEdit;

  const _LoanCard({required this.loan, required this.expanded, required this.onEdit});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final behind = loan.balanceMinor < 0 && loan.status == 'ACTIVE';

    // A Material rather than a decorated box, so the sections' ink shows.
    return Material(
      color: c.surface,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(T.rMd),
        side: BorderSide(color: c.line),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 4, 0),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        loan.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, fontWeight: FontWeight.w800, color: c.ink),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${formatMoney(loan.monthlyAmountMinor)} a month · ${loan.paidCount} of '
                        '${loan.months} paid · ${formatMoneyShort(loan.remainingMinor)} left',
                        style: TextStyle(fontSize: 12, color: c.muted),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Edit loan',
                  icon: Icon(Icons.edit_outlined, size: 18, color: c.muted),
                  onPressed: onEdit,
                ),
              ],
            ),
          ),
          if (loan.status == 'ACTIVE')
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 6, 14, 2),
              child: Text(
                loanTabLine(loan),
                key: ValueKey('loan-tab-${loan.id}'),
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: behind ? c.warn : (loan.balanceMinor > 0 ? c.credit : c.ink70),
                ),
              ),
            ),
          Theme(
            // No divider lines above and below an opened section.
            data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
            child: Column(
              children: [
                ExpansionTile(
                  initiallyExpanded: expanded,
                  tilePadding: const EdgeInsets.symmetric(horizontal: 14),
                  childrenPadding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
                  title: Text(
                    'Instalments',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink),
                  ),
                  children: [
                    for (final row in loan.instalments) _InstalmentRow(row: row),
                    if (loan.instalments.isEmpty)
                      Text('No schedule yet.', style: TextStyle(fontSize: 12, color: c.muted)),
                  ],
                ),
                ExpansionTile(
                  initiallyExpanded: expanded,
                  tilePadding: const EdgeInsets.symmetric(horizontal: 14),
                  childrenPadding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                  title: Text(
                    loan.payments.isEmpty ? 'Payments' : 'Payments (${loan.payments.length})',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: c.ink),
                  ),
                  children: [
                    for (final payment in loan.payments) _PaymentRow(payment: payment),
                    if (loan.payments.isEmpty)
                      Text(
                        'None linked yet. Mark a payment as a loan repayment from the transaction itself.',
                        style: TextStyle(fontSize: 12, height: 1.4, color: c.muted),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// One instalment: when, how much, and how much of it is paid.
class _InstalmentRow extends StatelessWidget {
  final LoanInstalmentRow row;

  const _InstalmentRow({required this.row});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final overdue = row.status != 'PAID' &&
        row.status != 'SKIPPED' &&
        istWallClock(row.dueDate).toIso8601String().substring(0, 10).compareTo(istToday()) <= 0;

    final (label, colour, background) = switch (row.status) {
      'PAID' => ('Paid', c.credit, c.credit50),
      'PARTIAL' => ('Part paid', c.warn, c.warnBg),
      'SKIPPED' => ('Skipped', c.muted, c.chipNeutral),
      _ => (overdue ? 'Due' : 'To come', overdue ? c.warn : c.muted, overdue ? c.warnBg : c.chipNeutral),
    };
    final detail = row.status == 'PARTIAL'
        ? '${loanMoney(row.paidMinor)} of ${loanMoney(row.amountMinor)} · ${loanMoney(row.shortMinor)} short'
        : loanMoney(row.amountMinor);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          SizedBox(
            width: 74,
            child: Text(
              DateFormat('d MMM yy').format(istWallClock(row.dueDate)),
              style: kNum.copyWith(fontSize: 12, color: c.ink70),
            ),
          ),
          Expanded(
            child: Text(
              detail,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: kNum.copyWith(fontSize: 12.5, color: c.ink),
            ),
          ),
          const SizedBox(width: 6),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
            decoration: BoxDecoration(color: background, borderRadius: BorderRadius.circular(100)),
            child: Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: colour)),
          ),
        ],
      ),
    );
  }
}

/// One payment towards the loan: this loan's share of it, and the whole of
/// it when it was split across several.
class _PaymentRow extends StatelessWidget {
  final LoanPaymentShare payment;

  const _PaymentRow({required this.payment});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final merchant = payment.merchant?.trim();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(loanShareLine(payment), style: TextStyle(fontSize: 12.5, color: c.ink)),
          if (merchant != null && merchant.isNotEmpty)
            Text(
              merchant,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 11.5, color: c.muted),
            ),
        ],
      ),
    );
  }
}
