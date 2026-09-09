import 'package:intl/intl.dart';

/// Amounts are stored in paise and always shown with Indian grouping.
String formatMoney(int amountMinor, [String currency = 'INR']) {
  final formatter = NumberFormat.currency(
    locale: 'en_IN',
    symbol: currency == 'INR' ? '₹' : '$currency ',
  );
  return formatter.format(amountMinor / 100);
}

/// Compact form for tiles and the month rollup: ₹42,318 with no paise.
String formatMoneyShort(int amountMinor, [String currency = 'INR']) {
  final formatter = NumberFormat.currency(
    locale: 'en_IN',
    symbol: currency == 'INR' ? '₹' : '$currency ',
    decimalDigits: 0,
  );
  return formatter.format(amountMinor / 100);
}

String formatDayLabel(String isoDate) {
  final date = DateTime.parse(isoDate);
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final yesterday = today.subtract(const Duration(days: 1));
  final target = DateTime(date.year, date.month, date.day);

  if (target == today) return 'Today';
  if (target == yesterday) return 'Yesterday';
  return DateFormat('EEE, d MMM').format(date);
}

String formatTime(DateTime dateTime) => DateFormat('h:mm a').format(dateTime.toLocal());

String formatDateTime(DateTime dateTime) => DateFormat('EEE, d MMM, h:mm a').format(dateTime.toLocal());

/// "September 2026" for the analytics month picker.
String formatMonthLabel(String month) {
  final parts = month.split('-').map(int.parse).toList();
  return DateFormat('MMMM yyyy').format(DateTime(parts[0], parts[1]));
}

String shiftMonth(String month, int delta) {
  final parts = month.split('-').map(int.parse).toList();
  final shifted = DateTime(parts[0], parts[1] + delta);
  return '${shifted.year.toString().padLeft(4, '0')}-${shifted.month.toString().padLeft(2, '0')}';
}

String currentMonth() {
  final now = DateTime.now();
  return '${now.year.toString().padLeft(4, '0')}-${now.month.toString().padLeft(2, '0')}';
}
