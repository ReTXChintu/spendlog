import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../models/models.dart';
import '../services/api_client.dart';
import '../widgets/ds/ds.dart';
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
        backgroundColor: c.bg,
        appBar: AppBar(title: const Text('Loans')),
        body: _loading
            ? const Center(child: DsSpinner())
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
                      padding: kPagePad,
                      children: [
                        if (running.isNotEmpty) ...[
                          _TotalLine(balanceMinor: _totals.balanceMinor, running: running),
                          const SizedBox(height: kCardGap),
                        ],
                        for (final loan in running) ...[
                          _LoanCard(
                            loan: loan,
                            expanded: loan.id == widget.focusLoanId || running.length == 1,
                            onEdit: () => _edit(loan),
                          ),
                          const SizedBox(height: kCardGap),
                        ],
                        if (finished.isNotEmpty) ...[
                          const DsLabel('Closed', padding: EdgeInsets.fromLTRB(2, 8, 2, 8)),
                          for (final loan in finished) ...[
                            _LoanCard(loan: loan, expanded: loan.id == widget.focusLoanId, onEdit: () => _edit(loan)),
                            const SizedBox(height: kCardGap),
                          ],
                        ],
                        if (_loans.isEmpty)
                          const DsEmpty(icon: DsIcons.banknote, message: 'No loans yet. Add one from Settings.'),
                      ],
                    ),
                  ),
      ),
    );
  }
}

/// "₹1,200 ahead overall", across every running loan, with the month's
/// figures beside it.
class _TotalLine extends StatelessWidget {
  final int balanceMinor;
  final List<Loan> running;

