import 'package:intl/intl.dart';
import '../models/models.dart';
import 'format.dart';

/// Whole rupees when there are no paise - "₹500 ahead" reads better than
/// "₹500.00 ahead" - and the paise when there are some, so a rupee of
/// rounding is never shown as nothing.
String loanMoney(int amountMinor) =>
    amountMinor % 100 == 0 ? formatMoneyShort(amountMinor) : formatMoney(amountMinor);

/// "Nov" for an instalment due in November, as the date reads in India.
String _month(DateTime dueDate) => DateFormat('MMM').format(istWallClock(dueDate));

/// The same from an IST calendar day the server already worked out.
String _monthOfDay(String isoDay) => DateFormat('MMM').format(DateTime.parse(isoDay));

/// Where a loan stands against its schedule, in one line: "₹500 ahead —
/// covers part of the Nov instalment", "₹300 behind on the Oct
/// instalment", or up to date.
///
/// Ahead is money in hand towards instalments still to come, not a
/// prepayment: the schedule is the lender's, and stays as it was.
String loanTabLine(Loan loan) {
  final next = loan.nextDue;
  if (loan.balanceMinor < 0) {
    final behind = loanMoney(loan.behindMinor);
    return next == null ? '$behind behind' : '$behind behind on the ${_month(next.dueDate)} instalment';
  }
  if (loan.balanceMinor > 0) {
    final ahead = loanMoney(loan.aheadMinor);
    if (next != null && next.alreadyCoveredMinor > 0) {
      return '$ahead ahead — covers part of the ${_month(next.dueDate)} instalment';
    }
    final through = loan.coveredThrough;
    if (through != null) return '$ahead ahead — covers the ${_monthOfDay(through)} instalment';
    return '$ahead ahead';
  }
  return 'Up to date';
}

/// Just the tab, for a row with no room for the rest: "₹500 ahead".
String loanTabShort(int balanceMinor) {
  if (balanceMinor > 0) return '${loanMoney(balanceMinor)} ahead';
  if (balanceMinor < 0) return '${loanMoney(-balanceMinor)} behind';
  return 'Up to date';
}

/// The same across every running loan, as one combined payment a month is
/// actually thought about.
String loanTotalLine(int balanceMinor) {
  if (balanceMinor > 0) return '${loanMoney(balanceMinor)} ahead overall';
  if (balanceMinor < 0) return '${loanMoney(-balanceMinor)} behind overall';
  return 'Up to date overall';
}

/// "₹14,500 of ₹15,000 assigned · ₹500 not assigned", for a payment being
/// split across loans. Says "over" instead when the loans add up to more
/// than the payment, which cannot be saved.
String loanAssignedLine({required int assignedMinor, required int totalMinor}) {
  final head = '${loanMoney(assignedMinor)} of ${loanMoney(totalMinor)} assigned';
  if (assignedMinor > totalMinor) return '$head · ${loanMoney(assignedMinor - totalMinor)} over';
  if (assignedMinor < totalMinor) return '$head · ${loanMoney(totalMinor - assignedMinor)} not assigned';
  return head;
}

/// "₹6,000 of a ₹15,000 payment on 5 Oct", or just "₹6,000 on 5 Oct" for a
/// payment that went to this loan alone.
String loanShareLine(LoanPaymentShare payment) {
  final day = formatShortDate(payment.occurredAt);
  if (!payment.isShared) return '${loanMoney(payment.amountMinor)} on $day';
  return '${loanMoney(payment.amountMinor)} of a ${loanMoney(payment.totalMinor)} payment on $day';
}
