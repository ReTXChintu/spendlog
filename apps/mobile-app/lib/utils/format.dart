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

/// Everything is shown in IST, whatever the phone's own timezone says.
///
/// A ledger read on a phone that has picked up another country's clock —
/// or one simply set wrong — should still say a payment happened on the
/// evening of the 11th, because that is when it happened. India has a fixed
/// +05:30 offset and no daylight saving, so the arithmetic is safe.
const Duration _istOffset = Duration(hours: 5, minutes: 30);

/// The instant as IST wall-clock, carried in a DateTime whose own fields
/// are what should be displayed.
DateTime _ist(DateTime instant) => instant.toUtc().add(_istOffset);

/// The instant as IST wall-clock, for a date/time picker to edit. The
/// result is a local-flavoured DateTime whose fields read as IST.
DateTime istWallClock(DateTime instant) {
  final ist = _ist(instant);
  return DateTime(ist.year, ist.month, ist.day, ist.hour, ist.minute, ist.second);
}

/// The reverse: IST wall-clock fields back to the instant they name.
DateTime fromIstWallClock(DateTime wallClock) =>
    DateTime.utc(
      wallClock.year,
      wallClock.month,
      wallClock.day,
      wallClock.hour,
      wallClock.minute,
      wallClock.second,
    ).subtract(_istOffset);

/// Today's date in IST, as YYYY-MM-DD.
String istToday() => _ist(DateTime.now()).toIso8601String().substring(0, 10);

String formatDayLabel(String isoDate) {
  final today = istToday();
  if (isoDate == today) return 'Today';

  final yesterday = DateTime.parse('${today}T00:00:00Z')
      .subtract(const Duration(days: 1))
      .toIso8601String()
      .substring(0, 10);
  if (isoDate == yesterday) return 'Yesterday';

  // Parsed as a plain date, so no offset can shift which day is named.
  return DateFormat('EEE, d MMM').format(DateTime.parse(isoDate));
}

String formatTime(DateTime dateTime) => DateFormat('h:mm a').format(_ist(dateTime));

String formatDateTime(DateTime dateTime) => DateFormat('EEE, d MMM, h:mm a').format(_ist(dateTime));

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
  // The IST month: at 1am on the 1st, UTC still says last month.
  return istToday().substring(0, 7);
}