  const _TotalLine({required this.balanceMinor, required this.running});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final behind = balanceMinor < 0;
    final ahead = balanceMinor > 0;
    final monthly = running.fold<int>(0, (sum, loan) => sum + loan.monthlyAmountMinor);
    final left = running.fold<int>(0, (sum, loan) => sum + loan.remainingMinor);
    return DsCard(
      color: behind ? c.warnSoft : null,
      borderColor: behind ? c.warnSoft : null,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              DsIconTile(
                behind ? DsIcons.alertTriangle : DsIcons.check,
                tone: behind ? DsTone.warn : (ahead ? DsTone.good : DsTone.neutral),
                onTinted: behind,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      loanTotalLine(balanceMinor),
                      style: kNum.copyWith(
                        fontSize: 19,
                        height: 24 / 19,
                        fontWeight: FontWeight.w600,
                        color: behind ? c.warn : (ahead ? c.good : c.tx),
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Everything paid towards your loans, against everything that has fallen due so far. '
                      'Extra counts towards the next instalments; it does not shorten the loan.',
                      style: TextStyle(fontSize: 13, height: 18 / 13, color: behind ? c.tx2 : c.tx3),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 24,
            runSpacing: 10,
            children: [
              DsInlineStat(label: 'EMIs a month', value: formatMoneyShort(monthly)),
              DsInlineStat(label: 'Still to pay', value: formatMoneyShort(left)),
            ],
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
    final active = loan.status == 'ACTIVE';
    final behind = loan.balanceMinor < 0 && active;
    final ahead = loan.balanceMinor > 0;
    final today = istToday();
    final fallenDue = loan.instalments
        .where((row) => istWallClock(row.dueDate).toIso8601String().substring(0, 10).compareTo(today) <= 0)
        .length;
    final paidShare = loan.months == 0 ? 0.0 : loan.paidCount / loan.months;
    final dueShare = loan.months == 0 || loan.instalments.isEmpty ? null : fallenDue / loan.months;

    final (tabTone, tabFill, tabText) = behind
        ? (DsTone.warn, c.warnSoft, c.warn)
        : ahead
            ? (DsTone.good, c.goodSoft, c.good)
            : (DsTone.neutral, c.sunk, c.tx2);

    // A Material rather than a decorated box, so the sections' ink shows.
    return Material(
      color: c.sf,
      clipBehavior: Clip.antiAlias,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(Ds.rXl),
        side: BorderSide(color: behind ? c.warnFill : c.ln),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 4, 0),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                DsMonogram(loan.label),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        loan.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${formatMoney(loan.monthlyAmountMinor)} a month · ${loan.paidCount} of '
                        '${loan.months} paid · ${formatMoneyShort(loan.remainingMinor)} left',
                        style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx3),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Edit loan',
                  icon: DsIcon(DsIcons.pencil, size: 18, color: c.tx2),
                  onPressed: onEdit,
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
            child: Text.rich(
              TextSpan(
                children: [
                  TextSpan(
                    text: formatMoneyShort(loan.monthlyAmountMinor),
                    style: TextStyle(fontSize: 22, height: 28 / 22, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  TextSpan(
                    text: ' /month',
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: c.tx3),
                  ),
                ],
              ),
              style: kNum,
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: DsMeter(
              value: paidShare,
              height: 10,
              color: c.tx,
              today: active ? dueShare : null,
            ),
          ),
          if (active)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 2),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(color: tabFill, borderRadius: BorderRadius.circular(Ds.rLg)),
                child: Row(
                  children: [
                    DsIcon(
                      behind ? DsIcons.alertTriangle : (ahead ? DsIcons.arrowUpRight : DsIcons.check),
                      size: 18,
                      color: c.strong(tabTone),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        loanTabLine(loan),
                        key: ValueKey('loan-tab-${loan.id}'),
                        style: kNum.copyWith(fontSize: 14, height: 20 / 14, fontWeight: FontWeight.w600, color: tabText),
                      ),
                    ),
                  ],
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
                  tilePadding: const EdgeInsets.symmetric(horizontal: 16),
                  childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                  title: Text(
                    'Instalments',
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  children: [
                    for (final (i, row) in loan.instalments.indexed)
                      _InstalmentRow(row: row, last: i == loan.instalments.length - 1),
                    if (loan.instalments.isEmpty)
                      Align(
                        alignment: Alignment.centerLeft,
                        child: Text('No schedule yet.', style: TextStyle(fontSize: 13, color: c.tx3)),
                      ),
                  ],
                ),
                Divider(indent: 16, endIndent: 16, color: c.ln),
                ExpansionTile(
                  initiallyExpanded: expanded,
                  tilePadding: const EdgeInsets.symmetric(horizontal: 16),
                  childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                  title: Text(
                    loan.payments.isEmpty ? 'Payments' : 'Payments (${loan.payments.length})',
                    style: TextStyle(fontSize: 15, height: 20 / 15, fontWeight: FontWeight.w600, color: c.tx),
                  ),
                  children: [
                    for (final payment in loan.payments) _PaymentRow(payment: payment),
                    if (loan.payments.isEmpty)
                      Text(
                        'None linked yet. Mark a payment as a loan repayment from the transaction itself.',
                        style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
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

/// One instalment on the schedule's timeline: a filled accent dot when it
/// is paid, a dashed ring while it is still to come.
class _InstalmentRow extends StatelessWidget {
  final LoanInstalmentRow row;
  final bool last;

  const _InstalmentRow({required this.row, this.last = false});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    final overdue = row.status != 'PAID' &&
        row.status != 'SKIPPED' &&
        istWallClock(row.dueDate).toIso8601String().substring(0, 10).compareTo(istToday()) <= 0;

    final (label, tone) = switch (row.status) {
      'PAID' => ('Paid', DsTone.good),
      'PARTIAL' => ('Part paid', DsTone.warn),
      'SKIPPED' => ('Skipped', DsTone.neutral),
      _ => (overdue ? 'Due' : 'To come', overdue ? DsTone.warn : DsTone.neutral),
    };
    final detail = row.status == 'PARTIAL'
        ? '${loanMoney(row.paidMinor)} of ${loanMoney(row.amountMinor)} · ${loanMoney(row.shortMinor)} short'
        : loanMoney(row.amountMinor);
    final done = row.status == 'PAID';

    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 18,
            child: Column(
              children: [
                const SizedBox(height: 15),
                _TimelineDot(done: done),
                if (!last)
                  Expanded(child: Container(width: 1, color: c.ln2))
                else
                  const Spacer(),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  SizedBox(
                    width: 72,
                    child: Text(
                      DateFormat('d MMM yy').format(istWallClock(row.dueDate)),
                      style: kNum.copyWith(fontSize: 13, height: 18 / 13, color: c.tx2),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      detail,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: kNum.copyWith(fontSize: 13, height: 18 / 13, fontWeight: FontWeight.w500, color: c.tx),
                    ),
                  ),
                  const SizedBox(width: 6),
                  DsBadge(label, tone: tone),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 10 px: a filled accent dot for done, a dashed accent ring for to come.
class _TimelineDot extends StatelessWidget {
  final bool done;

  const _TimelineDot({required this.done});

  @override
  Widget build(BuildContext context) {
    final c = context.c;
    if (done) {
      return Container(width: 10, height: 10, decoration: BoxDecoration(color: c.ac, shape: BoxShape.circle));
    }
    return DsDashedBorder(
      radius: 5,
      color: c.ac,
      strokeWidth: 1.5,
      dash: 2,
      gap: 2,
      child: const SizedBox(width: 10, height: 10),
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
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const DsIconTile(DsIcons.banknote, size: 36),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  loanShareLine(payment),
                  style: kNum.copyWith(fontSize: 14, height: 20 / 14, color: c.tx),
                ),
                if (merchant != null && merchant.isNotEmpty)
                  Text(
                    merchant,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, height: 18 / 13, color: c.tx3),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
