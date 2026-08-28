import 'package:intl/intl.dart';

String formatMoney(int amountMinor, [String currency = 'INR']) {
  final formatter = NumberFormat.currency(locale: 'en_IN', symbol: currency == 'INR' ? '₹' : '$currency ');
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
